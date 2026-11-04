import { Router } from 'express';
import { all, get, newId, now, run, type Business, type Connection, type Contact, type Conversation } from './db';
import { requireAuth } from './auth';
import { reviewLink } from './google';
import { localTime } from './hours';
import { replyChannels, sendToCustomer } from './outbound';

/**
 * Review requests: the ⭐ Ask for review button, and the automatic one that goes out a while after
 * a conversation is closed (Reviews → Asking for reviews). Automatic requests are sent only between
 * 9am and 8pm, at most once per customer in the set number of days, never to anyone who opted out,
 * and only where the team actually talked with the customer.
 */
const TICK_MS = Number(process.env.REVIEW_REQUESTS_TICK_MS) || 5 * 60 * 1000;
const SEND_FROM = process.env.REVIEW_SEND_FROM || '09:00';
const SEND_UNTIL = process.env.REVIEW_SEND_UNTIL || '20:00';

export function reviewRequestText(business: Business, contact: Contact, link: string) {
  const first = contact.name.trim().split(/\s+/)[0];
  return business.review_request_text
    .replace(/\{name\}/gi, /^\+?\d[\d\s]+$/.test(first) || first === 'Private' ? 'there' : first)
    .replace(/\{business\}/gi, business.name)
    .replace(/\{link\}/gi, link);
}

export function recordReviewRequest(businessId: string, contactId: string, conversationId: string | null, automatic: boolean) {
  run('INSERT INTO review_requests (id, business_id, contact_id, conversation_id, automatic, sent_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), businessId, contactId, conversationId, automatic ? 1 : 0, now());
}

/** Why an automatic request shouldn't go to this conversation, or null if it can. */
function reasonToSkip(business: Business, conversation: Conversation): string | null {
  if (business.review_auto_mode !== 'on_close') return 'automatic requests are off';
  if (!reviewLink(business)) return 'no review link';
  const contact = get<Contact & { opted_out_at: string | null }>('SELECT * FROM contacts WHERE id = ?', conversation.contact_id);
  if (!contact) return 'no contact';
  if (contact.opted_out_at) return 'the customer unsubscribed';
  const channels = replyChannels(business, conversation, contact);
  if (!channels.includes('sms') && !channels.includes('email')) return 'no mobile number or email';
  // Only customers the team actually helped: a reply from a person, not just an answered call.
  if (!get("SELECT 1 FROM messages WHERE conversation_id = ? AND direction = 'out' AND automated = 0 LIMIT 1", conversation.id)) return 'nobody replied in this conversation';
  const since = new Date(Date.now() - business.review_auto_repeat_days * 86_400_000).toISOString();
  if (get('SELECT 1 FROM review_requests WHERE contact_id = ? AND sent_at > ?', contact.id, since)) return 'already asked recently';
  return null;
}

/** Called when someone closes a conversation: schedules the automatic request if it applies. */
export function scheduleReviewRequest(business: Business, conversation: Conversation) {
  if (reasonToSkip(business, conversation)) return null;
  const due = new Date(Date.now() + business.review_auto_delay_hours * 3600_000).toISOString();
  run('UPDATE conversations SET review_due_at = ? WHERE id = ?', due, conversation.id);
  return due;
}

export function cancelReviewRequest(conversationId: string) {
  run('UPDATE conversations SET review_due_at = NULL WHERE id = ?', conversationId);
}

async function sendDue() {
  const due = all<Conversation & { review_due_at: string }>("SELECT * FROM conversations WHERE review_due_at IS NOT NULL AND review_due_at <= ?", now());
  for (const conversation of due) {
    const business = get<Business>('SELECT * FROM businesses WHERE id = ?', conversation.business_id)!;
    const { time } = localTime(business.timezone);
    if (time < SEND_FROM || time >= SEND_UNTIL) continue; // wait for the morning
    // Claim it first, so a slow send can't go out twice.
    if (!run('UPDATE conversations SET review_due_at = NULL WHERE id = ? AND review_due_at = ?', conversation.id, conversation.review_due_at).changes) continue;
    // Reopened since (they messaged again), or something changed: don't send.
    if (conversation.status !== 'closed' || reasonToSkip(business, conversation)) continue;
    const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', conversation.contact_id)!;
    const channel = replyChannels(business, conversation, contact).includes('sms') ? 'sms' : 'email';
    try {
      await sendToCustomer(business, conversation, channel, reviewRequestText(business, contact, reviewLink(business)!), { automated: true });
      recordReviewRequest(business.id, contact.id, conversation.id, true);
    } catch (err) {
      console.error(`Automatic review request for ${business.name} failed:`, (err as Error).message);
    }
  }
}

let busy = false;
export function startReviewRequests() {
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await sendDue();
    } catch (err) {
      console.error('Review requests failed:', err);
    } finally {
      busy = false;
    }
  }, TICK_MS).unref();
}

// ---------- Settings ----------

export const reviewRequestsRouter = Router();
reviewRequestsRouter.use(requireAuth);

const settingsOf = (b: Business) => ({ mode: b.review_auto_mode, delayHours: b.review_auto_delay_hours, repeatDays: b.review_auto_repeat_days });

