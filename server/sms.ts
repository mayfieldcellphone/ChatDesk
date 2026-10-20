import express, { Router } from 'express';
import crypto from 'node:crypto';
import { get, insertMessage, newId, normalizePhone, now, run, upsertContact, type Business, type Conversation } from './db';
import { publish } from './events';

const sid = () => process.env.TWILIO_ACCOUNT_SID || '';
const authToken = () => process.env.TWILIO_AUTH_TOKEN || '';

export const smsConfigured = () => Boolean(sid() && authToken());

export async function sendSms(from: string, to: string, body: string) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid()}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid()}:${authToken()}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(detail?.message || `Twilio returned ${res.status}`);
  }
}

// https://www.twilio.com/docs/usage/webhooks/webhooks-security
function validTwilioSignature(signature: string | undefined, url: string, params: Record<string, string>) {
  if (!signature) return false;
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac('sha1', authToken()).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const smsRouter = Router();

smsRouter.post('/inbound', express.urlencoded({ extended: false }), (req, res) => {
  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (!smsConfigured() || !publicUrl) return res.status(503).send('SMS is not configured');

  const params = req.body as Record<string, string>;
  if (!validTwilioSignature(req.get('X-Twilio-Signature'), `${publicUrl}/api/sms/inbound`, params)) {
    return res.status(403).send('Invalid signature');
  }

  const twiml = () => res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  const to = normalizePhone(params.To);
  const from = normalizePhone(params.From);
  const body = (params.Body || '').trim();
  if (!to || !from || !body) return twiml();

  const business = get<Business>('SELECT * FROM businesses WHERE sms_number = ?', to);
  if (!business) return twiml();

  const existingContact = get<{ id: string; name: string }>(
    'SELECT id, name FROM contacts WHERE business_id = ? AND phone = ?',
    business.id, from,
  );
  const contact = existingContact ?? upsertContact(business.id, from, from, null);

  // Continue the customer's latest conversation (webchat or SMS) so the thread stays in one place.
  let conversation = get<Conversation>(
    'SELECT * FROM conversations WHERE contact_id = ? ORDER BY last_message_at DESC LIMIT 1',
    contact.id,
  );
  if (!conversation) {
    const t = now();
    conversation = {
      id: newId(), business_id: business.id, contact_id: contact.id, channel: 'sms', status: 'open',
      visitor_token: null, page_url: null, unread_count: 0, last_message_at: t, created_at: t,
    };
    run(
      'INSERT INTO conversations (id, business_id, contact_id, channel, status, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      conversation.id, business.id, contact.id, 'sms', 'open', t, t,
    );
  } else if (conversation.channel !== 'sms') {
    run("UPDATE conversations SET channel = 'sms' WHERE id = ?", conversation.id);
  }

  const message = insertMessage(conversation, 'in', 'sms', body.slice(0, 2000));
  publish(`biz:${business.id}`, { type: 'message', conversationId: conversation.id, message });
  publish(`conv:${conversation.id}`, { type: 'message', message });
  twiml();
});
