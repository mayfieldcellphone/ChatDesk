import { Router, type Request, type Response } from 'express';
import { Readable } from 'node:stream';
import {
  all, get, insertMessage, newId, normalizePhone, now, run,
  type Business, type Channel, type Contact, type Conversation, type Message, type SavedReply, type Tag, type Faq,
} from './db';
import { isVisitorOnline, publish, subscribe } from './events';
import { requireAuth } from './auth';
import { isOpen, parseHours, validateHours, validTimezone } from './hours';
import { emailConfigured, replyAddress } from './notify';
import { aiConfigured, AiError, suggestReply } from './ai';
import { rateLimit } from './rateLimit';
import { fetchRecording, makeCall, smsConfigured, twiml } from './twilio';
import { defaultChannel, DeliveryError, replyChannels, sendToCustomer } from './outbound';
import { reviewLink } from './google';
import { proposeFromWebsite, WebsiteError } from './website';
import { normalizeRepairbillUrl, sendLead } from './repairbill';
import { leadToken } from './leads';
import { assistantPausedNow, decide, faqNeedsEditing, parseTable } from './assistant';
import { pushPublicKey, pushToBusiness } from './push';
import { createBusiness, setSession } from './auth';
import { isAdmin } from './config';

// Authenticated API for the team inbox. Every query is scoped to the signed-in user's business.
export const inboxRouter = Router();
inboxRouter.use(requireAuth);

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const CHANNELS: Channel[] = ['webchat', 'sms', 'facebook', 'instagram', 'email'];

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
    forwardNumber: b.forward_number,
    ringSeconds: b.ring_seconds,
    voicemailGreeting: b.voicemail_greeting,
    missedCallTextEnabled: Boolean(b.missed_call_text_enabled),
    missedCallText: b.missed_call_text,
    reviewLink: b.review_link,
    reviewLinkEffective: reviewLink(b),
    reviewRequestText: b.review_request_text,
    websiteUrl: b.website_url,
    websiteImportedAt: b.website_imported_at,
    widgetPosition: b.widget_position,
    widgetOffsetX: b.widget_offset_x,
    widgetOffsetY: b.widget_offset_y,
    widgetQuote: Boolean(b.widget_quote),
    widgetCallback: Boolean(b.widget_callback),
    widgetCallNumber: b.widget_call_number,
    repairbillUrl: b.repairbill_url,
    // The key is in the site's HTML anyway, but there's no need to show it again in full.
    repairbillKeyHint: b.repairbill_key ? `••••${b.repairbill_key.slice(-4)}` : null,
    repairbillLastSentAt: b.repairbill_last_sent_at,
    repairbillLastError: b.repairbill_last_error,
    replyEmail: b.reply_email,
    assistantMode: b.assistant_mode,
    assistantHandoff: b.assistant_handoff,
    bookingReplyEnabled: Boolean(b.booking_reply_enabled),
    bookingReplyText: b.booking_reply_text,
    // Where a website's own server posts its forms (bookings, quotes) so they land in the inbox.
    leadsUrl: `${(process.env.PUBLIC_URL || '').replace(/\/$/, '')}/api/leads/${leadToken(b)}`,
    replyEmailEffective: replyAddress(b),
  };
}

const loadBusiness = (id: string) => get<Business>('SELECT * FROM businesses WHERE id = ?', id)!;

inboxRouter.get('/me', (req, res) => {
  const { userId, businessId } = req.session!;
  const user = get<{ id: string; name: string; email: string; notify_email: number; phone: string | null }>(
    'SELECT id, name, email, notify_email, phone FROM users WHERE id = ?',
    userId,
  )!;
  const businesses = all<{ id: string; name: string; color: string; unread: number }>(
    `SELECT b.id, b.name, b.color,
            (SELECT COALESCE(SUM(c.unread_count), 0) FROM conversations c WHERE c.business_id = b.id AND c.status = 'open') AS unread
       FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = ? ORDER BY b.created_at`,
    userId,
  );
  res.json({
    businesses,
    user: { id: user.id, name: user.name, email: user.email, notifyEmail: Boolean(user.notify_email), phone: user.phone, isAdmin: isAdmin(user.id) },
    business: publicBusiness(loadBusiness(businessId)),
  });
});

