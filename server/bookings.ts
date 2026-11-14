import { Router } from 'express';
import { all, get, newId, now, run, type Business, type Contact, type Conversation } from './db';
import { requireAuth } from './auth';
import { localDateIn, localTime } from './hours';
import { replyChannels, sendToCustomer } from './outbound';
import { firstName } from './campaigns';
import { tagConversation } from './assistant';
import { pushMessage } from './inbound';
import { emailTeam } from './notify';
import { publish } from './events';

/**
 * Bookings with a real date and time, so customers get reminders and fewer forget to come:
 * a text the evening before ("Reply C to confirm or R to change it") and one a couple of hours
 * before. Replies of C confirm the booking; R tells the team to rearrange. The team marks each
 * booking Arrived or No-show, and a no-show can be sent a friendly "want to rebook?" text.
 */
const TICK_MS = Number(process.env.BOOKINGS_TICK_MS) || 5 * 60 * 1000;
const DAY_BEFORE_FROM = process.env.BOOKING_DAY_BEFORE_FROM || '17:00';
const SEND_UNTIL = process.env.BOOKING_SEND_UNTIL || '20:00';
const SEND_FROM = process.env.BOOKING_SEND_FROM || '08:00';
const SOON_MS = 2 * 60 * 60 * 1000;

export type BookingStatus = 'booked' | 'confirmed' | 'arrived' | 'no_show' | 'cancelled';
interface AppointmentRow {
  id: string;
  business_id: string;
  conversation_id: string;
  contact_id: string;
  starts_at: string | null;
  when_text: string;
  device: string;
  service: string;
  status: BookingStatus;
  source: string;
  reminder_day_at: string | null;
  reminder_soon_at: string | null;
  no_show_text_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- Times in the business's time zone ----------

/** "2026-11-18" + "14:30" in Australia/Sydney → the UTC instant (ISO). */
export function zonedToUtc(date: string, time: string, timezone: string) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at));
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute')) - at;
  };
  // Twice, so a time near a daylight-saving change still lands right.
  let utc = guess - offset(guess);
  utc = guess - offset(utc);
  return new Date(utc).toISOString();
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Reads a date ("2026-11-18", "18/11/2026", "18/11") and a time ("14:30", "2:30 pm", "2pm") as typed on forms. */
export function parseWhen(dateText: string, timeText: string, timezone: string): string | null {
  const ds = dateText.trim(), ts = timeText.trim().toLowerCase();
  let date: string | null = null;
  let m = ds.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) date = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = m ? null : ds.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (m) {
    const thisYear = Number(localDateIn(timezone).slice(0, 4));
    const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : thisYear;
    date = `${year}-${pad(+m[2])}-${pad(+m[1])}`;
  }
  const t = ts.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/);
  if (!date || !t) return null;
  let h = +t[1];
  if (t[3] === 'pm' && h < 12) h += 12;
  if (t[3] === 'am' && h === 12) h = 0;
  if (h > 23 || +(t[2] ?? 0) > 59) return null;
  return zonedToUtc(date, `${pad(h)}:${t[2] ?? '00'}`, timezone);
}

function describeTime(iso: string, timezone: string) {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-AU', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-AU', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).replace(/\s?([ap])\.?m\.?/i, (_, x: string) => `${x.toLowerCase()}m`);
  return { day, time };
}

// ---------- Creating bookings ----------

export function createAppointment(
  business: Business,
  conversation: Conversation,
  b: { startsAt: string | null; whenText: string; device: string; service: string; source: 'website' | 'receptionist' | 'manual' },
) {
  const id = newId();
  const t = now();
  run(
    `INSERT INTO appointments (id, business_id, conversation_id, contact_id, starts_at, when_text, device, service, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?)`,
    id, business.id, conversation.id, conversation.contact_id, b.startsAt, b.whenText.slice(0, 120), b.device.slice(0, 120), b.service.slice(0, 200), b.source, t, t,
  );
  return id;
}

// ---------- Texts ----------

function fill(template: string, business: Business, contact: Contact, a: AppointmentRow) {
  const { day, time } = a.starts_at ? describeTime(a.starts_at, business.timezone) : { day: a.when_text, time: '' };
  return template
    .replace(/\{name\}/gi, firstName(contact) ?? 'there')
    .replace(/\{business\}/gi, business.name)
    .replace(/\{device\}/gi, a.device || 'device')
    .replace(/\{day\}/gi, day)
    .replace(/\{time\}/gi, time)
    .replace(/\{address\}/gi, business.address || '')
    .replace(/\{phone\}/gi, business.widget_call_number || '')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
}

