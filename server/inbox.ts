import { Router } from 'express';
import {
  all, get, insertMessage, newId, normalizePhone, now, run,
  type Business, type Contact, type Conversation, type Message, type SavedReply,
} from './db';
import { isVisitorOnline, publish, subscribe } from './events';
import { requireAuth } from './auth';
import { isOpen, parseHours, validateHours, validTimezone } from './hours';
import { emailConfigured } from './notify';
import { aiConfigured, AiError, suggestReply } from './ai';
import { rateLimit } from './rateLimit';
import { sendSms, smsConfigured } from './twilio';

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
    hoursEnabled: Boolean(b.hours_enabled),
    timezone: b.timezone,
    hours: parseHours(b.hours),
    awayMessage: b.away_message,
    openNow: isOpen(b),
    aiNotes: b.ai_notes,
    aiAvailable: aiConfigured(),
    emailAvailable: emailConfigured(),
  };
}

const loadBusiness = (id: string) => get<Business>('SELECT * FROM businesses WHERE id = ?', id)!;

inboxRouter.get('/me', (req, res) => {
  const { userId, businessId } = req.session!;
  const user = get<{ id: string; name: string; email: string; notify_email: number }>(
    'SELECT id, name, email, notify_email FROM users WHERE id = ?',
    userId,
  )!;
  res.json({
    user: { id: user.id, name: user.name, email: user.email, notifyEmail: Boolean(user.notify_email) },
    business: publicBusiness(loadBusiness(businessId)),
  });
});

inboxRouter.patch('/me', (req, res) => {
  if (typeof req.body.notifyEmail !== 'boolean') return res.status(400).json({ error: 'notifyEmail must be true or false' });
  run('UPDATE users SET notify_email = ? WHERE id = ?', req.body.notifyEmail ? 1 : 0, req.session!.userId);
  res.json({ ok: true });
});

inboxRouter.patch('/business', (req, res) => {
  const { businessId } = req.session!;
  const business = loadBusiness(businessId);
  const b = req.body;
  const text = (value: unknown, current: string, max: number) => (value === undefined ? current : String(value).trim().slice(0, max));

  const name = text(b.name, business.name, 100);
  const greeting = text(b.greeting, business.greeting, 300);
  const awayMessage = text(b.awayMessage, business.away_message, 500);
  const aiNotes = text(b.aiNotes, business.ai_notes, 5000);
  const color = b.color === undefined ? business.color : String(b.color);
  const timezone = b.timezone === undefined ? business.timezone : String(b.timezone);
  const hoursEnabled = b.hoursEnabled === undefined ? business.hours_enabled : b.hoursEnabled ? 1 : 0;

  let hours = business.hours;
  if (b.hours !== undefined) {
    const valid = validateHours(b.hours);
    if (!valid) return res.status(400).json({ error: 'Each open day needs an opening time before its closing time' });
    hours = JSON.stringify(valid);
  }

  let smsNumber = business.sms_number;
  if (b.smsNumber !== undefined) {
    smsNumber = b.smsNumber ? normalizePhone(String(b.smsNumber)) : null;
    if (b.smsNumber && !smsNumber) return res.status(400).json({ error: 'Enter the SMS number in +E.164 format, e.g. +61400123456' });
  }

  if (!name) return res.status(400).json({ error: 'Business name is required' });
  if (!greeting) return res.status(400).json({ error: 'Greeting is required' });
  if (!awayMessage) return res.status(400).json({ error: 'Away message is required' });
  if (!HEX_COLOR.test(color)) return res.status(400).json({ error: 'Colour must be a hex value like #2563eb' });
  if (!validTimezone(timezone)) return res.status(400).json({ error: 'Unknown timezone' });
  if (smsNumber && get('SELECT id FROM businesses WHERE sms_number = ? AND id != ?', smsNumber, businessId)) {
    return res.status(409).json({ error: 'That SMS number is already used by another business' });
  }

  run(
    `UPDATE businesses SET name = ?, greeting = ?, color = ?, sms_number = ?, hours_enabled = ?, timezone = ?,
       hours = ?, away_message = ?, ai_notes = ? WHERE id = ?`,
    name, greeting, color, smsNumber, hoursEnabled, timezone, hours, awayMessage, aiNotes, businessId,
  );
  res.json({ business: publicBusiness(loadBusiness(businessId)) });
});

