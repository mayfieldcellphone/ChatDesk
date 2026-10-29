import { get, run, type Call, type Message } from './db';
import { publish } from './events';

export const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const OUTCOMES: Record<string, string> = {
  booked: 'booking taken',
  message: 'message taken',
  transferred: 'put through to you',
  answered: 'questions answered',
  voicemail: 'sent to voicemail',
};

export function callSummary(call: Pick<Call, 'status' | 'has_voicemail' | 'duration' | 'ai_handled' | 'ai_outcome'>) {
  if (call.ai_handled) {
    const parts = ['AI receptionist call'];
    if (call.duration) parts.push(formatDuration(call.duration));
    if (call.ai_outcome && OUTCOMES[call.ai_outcome]) parts.push(OUTCOMES[call.ai_outcome]);
    return parts.join(' · ');
  }
  if (call.status === 'answered') return `Answered call${call.duration ? ` · ${formatDuration(call.duration)}` : ''}`;
  if (call.status === 'missed') return call.has_voicemail ? 'Missed call · left a voicemail' : 'Missed call';
  return 'Incoming call…';
}

export function publishUpdated(businessId: string, conversationId: string, messageId: string) {
  const message = get<Message>('SELECT * FROM messages WHERE id = ?', messageId);
  if (message) publish(`biz:${businessId}`, { type: 'message-updated', conversationId, message: { ...message, author_name: null } });
}

/** Rewrites the call's line in the conversation timeline to match its current status. */
export function refreshCallMessage(call: Call) {
  if (!call.message_id) return;
  run('UPDATE messages SET body = ?, duration = ? WHERE id = ?', callSummary(call), call.duration, call.message_id);
  publishUpdated(call.business_id, call.conversation_id, call.message_id);
}

export const loadCall = (callSid: string | undefined) => (callSid ? get<Call>('SELECT * FROM calls WHERE call_sid = ?', callSid) : undefined);
