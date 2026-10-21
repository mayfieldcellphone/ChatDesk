import webpush from 'web-push';
import { all, get, run } from './db';

// Web push notifications for the installed app and desktop browsers. The keys are generated once
// and kept in the database, so there's nothing to configure (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
// override them if set).

function vapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const saved = get<{ value: string }>("SELECT value FROM settings WHERE key = 'vapid'");
  if (saved) return JSON.parse(saved.value) as { publicKey: string; privateKey: string };
  const keys = webpush.generateVAPIDKeys();
  run("INSERT INTO settings (key, value) VALUES ('vapid', ?)", JSON.stringify(keys));
  return keys;
}

const keys = vapidKeys();
webpush.setVapidDetails(`mailto:${process.env.VAPID_CONTACT || process.env.SMTP_FROM?.match(/<?([^<>\s]+@[^<>\s]+)>?/)?.[1] || 'admin@chatdesk.invalid'}`, keys.publicKey, keys.privateKey);

export const pushPublicKey = () => keys.publicKey;

export interface PushPayload {
  title: string;
  body: string;
  /** Where tapping the notification goes, e.g. /?business=..&conversation=.. */
  url: string;
  /** Notifications with the same tag replace each other (one per conversation). */
  tag: string;
}

/** Sends a notification to every device of everyone in the business. Expired subscriptions are removed. */
export async function pushToBusiness(businessId: string, payload: PushPayload) {
  const subs = all<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
       JOIN memberships m ON m.user_id = s.user_id WHERE m.business_id = ?`,
    businessId,
  );
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
        else console.error('Push failed:', status, (err as Error).message);
      }
    }),
  );
}