async function textCustomer(business: Business, a: AppointmentRow, template: string) {
  const conversation = get<Conversation>('SELECT * FROM conversations WHERE id = ?', a.conversation_id);
  const contact = get<Contact & { opted_out_at: string | null }>('SELECT * FROM contacts WHERE id = ?', a.contact_id);
  if (!conversation || !contact || contact.opted_out_at) return false;
  const channels = replyChannels(business, conversation, contact);
  const channel = channels.includes('sms') ? 'sms' : channels.includes('email') ? 'email' : null;
  if (!channel) return false;
  await sendToCustomer(business, conversation, channel, fill(template, business, contact, a), { automated: true });
  return true;
}

// ---------- Reminders ----------

const ACTIVE = "status IN ('booked', 'confirmed')";

async function tick() {
  const nowMs = Date.now();
  for (const business of all<Business & { booking_reminders: number; reminder_day_text: string; reminder_soon_text: string; no_show_auto: number; no_show_text: string }>(
    'SELECT * FROM businesses WHERE booking_reminders = 1 OR no_show_auto = 1',
  )) {
    const { time } = localTime(business.timezone);
    if (time < SEND_FROM || time >= SEND_UNTIL) continue;
    const tomorrow = localDateIn(business.timezone, new Date(nowMs + 24 * 3600_000));
    const rows = all<AppointmentRow>(`SELECT * FROM appointments WHERE business_id = ? AND ${ACTIVE} AND starts_at IS NOT NULL AND starts_at > ?`, business.id, new Date(nowMs - 6 * 3600_000).toISOString());
    for (const a of rows) {
      const starts = Date.parse(a.starts_at!);
      const bookedHoursAgo = (nowMs - Date.parse(a.created_at)) / 3600_000;
      // Claim each text before sending, so a slow send can't go twice.
      const claim = (column: 'reminder_day_at' | 'reminder_soon_at' | 'no_show_text_at') => run(`UPDATE appointments SET ${column} = ? WHERE id = ? AND ${column} IS NULL`, now(), a.id).changes > 0;
      try {
        if (business.booking_reminders && !a.reminder_day_at && time >= DAY_BEFORE_FROM && localDateIn(business.timezone, new Date(starts)) === tomorrow && bookedHoursAgo >= 6) {
          if (claim('reminder_day_at')) await textCustomer(business, a, business.reminder_day_text);
        } else if (business.booking_reminders && !a.reminder_soon_at && starts > nowMs && starts - nowMs <= SOON_MS && bookedHoursAgo >= 3) {
          if (claim('reminder_soon_at')) await textCustomer(business, a, business.reminder_soon_text);
        } else if (business.no_show_auto && !a.no_show_text_at && nowMs - starts > 90 * 60_000) {
          // Opt-in only: nobody marked them Arrived 90 minutes after the time.
          if (claim('no_show_text_at')) {
            run("UPDATE appointments SET status = 'no_show', updated_at = ? WHERE id = ?", now(), a.id);
            await textCustomer(business, a, business.no_show_text);
          }
        }
      } catch (err) {
        console.error(`Booking text for ${business.name} failed:`, (err as Error).message);
      }
    }
  }
}

let busy = false;
export function startBookingReminders() {
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } catch (err) {
      console.error('Booking reminders failed:', err);
    } finally {
      busy = false;
    }
  }, TICK_MS).unref();
}

// ---------- Replies to reminders (sms.ts) ----------

