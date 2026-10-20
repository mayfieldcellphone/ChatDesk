import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import {
  all, get, insertMessage, newId, normalizePhone, now, run, upsertContact,
  type Business, type Conversation, type Message,
} from './db';
import { isVisitorOnline, publish, subscribe } from './events';
import { rateLimit } from './rateLimit';

// Public API used by the embeddable widget (public/widget.js) on customers' websites.
export const widgetRouter = Router();

widgetRouter.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Visitor-Token',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const MAX_MESSAGE = 2000;
const publicMessage = (m: Message) => ({ id: m.id, direction: m.direction, body: m.body, created_at: m.created_at });

function loadBusiness(req: Request, res: Response) {
  const business = get<Business>('SELECT * FROM businesses WHERE widget_key = ?', req.params.key);
  if (!business) res.status(404).json({ error: 'Unknown widget key' });
  return business;
}

/** Loads the conversation and checks the visitor's secret token (header, or query for EventSource). */
function loadVisitorConversation(req: Request, res: Response) {
  const business = loadBusiness(req, res);
  if (!business) return undefined;
  const token = req.get('X-Visitor-Token') || (typeof req.query.token === 'string' ? req.query.token : '');
  const conversation = get<Conversation>(
    'SELECT * FROM conversations WHERE id = ? AND business_id = ?',
    req.params.id, business.id,
  );
  const ok =
    conversation?.visitor_token &&
    token.length === conversation.visitor_token.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(conversation.visitor_token));
  if (!conversation || !ok) {
    res.status(404).json({ error: 'Conversation not found' });
    return undefined;
  }
  return { business, conversation };
}

const startLimit = rateLimit('widget-start', 10, 10 * 60 * 1000);
const messageLimit = rateLimit('widget-message', 30, 60 * 1000);
const tooLong = (s: string) => s.length > MAX_MESSAGE;

widgetRouter.get('/:key/config', (req, res) => {
  const business = loadBusiness(req, res);
  if (!business) return;
  res.json({ name: business.name, color: business.color, greeting: business.greeting });
});

widgetRouter.post('/:key/conversations', startLimit, (req, res) => {
  const business = loadBusiness(req, res);
  if (!business) return;

  const name = String(req.body.name ?? '').trim().slice(0, 100);
  const body = String(req.body.message ?? '').trim();
  const phone = normalizePhone(req.body.phone);
  const pageUrl = String(req.body.pageUrl ?? '').slice(0, 500) || null;

  if (!name) return res.status(400).json({ error: 'Please enter your name' });
  if (!phone) return res.status(400).json({ error: 'Please enter a valid mobile number' });
  if (!body) return res.status(400).json({ error: 'Please enter a message' });
  if (tooLong(body)) return res.status(400).json({ error: 'Message is too long' });

  const contact = upsertContact(business.id, name, phone, null);
  const t = now();
  const conversation: Conversation = {
    id: newId(), business_id: business.id, contact_id: contact.id, channel: 'webchat', status: 'open',
    visitor_token: crypto.randomBytes(24).toString('base64url'), page_url: pageUrl,
    unread_count: 0, last_message_at: t, created_at: t,
  };
  run(
    `INSERT INTO conversations (id, business_id, contact_id, channel, status, visitor_token, page_url, last_message_at, created_at)
     VALUES (?, ?, ?, 'webchat', 'open', ?, ?, ?, ?)`,
    conversation.id, business.id, contact.id, conversation.visitor_token, pageUrl, t, t,
  );
  const message = insertMessage(conversation, 'in', 'webchat', body);
  publish(`biz:${business.id}`, { type: 'message', conversationId: conversation.id, message });

  res.status(201).json({
    conversationId: conversation.id,
    visitorToken: conversation.visitor_token,
    messages: [publicMessage(message)],
  });
});

widgetRouter.get('/:key/conversations/:id/messages', (req, res) => {
  const found = loadVisitorConversation(req, res);
  if (!found) return;
  const messages = all<Message>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at',
    found.conversation.id,
  );
  res.json({ messages: messages.map(publicMessage) });
});

widgetRouter.post('/:key/conversations/:id/messages', messageLimit, (req, res) => {
  const found = loadVisitorConversation(req, res);
  if (!found) return;
  const body = String(req.body.body ?? '').trim();
  if (!body) return res.status(400).json({ error: 'Message is empty' });
  if (tooLong(body)) return res.status(400).json({ error: 'Message is too long' });

  // A visitor typing in the widget brings an SMS thread back to web chat.
  if (found.conversation.channel !== 'webchat') {
    run("UPDATE conversations SET channel = 'webchat' WHERE id = ?", found.conversation.id);
  }
  const message = insertMessage(found.conversation, 'in', 'webchat', body);
  publish(`biz:${found.business.id}`, { type: 'message', conversationId: found.conversation.id, message });
  res.status(201).json({ message: publicMessage(message) });
});

widgetRouter.get('/:key/conversations/:id/stream', (req, res) => {
  const found = loadVisitorConversation(req, res);
  if (!found) return;
  const { business, conversation } = found;
  const announce = () =>
    publish(`biz:${business.id}`, { type: 'presence', conversationId: conversation.id, online: isVisitorOnline(conversation.id) });

  subscribe(`conv:${conversation.id}`, req, res, announce);
  announce();
});
