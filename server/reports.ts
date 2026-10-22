import { Router } from 'express';
import { all, get, run, type Business, type Channel, type MessageKind } from './db';
import { requireAuth } from './auth';
import { emailConfigured, emailWeeklyReport } from './notify';
import { rateLimit } from './rateLimit';

/**
 * Reports: what came in, how fast it was answered, what the AI assistant handled, and when customers
 * get in touch. Days and hours are counted in each business's own timezone. A weekly summary can be
 * emailed every Monday morning.
 */
export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------- Dates in a business's timezone ----------

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneParts(timezone: string, at: number) {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
    });
    formatters.set(timezone, f);
  }
  const parts = f.formatToParts(new Date(at));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    hour: Number(part('hour')),
    minute: Number(part('minute')),
    weekday: WEEKDAYS.indexOf(part('weekday')),
  };
}

export const localDate = (timezone: string, at = Date.now()) => zoneParts(timezone, at).date;

export function addDays(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The moment a local date starts in the timezone, as an ISO string (handles daylight saving). */
function startOfDay(date: string, timezone: string) {
  const [y, m, d] = date.split('-').map(Number);
  const wanted = Date.UTC(y, m - 1, d);
  let t = wanted;
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(timezone, t);
    const [py, pm, pd] = p.date.split('-').map(Number);
    t = wanted - (Date.UTC(py, pm - 1, pd, p.hour, p.minute) - t);
  }
  return new Date(t).toISOString();
}

// ---------- The report ----------

type Source = 'chat' | 'sms' | 'email' | 'facebook' | 'instagram' | 'call' | 'form';

function sourceOf(channel: Channel, firstKind: MessageKind | null): Source {
  if (firstKind === 'call' || firstKind === 'voicemail') return 'call';
  if (firstKind === 'booking' || firstKind === 'enquiry') return 'form';
  return channel === 'webchat' ? 'chat' : channel;
}

interface Totals {
  conversations: number;
  customerMessages: number;
  calls: number;
  missedCalls: number;
  voicemails: number;
  bookings: number;
  quotes: number;
  callbacks: number;
  forms: number;
}

const emptyTotals = (): Totals => ({ conversations: 0, customerMessages: 0, calls: 0, missedCalls: 0, voicemails: 0, bookings: 0, quotes: 0, callbacks: 0, forms: 0 });

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
};