// Adds another business (e.g. another website) to this login and switches to it.
inboxRouter.post('/businesses', (req, res) => {
  const { userId } = req.session!;
  const name = String(req.body.name ?? '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'Enter the business name' });
  if ((get<{ n: number }>('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?', userId)?.n ?? 0) >= 25) {
    return res.status(400).json({ error: 'You can run up to 25 businesses from one login' });
  }
  const website = String(req.body.website ?? '').trim().slice(0, 500) || null;
  const businessId = createBusiness(userId, name, website);
  run('UPDATE users SET business_id = ? WHERE id = ?', businessId, userId);
  setSession(res, { userId, businessId });
  res.status(201).json({ businessId });
});

// ---------- Push notifications ----------

inboxRouter.get('/push/key', (_req, res) => res.json({ publicKey: pushPublicKey() }));

inboxRouter.post('/push/subscribe', (req, res) => {
  const sub = req.body.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    return res.status(400).json({ error: 'Invalid push subscription' });
  }
  // A device belongs to whoever subscribed it last.
  run('DELETE FROM push_subscriptions WHERE endpoint = ?', sub.endpoint);
  run(
    'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId(), req.session!.userId, sub.endpoint.slice(0, 1000), sub.keys.p256dh.slice(0, 200), sub.keys.auth.slice(0, 100), now(),
  );
  res.status(201).json({ ok: true });
});

inboxRouter.delete('/push/subscribe', (req, res) => {
  run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', String(req.body.endpoint ?? ''), req.session!.userId);
  res.json({ ok: true });
});

inboxRouter.post('/push/test', rateLimit('push-test', 10, 10 * 60 * 1000), async (req, res) => {
  const { businessId } = req.session!;
  const business = loadBusiness(businessId);
  await pushToBusiness(businessId, { title: `ChatBird · ${business.name}`, body: 'Notifications are working 🎉', url: '/', tag: 'test' });
  res.json({ ok: true });
});

inboxRouter.patch('/me', (req, res) => {
  const { userId } = req.session!;
  if (req.body.notifyEmail !== undefined) {
    if (typeof req.body.notifyEmail !== 'boolean') return res.status(400).json({ error: 'notifyEmail must be true or false' });
    run('UPDATE users SET notify_email = ? WHERE id = ?', req.body.notifyEmail ? 1 : 0, userId);
  }
  if (req.body.phone !== undefined) {
    const phone = req.body.phone ? normalizePhone(String(req.body.phone)) : null;
    if (req.body.phone && !phone) return res.status(400).json({ error: 'Enter a valid mobile number' });
    run('UPDATE users SET phone = ? WHERE id = ?', phone, userId);
  }
  res.json({ ok: true });
});

