import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const sid = () => process.env.TWILIO_ACCOUNT_SID || '';
const authToken = () => process.env.TWILIO_AUTH_TOKEN || '';
// Overridable so tests can point at a fake Twilio.
const apiBase = () => (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
const accountUrl = (path: string) => `${apiBase()}/2010-04-01/Accounts/${sid()}${path}`;
const authHeader = () => 'Basic ' + Buffer.from(`${sid()}:${authToken()}`).toString('base64');

export const smsConfigured = () => Boolean(sid() && authToken());
export const publicUrl = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');

async function post(path: string, params: Record<string, string>) {
  const res = await fetch(accountUrl(path), {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(detail?.message || `Twilio returned ${res.status}`);
  }
  return res.json() as Promise<{ sid: string }>;
}

export async function sendSms(from: string, to: string, body: string) {
  await post('/Messages.json', { From: from, To: to, Body: body });
}

/** Places an outbound call that runs the given TwiML once answered. */
export async function makeCall(from: string, to: string, twimlBody: string) {
  return post('/Calls.json', { From: from, To: to, Twiml: twimlBody });
}

/** Fetches a call recording's audio from Twilio (recordings need account auth to download). */
export function fetchRecording(recordingSid: string, range?: string) {
  return fetch(accountUrl(`/Recordings/${encodeURIComponent(recordingSid)}.mp3`), {
    headers: { Authorization: authHeader(), ...(range ? { Range: range } : {}) },
  });
}

// https://www.twilio.com/docs/usage/webhooks/webhooks-security
function validSignature(signature: string | undefined, url: string, params: Record<string, string>) {
  if (!signature) return false;
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac('sha1', authToken()).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Rejects webhook requests that weren't signed by Twilio. Expects a urlencoded body parser before it. */
export function verifyTwilio(req: Request, res: Response, next: NextFunction) {
  if (!smsConfigured() || !publicUrl()) return res.status(503).send('Twilio is not configured');
  // Twilio signs the full URL it requested, including any query string.
  if (!validSignature(req.get('X-Twilio-Signature'), publicUrl() + req.originalUrl, req.body as Record<string, string>)) {
    return res.status(403).send('Invalid signature');
  }
  next();
}

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** Tagged template for TwiML: interpolated values are XML-escaped. */
export function twiml(strings: TemplateStringsArray, ...values: (string | number)[]) {
  const inner = strings.reduce((acc, str, i) => acc + str + (i < values.length ? escapeXml(String(values[i])) : ''), '');
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}
