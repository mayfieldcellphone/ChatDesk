import express, { Router } from 'express';
import { get, insertMessage, normalizePhone, type Business } from './db';
import { publish } from './events';
import { onInboundMessage } from './inbound';
import { phoneConversation } from './phone';
import { twiml, verifyTwilio } from './twilio';

export const smsRouter = Router();
smsRouter.use(express.urlencoded({ extended: false }), verifyTwilio);

smsRouter.post('/inbound', (req, res) => {
  const params = req.body as Record<string, string>;
  const reply = () => res.type('text/xml').send(twiml``);
  const to = normalizePhone(params.To);
  const from = normalizePhone(params.From);
  const body = (params.Body || '').trim();
  if (!to || !from || !body) return reply();

  const business = get<Business>('SELECT * FROM businesses WHERE sms_number = ?', to);
  if (!business) return reply();

  const conversation = phoneConversation(business, from);
  const message = insertMessage(conversation, 'in', 'sms', body.slice(0, 2000));
  // Show the text in the customer's web chat too, if they still have it open.
  publish(`conv:${conversation.id}`, {
    type: 'message',
    message: { id: message.id, direction: 'in', body: message.body, created_at: message.created_at },
  });
  onInboundMessage(business, conversation, message);
  reply();
});
