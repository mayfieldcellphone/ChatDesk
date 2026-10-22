import { Router } from 'express';
import crypto from 'node:crypto';
import {
  all, get, insertMessage, newId, normalizePhone, now, run,
  type Business, type Channel, type Contact, type Conversation,
} from './db';
import { requireAuth } from './auth';
import { emailCampaign, emailConfigured } from './notify';
import { reviewLink } from './google';
import { sendSms, smsConfigured, publicUrl } from './twilio';
import { localTime } from './hours';
import { rateLimit } from './rateLimit';

/**
 * Marketing: your customer list (with imports from a phone, Birdeye or RepairBill), and text or email
 * campaigns to it. Built to keep within Australia's Spam Act: every message names the business and
 * has a working opt-out (reply STOP, or the email's unsubscribe link), opted-out customers are never
 * messaged again, and sending only happens 9am–8pm in the business's timezone.
 */
export const marketingRouter = Router();
marketingRouter.use(requireAuth);
export const unsubscribeRouter = Router();

const TICK_MS = Number(process.env.CAMPAIGN_TICK_MS) || 1000;
const SEND_FROM = '09:00';
const SEND_UNTIL = '20:00';
// Nobody gets two campaigns within this many days.
const MIN_GAP_DAYS = 3;
const MAX_IMPORT_ROWS = 2000;

// ---------- Message text ----------

const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;

/** How many texts Twilio bills for a message: 160 plain characters per text, 70 with emoji or curly quotes. */
export function smsSegments(text: string) {
  const gsm = GSM.test(text);
  const length = gsm ? [...text].reduce((n, c) => n + ('^{}\\[~]|€'.includes(c) ? 2 : 1), 0) : [...text].length;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return length <= single ? 1 : Math.ceil(length / multi);
}

/** First name for {name}, or null when all we have is their number. */
export function firstName(contact: Pick<Contact, 'name' | 'phone'>) {
  const first = contact.name.trim().split(/\s+/)[0] ?? '';
  return !first || /^\+?[\d\s()-]+$/.test(first) || first === 'Private' || first === 'Website' ? null : first;
}

function personalise(body: string, business: Business, contact: Pick<Contact, 'name' | 'phone'>) {
  return body
    .replace(/\{name\}/gi, firstName(contact) ?? 'there')
    .replace(/\{business\}/gi, business.name)
    .replace(/\{link\}/gi, reviewLink(business) ?? '');
}

/** The text as sent: says who it's from and how to opt out, unless the owner already wrote that in. */
export function finalSms(body: string, business: Business) {
  let text = body.trim();
  if (!text.toLowerCase().includes(business.name.toLowerCase())) text += `\n- ${business.name}`;
  if (!/\bstop\b/i.test(text)) text += '\nReply STOP to opt out';
  return text;
}

// ---------- Opt-outs ----------

const secret = () => process.env.JWT_SECRET || 'dev-only-insecure-secret';
const signContact = (contactId: string) => crypto.createHmac('sha256', secret()).update(`unsubscribe:${contactId}`).digest('base64url').slice(0, 24);
export const unsubscribeUrl = (contactId: string) => `${publicUrl()}/api/unsubscribe/${contactId}/${signContact(contactId)}`;

const STOP_WORDS = /^(stop|stop all|stopall|unsubscribe|cancel|end|quit|opt out|optout)[.!]*$/i;
const START_WORDS = /^(start|unstop|subscribe)[.!]*$/i;

/**
 * Handles STOP and START texts. Returns the confirmation to send back, or null for ordinary messages.
 * Unsubscribing only stops marketing: you can still reply to the customer about their repair.
 */
export function handleOptOutText(business: Business, phone: string, body: string) {
  const text = body.trim();
  if (STOP_WORDS.test(text)) {
    run('UPDATE contacts SET opted_out_at = ? WHERE business_id = ? AND phone = ? AND opted_out_at IS NULL', now(), business.id, phone);
    return `You're unsubscribed from ${business.name} marketing texts. Reply START to get them again.`;
  }
  if (START_WORDS.test(text)) {
    run('UPDATE contacts SET opted_out_at = NULL WHERE business_id = ? AND phone = ?', business.id, phone);
    return `You're subscribed to ${business.name} texts again. Reply STOP to opt out.`;
  }
  return null;
}

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f1f5f9;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}main{background:#fff;border-radius:12px;padding:28px;max-width:380px;box-shadow:0 1px 3px #0002;text-align:center}button{background:#0f172a;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}</style></head><body><main>${body}</main></body></html>`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function unsubscribeContact(req: { params: Record<string, string> }) {
  const { contactId, sig } = req.params;
  const expected = signContact(contactId);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return get<Contact & { business_name: string }>('SELECT c.*, b.name AS business_name FROM contacts c JOIN businesses b ON b.id = c.business_id WHERE c.id = ?', contactId) ?? null;
}