// Reads the business's website and proposes settings for the owner to review. Saves only the URL.
inboxRouter.post('/business/website', rateLimit('website-import', 10, 60 * 60 * 1000), async (req, res) => {
  const { businessId } = req.session!;
  const url = String(req.body.url ?? '').trim().slice(0, 500);
  if (!url) return res.status(400).json({ error: 'Enter your website address' });
  try {
    const result = await proposeFromWebsite(url);
    run('UPDATE businesses SET website_url = ? WHERE id = ?', result.pages[0], businessId);
    res.json(result);
  } catch (err) {
    if (err instanceof WebsiteError) return res.status(400).json({ error: err.message });
    const timedOut = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
    console.error('Website import failed:', err);
    res.status(502).json({ error: timedOut ? 'The website took too long to respond. Try again.' : 'Couldn’t read that website. Check the address and try again.' });
  }
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
  const voicemailGreeting = text(b.voicemailGreeting, business.voicemail_greeting, 500);
  const missedCallText = text(b.missedCallText, business.missed_call_text, 320);
  const reviewRequestText = text(b.reviewRequestText, business.review_request_text, 500);
  const reviewLinkValue = b.reviewLink === undefined ? business.review_link : String(b.reviewLink).trim() || null;
  if (reviewLinkValue && !/^https:\/\/\S+$/.test(reviewLinkValue)) return res.status(400).json({ error: 'The review link must start with https://' });
  const missedCallTextEnabled =
    b.missedCallTextEnabled === undefined ? business.missed_call_text_enabled : b.missedCallTextEnabled ? 1 : 0;
  const ringSeconds = b.ringSeconds === undefined ? business.ring_seconds : Math.round(Number(b.ringSeconds));
  if (!Number.isFinite(ringSeconds) || ringSeconds < 5 || ringSeconds > 60) {
    return res.status(400).json({ error: 'Ring time must be between 5 and 60 seconds' });
  }

  let forwardNumber = business.forward_number;
  if (b.forwardNumber !== undefined) {
    forwardNumber = b.forwardNumber ? normalizePhone(String(b.forwardNumber)) : null;
    if (b.forwardNumber && !forwardNumber) return res.status(400).json({ error: 'Enter a valid number to ring' });
  }

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
  if (!voicemailGreeting) return res.status(400).json({ error: 'Voicemail greeting is required' });
  if (!missedCallText) return res.status(400).json({ error: 'Missed-call text is required' });
  if (!reviewRequestText.includes('{link}')) return res.status(400).json({ error: 'The review request needs {link} where the review link goes' });
  if (forwardNumber && forwardNumber === smsNumber) {
    return res.status(400).json({ error: 'The number to ring can’t be your Twilio number itself' });
  }
  if (!HEX_COLOR.test(color)) return res.status(400).json({ error: 'Colour must be a hex value like #2563eb' });
  if (!validTimezone(timezone)) return res.status(400).json({ error: 'Unknown timezone' });
  if (smsNumber && get('SELECT id FROM businesses WHERE sms_number = ? AND id != ?', smsNumber, businessId)) {
    return res.status(409).json({ error: 'That SMS number is already used by another business' });
  }

  const widget = readWidgetSettings(b, business);
  if ('error' in widget) return res.status(400).json({ error: widget.error });

  // Validate everything before writing anything, so a rejected save changes nothing.
  const bookingReplyEnabled = b.bookingReplyEnabled === undefined ? business.booking_reply_enabled : b.bookingReplyEnabled ? 1 : 0;
  const bookingReplyText = text(b.bookingReplyText, business.booking_reply_text, 600);
  if (!bookingReplyText) return res.status(400).json({ error: 'The booking reply needs some text' });
  const assistantMode = b.assistantMode === undefined ? business.assistant_mode : b.assistantMode;
  if (!['off', 'always', 'after_hours', 'no_reply'].includes(assistantMode)) return res.status(400).json({ error: 'Choose when the assistant answers' });
  const assistantHandoff = text(b.assistantHandoff, business.assistant_handoff, 500);
  if (!assistantHandoff) return res.status(400).json({ error: 'The assistant’s holding message needs some text' });
  let replyEmail = business.reply_email;
  if (b.replyEmail !== undefined) {
    replyEmail = String(b.replyEmail ?? '').trim().toLowerCase().slice(0, 200) || null;
    if (replyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyEmail)) return res.status(400).json({ error: 'Enter a valid email address for replies' });
  }

  if (b.websiteImported === true) run('UPDATE businesses SET website_imported_at = ? WHERE id = ?', now(), businessId);
  run(
    'UPDATE businesses SET booking_reply_enabled = ?, booking_reply_text = ?, reply_email = ?, assistant_mode = ?, assistant_handoff = ? WHERE id = ?',
    bookingReplyEnabled, bookingReplyText, replyEmail, assistantMode, assistantHandoff, businessId,
  );
  run(
    `UPDATE businesses SET widget_position = ?, widget_offset_x = ?, widget_offset_y = ?, widget_quote = ?, widget_callback = ?,
       widget_call_number = ?, repairbill_url = ?, repairbill_key = ? WHERE id = ?`,
    widget.position, widget.offsetX, widget.offsetY, widget.quote, widget.callback, widget.callNumber,
    widget.repairbillUrl, widget.repairbillKey, businessId,
  );
  if (widget.repairbillUrl !== business.repairbill_url || widget.repairbillKey !== business.repairbill_key) {
    run('UPDATE businesses SET repairbill_last_sent_at = NULL, repairbill_last_error = NULL WHERE id = ?', businessId);
  }
  run(
    `UPDATE businesses SET name = ?, greeting = ?, color = ?, sms_number = ?, hours_enabled = ?, timezone = ?,
       hours = ?, away_message = ?, ai_notes = ?, forward_number = ?, ring_seconds = ?, voicemail_greeting = ?,
       missed_call_text_enabled = ?, missed_call_text = ?, review_link = ?, review_request_text = ? WHERE id = ?`,
    name, greeting, color, smsNumber, hoursEnabled, timezone, hours, awayMessage, aiNotes,
    forwardNumber, ringSeconds, voicemailGreeting, missedCallTextEnabled, missedCallText, reviewLinkValue, reviewRequestText, businessId,
  );
  res.json({ business: publicBusiness(loadBusiness(businessId)) });
});

