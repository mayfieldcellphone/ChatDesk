import express, { Router } from 'express';
import { get, insertMessage, normalizePhone, type Business } from './db';
import { publish } from './events';
import { onInboundMessage } from './inbound';
import { phoneConversation } from './phone';
import { handleOptOutText } from './campaigns';
import { sendToCustomer } from './outbound';
import { fetchTwilioMedia, twiml, verifyTwilio } from './twilio';
import { MAX_PHOTO_BYTES, saveMedia } from './media';

export const smsRouter = Router();
smsRouter.use(express.urlencoded({ extended: false }), verifyTwilio);

smsRouter.post('/inbound', async (req, res) => {
  const params = req.body as Record<string, string>;
  const reply = () => res.type('text/xml').send(twiml``);
  const to = normalizePhone(params.To);
  const from = normalizePhone(params.From);
  const body = (params.Body || '').trim();
  const photos = Number(params.NumMedia) || 0;
  if (!to || !from || (!body && photos === 0)) return reply();

  const business = get<Business>('SELECT * FROM businesses WHERE sms_number = ?', to);
  if (!business) return reply();

  // Photos the customer texted (e.g. their cracked screen): kept privately for the team.
  const mediaIds: string[] = [];
  for (let i = 0; i < Math.min(photos, 5); i++) {
    const url = params[`MediaUrl${i}`];
    if (!url || !/^image\//.test(params[`MediaContentType${i}`] || '')) continue;
    try {
      const file = await fetchTwilioMedia(url);
      if (file.data.length <= MAX_PHOTO_BYTES * 2) mediaIds.push(saveMedia(business.id, file.mime, file.data, true));
    } catch (err) {
      console.error('Customer photo download failed:', (err as Error).message);
    }
  }
  if (!body && mediaIds.length === 0) return reply();

  const conversation = phoneConversation(business, from);
  const message = insertMessage(conversation, 'in', 'sms', (body || '📷 Photo').slice(0, 2000), { mediaId: mediaIds[0] ?? null });
  // Further photos in the same text: one line each, without counting them as extra unread messages.
  for (const id of mediaIds.slice(1)) insertMessage(conversation, 'in', 'sms', '📷 Photo', { mediaId: id, quiet: true });
  // Show the text in the customer's web chat too, if they still have it open.
  publish(`conv:${conversation.id}`, {
    type: 'message',
    message: { id: message.id, direction: 'in', body: message.body, created_at: message.created_at },
  });
  // STOP / START: confirm straight away instead of the usual auto-replies.
  const optOut = handleOptOutText(business, from, body);
  if (optOut) {
    publish(`biz:${business.id}`, { type: 'message', conversationId: conversation.id, message: { ...message, author_name: null } });
    sendToCustomer(business, conversation, 'sms', optOut, { automated: true }).catch((err) => console.error('Opt-out confirmation failed:', err.message));
    return reply();
  }
  onInboundMessage(business, conversation, message);
  reply();
});