// A link opened by a mail scanner mustn't unsubscribe anyone, so the page asks first.
unsubscribeRouter.get('/:contactId/:sig', (req, res) => {
  const contact = unsubscribeContact(req);
  if (!contact) return res.status(404).type('html').send(page('Link not valid', '<p>This unsubscribe link isn’t valid.</p>'));
  const name = escapeHtml(contact.business_name);
  if (contact.opted_out_at) return res.type('html').send(page('Unsubscribed', `<h2>You’re unsubscribed</h2><p>${name} won’t send you marketing emails.</p>`));
  res.type('html').send(page('Unsubscribe', `<h2>Unsubscribe from ${name}?</h2><p>You won’t get marketing emails from ${name} any more.</p><form method="post"><button>Unsubscribe</button></form>`));
});

// Also the target of the one-click List-Unsubscribe header in each email.
unsubscribeRouter.post('/:contactId/:sig', (req, res) => {
  const contact = unsubscribeContact(req);
  if (!contact) return res.status(404).type('html').send(page('Link not valid', '<p>This unsubscribe link isn’t valid.</p>'));
  if (!contact.opted_out_at) run('UPDATE contacts SET opted_out_at = ? WHERE id = ?', now(), contact.id);
  res.type('html').send(page('Unsubscribed', `<h2>You’re unsubscribed</h2><p>${escapeHtml(contact.business_name)} won’t send you marketing emails.</p>`));
});

// ---------- Customers ----------

const isMobile = (phone: string | null) => Boolean(phone && (!phone.startsWith('+61') || phone.startsWith('+614')));

// When we last heard from or wrote to them: before ChatBird (imported) or in ChatBird.
const LAST_TOUCH = `MAX(COALESCE(c.last_contact_at, ''), COALESCE((SELECT MAX(m.created_at) FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE v.contact_id = c.id), ''))`;

marketingRouter.get('/contacts', (req, res) => {
  const { businessId } = req.session!;
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  const status = String(req.query.status ?? 'all');
  const source = req.query.source ? String(req.query.source) : null;
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const where = ['c.business_id = ?'];
  const params: (string | number)[] = [businessId];
  if (q) {
    where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)');
    const digits = q.replace(/\D/g, '').replace(/^0/, '');
    params.push(`%${q}%`, `%${digits || q}%`, `%${q}%`);
  }
  if (status === 'subscribed') where.push('c.opted_out_at IS NULL');
  if (status === 'unsubscribed') where.push('c.opted_out_at IS NOT NULL');
  if (source) {
    where.push(source === 'chatbird' ? 'c.source IS NULL' : 'c.source = ?');
    if (source !== 'chatbird') params.push(source);
  }
  const filter = where.join(' AND ');
  const total = get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts c WHERE ${filter}`, ...params)!.n;
  const rows = all<Contact & { created_at: string; last_touch: string }>(
    `SELECT c.*, ${LAST_TOUCH} AS last_touch FROM contacts c WHERE ${filter} ORDER BY last_touch DESC, c.created_at DESC LIMIT 100 OFFSET ?`,
    ...params, offset,
  );
  const counts = get<{ total: number; unsubscribed: number; mobiles: number; emails: number }>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(opted_out_at IS NOT NULL), 0) AS unsubscribed,
       COALESCE(SUM(phone IS NOT NULL AND (phone NOT LIKE '+61%' OR phone LIKE '+614%')), 0) AS mobiles, COALESCE(SUM(email IS NOT NULL), 0) AS emails
     FROM contacts WHERE business_id = ?`,
    businessId,
  )!;
  const sources = all<{ source: string | null; count: number }>('SELECT source, COUNT(*) AS count FROM contacts WHERE business_id = ? GROUP BY source ORDER BY count DESC', businessId);
  res.json({
    contacts: rows.map((c) => ({
      id: c.id, name: c.name, phone: c.phone, email: c.email, source: c.source ?? null,
      lastContactAt: c.last_touch || null, optedOut: Boolean(c.opted_out_at),
    })),
    total,
    counts,
    sources: sources.map((s) => ({ source: s.source ?? 'chatbird', count: s.count })),
  });
});