/** Widget placement, menu and RepairBill forwarding fields of PATCH /business. Missing fields keep their value. */
function readWidgetSettings(b: Record<string, unknown>, business: Business) {
  const position = b.widgetPosition === undefined ? business.widget_position : b.widgetPosition;
  if (position !== 'left' && position !== 'right') return { error: 'Position must be left or right' };
  const offset = (value: unknown, current: number) => (value === undefined ? current : Math.round(Number(value)));
  const offsetX = offset(b.widgetOffsetX, business.widget_offset_x);
  const offsetY = offset(b.widgetOffsetY, business.widget_offset_y);
  if (![offsetX, offsetY].every((n) => Number.isFinite(n) && n >= 0 && n <= 400)) {
    return { error: 'Distances must be between 0 and 400 pixels' };
  }
  const flag = (value: unknown, current: number) => (value === undefined ? current : value ? 1 : 0);

  let callNumber = business.widget_call_number;
  if (b.widgetCallNumber !== undefined) {
    callNumber = String(b.widgetCallNumber ?? '').trim().slice(0, 30) || null;
    if (callNumber && !/^\+?[\d\s()-]{6,}$/.test(callNumber)) return { error: 'Enter the phone number for “Call us”, e.g. 02 4968 1234' };
  }

  let repairbillUrl = business.repairbill_url;
  if (b.repairbillUrl !== undefined) {
    const raw = String(b.repairbillUrl ?? '').trim();
    repairbillUrl = raw ? normalizeRepairbillUrl(raw) : null;
    if (raw && !repairbillUrl) return { error: 'Enter your RepairBill address, e.g. https://repairbill.shop' };
  }
  // An empty key keeps the saved one; disconnecting clears the address and key together.
  let repairbillKey = business.repairbill_key;
  if (typeof b.repairbillKey === 'string' && b.repairbillKey.trim()) repairbillKey = b.repairbillKey.trim().slice(0, 200);
  if (!repairbillUrl) repairbillKey = null;
  if (repairbillUrl && !repairbillKey) return { error: 'Paste the widget API key from RepairBill → Settings' };

  return {
    position, offsetX, offsetY, callNumber, repairbillUrl, repairbillKey,
    quote: flag(b.widgetQuote, business.widget_quote),
    callback: flag(b.widgetCallback, business.widget_callback),
  };
}

/** New private address for website forms; the old one stops working. */
inboxRouter.post('/business/lead-token', (req, res) => {
  const { businessId } = req.session!;
  run('UPDATE businesses SET lead_token = NULL WHERE id = ?', businessId);
  res.json({ business: publicBusiness(loadBusiness(businessId)) });
});

