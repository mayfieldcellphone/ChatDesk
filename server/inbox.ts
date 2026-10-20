import { Router } from 'express';
import { all, get, insertMessage, normalizePhone, run, type Business, type Contact, type Conversation, type Message } from './db';
import { isVisitorOnline, publish, subscribe } from './events';
import { requireAuth } from './auth';
import { sendSms, smsConfigured } from './sms';

// Authenticated API for the team inbox. Every query is scoped to the signed-in user's business.
export const inboxRouter = Router();
inboxRouter.use(requireAuth);

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function publicBusiness(b: Business) {
  return {
    id: b.id,
    name: b.name,
    widgetKey: b.widget_key,
    color: b.color,
    greeting: b.greeting,
    smsNumber: b.sms_number,
    smsAvailable: smsConfigured(),
  };
}

inboxRouter.get('/me', (req, res) => {
  const { userId, businessId } = req.session!;
  const user = get<{ id: string; name: string; email: string }>('SELECT id, name, email FROM users WHERE id = ?', userId)!;
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  res.json({ user, business: publicBusiness(business) });
});

inboxRouter.patch('/business', (req, res) => {
  const { businessId } = req.session!;
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;

  const name = req.body.name === undefined ? business.name : String(req.body.name).trim().slice(0, 100);
  const greeting = req.body.greeting === undefined ? business.greeting : String(req.body.greeting).trim().slice(0, 300);
  const color = req.body.color === undefined ? business.color : String(req.body.color);
  let smsNumber = business.sms_number;
  if (req.body.smsNumber !== undefined) {
    smsNumber = req.body.smsNumber ? normalizePhone(String(req.body.smsNumber)) : null;
    if (req.body.smsNumber && !smsNumber) return res.status(400).json({ error: 'Enter the SMS number in +E.164 format, e.g. +61400123456' });
  }

  if (!name) return res.status(400).json({ error: 'Business name is required' });
  if (!greeting) return res.status(400).json({ error: 'Greeting is required' });
  if (!HEX_COLOR.test(color)) return res.status(400).json({ error: 'Colour must be a hex value like #2563eb' });
  if (smsNumber && get('SELECT id FROM businesses WHERE sms_number = ? AND id != ?', smsNumber, businessId)) {
    return res.status(409).json({ error: 'That SMS number is already used by another business' });
  }

  run('UPDATE businesses SET name = ?, greeting = ?, color = ?, sms_number = ? WHERE id = ?', name, greeting, color, smsNumber, businessId);
  res.json({ business: publicBusiness(get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!) });
});

inboxRouter.get('/conversations', (req, res) => {
  const { businessId } = req.session!;
  const status = req.query.status === 'closed' ? 'closed' : 'open';
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  const rows = all<Conversation & { contact_name: string; contact_phone: string | null; last_body: string | null; last_direction: string | null }>(
    `SELECT c.*, ct.name AS contact_name, ct.phone AS contact_phone,
            (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
            (SELECT direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_direction
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.business_id = ? AND c.status = ?
        AND (? = '' OR ct.name LIKE ? OR ct.phone LIKE ? OR ct.email LIKE ?)
      ORDER BY c.last_message_at DESC
      LIMIT 200`,
    businessId, status, q, `%${q}%`, `%${q}%`, `%${q}%`,
  );

  res.json({
    conversations: rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      status: r.status,
      unreadCount: r.unread_count,
      lastMessageAt: r.last_message_at,
      lastMessage: r.last_body,
      lastDirection: r.last_direction,
      contactName: r.contact_name,
      contactPhone: r.contact_phone,
      online: isVisitorOnline(r.id),
    })),
  });
});

function loadConversation(businessId: string, id: string) {
  return get<Conversation>('SELECT * FROM conversations WHERE id = ? AND business_id = ?', id, businessId);
}

inboxRouter.get('/conversations/:id', (req, res) => {
  const { businessId } = req.session!;
  const conversation = loadConversation(businessId, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  if (conversation.unread_count > 0) {
    run('UPDATE conversations SET unread_count = 0 WHERE id = ?', conversation.id);
    publish(`biz:${businessId}`, { type: 'read', conversationId: conversation.id });
  }

  const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', conversation.contact_id)!;
  const messages = all<Message & { author_name: string | null }>(
    `SELECT m.*, u.name AS author_name FROM messages m LEFT JOIN users u ON u.id = m.author_id
      WHERE m.conversation_id = ? ORDER BY m.created_at`,
    conversation.id,
  );
  res.json({
    conversation: {
      id: conversation.id,
      channel: conversation.channel,
      status: conversation.status,
      pageUrl: conversation.page_url,
      createdAt: conversation.created_at,
      online: isVisitorOnline(conversation.id),
      contact: { id: contact.id, name: contact.name, phone: contact.phone, email: contact.email },
    },
    messages,
  });
});

inboxRouter.post('/conversations/:id/messages', async (req, res) => {
  const { businessId, userId } = req.session!;
  const conversation = loadConversation(businessId, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const body = String(req.body.body ?? '').trim();
  const channel = req.body.channel === 'sms' ? 'sms' : 'webchat';
  if (!body) return res.status(400).json({ error: 'Message is empty' });
  if (body.length > 1600) return res.status(400).json({ error: 'Message is too long (1600 characters max)' });

  if (channel === 'sms') {
    const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
    const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', conversation.contact_id)!;
    if (!smsConfigured() || !business.sms_number) return res.status(400).json({ error: 'Texting is not set up. Add your SMS number in Settings.' });
    if (!contact.phone) return res.status(400).json({ error: 'This contact has no mobile number' });
    try {
      await sendSms(business.sms_number, contact.phone, body);
    } catch (err) {
      return res.status(502).json({ error: `Text not sent: ${(err as Error).message}` });
    }
  } else if (conversation.channel === 'sms' && !conversation.visitor_token) {
    return res.status(400).json({ error: 'This customer texted in, so reply by text' });
  }

  const message = insertMessage(conversation, 'out', channel, body, userId);
  const author = get<{ name: string }>('SELECT name FROM users WHERE id = ?', userId);
  const full = { ...message, author_name: author?.name ?? null };
  publish(`biz:${businessId}`, { type: 'message', conversationId: conversation.id, message: full });
  publish(`conv:${conversation.id}`, {
    type: 'message',
    message: { id: message.id, direction: 'out', body: message.body, created_at: message.created_at },
  });
  res.status(201).json({ message: full });
});

inboxRouter.patch('/conversations/:id', (req, res) => {
  const { businessId } = req.session!;
  const conversation = loadConversation(businessId, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const status = req.body.status;
  if (status !== 'open' && status !== 'closed') return res.status(400).json({ error: 'Status must be open or closed' });
  run('UPDATE conversations SET status = ? WHERE id = ?', status, conversation.id);
  publish(`biz:${businessId}`, { type: 'status', conversationId: conversation.id, status });
  res.json({ ok: true });
});

inboxRouter.get('/stream', (req, res) => {
  subscribe(`biz:${req.session!.businessId}`, req, res);
});
