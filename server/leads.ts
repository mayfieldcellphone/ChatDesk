import { Router } from 'express';
import crypto from 'node:crypto';
import {
  get, insertMessage, newId, normalizePhone, now, run, upsertContact,
  type Business, type Contact, type Conversation, type MessageKind,
} from './db';
import { onInboundMessage } from './inbound';
import { replyChannels, sendToCustomer } from './outbound';
import { rateLimit } from './rateLimit';

/**
 * Website forms (bookings, quotes, business enquiries) posted by a website's own server, e.g. the
 * Mayfield site's /api/notify. Each business has a private address, /api/leads/<lead token>, shown in
 * Settings. Accepts {type, data} (the form as submitted) or the CRM-sync payload that site already
 * builds ({type, customerName, customerPhone, customerEmail, message, metadata}).
 */
export const leadsRouter = Router();

/** The business's private website-forms token, created the first time it's needed. */
export function leadToken(business: Business) {
  if (business.lead_token) return business.lead_token;
  const token = crypto.randomBytes(24).toString('base64url');
  run('UPDATE businesses SET lead_token = ? WHERE id = ? AND lead_token IS NULL', token, business.id);
  return get<{ lead_token: string }>('SELECT lead_token FROM businesses WHERE id = ?', business.id)!.lead_token;
}

const text = (value: unknown, max = 500) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : '');
const line = (label: string, value: string) => (value ? [`${label}: ${value}`] : []);

interface BookingFacts {
  device: string;
  service: string;
  when: string;
}

/** Fills the business's booking-reply wording: {name} {business} {device} {service} {when} {phone}. */
export function fillBookingReply(template: string, business: Business, customerName: string, facts: BookingFacts) {
  const values: Record<string, string> = {
    name: customerName.trim().split(/\s+/)[0] || 'there',
    business: business.name,
    device: facts.device || 'your device',
    service: facts.service || 'repair',
    when: facts.when || 'the time you chose',
    phone: business.widget_call_number || '',
  };
  return template
    .replace(/\{(name|business|device|service|when|phone)\}/gi, (_, key: string) => values[key.toLowerCase()])
    .replace(/[ \t]+([.,!?])/g, '$1')
    .trim();
}

/** Turns a submitted form into the conversation's first message: a title line, then the details. */
function describe(type: string, d: Record<string, unknown>): { kind: MessageKind; lines: string[]; booking?: BookingFacts } {
  const device = [text(d.brand), text(d.model)].filter((v, i, all) => v && all.indexOf(v) === i).join(' ');
  switch (type) {
    case 'booking': {
      const when = [text(d.date), text(d.time)].filter(Boolean).join(' at ') || text(d.dateTime);
      return {
        kind: 'booking',
        lines: ['Booking request', ...line('Device', device || text(d.category)), ...line('Service', text(d.service)), ...line('When', when), ...line('Details', text(d.details || d.issue, 2000))],
        booking: { device: device || text(d.category), service: text(d.service), when },
      };
    }
    case 'quote':
      return { kind: 'quote', lines: ['Quote request', ...line('Device', device || text(d.device)), ...line('Details', text(d.details || d.issue || d.message, 2000))] };
    case 'corporate':
      return {
        kind: 'enquiry',
        lines: ['Business enquiry', ...line('Company', text(d.organization || d.companyName)), ...line('Contact', text(d.contactName)), ...line('Message', text(d.message, 2000))],
      };
    case 'voice_message':
      return { kind: 'enquiry', lines: ['Voice message on the website', ...line('Length', d.duration ? `${text(d.duration)} seconds` : ''), 'Listen in the website’s admin dashboard.'] };
    default:
      return {
        kind: 'enquiry',
        lines: ['Website enquiry', ...line('Device', device), ...line('Issue', text(d.issue, 2000)), ...line('Details', text(d.details || d.message, 2000))],
      };
  }
}

// One website server sends everything, so allow a fair number per address.
leadsRouter.post('/:token', rateLimit('website-lead', 120, 10 * 60 * 1000), (req, res) => {
  const token = String(req.params.token);
  const business = token.length >= 20 ? get<Business>('SELECT * FROM businesses WHERE lead_token = ?', token) : undefined;
  if (!business) return res.status(404).json({ error: 'Unknown address' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const type = text(body.type, 40) || 'contact';
  if (type === 'chat') return res.json({ ok: true, skipped: 'chats come in through the ChatBird widget' });
  const data = { ...((body.metadata as object) ?? {}), ...((body.data as object) ?? {}) } as Record<string, unknown>;

  const name = text(data.customerName || data.name || data.contactName || body.customerName || body.name, 100) || 'Website visitor';
  const phone = normalizePhone(text(data.phone || body.customerPhone || body.phone, 40));
  const emailRaw = text(data.email || body.customerEmail || body.email, 200).toLowerCase();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : null;
  if (!phone && !email) return res.status(400).json({ error: 'A phone number or email is needed' });

  const { kind, lines, booking } = describe(type, data);
  if (email) lines.push(`Email: ${email}`);
  const pageUrl = text(data.pageUrl || data.source || body.pageUrl, 500);

  const contact = upsertContact(business.id, name, phone, email);
  const t = now();
  const conversation: Conversation = {
    id: newId(), business_id: business.id, contact_id: contact.id, channel: 'webchat', status: 'open',
    visitor_token: null, page_url: /^https?:\/\//.test(pageUrl) ? pageUrl : null, unread_count: 0, last_message_at: t, created_at: t,
  };
  run(
    `INSERT INTO conversations (id, business_id, contact_id, channel, status, page_url, last_message_at, created_at)
     VALUES (?, ?, ?, 'webchat', 'open', ?, ?, ?)`,
    conversation.id, business.id, contact.id, conversation.page_url, t, t,
  );
  const message = insertMessage(conversation, 'in', 'webchat', lines.join('\n'), { kind });
  // No away message: the visitor isn't in a chat to see it; you reply by text or email.
  onInboundMessage(business, conversation, message, { awayMessage: false });
  if (booking && business.booking_reply_enabled) sendBookingReply(business, conversation, name, booking);
  res.status(201).json({ ok: true, conversationId: conversation.id });
});

/** Confirms a website booking straight away: by email when they gave one, otherwise by text. */
function sendBookingReply(business: Business, conversation: Conversation, customerName: string, facts: BookingFacts) {
  const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', conversation.contact_id)!;
  const channels = replyChannels(business, conversation, contact);
  const channel = channels.includes('email') ? 'email' : channels.includes('sms') ? 'sms' : null;
  if (!channel) return;
  const body = fillBookingReply(business.booking_reply_text, business, customerName, facts);
  sendToCustomer(business, conversation, channel, body, { automated: true }).catch((err) =>
    console.error(`Booking auto-reply for ${business.name} failed:`, err.message),
  );
}