marketingRouter.patch('/contacts/:id', (req, res) => {
  const { businessId } = req.session!;
  if (typeof req.body.optedOut !== 'boolean') return res.status(400).json({ error: 'optedOut must be true or false' });
  const result = run(
    `UPDATE contacts SET opted_out_at = ${req.body.optedOut ? 'COALESCE(opted_out_at, ?)' : 'NULL'} WHERE id = ? AND business_id = ?`,
    ...(req.body.optedOut ? [now()] : []), req.params.id, businessId,
  );
  if (!result.changes) return res.status(404).json({ error: 'Customer not found' });
  res.json({ ok: true });
});

const cleanSource = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'Imported';

/**
 * Adds imported customers. The browser reads the file and sends just name, number, email and when they
 * were last in touch (message text never leaves the computer). Existing customers are matched by number,
 * then email, and only filled in, never overwritten.
 */
marketingRouter.post('/contacts/import', (req, res) => {
  const { businessId } = req.session!;
  const rows = Array.isArray(req.body.rows) ? (req.body.rows as Record<string, unknown>[]) : null;
  if (!rows || rows.length === 0) return res.status(400).json({ error: 'Nothing to import' });
  if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ error: `At most ${MAX_IMPORT_ROWS} rows at a time` });
  const source = cleanSource(req.body.source);
  const t = now();
  let added = 0, updated = 0, skipped = 0;
  run('BEGIN');
  try {
    for (const row of rows) {
      const phone = normalizePhone(typeof row.phone === 'string' ? row.phone : null);
      const emailRaw = typeof row.email === 'string' ? row.email.trim().toLowerCase().slice(0, 200) : '';
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : null;
      if (!phone && !email) {
        skipped++;
        continue;
      }
      const name = typeof row.name === 'string' ? row.name.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
      const last = typeof row.lastContactAt === 'string' && !Number.isNaN(Date.parse(row.lastContactAt)) ? new Date(row.lastContactAt).toISOString() : null;
      const existing =
        (phone && get<Contact>('SELECT * FROM contacts WHERE business_id = ? AND phone = ?', businessId, phone)) ||
        (email && get<Contact>('SELECT * FROM contacts WHERE business_id = ? AND email = ?', businessId, email)) ||
        undefined;
      if (existing) {
        const betterName = name && !firstName(existing) ? name : existing.name;
        run(
          `UPDATE contacts SET name = ?, phone = COALESCE(phone, ?), email = COALESCE(email, ?),
             last_contact_at = CASE WHEN ? IS NOT NULL AND (last_contact_at IS NULL OR last_contact_at < ?) THEN ? ELSE last_contact_at END
           WHERE id = ?`,
          betterName, phone, email, last, last, last, existing.id,
        );
        updated++;
      } else {
        run(
          'INSERT INTO contacts (id, business_id, name, phone, email, source, last_contact_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          newId(), businessId, name || phone || email!, phone, email, source, last, t,
        );
        added++;
      }
    }
    run('COMMIT');
  } catch (err) {
    run('ROLLBACK');
    throw err;
  }
  res.json({ added, updated, skipped });
});

/** Undoes an import: removes that list's customers who have never been in a conversation. */
marketingRouter.delete('/contacts', (req, res) => {
  const { businessId } = req.session!;
  const source = String(req.query.source ?? '');
  if (!source || source === 'chatbird') return res.status(400).json({ error: 'Choose an imported list to remove' });
  const result = run(
    'DELETE FROM contacts WHERE business_id = ? AND source = ? AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.contact_id = contacts.id)',
    businessId, source,
  );
  res.json({ deleted: result.changes });
});

// ---------- Campaigns ----------

interface Audience {
  /** An imported list's name, 'chatbird' for customers who came in through ChatBird, or null for everyone. */
  source: string | null;
  /** Only customers in touch within this many months. */
  lastContactMonths: number | null;
}

function parseAudience(input: unknown): Audience {
  const a = (input ?? {}) as Record<string, unknown>;
  const months = Number(a.lastContactMonths);
  return {
    source: typeof a.source === 'string' && a.source ? a.source.slice(0, 40) : null,
    lastContactMonths: Number.isFinite(months) && months > 0 ? Math.min(Math.round(months), 120) : null,
  };
}

