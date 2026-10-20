import express, { Router, type Response } from 'express';
import {
  get, insertMessage, newId, normalizePhone, now, run,
  type Business, type Call, type Contact, type Conversation, type Message,
} from './db';
import { publish } from './events';
import { isOpen } from './hours';
import { onInboundMessage } from './inbound';
import { emailTeam } from './notify';
import { phoneConversation } from './phone';
import { replyChannels, sendToCustomer } from './outbound';
import { publicUrl, twiml, verifyTwilio } from './twilio';

// Twilio Voice webhooks. Point the number's "A call comes in" at /api/voice/incoming and
// "Call status changes" at /api/voice/status. The other URLs are handed to Twilio in the TwiML below.
export const voiceRouter = Router();
voiceRouter.use(express.urlencoded({ extended: false }), verifyTwilio);

const MISSED_TEXT_REPEAT_MS = 60 * 60 * 1000;
const VOICEMAIL_GRACE_MS = Number(process.env.VOICEMAIL_GRACE_MS) || 30_000;
const sendTwiml = (res: Response, xml: string) => res.type('text/xml').send(xml);
const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

function callSummary(call: Pick<Call, 'status' | 'has_voicemail' | 'duration'>) {
  if (call.status === 'answered') return `Answered call${call.duration ? ` · ${formatDuration(call.duration)}` : ''}`;
  if (call.status === 'missed') return call.has_voicemail ? 'Missed call · left a voicemail' : 'Missed call';
  return 'Incoming call…';
}

function publishUpdated(businessId: string, conversationId: string, messageId: string) {
  const message = get<Message>('SELECT * FROM messages WHERE id = ?', messageId);
  if (message) publish(`biz:${businessId}`, { type: 'message-updated', conversationId, message: { ...message, author_name: null } });
}

/** Rewrites the call's line in the conversation timeline to match its current status. */
function refreshCallMessage(call: Call) {
  if (!call.message_id) return;
  run('UPDATE messages SET body = ?, duration = ? WHERE id = ?', callSummary(call), call.duration, call.message_id);
  publishUpdated(call.business_id, call.conversation_id, call.message_id);
}

const loadCall = (callSid: string | undefined) => (callSid ? get<Call>('SELECT * FROM calls WHERE call_sid = ?', callSid) : undefined);

function voicemailTwiml(business: Business) {
  const base = publicUrl();
  return twiml`<Say>${business.voicemail_greeting}</Say><Record maxLength="120" timeout="5" playBeep="true" trim="trim-silence" action="${base}/api/voice/voicemail-done" recordingStatusCallback="${base}/api/voice/recording" transcribe="true" transcribeCallback="${base}/api/voice/transcription"/><Say>We didn't get a message. Goodbye.</Say>`;
}

voiceRouter.post('/incoming', (req, res) => {
  const params = req.body as Record<string, string>;
  const to = normalizePhone(params.To);
  const business = to ? get<Business>('SELECT * FROM businesses WHERE sms_number = ?', to) : undefined;
  if (!business || !params.CallSid) return sendTwiml(res, twiml`<Say>Sorry, this number isn't set up yet. Goodbye.</Say><Hangup/>`);

  const from = normalizePhone(params.From);
  if (!loadCall(params.CallSid)) {
    const conversation = phoneConversation(business, from);
    const message = insertMessage(conversation, 'in', 'sms', 'Incoming call…', { kind: 'call' });
    run(
      "INSERT INTO calls (id, business_id, conversation_id, call_sid, status, message_id, created_at) VALUES (?, ?, ?, ?, 'ringing', ?, ?)",
      newId(), business.id, conversation.id, params.CallSid, message.id, now(),
    );
    publish(`biz:${business.id}`, { type: 'message', conversationId: conversation.id, message: { ...message, author_name: null } });
  }

  // Ring the shop first during opening hours; the caller hears ringing until someone answers.
  if (business.forward_number && business.forward_number !== from && isOpen(business)) {
    return sendTwiml(
      res,
      twiml`<Dial timeout="${business.ring_seconds}" answerOnBridge="true" action="${publicUrl()}/api/voice/dial-status"><Number>${business.forward_number}</Number></Dial>`,
    );
  }
  sendTwiml(res, voicemailTwiml(business));
});

voiceRouter.post('/dial-status', (req, res) => {
  const params = req.body as Record<string, string>;
  const call = loadCall(params.CallSid);
  const business = call && get<Business>('SELECT * FROM businesses WHERE id = ?', call.business_id);
  if (!call || !business) return sendTwiml(res, twiml`<Hangup/>`);

  if (params.DialCallStatus === 'completed') {
    call.status = 'answered';
    call.duration = Number(params.DialCallDuration) || null;
    run("UPDATE calls SET status = 'answered', duration = ? WHERE id = ?", call.duration, call.id);
    refreshCallMessage(call);
    return sendTwiml(res, twiml`<Hangup/>`);
  }
  // Nobody picked up (or the line was busy): take a voicemail instead.
  sendTwiml(res, voicemailTwiml(business));
});