/** Sends a sample enquiry to RepairBill so the owner can see it arrive. */
inboxRouter.post('/business/repairbill/test', async (req, res) => {
  const business = loadBusiness(req.session!.businessId);
  if (!business.repairbill_url || !business.repairbill_key) return res.status(400).json({ error: 'Save your RepairBill address and key first' });
  try {
    await sendLead(business, {
      type: 'contact', name: 'ChatBird test', phone: null, email: null, pageUrl: null,
      message: `Test from ChatBird: website enquiries for ${business.name} will arrive here.`,
    });
    res.json({ business: publicBusiness(loadBusiness(business.id)) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// ---------- FAQs (what the AI assistant answers from) ----------

const publicFaq = (f: Faq) => ({ id: f.id, question: f.question, answer: f.answer, needsEditing: faqNeedsEditing(f) });

function readFaq(body: Record<string, unknown>) {
  const question = String(body.question ?? '').trim().slice(0, 300);
  const answer = String(body.answer ?? '').trim().slice(0, 2000);
  if (!question || !answer) return { error: 'Each FAQ needs a question and an answer' };
  return { question, answer };
}

inboxRouter.get('/faqs', (req, res) => {
  const rows = all<Faq>('SELECT * FROM faqs WHERE business_id = ? ORDER BY created_at', req.session!.businessId);
  res.json({ faqs: rows.map(publicFaq) });
});

inboxRouter.post('/faqs', (req, res) => {
  const faq = readFaq(req.body);
  if ('error' in faq) return res.status(400).json({ error: faq.error });
  const row: Faq = { id: newId(), business_id: req.session!.businessId, ...faq, created_at: now() };
  run('INSERT INTO faqs (id, business_id, question, answer, created_at) VALUES (?, ?, ?, ?, ?)', row.id, row.business_id, row.question, row.answer, row.created_at);
  res.status(201).json({ faq: publicFaq(row) });
});

inboxRouter.patch('/faqs/:id', (req, res) => {
  const current = get<Faq>('SELECT * FROM faqs WHERE id = ? AND business_id = ?', req.params.id, req.session!.businessId);
  if (!current) return res.status(404).json({ error: 'FAQ not found' });
  const faq = readFaq({ question: current.question, answer: current.answer, ...req.body });
  if ('error' in faq) return res.status(400).json({ error: faq.error });
  run('UPDATE faqs SET question = ?, answer = ? WHERE id = ?', faq.question, faq.answer, current.id);
  res.json({ faq: publicFaq({ ...current, ...faq }) });
});

inboxRouter.delete('/faqs/:id', (req, res) => {
  run('DELETE FROM faqs WHERE id = ? AND business_id = ?', req.params.id, req.session!.businessId);
  res.json({ ok: true });
});

/** Adds FAQs from a CSV or a paste from Excel (Question, Answer columns). Skips the header and exact duplicates. */
inboxRouter.post('/faqs/import', (req, res) => {
  const { businessId } = req.session!;
  const rows = parseTable(String(req.body.text ?? '').slice(0, 500_000));
  if (rows.length && /question/i.test(rows[0][0] ?? '') && /answer/i.test(rows[0][1] ?? '')) rows.shift();
  const existing = new Set(all<Faq>('SELECT * FROM faqs WHERE business_id = ?', businessId).map((f) => f.question.trim().toLowerCase()));
  let added = 0;
  let skipped = 0;
  const t = now();
  for (const [i, r] of rows.entries()) {
    const faq = readFaq({ question: r[0], answer: r[1] });
    if ('error' in faq || existing.has(faq.question.toLowerCase())) {
      skipped++;
      continue;
    }
    existing.add(faq.question.toLowerCase());
    // Keep the file's order: created_at increases row by row.
    run('INSERT INTO faqs (id, business_id, question, answer, created_at) VALUES (?, ?, ?, ?, ?)', newId(), businessId, faq.question, faq.answer, new Date(Date.parse(t) + i).toISOString());
    added++;
  }
  res.json({ added, skipped });
});

/** Shows what the assistant would reply to a question, without sending anything. */
inboxRouter.post('/assistant/test', rateLimit('assistant-test', 30, 10 * 60 * 1000), async (req, res) => {
  const business = loadBusiness(req.session!.businessId);
  const question = String(req.body.question ?? '').trim().slice(0, 1000);
  if (!question) return res.status(400).json({ error: 'Type a question to try' });
  if (!aiConfigured()) return res.status(400).json({ error: 'Add ANTHROPIC_API_KEY under Integrations → Server keys first' });
  try {
    const decision = await decide(business, 'Test customer', [{ direction: 'in', body: question, automated: 0 }]);
    res.json({ action: decision.action, reply: decision.action === 'answer' ? decision.reply : business.assistant_handoff });
  } catch (err) {
    console.error('Assistant test failed:', err);
    res.status(502).json({ error: 'The AI service had a problem. Check the Anthropic key, then try again.' });
  }
});

// ---------- Tags ----------
// Internal labels for the team. Only these logged-in routes ever read them; nothing customer-facing does.

const publicTag = (t: Pick<Tag, 'id' | 'name' | 'color'>) => ({ id: t.id, name: t.name, color: t.color });

/** Each conversation's tags, alphabetical. */
function tagsByConversation(conversationIds: string[]) {
  const map = new Map<string, ReturnType<typeof publicTag>[]>();
  if (conversationIds.length === 0) return map;
  const rows = all<Tag & { conversation_id: string }>(
    `SELECT t.*, x.conversation_id FROM conversation_tags x JOIN tags t ON t.id = x.tag_id
      WHERE x.conversation_id IN (${conversationIds.map(() => '?').join(', ')}) ORDER BY t.name COLLATE NOCASE`,
    ...conversationIds,
  );
  for (const r of rows) map.set(r.conversation_id, [...(map.get(r.conversation_id) ?? []), publicTag(r)]);
  return map;
}

const loadTag = (businessId: string, id: string) => get<Tag>('SELECT * FROM tags WHERE id = ? AND business_id = ?', id, businessId);

/** Validates a tag's name and colour; missing fields keep the current tag's values. */
function readTag(body: Record<string, unknown>, businessId: string, current?: Tag) {
  const name = body.name === undefined && current ? current.name : String(body.name ?? '').trim().replace(/\s+/g, ' ');
  const color = body.color === undefined && current ? current.color : String(body.color ?? '').trim().toLowerCase();
  if (!name) return { error: 'Give the tag a name' };
  if (name.length > 30) return { error: 'Tag names can be up to 30 characters' };
  if (!HEX_COLOR.test(color)) return { error: 'Colour must be a hex value like #2563eb' };
  const clash = get<{ id: string }>('SELECT id FROM tags WHERE business_id = ? AND name = ? COLLATE NOCASE AND id != ?', businessId, name, current?.id ?? '');
  if (clash) return { error: `There's already a tag called “${name}”` };
  return { name, color };
}

inboxRouter.get('/tags', (req, res) => {
  const { businessId } = req.session!;
  const rows = all<Tag & { uses: number }>(
    `SELECT t.*, (SELECT COUNT(*) FROM conversation_tags x WHERE x.tag_id = t.id) AS uses
       FROM tags t WHERE t.business_id = ? ORDER BY t.name COLLATE NOCASE`,
    businessId,
  );
  res.json({ tags: rows.map((t) => ({ ...publicTag(t), uses: t.uses })) });
});

inboxRouter.post('/tags', (req, res) => {
  const { businessId } = req.session!;
  const tag = readTag(req.body, businessId);
  if ('error' in tag) return res.status(400).json({ error: tag.error });
  const id = newId();
  run('INSERT INTO tags (id, business_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)', id, businessId, tag.name, tag.color, now());
  publish(`biz:${businessId}`, { type: 'tags' });
  res.status(201).json({ tag: { id, ...tag, uses: 0 } });
});

inboxRouter.patch('/tags/:id', (req, res) => {
  const { businessId } = req.session!;
  const current = loadTag(businessId, req.params.id);
  if (!current) return res.status(404).json({ error: 'Tag not found' });
  const tag = readTag(req.body, businessId, current);
  if ('error' in tag) return res.status(400).json({ error: tag.error });
  run('UPDATE tags SET name = ?, color = ? WHERE id = ?', tag.name, tag.color, current.id);
  publish(`biz:${businessId}`, { type: 'tags' });
  res.json({ tag: { id: current.id, ...tag } });
});

/** Deletes the tag; it comes off every conversation with it (ON DELETE CASCADE). */
inboxRouter.delete('/tags/:id', (req, res) => {
  const { businessId } = req.session!;
  const tag = loadTag(businessId, req.params.id);
  if (!tag) return res.status(404).json({ error: 'Tag not found' });
  const removedFrom = get<{ n: number }>('SELECT COUNT(*) AS n FROM conversation_tags WHERE tag_id = ?', tag.id)!.n;
  run('DELETE FROM tags WHERE id = ?', tag.id);
  publish(`biz:${businessId}`, { type: 'tags' });
  res.json({ ok: true, removedFrom });
});

function changeConversationTag(add: boolean) {
  return (req: Request, res: Response) => {
    const { businessId } = req.session!;
    const conversation = loadConversation(businessId, req.params.id);
    const tag = loadTag(businessId, req.params.tagId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!tag) return res.status(404).json({ error: 'Tag not found' });
    if (add) {
      run('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id, created_at) VALUES (?, ?, ?)', conversation.id, tag.id, now());
    } else {
      run('DELETE FROM conversation_tags WHERE conversation_id = ? AND tag_id = ?', conversation.id, tag.id);
    }
    publish(`biz:${businessId}`, { type: 'tags', conversationId: conversation.id });
    res.json({ tags: tagsByConversation([conversation.id]).get(conversation.id) ?? [] });
  };
}
inboxRouter.put('/conversations/:id/tags/:tagId', changeConversationTag(true));
inboxRouter.delete('/conversations/:id/tags/:tagId', changeConversationTag(false));

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
  // scope=all lists every business this login runs; otherwise just the open one.
  const businessIds =
    req.query.scope === 'all'
      ? all<{ business_id: string }>('SELECT business_id FROM memberships WHERE user_id = ?', req.session!.userId).map((m) => m.business_id)
      : [businessId];
  const placeholders = businessIds.map(() => '?').join(', ');
  // ?tags=id1,id2 keeps conversations that have every one of those tags.
  const tagIds = (typeof req.query.tags === 'string' ? req.query.tags.split(',') : []).map((t) => t.trim()).filter(Boolean).slice(0, 10);
  const tagFilter = tagIds.map(() => ' AND EXISTS (SELECT 1 FROM conversation_tags x WHERE x.conversation_id = c.id AND x.tag_id = ?)').join('');

  const rows = all<Conversation & { contact_name: string; contact_phone: string | null; last_body: string | null; last_direction: string | null; last_automated: number | null; business_name: string; business_color: string }>(
    `SELECT c.*, ct.name AS contact_name, ct.phone AS contact_phone, b.name AS business_name, b.color AS business_color,
            (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
            (SELECT direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_direction,
            (SELECT automated FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_automated
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN businesses b ON b.id = c.business_id
      WHERE c.business_id IN (${placeholders}) AND c.status = ?
        AND (? = '' OR ct.name LIKE ? OR ct.phone LIKE ? OR ct.email LIKE ?)${tagFilter}
      ORDER BY c.last_message_at DESC
      LIMIT 200`,
    ...businessIds, status, q, `%${q}%`, `%${q}%`, `%${q}%`, ...tagIds,
  );
  const tags = tagsByConversation(rows.map((r) => r.id));

  res.json({
    conversations: rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      status: r.status,
      unreadCount: r.unread_count,
      lastMessageAt: r.last_message_at,
      lastMessage: r.last_body,
      lastDirection: r.last_direction,
      lastAutomated: r.last_automated ?? 0,
      contactName: r.contact_name,
      contactPhone: r.contact_phone,
      businessId: r.business_id,
      businessName: r.business_name,
      businessColor: r.business_color,
      online: isVisitorOnline(r.id),
      tags: tags.get(r.id) ?? [],
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
      replyChannels: replyChannels(loadBusiness(businessId), conversation, contact),
      defaultChannel: defaultChannel(loadBusiness(businessId), conversation, contact),
      tags: tagsByConversation([conversation.id]).get(conversation.id) ?? [],
      assistantPaused: assistantPausedNow(conversation.id),
      // Paused because staff replied (it comes back by itself) rather than switched off here.
      assistantPausedByReply: conversation.assistant_paused === 2,
    },
    messages: loadMessages(conversation.id),
  });
});

inboxRouter.post('/conversations/:id/messages', async (req, res) => {
  const { businessId, userId } = req.session!;
  const conversation = loadConversation(businessId, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const body = String(req.body.body ?? '').trim();
  const channel = String(req.body.channel ?? '') as Channel;
  if (!body) return res.status(400).json({ error: 'Message is empty' });
  if (body.length > 1600) return res.status(400).json({ error: 'Message is too long (1600 characters max)' });
  if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'Choose how to send the reply' });

  const author = get<{ name: string }>('SELECT name FROM users WHERE id = ?', userId);
  try {
    const message = await sendToCustomer(loadBusiness(businessId), conversation, channel, body, { authorId: userId, authorName: author?.name ?? null });
    // A person has stepped in: the assistant leaves this conversation to them for 30 minutes after
    // their last message. A manual pause (1) stays as it is.
    run('UPDATE conversations SET assistant_paused = 2 WHERE id = ? AND assistant_paused != 1', conversation.id);
    res.status(201).json({ message });
  } catch (err) {
    if (err instanceof DeliveryError) return res.status(err.message.includes('not sent') ? 502 : 400).json({ error: err.message });
    console.error('Reply failed:', err);
    res.status(500).json({ error: 'Could not send the reply. Try again.' });
  }
});

// Texts or messages the customer your Google review link (Birdeye's "review request").
inboxRouter.post('/conversations/:id/review-request', async (req, res) => {
  const { businessId, userId } = req.session!;
  const conversation = loadConversation(businessId, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const business = loadBusiness(businessId);
  const link = reviewLink(business);
  if (!link) return res.status(400).json({ error: 'Connect your Google Business Profile, or add your review link on the Reviews page.' });

  const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', conversation.contact_id)!;
  const channel = CHANNELS.includes(req.body.channel) ? (req.body.channel as Channel) : defaultChannel(business, conversation, contact);
  if (!channel) return res.status(400).json({ error: 'There’s no way to message this customer.' });
  const first = contact.name.trim().split(/\s+/)[0];
  const body = business.review_request_text
    .replace(/\{name\}/gi, /^\+?\d[\d\s]+$/.test(first) ? 'there' : first)
    .replace(/\{business\}/gi, business.name)
    .replace(/\{link\}/gi, link);
  const author = get<{ name: string }>('SELECT name FROM users WHERE id = ?', userId);
  try {
    const message = await sendToCustomer(business, conversation, channel, body, { authorId: userId, authorName: author?.name ?? null });
    res.status(201).json({ message });
  } catch (err) {
    if (err instanceof DeliveryError) return res.status(400).json({ error: err.message });
    console.error('Review request failed:', err);
    res.status(500).json({ error: 'Could not send the review request. Try again.' });
  }
});

inboxRouter.patch('/contacts/:id', (req, res) => {
  const { businessId } = req.session!;
  const contact = get<Contact>('SELECT * FROM contacts WHERE id = ? AND business_id = ?', req.params.id, businessId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  // Each field is optional; an empty phone or email removes it.
  const name = req.body.name === undefined ? contact.name : String(req.body.name).trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  let phone = contact.phone;
  if (req.body.phone !== undefined) {
    phone = String(req.body.phone).trim() ? normalizePhone(String(req.body.phone)) : null;
    if (String(req.body.phone).trim() && !phone) return res.status(400).json({ error: 'Enter a valid phone number' });
  }
  let email = contact.email;
  if (req.body.email !== undefined) {
    email = String(req.body.email).trim().toLowerCase().slice(0, 200) || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  }
  run('UPDATE contacts SET name = ?, phone = ?, email = ? WHERE id = ?', name, phone, email, contact.id);
  publish(`biz:${businessId}`, { type: 'contact', contactId: contact.id });
  res.json({ contact: { id: contact.id, name, phone, email } });
});

// Click-to-call: Twilio rings the staff member's phone, then connects them to the customer, who
// sees the business number as caller ID.
inboxRouter.post('/conversations/:id/call', async (req, res) => {
  const { businessId, userId } = req.session!;
  const conversation = loadConversation(businessId, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const business = loadBusiness(businessId);
  const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', conversation.contact_id)!;
  const user = get<{ name: string; phone: string | null }>('SELECT name, phone FROM users WHERE id = ?', userId)!;
  const staffPhone = user.phone || business.forward_number;
  if (!smsConfigured() || !business.sms_number) return res.status(400).json({ error: 'Calling is not set up. Add your Twilio number in Settings.' });
  if (!contact.phone) return res.status(400).json({ error: 'This contact has no phone number' });
  if (!staffPhone) return res.status(400).json({ error: 'Add your mobile number under Settings → Phone calls so we know which phone to ring.' });

  try {
    await makeCall(
      business.sms_number,
      staffPhone,
      twiml`<Say>Connecting you to ${contact.name}.</Say><Dial callerId="${business.sms_number}"><Number>${contact.phone}</Number></Dial>`,
    );
  } catch (err) {
    return res.status(502).json({ error: `Call not started: ${(err as Error).message}` });
  }

  const message = insertMessage(conversation, 'out', 'sms', `${user.name} called ${contact.name} back`, { authorId: userId, kind: 'call' });
  const full = { ...message, author_name: user.name };
  publish(`biz:${businessId}`, { type: 'message', conversationId: conversation.id, message: full });
  res.status(201).json({ message: full, ringing: staffPhone });
});

// Streams a voicemail's audio from Twilio, so recordings stay private to signed-in staff.
inboxRouter.get('/recordings/:messageId', async (req, res) => {
  const message = get<{ recording_sid: string | null }>(
    `SELECT m.recording_sid FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = ? AND c.business_id = ? AND m.kind = 'voicemail'`,
    req.params.messageId, req.session!.businessId,
  );
  if (!message?.recording_sid) return res.status(404).json({ error: 'Recording not found' });
  if (!smsConfigured()) return res.status(503).json({ error: 'Twilio is not configured' });

  try {
    const upstream = await fetchRecording(message.recording_sid, req.get('Range'));
    if (!upstream.ok || !upstream.body) return res.status(502).json({ error: 'Could not load the recording from Twilio' });
    res.status(upstream.status);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    for (const header of ['Content-Length', 'Content-Range', 'Accept-Ranges']) {
      const value = upstream.headers.get(header);
      if (value) res.set(header, value);
    }
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res);
  } catch (err) {
    console.error('Recording fetch failed:', err);
    if (!res.headersSent) res.status(502).json({ error: 'Could not load the recording from Twilio' });
  }
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
  if (req.body.assistantPaused !== undefined) {
    run('UPDATE conversations SET assistant_paused = ? WHERE id = ?', req.body.assistantPaused ? 1 : 0, conversation.id);
    if (req.body.status === undefined) return res.json({ ok: true });
  }
  const status = req.body.status;
  if (status !== 'open' && status !== 'closed') return res.status(400).json({ error: 'Status must be open or closed' });
  run('UPDATE conversations SET status = ? WHERE id = ?', status, conversation.id);
  publish(`biz:${businessId}`, { type: 'status', conversationId: conversation.id, status });
  res.json({ ok: true });
});

// One live connection follows every business this login runs, for the combined inbox and alerts.
inboxRouter.get('/stream', (req, res) => {
  const ids = all<{ business_id: string }>('SELECT business_id FROM memberships WHERE user_id = ?', req.session!.userId).map((m) => m.business_id);
  subscribe(ids.map((id) => `biz:${id}`), req, res);
});