const CONFIRM = /^\s*(c|y|yes|yep|yeah|confirm(ed)?|ok(ay)?|see you)\s*[.!👍]*\s*$/i;
const CHANGE = /^\s*(r|reschedule|change|cancel|can'?t make it|rebook)\b/i;

/**
 * A text that answers a booking reminder: C confirms (no alert needed), R asks the team to
 * rearrange (alert). Returns true when it was handled here and the usual auto-replies should be skipped.
 */
export async function handleBookingReply(business: Business, conversation: Conversation, message: { id: string; body: string }) {
  const a = get<AppointmentRow>(
    `SELECT * FROM appointments WHERE conversation_id = ? AND ${ACTIVE} AND (reminder_day_at IS NOT NULL OR reminder_soon_at IS NOT NULL) AND starts_at > ? ORDER BY starts_at LIMIT 1`,
    conversation.id, new Date(Date.now() - 3 * 3600_000).toISOString(),
  );
  if (!a) return false;
  const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', a.contact_id)!;
  if (CONFIRM.test(message.body)) {
    run("UPDATE appointments SET status = 'confirmed', updated_at = ? WHERE id = ?", now(), a.id);
    // Nothing for the team to do: leave it read, no alert.
    run('UPDATE conversations SET unread_count = MAX(0, unread_count - 1) WHERE id = ?', conversation.id);
    publish(`biz:${business.id}`, { type: 'message', conversationId: conversation.id, message: { ...message, author_name: null }, quiet: true });
    await sendToCustomer(business, conversation, 'sms', fill('Thanks {name}, you’re confirmed for {day} at {time}. See you then!', business, contact, a), { automated: true });
    return true;
  }
  if (CHANGE.test(message.body)) {
    tagConversation(business.id, conversation.id, { name: 'Needs reply', color: '#dc2626' });
    publish(`biz:${business.id}`, { type: 'message', conversationId: conversation.id, message: { ...message, author_name: null } });
    const full = get<import('./db').Message>('SELECT * FROM messages WHERE id = ?', message.id)!;
    emailTeam(business, conversation, full).catch((err) => console.error('Email alert failed:', err));
    pushMessage(business, conversation, full).catch((err) => console.error('Push failed:', err));
    await sendToCustomer(business, conversation, 'sms', fill('No problem {name}, we’ll text you shortly to find a new time.', business, contact, a), { automated: true });
    return true;
  }
  return false;
}

// ---------- API: Bookings page and the conversation banner ----------

export const bookingsRouter = Router();
bookingsRouter.use(requireAuth);

export function publicAppointment(a: AppointmentRow, extra: Record<string, unknown> = {}) {
  return {
    id: a.id,
    conversationId: a.conversation_id,
    startsAt: a.starts_at,
    whenText: a.when_text,
    device: a.device,
    service: a.service,
    status: a.status,
    source: a.source,
    remindedDayBefore: Boolean(a.reminder_day_at),
    remindedSoon: Boolean(a.reminder_soon_at),
    noShowTexted: Boolean(a.no_show_text_at),
    createdAt: a.created_at,
    ...extra,
  };
}

/** The conversation's current booking (upcoming, or the latest one) for the banner in the thread. */
export function conversationAppointment(conversationId: string) {
  const a =
    get<AppointmentRow>(`SELECT * FROM appointments WHERE conversation_id = ? AND ${ACTIVE} ORDER BY COALESCE(starts_at, created_at) LIMIT 1`, conversationId) ??
    get<AppointmentRow>('SELECT * FROM appointments WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1', conversationId);
  return a ? publicAppointment(a) : null;
}

const settingsOf = (b: Business & Record<string, unknown>) => ({
  reminders: Boolean(b.booking_reminders),
  dayBeforeText: b.reminder_day_text as string,
  soonText: b.reminder_soon_text as string,
  noShowAuto: Boolean(b.no_show_auto),
  noShowText: b.no_show_text as string,
});

bookingsRouter.get('/', (req, res) => {
  const { businessId } = req.session!;
  const business = get<Business & Record<string, unknown>>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  const rows = all<AppointmentRow & { contact_name: string; contact_phone: string | null }>(
    `SELECT a.*, k.name AS contact_name, k.phone AS contact_phone FROM appointments a JOIN contacts k ON k.id = a.contact_id
      WHERE a.business_id = ? AND (a.starts_at IS NULL OR a.starts_at > ?) ORDER BY a.starts_at IS NULL, a.starts_at LIMIT 300`,
    businessId, new Date(Date.now() - 30 * 86_400_000).toISOString(),
  );
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const stats = get<{ arrived: number; no_show: number; confirmed: number; total: number }>(
    `SELECT COALESCE(SUM(status = 'arrived'), 0) AS arrived, COALESCE(SUM(status = 'no_show'), 0) AS no_show,
            COALESCE(SUM(status = 'confirmed'), 0) AS confirmed, COUNT(*) AS total
       FROM appointments WHERE business_id = ? AND starts_at BETWEEN ? AND ?`,
    businessId, since, now(),
  )!;
  res.json({
    timezone: business.timezone,
    settings: settingsOf(business),
    stats,
    appointments: rows.map((a) => publicAppointment(a, { contactName: a.contact_name, contactPhone: a.contact_phone })),
  });
});

function readWhen(body: Record<string, unknown>, timezone: string) {
  const date = String(body.date ?? ''), time = String(body.time ?? '');
  if (!date && !time) return { startsAt: null, ok: true };
  const startsAt = parseWhen(date, time, timezone);
  return { startsAt, ok: Boolean(startsAt) };
}

/** Adds a booking to a conversation by hand (e.g. agreed over the phone or in a text). */
bookingsRouter.post('/', (req, res) => {
  const { businessId } = req.session!;
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  const conversation = get<Conversation>('SELECT * FROM conversations WHERE id = ? AND business_id = ?', String(req.body.conversationId ?? ''), businessId);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const when = readWhen(req.body, business.timezone);
  if (!when.ok || !when.startsAt) return res.status(400).json({ error: 'Choose the date and time' });
  const id = createAppointment(business, conversation, { startsAt: when.startsAt, whenText: '', device: String(req.body.device ?? '').trim(), service: String(req.body.service ?? '').trim(), source: 'manual' });
  res.status(201).json({ appointment: publicAppointment(get<AppointmentRow>('SELECT * FROM appointments WHERE id = ?', id)!) });
});

const STATUSES: BookingStatus[] = ['booked', 'confirmed', 'arrived', 'no_show', 'cancelled'];

bookingsRouter.patch('/:id', (req, res) => {
  const { businessId } = req.session!;
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  const a = get<AppointmentRow>('SELECT * FROM appointments WHERE id = ? AND business_id = ?', req.params.id, businessId);
  if (!a) return res.status(404).json({ error: 'Booking not found' });
  const b = (req.body ?? {}) as Record<string, unknown>;
  let startsAt = a.starts_at;
  let reminders = { day: a.reminder_day_at, soon: a.reminder_soon_at };
  if (b.date !== undefined || b.time !== undefined) {
    const when = readWhen(b, business.timezone);
    if (!when.ok || !when.startsAt) return res.status(400).json({ error: 'Choose the date and time' });
    // A new time gets fresh reminders, and needs confirming again.
    if (when.startsAt !== a.starts_at) {
      reminders = { day: null, soon: null };
      if (a.status === 'confirmed' && b.status === undefined) b.status = 'booked';
    }
    startsAt = when.startsAt;
  }
  const status = b.status === undefined ? a.status : (String(b.status) as BookingStatus);
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  const device = b.device === undefined ? a.device : String(b.device).trim().slice(0, 120);
  run(
    'UPDATE appointments SET starts_at = ?, status = ?, device = ?, reminder_day_at = ?, reminder_soon_at = ?, updated_at = ? WHERE id = ?',
    startsAt, status, device, reminders.day, reminders.soon, now(), a.id,
  );
  res.json({ appointment: publicAppointment(get<AppointmentRow>('SELECT * FROM appointments WHERE id = ?', a.id)!) });
});

/** Marks a no-show and (optionally) texts them to rebook. */
bookingsRouter.post('/:id/no-show', async (req, res) => {
  const { businessId } = req.session!;
  const business = get<Business & { no_show_text: string }>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  const a = get<AppointmentRow>('SELECT * FROM appointments WHERE id = ? AND business_id = ?', req.params.id, businessId);
  if (!a) return res.status(404).json({ error: 'Booking not found' });
  run("UPDATE appointments SET status = 'no_show', updated_at = ? WHERE id = ?", now(), a.id);
  let texted = false;
  if (req.body.text && !a.no_show_text_at) {
    run('UPDATE appointments SET no_show_text_at = ? WHERE id = ?', now(), a.id);
    try {
      texted = await textCustomer(business, a, business.no_show_text);
    } catch (err) {
      return res.status(502).json({ error: `Marked as no-show, but the text didn’t send: ${(err as Error).message}` });
    }
  }
  res.json({ appointment: publicAppointment(get<AppointmentRow>('SELECT * FROM appointments WHERE id = ?', a.id)!), texted });
});

bookingsRouter.patch('/settings/texts', (req, res) => {
  const { businessId } = req.session!;
  const business = get<Business & Record<string, unknown>>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const text = (v: unknown, current: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 320) : current);
  const s = settingsOf(business);
  run(
    'UPDATE businesses SET booking_reminders = ?, reminder_day_text = ?, reminder_soon_text = ?, no_show_auto = ?, no_show_text = ? WHERE id = ?',
    b.reminders === undefined ? Number(s.reminders) : b.reminders ? 1 : 0,
    text(b.dayBeforeText, s.dayBeforeText), text(b.soonText, s.soonText),
    b.noShowAuto === undefined ? Number(s.noShowAuto) : b.noShowAuto ? 1 : 0,
    text(b.noShowText, s.noShowText), businessId,
  );
  res.json({ settings: settingsOf(get<Business & Record<string, unknown>>('SELECT * FROM businesses WHERE id = ?', businessId)!) });
});