voiceRouter.post('/voicemail-done', (_req, res) => {
  sendTwiml(res, twiml`<Say>Thanks for your message. Goodbye.</Say><Hangup/>`);
});

voiceRouter.post('/recording', (req, res) => {
  const params = req.body as Record<string, string>;
  res.sendStatus(204);
  if (params.RecordingStatus !== 'completed' || !params.RecordingSid) return;
  const call = loadCall(params.CallSid);
  if (!call || get('SELECT id FROM messages WHERE recording_sid = ?', params.RecordingSid)) return;

  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', call.business_id)!;
  const conversation = get<Conversation>('SELECT * FROM conversations WHERE id = ?', call.conversation_id)!;
  const duration = Number(params.RecordingDuration) || 0;
  const message = insertMessage(conversation, 'in', 'sms', `Voicemail (${formatDuration(duration)}). Transcript on its way…`, {
    kind: 'voicemail',
    recordingSid: params.RecordingSid,
    duration,
  });

  call.status = 'missed';
  call.has_voicemail = 1;
  run("UPDATE calls SET status = 'missed', has_voicemail = 1 WHERE id = ?", call.id);
  refreshCallMessage(call);
  onInboundMessage(business, conversation, message, { awayMessage: false });
});

voiceRouter.post('/transcription', (req, res) => {
  const params = req.body as Record<string, string>;
  res.sendStatus(204);
  const message = params.RecordingSid
    ? get<Message & { business_id: string }>(
        'SELECT m.*, c.business_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.recording_sid = ?',
        params.RecordingSid,
      )
    : undefined;
  if (!message) return;

  const text = (params.TranscriptionText || '').trim();
  const body = params.TranscriptionStatus === 'completed' && text ? text : 'Voicemail (no transcript available, press play to listen)';
  run('UPDATE messages SET body = ? WHERE id = ?', body.slice(0, 2000), message.id);
  publishUpdated(message.business_id, message.conversation_id, message.id);
});

// The number's "Call status changes" webhook: fires when the call ends, however it ended.
voiceRouter.post('/status', (req, res) => {
  const params = req.body as Record<string, string>;
  res.sendStatus(204);
  if (!['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(params.CallStatus)) return;
  const call = loadCall(params.CallSid);
  if (!call || call.ended) return;
  run('UPDATE calls SET ended = 1 WHERE id = ?', call.id);
  if (call.status === 'answered') return;

  // Still 'ringing' means they hung up before voicemail; 'missed' means the voicemail already arrived.
  if (call.status === 'ringing') {
    call.status = 'missed';
    run("UPDATE calls SET status = 'missed' WHERE id = ?", call.id);
    refreshCallMessage(call);
  }

  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', call.business_id)!;
  const conversation = get<Conversation & { last_missed_text_at: string | null }>('SELECT * FROM conversations WHERE id = ?', call.conversation_id)!;
  sendMissedCallText(business, conversation).catch((err) => console.error('Missed-call text failed:', err));
  // A voicemail sends its own alert. Twilio usually delivers the recording a few seconds after the
  // call ends, so wait before deciding the caller hung up without leaving one.
  if (!call.has_voicemail && call.message_id) {
    setTimeout(() => {
      const latest = get<Call>('SELECT * FROM calls WHERE id = ?', call.id);
      const message = latest?.message_id && get<Message>('SELECT * FROM messages WHERE id = ?', latest.message_id);
      if (!latest || latest.has_voicemail || !message) return;
      emailTeam(business, conversation, message).catch((err) => console.error('Email alert failed:', err));
    }, VOICEMAIL_GRACE_MS).unref();
  }
});

/** Texts the caller back after a missed call (Birdeye-style), at most once an hour per conversation. */
async function sendMissedCallText(business: Business, conversation: Conversation & { last_missed_text_at: string | null }) {
  if (!business.missed_call_text_enabled) return;
  if (conversation.last_missed_text_at && Date.now() - Date.parse(conversation.last_missed_text_at) < MISSED_TEXT_REPEAT_MS) return;
  const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', conversation.contact_id)!;
  if (!replyChannels(business, conversation, contact).includes('sms')) return;

  run('UPDATE conversations SET last_missed_text_at = ? WHERE id = ?', now(), conversation.id);
  await sendToCustomer(business, conversation, 'sms', business.missed_call_text, { automated: true });
}