/** Counts for one business between two local dates (inclusive). */
function totalsFor(business: Business, from: string, to: string): Totals {
  const start = startOfDay(from, business.timezone);
  const end = startOfDay(addDays(to, 1), business.timezone);
  const t = emptyTotals();
  t.conversations = get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE business_id = ? AND created_at >= ? AND created_at < ?', business.id, start, end)!.n;
  const kinds = all<{ kind: MessageKind; n: number }>(
    `SELECT m.kind, COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.business_id = ? AND m.direction = 'in' AND m.created_at >= ? AND m.created_at < ? GROUP BY m.kind`,
    business.id, start, end,
  );
  for (const { kind, n } of kinds) {
    if (kind !== 'call' && kind !== 'voicemail') t.customerMessages += n;
    if (kind === 'booking') t.bookings = n;
    if (kind === 'quote') t.quotes = n;
    if (kind === 'callback') t.callbacks = n;
    if (kind === 'enquiry') t.forms = n;
  }
  const calls = get<{ total: number; missed: number; voicemails: number }>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'missed'), 0) AS missed, COALESCE(SUM(has_voicemail), 0) AS voicemails
     FROM calls WHERE business_id = ? AND created_at >= ? AND created_at < ?`,
    business.id, start, end,
  )!;
  t.calls = calls.total;
  t.missedCalls = calls.missed;
  t.voicemails = calls.voicemails;
  return t;
}

export function buildReport(businesses: Business[], from: string, to: string) {
  const days = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  const multiple = businesses.length > 1;

  const totals = emptyTotals();
  const previousTotals = emptyTotals();
  const bySource: Record<Source, number> = { chat: 0, sms: 0, email: 0, facebook: 0, instagram: 0, call: 0, form: 0 };
  const daily = new Map<string, number>();
  for (let i = 0; i < days; i++) daily.set(addDays(from, i), 0);
  const heatmap = WEEKDAYS.map(() => Array.from({ length: 24 }, () => 0));
  const pages = new Map<string, number>();
  const answerTimes: number[] = [];
  const staffTimes: number[] = [];
  let measured = 0, within5 = 0, over1h = 0, noReply = 0;
  let answered = 0, handedOver = 0;
  let assistantSince: string | null = null;
  const questions: { body: string; at: string; conversationId: string; businessId: string; businessName: string }[] = [];

  for (const business of businesses) {
    const tz = business.timezone;
    const start = startOfDay(from, tz);
    const end = startOfDay(addDays(to, 1), tz);
    for (const [key, value] of Object.entries(totalsFor(business, from, to))) totals[key as keyof Totals] += value;
    for (const [key, value] of Object.entries(totalsFor(business, prevFrom, prevTo))) previousTotals[key as keyof Totals] += value;

    const conversations = all<{
      channel: Channel; page_url: string | null; created_at: string; first_kind: MessageKind | null;
      first_in: string | null; first_answer: string | null; first_staff: string | null;
    }>(
      `SELECT c.channel, c.page_url, c.created_at,
         (SELECT kind FROM messages WHERE conversation_id = c.id ORDER BY created_at LIMIT 1) AS first_kind,
         (SELECT MIN(created_at) FROM messages WHERE conversation_id = c.id AND direction = 'in') AS first_in,
         (SELECT MIN(created_at) FROM messages WHERE conversation_id = c.id AND direction = 'out' AND automated IN (0, 2)) AS first_answer,
         (SELECT MIN(created_at) FROM messages WHERE conversation_id = c.id AND direction = 'out' AND automated = 0) AS first_staff
       FROM conversations c WHERE c.business_id = ? AND c.created_at >= ? AND c.created_at < ?`,
      business.id, start, end,
    );
    for (const c of conversations) {
      const source = sourceOf(c.channel, c.first_kind);
      bySource[source]++;
      const day = localDate(tz, Date.parse(c.created_at));
      daily.set(day, (daily.get(day) ?? 0) + 1);
      if (c.page_url) {
        try {
          const url = new URL(c.page_url);
          const page = `${multiple ? url.host : ''}${url.pathname.replace(/\/$/, '') || '/'}`;
          pages.set(page, (pages.get(page) ?? 0) + 1);
        } catch { /* not a URL */ }
      }
      // Reply times: customer-started chats, texts, emails and forms. Missed calls are usually rung
      // back by phone, which ChatBird can't see, so they'd look unanswered.
      if (source === 'call' || !c.first_in) continue;
      const asked = Date.parse(c.first_in);
      const answer = c.first_answer && Date.parse(c.first_answer) >= asked ? Date.parse(c.first_answer) : null;
      const staff = c.first_staff && Date.parse(c.first_staff) >= asked ? Date.parse(c.first_staff) : null;
      measured++;
      if (answer === null) noReply++;
      else {
        answerTimes.push((answer - asked) / 1000);
        if (answer - asked <= 5 * 60_000) within5++;
      }
      if (staff !== null) staffTimes.push((staff - asked) / 1000);
      if ((answer ?? Date.now()) - asked > 60 * 60_000) over1h++;
    }

    const inbound = all<{ created_at: string }>(
      `SELECT m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.business_id = ? AND m.direction = 'in' AND m.created_at >= ? AND m.created_at < ?`,
      business.id, start, end,
    );
    for (const m of inbound) {
      const p = zoneParts(tz, Date.parse(m.created_at));
      if (p.weekday >= 0) heatmap[p.weekday][p.hour]++;
    }

    const log = get<{ answered: number; handed: number }>(
      `SELECT COALESCE(SUM(action = 'answer'), 0) AS answered, COALESCE(SUM(action = 'handoff'), 0) AS handed
       FROM assistant_log WHERE business_id = ? AND created_at >= ? AND created_at < ?`,
      business.id, start, end,
    )!;
    answered += log.answered;
    handedOver += log.handed;
    const since = get<{ at: string | null }>('SELECT MIN(created_at) AS at FROM assistant_log WHERE business_id = ?', business.id)?.at ?? null;
    if (since && (!assistantSince || since < assistantSince)) assistantSince = since;
    for (const q of all<{ body: string; created_at: string; conversation_id: string }>(
      `SELECT m.body, l.created_at, l.conversation_id FROM assistant_log l JOIN messages m ON m.id = l.message_id
       WHERE l.business_id = ? AND l.action = 'handoff' AND l.created_at >= ? AND l.created_at < ?
       ORDER BY l.created_at DESC LIMIT 50`,
      business.id, start, end,
    )) {
      questions.push({ body: q.body.slice(0, 300), at: q.created_at, conversationId: q.conversation_id, businessId: business.id, businessName: business.name });
    }
  }

  questions.sort((a, b) => b.at.localeCompare(a.at));
  return {
    range: { from, to, days },
    previous: { from: prevFrom, to: prevTo },
    totals,
    previousTotals,
    bySource,
    daily: [...daily].map(([date, count]) => ({ date, count })),
    response: {
      measured,
      medianFirstAnswer: median(answerTimes),
      medianStaffReply: median(staffTimes),
      within5min: within5,
      over1h,
      noReply,
    },
    assistant: { answered, handedOver, since: assistantSince, questions: questions.slice(0, 50) },
    heatmap,
    pages: [...pages].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([page, count]) => ({ page, count })),
  };
}

const userBusinesses = (userId: string) =>
  all<Business>('SELECT b.* FROM businesses b JOIN memberships m ON m.business_id = b.id WHERE m.user_id = ? ORDER BY b.created_at', userId);

reportsRouter.get('/', (req, res) => {
  const { userId, businessId } = req.session!;
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  const today = localDate(business.timezone);
  const to = DATE.test(String(req.query.to)) ? String(req.query.to) : today;
  const from = DATE.test(String(req.query.from)) ? String(req.query.from) : addDays(to, -6);
  const days = daysBetween(from, to) + 1;
  if (!(days >= 1 && days <= MAX_DAYS)) return res.status(400).json({ error: `Choose a range of 1 to ${MAX_DAYS} days` });

  const scope = req.query.scope === 'all' ? userBusinesses(userId) : [business];
  res.json({
    ...buildReport(scope, from, to),
    today,
    scope: scope.length > 1 ? 'all' : 'business',
    weeklyReport: Boolean(business.weekly_report),
    emailAvailable: emailConfigured(),
  });
});

reportsRouter.patch('/settings', (req, res) => {
  const { businessId } = req.session!;
  if (typeof req.body.weeklyReport !== 'boolean') return res.status(400).json({ error: 'weeklyReport must be true or false' });
  run('UPDATE businesses SET weekly_report = ? WHERE id = ?', req.body.weeklyReport ? 1 : 0, businessId);
  res.json({ weeklyReport: req.body.weeklyReport });
});

reportsRouter.post('/weekly/test', rateLimit('weekly-report-test', 5, 60 * 60 * 1000), async (req, res) => {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', req.session!.businessId)!;
  if (!emailConfigured()) return res.status(400).json({ error: 'Set up email under Integrations → Server keys first' });
  try {
    await sendWeeklyReport(business);
    res.json({ ok: true });
  } catch (err) {
    console.error('Weekly report test failed:', err);
    res.status(502).json({ error: 'The email could not be sent. Check the email settings.' });
  }
});

// ---------- Weekly email ----------

const duration = (seconds: number | null) =>
  seconds === null ? '–' : seconds < 60 ? `${Math.round(seconds)} sec` : seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} hr`;

