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

/** Whether the business is open now. Always true when office hours are turned off. */
export function isOpen(business: Pick<Business, 'hours_enabled' | 'hours' | 'timezone'>, at = new Date()) {
  if (!business.hours_enabled) return true;
  const { day, time } = localTime(business.timezone, at);
  const today = parseHours(business.hours)[day];
  return Boolean(today && time >= today.open && time < today.close);
}