// ---------- Saved replies ----------

const publicReply = (r: SavedReply) => ({ id: r.id, title: r.title, body: r.body });

function readReply(body: Record<string, unknown>) {
  const title = String(body.title ?? '').trim().slice(0, 80);
  const text = String(body.body ?? '').trim().slice(0, 1600);
  return title && text ? { title, body: text } : null;
}

inboxRouter.get('/saved-replies', (req, res) => {
  const replies = all<SavedReply>('SELECT * FROM saved_replies WHERE business_id = ? ORDER BY title COLLATE NOCASE', req.session!.businessId);
  res.json({ savedReplies: replies.map(publicReply) });
});

inboxRouter.post('/saved-replies', (req, res) => {
  const { businessId } = req.session!;
  const input = readReply(req.body);
  if (!input) return res.status(400).json({ error: 'A saved reply needs a title and a message' });
  if ((get<{ n: number }>('SELECT COUNT(*) AS n FROM saved_replies WHERE business_id = ?', businessId)?.n ?? 0) >= 200) {
    return res.status(400).json({ error: 'You can have up to 200 saved replies' });
  }
  const reply: SavedReply = { id: newId(), business_id: businessId, ...input, created_at: now() };
  run('INSERT INTO saved_replies (id, business_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)', reply.id, businessId, reply.title, reply.body, reply.created_at);
  res.status(201).json({ savedReply: publicReply(reply) });
});

inboxRouter.put('/saved-replies/:id', (req, res) => {
  const input = readReply(req.body);
  if (!input) return res.status(400).json({ error: 'A saved reply needs a title and a message' });
  const result = run('UPDATE saved_replies SET title = ?, body = ? WHERE id = ? AND business_id = ?', input.title, input.body, req.params.id, req.session!.businessId);
  if (result.changes === 0) return res.status(404).json({ error: 'Saved reply not found' });
  res.json({ savedReply: { id: req.params.id, ...input } });
});

inboxRouter.delete('/saved-replies/:id', (req, res) => {
  const result = run('DELETE FROM saved_replies WHERE id = ? AND business_id = ?', req.params.id, req.session!.businessId);
  if (result.changes === 0) return res.status(404).json({ error: 'Saved reply not found' });
  res.json({ ok: true });
});

// ---------- Conversations ----------

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

const loadMessages = (conversationId: string) =>
  all<Message & { author_name: string | null }>(
    `SELECT m.*, u.name AS author_name FROM messages m LEFT JOIN users u ON u.id = m.author_id
      WHERE m.conversation_id = ? ORDER BY m.created_at`,
    conversationId,
  );

inboxRouter.get('/conversations/:id', (req, res) => {
  const { businessId } = req.session!;
  const conversation = loadConversation(businessId, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  if (conversation.unread_count > 0) {
    run('UPDATE conversations SET unread_count = 0 WHERE id = ?', conversation.id);
    publish(`biz:${businessId}`, { type: 'read', conversationId: conversation.id });
  }

  const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', conversation.contact_id)!;
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
    messages: loadMessages(conversation.id),
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
    const business = loadBusiness(businessId);
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

// Each suggestion is a paid API call, so keep a lid on how fast one person can request them.
inboxRouter.post('/conversations/:id/suggest', rateLimit('ai-suggest', 30, 10 * 60 * 1000), async (req, res) => {
  const { businessId } = req.session!;
  if (!aiConfigured()) return res.status(400).json({ error: 'AI replies are not set up. Add ANTHROPIC_API_KEY on the server.' });
  const conversation = loadConversation(businessId, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', conversation.contact_id)!;
  const savedReplies = all<SavedReply>('SELECT * FROM saved_replies WHERE business_id = ? ORDER BY title COLLATE NOCASE LIMIT 50', businessId);
  try {
    const suggestion = await suggestReply(loadBusiness(businessId), contact.name, loadMessages(conversation.id), savedReplies);
    res.json({ suggestion });
  } catch (err) {
    if (err instanceof AiError) return res.status(502).json({ error: err.message });
    // Express 4 doesn't catch errors from async handlers, so answer here rather than rethrowing.
    console.error('AI suggestion failed:', err);
    res.status(500).json({ error: 'Could not get a suggestion. Try again.' });
  }
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
