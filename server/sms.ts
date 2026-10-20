import express, { Router } from 'express';
import { get, insertMessage, newId, normalizePhone, now, run, upsertContact, type Business, type Conversation } from './db';
import { publish } from './events';
import { onInboundMessage } from './inbound';
import { smsConfigured, validTwilioSignature } from './twilio';

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
    conversation.channel = 'sms';
  }

  const message = insertMessage(conversation, 'in', 'sms', body.slice(0, 2000));
  // Show the text in the customer's web chat too, if they still have it open.
  publish(`conv:${conversation.id}`, {
    type: 'message',
    message: { id: message.id, direction: 'in', body: message.body, created_at: message.created_at },
  });
  onInboundMessage(business, conversation, message);
  twiml();
});
