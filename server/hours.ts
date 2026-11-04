import type { Business } from './db';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];
/** Opening hours per weekday in the business's timezone; null means closed all day. */
export type WeeklyHours = Record<Day, { open: string; close: string } | null>;

const nineToFive = { open: '09:00', close: '17:00' };
export const DEFAULT_HOURS: WeeklyHours = {
  mon: nineToFive, tue: nineToFive, wed: nineToFive, thu: nineToFive, fri: nineToFive,
  sat: { open: '10:00', close: '14:00' },
  sun: null,
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Returns valid hours, or null if the input is malformed. Overnight ranges (close before open) aren't supported. */
export function validateHours(input: unknown): WeeklyHours | null {
  if (!input || typeof input !== 'object') return null;
  const result = {} as WeeklyHours;
  for (const day of DAYS) {
    const value = (input as Record<string, unknown>)[day];
    if (value === null || value === undefined) {
      result[day] = null;
      continue;
    }
    const { open, close } = value as { open?: unknown; close?: unknown };
    if (typeof open !== 'string' || typeof close !== 'string' || !TIME.test(open) || !TIME.test(close) || open >= close) {
      return null;
    }
    result[day] = { open, close };
  }
  return result;
}

export function parseHours(json: string | null): WeeklyHours {
  if (!json) return DEFAULT_HOURS;
  try {
    return validateHours(JSON.parse(json)) ?? DEFAULT_HOURS;
  } catch {
    return DEFAULT_HOURS;
  }
}

export function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The weekday and HH:MM time right now in the given timezone. */
export function localTime(timezone: string, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: part('weekday').toLowerCase().slice(0, 3) as Day, time: `${part('hour')}:${part('minute')}` };
}

/** A one-off day: closed (e.g. Christmas Day) or different hours. date is YYYY-MM-DD in the business's time. */
export interface SpecialDay {
  date: string;
  closed: boolean;
  open?: string;
  close?: string;
  label?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Valid special days, sorted, at most 60; null if the input isn't a list. */
export function validateSpecialDays(input: unknown): SpecialDay[] | null {
  if (!Array.isArray(input)) return null;
  const out: SpecialDay[] = [];
  for (const raw of input.slice(0, 60)) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const date = String(r.date ?? '');
    if (!DATE.test(date)) return null;
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, 60) : '';
    if (r.closed) out.push({ date, closed: true, ...(label ? { label } : {}) });
    else {
      const open = String(r.open ?? ''), close = String(r.close ?? '');
      if (!TIME.test(open) || !TIME.test(close) || close <= open) return null;
      out.push({ date, closed: false, open, close, ...(label ? { label } : {}) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function parseSpecialDays(json: string | null | undefined): SpecialDay[] {
  try {
    return validateSpecialDays(JSON.parse(json || '[]')) ?? [];
  } catch {
    return [];
  }
}

export const localDateIn = (timezone: string, at = new Date()) => at.toLocaleDateString('en-CA', { timeZone: timezone });

/** Whether the business is open now. Always true when office hours are turned off. Holiday hours win over the usual week. */
export function isOpen(business: Pick<Business, 'hours_enabled' | 'hours' | 'timezone'> & { special_hours?: string | null }, at = new Date()) {
  if (!business.hours_enabled) return true;
  const { day, time } = localTime(business.timezone, at);
  const special = parseSpecialDays(business.special_hours).find((s) => s.date === localDateIn(business.timezone, at));
  if (special) return !special.closed && time >= special.open! && time < special.close!;
  const today = parseHours(business.hours)[day];
  return Boolean(today && time >= today.open && time < today.close);
}

const SHORT: Record<Day, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
};

/** Opening hours in one line for customers, e.g. "Mon–Fri 9am–5pm, Sat 10am–4pm, Sun closed". */
export function hoursSummary(business: Pick<Business, 'hours_enabled' | 'hours'>) {
  if (!business.hours_enabled) return '';
  const hours = parseHours(business.hours);
  const label = (d: Day) => (hours[d] ? `${clock(hours[d]!.open)}–${clock(hours[d]!.close)}` : 'closed');
  const groups: { from: Day; to: Day; text: string }[] = [];
  for (const d of DAYS) {
    const last = groups.at(-1);
    if (last && last.text === label(d)) last.to = d;
    else groups.push({ from: d, to: d, text: label(d) });
  }
  return groups.map((g) => `${SHORT[g.from]}${g.to !== g.from ? `–${SHORT[g.to]}` : ''} ${g.text}`).join(', ');
}
