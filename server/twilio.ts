import crypto from 'node:crypto';

const sid = () => process.env.TWILIO_ACCOUNT_SID || '';
const authToken = () => process.env.TWILIO_AUTH_TOKEN || '';

export const smsConfigured = () => Boolean(sid() && authToken());

export async function sendSms(from: string, to: string, body: string) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid()}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid()}:${authToken()}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(detail?.message || `Twilio returned ${res.status}`);
  }
}

// https://www.twilio.com/docs/usage/webhooks/webhooks-security
export function validTwilioSignature(signature: string | undefined, url: string, params: Record<string, string>) {
  if (!signature) return false;
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac('sha1', authToken()).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