/** Who a campaign would go to: subscribed, reachable on the channel, and not messaged by a campaign lately. */
function audienceContacts(businessId: string, channel: 'sms' | 'email', audience: Audience) {
  const where = ['c.business_id = ?', 'c.opted_out_at IS NULL', channel === 'sms' ? 'c.phone IS NOT NULL' : 'c.email IS NOT NULL'];
  const params: string[] = [businessId];
  if (audience.source === 'chatbird') where.push('c.source IS NULL');
  else if (audience.source) {
    where.push('c.source = ?');
    params.push(audience.source);
  }
  const gap = new Date(Date.now() - MIN_GAP_DAYS * 86_400_000).toISOString();
  where.push('NOT EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.contact_id = c.id AND r.status = \'sent\' AND r.sent_at > ?)');
  params.push(gap);
  let rows = all<Contact & { last_touch: string }>(`SELECT c.*, ${LAST_TOUCH} AS last_touch FROM contacts c WHERE ${where.join(' AND ')}`, ...params);
  if (channel === 'sms') rows = rows.filter((c) => isMobile(c.phone));
  if (audience.lastContactMonths) {
    const since = new Date();
    since.setMonth(since.getMonth() - audience.lastContactMonths);
    rows = rows.filter((c) => c.last_touch && c.last_touch >= since.toISOString());
  }
  return rows;
}

interface Draft {
  name: string;
  channel: 'sms' | 'email';
  subject: string | null;
  body: string;
  audience: Audience;
}

/** Checks a campaign; returns an error message or the cleaned-up draft. */
function readDraft(business: Business, input: Record<string, unknown>): string | Draft {
  const channel = input.channel === 'email' ? 'email' : input.channel === 'sms' ? 'sms' : null;
  if (!channel) return 'Choose text or email';
  if (channel === 'sms' && !(smsConfigured() && business.sms_number)) return 'Texting is not set up. Add your Twilio number in Settings.';
  if (channel === 'email' && !emailConfigured()) return 'Email is not set up. Add your email settings under Integrations → Server keys.';
  const body = String(input.body ?? '').trim();
  if (!body) return 'Write the message';
  if (body.length > (channel === 'sms' ? 800 : 5000)) return 'The message is too long';
  if (/\{link\}/i.test(body) && !reviewLink(business)) return 'Add your Google review link on the Reviews page to use {link}';
  const subject = channel === 'email' ? String(input.subject ?? '').trim().slice(0, 150) : null;
  if (channel === 'email' && !subject) return 'Add an email subject';
  const name = String(input.name ?? '').trim().slice(0, 80) || `${channel === 'sms' ? 'Text' : 'Email'} campaign`;
  return { name, channel, subject, body, audience: parseAudience(input.audience) };
}

const loadBusiness = (id: string) => get<Business>('SELECT * FROM businesses WHERE id = ?', id)!;

marketingRouter.post('/campaigns/preview', (req, res) => {
  const business = loadBusiness(req.session!.businessId);
  const channel = req.body.channel === 'email' ? 'email' : 'sms';
  const audience = parseAudience(req.body.audience);
  const contacts = audienceContacts(business.id, channel, audience);
  const body = String(req.body.body ?? '');
  const sample = contacts[0] ?? { name: 'Sam', phone: null };
  const text = body.trim() ? personalise(body, business, sample) : '';
  res.json({
    recipients: contacts.length,
    preview: channel === 'sms' && text ? finalSms(text, business) : text,
    segments: channel === 'sms' && text ? smsSegments(finalSms(text, business)) : 0,
    reviewLink: reviewLink(business),
  });
});

marketingRouter.post('/campaigns/test', rateLimit('campaign-test', 20, 60 * 60 * 1000), async (req, res) => {
  const { businessId, userId } = req.session!;
  const business = loadBusiness(businessId);
  const draft = readDraft(business, req.body);
  if (typeof draft === 'string') return res.status(400).json({ error: draft });
  const user = get<{ name: string; email: string; phone: string | null }>('SELECT name, email, phone FROM users WHERE id = ?', userId)!;
  const me = { id: userId, name: user.name, phone: user.phone };
  try {
    if (draft.channel === 'sms') {
      if (!user.phone) return res.status(400).json({ error: 'Add “Your mobile” under Settings → Phone calls & voicemail to get test texts' });
      await sendSms(business.sms_number!, user.phone, finalSms(personalise(draft.body, business, me), business));
    } else {
      await emailCampaign(business, user.email, `[Test] ${draft.subject}`, personalise(draft.body, business, me), `${publicUrl()}/`);
    }
    res.json({ ok: true, to: draft.channel === 'sms' ? user.phone : user.email });
  } catch (err) {
    res.status(502).json({ error: `Test not sent: ${(err as Error).message}` });
  }
});