reviewRequestsRouter.get('/', (req, res) => {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', req.session!.businessId)!;
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const sent = get<{ n: number; auto: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(automatic), 0) AS auto FROM review_requests WHERE business_id = ? AND sent_at > ?', business.id, since)!;
  const waiting = get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE business_id = ? AND review_due_at IS NOT NULL', business.id)!.n;
  res.json({ settings: settingsOf(business), sentLast30Days: sent.n, automaticLast30Days: sent.auto, waiting });
});

reviewRequestsRouter.patch('/', (req, res) => {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', req.session!.businessId)!;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const mode = b.mode ?? business.review_auto_mode;
  if (mode !== 'off' && mode !== 'on_close') return res.status(400).json({ error: 'Choose when to ask' });
  const delay = b.delayHours === undefined ? business.review_auto_delay_hours : Math.round(Number(b.delayHours));
  if (!(delay >= 0 && delay <= 72)) return res.status(400).json({ error: 'Wait between 0 and 72 hours' });
  const repeat = b.repeatDays === undefined ? business.review_auto_repeat_days : Math.round(Number(b.repeatDays));
  if (!(repeat >= 7 && repeat <= 3650)) return res.status(400).json({ error: 'Ask again after 7 days or more' });
  if (mode === 'on_close' && !reviewLink(business)) return res.status(400).json({ error: 'Add your review link first (or connect Google Business Profile).' });
  run('UPDATE businesses SET review_auto_mode = ?, review_auto_delay_hours = ?, review_auto_repeat_days = ? WHERE id = ?', mode, delay, repeat, business.id);
  // Turning it off stops any waiting requests.
  if (mode === 'off') run('UPDATE conversations SET review_due_at = NULL WHERE business_id = ?', business.id);
  res.json({ settings: settingsOf(get<Business>('SELECT * FROM businesses WHERE id = ?', business.id)!) });
});

// ---------- Reviews widget for the business's website (public/reviews.js) ----------

export interface WidgetSettings {
  location: string; // 'all' or a Google connection id
  minRating: 4 | 5;
  count: number;
}

export function widgetSettings(business: Business): WidgetSettings {
  let saved: Partial<WidgetSettings> = {};
  try {
    saved = JSON.parse(business.reviews_widget || '{}');
  } catch { /* defaults */ }
  // With several Google locations, start with the first (the main shop) rather than mixing them.
  return { location: saved.location || googleLocations(business.id)[0]?.id || 'all', minRating: saved.minRating === 5 ? 5 : 4, count: [3, 6, 9, 12].includes(Number(saved.count)) ? Number(saved.count) : 9 };
}

const googleLocations = (businessId: string) => all<Connection>("SELECT * FROM connections WHERE business_id = ? AND provider = 'google' ORDER BY created_at", businessId);

/** What the widget shows: the rating summary and the newest good reviews that have words. */
export function widgetReviews(business: Business) {
  const s = widgetSettings(business);
  const where = s.location === 'all' ? '' : ' AND connection_id = ?';
  const args = s.location === 'all' ? [business.id] : [business.id, s.location];
  const summary = get<{ n: number; avg: number | null }>(`SELECT COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE business_id = ?${where}`, ...args)!;
  const rows = all<{ author_name: string; author_photo: string | null; rating: number; comment: string; review_created_at: string }>(
    `SELECT author_name, author_photo, rating, comment, review_created_at FROM reviews
      WHERE business_id = ?${where} AND rating >= ? AND comment IS NOT NULL AND LENGTH(TRIM(comment)) >= 20
      ORDER BY review_created_at DESC LIMIT ?`,
    ...args, s.minRating, s.count,
  );
  const location = s.location === 'all' ? null : googleLocations(business.id).find((c) => c.id === s.location);
  return {
    name: location?.name ?? business.name,
    color: business.color,
    rating: summary.avg ? Math.round(summary.avg * 10) / 10 : null,
    total: summary.n,
    reviewLink: reviewLink(business),
    reviews: rows.map((r) => ({
      author: r.author_name,
      photo: r.author_photo,
      rating: r.rating,
      // Google adds "(Translated by Google)" blocks; show the original words only.
      text: r.comment.split(/\n\n\(Original\)\n|\(Translated by Google\)/)[0].trim().slice(0, 600),
      date: r.review_created_at,
    })),
  };
}

reviewRequestsRouter.get('/widget', (req, res) => {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', req.session!.businessId)!;
  res.json({
    settings: widgetSettings(business),
    locations: googleLocations(business.id).map((c) => ({ id: c.id, name: c.name })),
    widgetKey: business.widget_key,
    preview: widgetReviews(business),
  });
});

reviewRequestsRouter.patch('/widget', (req, res) => {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', req.session!.businessId)!;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const location = String(b.location ?? 'all');
  if (location !== 'all' && !googleLocations(business.id).some((c) => c.id === location)) return res.status(400).json({ error: 'Choose a location' });
  const settings: WidgetSettings = { location, minRating: Number(b.minRating) === 5 ? 5 : 4, count: [3, 6, 9, 12].includes(Number(b.count)) ? Number(b.count) : 9 };
  run('UPDATE businesses SET reviews_widget = ? WHERE id = ?', JSON.stringify(settings), business.id);
  res.json({ settings, preview: widgetReviews({ ...business, reviews_widget: JSON.stringify(settings) }) });
});