function change(now: number, before: number) {
  if (before === 0) return now > 0 ? ' (new)' : '';
  const pct = Math.round(((now - before) / before) * 100);
  return pct === 0 ? ' (same as the week before)' : ` (${pct > 0 ? '+' : ''}${pct}% on the week before)`;
}

/** The last full Monday–Sunday week, as plain text. */
export function weeklyReportText(business: Business, today = localDate(business.timezone)) {
  // The Monday on or before today, minus a week.
  const weekday = zoneParts(business.timezone, Date.parse(`${today}T12:00:00Z`)).weekday;
  const thisMonday = addDays(today, -Math.max(weekday, 0));
  const from = addDays(thisMonday, -7);
  const to = addDays(thisMonday, -1);
  const r = buildReport([business], from, to);
  const t = r.totals, p = r.previousTotals;
  const busiest = r.heatmap
    .flatMap((hours, day) => hours.map((n, hour) => ({ n, day, hour })))
    .sort((a, b) => b.n - a.n)[0];
  const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
  const lines = [
    `${business.name}: your week in ChatBird (${from} to ${to})`,
    '',
    `New conversations: ${t.conversations}${change(t.conversations, p.conversations)}`,
    `Customer messages: ${t.customerMessages}`,
    `Calls: ${t.calls} (${t.missedCalls} missed, ${t.voicemails} voicemails)`,
    `Bookings: ${t.bookings} · Quote requests: ${t.quotes} · Call-back requests: ${t.callbacks} · Other forms: ${t.forms}`,
    '',
    `First answer (you or the assistant), typical: ${duration(r.response.medianFirstAnswer)}`,
    `Your first reply, typical: ${duration(r.response.medianStaffReply)}`,
    `Waited over an hour: ${r.response.over1h} · Still no reply: ${r.response.noReply}`,
  ];
  if (r.assistant.answered + r.assistant.handedOver > 0) {
    lines.push('', `AI assistant: answered ${r.assistant.answered}, passed ${r.assistant.handedOver} to you.`);
    const qs = r.assistant.questions.slice(0, 10);
    if (qs.length) lines.push('Questions it couldn’t answer (add these to your FAQs):', ...qs.map((q) => `- ${q.body.replace(/\s+/g, ' ').slice(0, 140)}`));
  }
  if (busiest && busiest.n > 0) lines.push('', `Busiest hour: ${WEEKDAYS[busiest.day]} ${hourLabel(busiest.hour)}–${hourLabel((busiest.hour + 1) % 24)} (${busiest.n} messages)`);
  if (process.env.PUBLIC_URL) lines.push('', `See the full report: ${process.env.PUBLIC_URL.replace(/\/$/, '')}/?business=${business.id}&view=reports`);
  lines.push('', 'Turn this email off in ChatBird → Reports.');
  return { subject: `${business.name}: ${t.conversations} new conversations last week`, text: lines.join('\n') };
}

async function sendWeeklyReport(business: Business) {
  const { subject, text } = weeklyReportText(business);
  return emailWeeklyReport(business, subject, text);
}

/** Every Monday from 8am (business time), once per business that has the weekly email on. */
async function sendDueWeeklyReports() {
  for (const business of all<Business>('SELECT * FROM businesses WHERE weekly_report = 1')) {
    const p = zoneParts(business.timezone, Date.now());
    if (p.weekday !== 0 || p.hour < 8 || business.weekly_report_sent_on === p.date) continue;
    run('UPDATE businesses SET weekly_report_sent_on = ? WHERE id = ?', p.date, business.id);
    try {
      if (await sendWeeklyReport(business)) console.log(`Weekly report sent for ${business.name}`);
    } catch (err) {
      console.error(`Weekly report for ${business.name} failed:`, (err as Error).message);
    }
  }
}

export function startWeeklyReports() {
  const every = Number(process.env.WEEKLY_REPORT_CHECK_MS) || 10 * 60 * 1000;
  setInterval(() => sendDueWeeklyReports().catch((err) => console.error('Weekly reports failed:', err)), every).unref();
}