marketingRouter.post('/campaigns', (req, res) => {
  const { businessId, userId } = req.session!;
  const business = loadBusiness(businessId);
  const draft = readDraft(business, req.body);
  if (typeof draft === 'string') return res.status(400).json({ error: draft });
  const contacts = audienceContacts(businessId, draft.channel, draft.audience);
  if (contacts.length === 0) return res.status(400).json({ error: 'Nobody to send to with these choices' });
  // The number shown to the owner must still be right, so nobody extra is messaged.
  if (req.body.expectedRecipients !== undefined && Number(req.body.expectedRecipients) !== contacts.length) {
    return res.status(409).json({ error: `The audience changed to ${contacts.length} customers. Check and send again.`, recipients: contacts.length });
  }
  const id = newId();
  run('BEGIN');
  try {
    run(
      `INSERT INTO campaigns (id, business_id, name, channel, subject, body, audience, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
      id, businessId, draft.name, draft.channel, draft.subject, draft.body, JSON.stringify(draft.audience), userId, now(),
    );
    for (const c of contacts) run('INSERT INTO campaign_recipients (campaign_id, contact_id) VALUES (?, ?)', id, c.id);
    run('COMMIT');
  } catch (err) {
    run('ROLLBACK');
    throw err;
  }
  res.status(201).json({ campaign: campaignSummary(id) });
});

function campaignSummary(id: string) {
  const c = get<{ id: string; name: string; channel: string; subject: string | null; body: string; status: string; created_at: string; finished_at: string | null; business_id: string }>(
    'SELECT * FROM campaigns WHERE id = ?', id,
  )!;
  const counts = get<{ total: number; sent: number; failed: number; skipped: number; pending: number }>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'sent'), 0) AS sent, COALESCE(SUM(status = 'failed'), 0) AS failed,
       COALESCE(SUM(status = 'skipped'), 0) AS skipped, COALESCE(SUM(status = 'pending'), 0) AS pending
     FROM campaign_recipients WHERE campaign_id = ?`,
    id,
  )!;
  const replies = get<{ n: number }>(
    `SELECT COUNT(DISTINCT r.contact_id) AS n FROM campaign_recipients r
       JOIN conversations v ON v.contact_id = r.contact_id JOIN messages m ON m.conversation_id = v.id
     WHERE r.campaign_id = ? AND r.status = 'sent' AND m.direction = 'in' AND m.created_at > r.sent_at`,
    id,
  )!.n;
  const optOuts = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM campaign_recipients r JOIN contacts k ON k.id = r.contact_id
     WHERE r.campaign_id = ? AND r.status = 'sent' AND k.opted_out_at > r.sent_at`,
    id,
  )!.n;
  const lastError = get<{ error: string }>("SELECT error FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed' AND error IS NOT NULL LIMIT 1", id)?.error ?? null;
  return {
    id: c.id, name: c.name, channel: c.channel, subject: c.subject, body: c.body, status: c.status,
    createdAt: c.created_at, finishedAt: c.finished_at, ...counts, replies, optOuts, lastError,
  };
}

marketingRouter.get('/campaigns', (req, res) => {
  const rows = all<{ id: string }>('SELECT id FROM campaigns WHERE business_id = ? ORDER BY created_at DESC LIMIT 50', req.session!.businessId);
  const business = loadBusiness(req.session!.businessId);
  const { time } = localTime(business.timezone);
  res.json({
    campaigns: rows.map((r) => campaignSummary(r.id)),
    smsAvailable: smsConfigured() && Boolean(business.sms_number),
    emailAvailable: emailConfigured(),
    reviewLink: reviewLink(business),
    sendingHours: { from: SEND_FROM, until: SEND_UNTIL, now: time, open: time >= SEND_FROM && time < SEND_UNTIL },
  });
});

marketingRouter.post('/campaigns/:id/:action', (req, res) => {
  const { businessId } = req.session!;
  const campaign = get<{ status: string }>('SELECT status FROM campaigns WHERE id = ? AND business_id = ?', req.params.id, businessId);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const next = { pause: campaign.status === 'sending' ? 'paused' : null, resume: campaign.status === 'paused' ? 'sending' : null, cancel: ['sending', 'paused'].includes(campaign.status) ? 'cancelled' : null }[req.params.action];
  if (next === undefined) return res.status(404).json({ error: 'Unknown action' });
  if (!next) return res.status(400).json({ error: `This campaign is ${campaign.status}` });
  run(`UPDATE campaigns SET status = ?, finished_at = ${next === 'cancelled' ? '?' : 'finished_at'} WHERE id = ?`, next, ...(next === 'cancelled' ? [now()] : []), req.params.id);
  res.json({ campaign: campaignSummary(req.params.id) });
});

// ---------- Sending ----------

/** The customer's latest conversation, or a new closed one so a campaign doesn't fill the inbox. A reply reopens it. */
function conversationFor(business: Business, contact: Contact, channel: Channel): Conversation {
  const existing = get<Conversation>('SELECT * FROM conversations WHERE contact_id = ? ORDER BY last_message_at DESC LIMIT 1', contact.id);
  if (existing) {
    if (channel === 'sms' && existing.channel !== 'sms' && existing.channel !== 'webchat') {
      run("UPDATE conversations SET channel = 'sms' WHERE id = ?", existing.id);
      existing.channel = 'sms';
    }
    return existing;
  }
  const t = now();
  const conversation: Conversation = {
    id: newId(), business_id: business.id, contact_id: contact.id, channel, status: 'closed',
    visitor_token: null, page_url: null, unread_count: 0, last_message_at: t, created_at: t,
  };
  run(
    "INSERT INTO conversations (id, business_id, contact_id, channel, status, last_message_at, created_at) VALUES (?, ?, ?, ?, 'closed', ?, ?)",
    conversation.id, business.id, contact.id, channel, t, t,
  );
  return conversation;
}

async function sendOne(campaignId: string) {
  const campaign = get<{ id: string; business_id: string; channel: 'sms' | 'email'; subject: string | null; body: string }>('SELECT * FROM campaigns WHERE id = ?', campaignId)!;
  const business = loadBusiness(campaign.business_id);
  const next = get<{ contact_id: string }>("SELECT contact_id FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' LIMIT 1", campaignId);
  if (!next) {
    run("UPDATE campaigns SET status = 'done', finished_at = ? WHERE id = ? AND status = 'sending'", now(), campaignId);
    return;
  }
  const mark = (status: string, error: string | null = null) =>
    run('UPDATE campaign_recipients SET status = ?, error = ?, sent_at = ? WHERE campaign_id = ? AND contact_id = ?', status, error, now(), campaignId, next.contact_id);
  const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', next.contact_id);
  // They may have unsubscribed or been edited since the campaign started.
  if (!contact || contact.opted_out_at || (campaign.channel === 'sms' ? !isMobile(contact.phone) : !contact.email)) return mark('skipped');
  const text = personalise(campaign.body, business, contact);
  try {
    if (campaign.channel === 'sms') {
      if (!(smsConfigured() && business.sms_number)) throw new Error('Texting is not set up');
      const body = finalSms(text, business);
      await sendSms(business.sms_number, contact.phone!, body);
      insertMessage(conversationFor(business, contact, 'sms'), 'out', 'sms', body, { automated: true });
    } else {
      await emailCampaign(business, contact.email!, campaign.subject ?? business.name, text, unsubscribeUrl(contact.id));
      insertMessage(conversationFor(business, contact, 'email'), 'out', 'email', `${campaign.subject}\n\n${text}`, { automated: true });
    }
    mark('sent');
  } catch (err) {
    mark('failed', (err as Error).message.slice(0, 300));
  }
}

let busy = false;
/** One message per tick for each business that's sending, only within sending hours. */
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const sending = all<{ id: string; business_id: string; timezone: string }>(
      "SELECT c.id, c.business_id, b.timezone FROM campaigns c JOIN businesses b ON b.id = c.business_id WHERE c.status = 'sending' ORDER BY c.created_at",
    );
    const served = new Set<string>();
    for (const c of sending) {
      if (served.has(c.business_id)) continue;
      const { time } = localTime(c.timezone);
      if (!process.env.CAMPAIGN_ANY_HOUR && (time < SEND_FROM || time >= SEND_UNTIL)) continue;
      served.add(c.business_id);
      await sendOne(c.id);
    }
  } catch (err) {
    console.error('Campaign sending failed:', err);
  } finally {
    busy = false;
  }
}

export function startCampaigns() {
  setInterval(tick, TICK_MS).unref();
}
