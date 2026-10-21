import { now, run, type Business } from './db';
import { assertPublicHost } from './website';

/**
 * Sends website enquiries on to a RepairBill dashboard (its "web integration" leads API), so a site
 * needs only the ChatBird widget. The key is the RepairBill widget API key from its Settings.
 */

export type LeadType = 'contact' | 'quote' | 'callback';

export interface Lead {
  type: LeadType;
  name: string;
  phone: string | null;
  email: string | null;
  message: string;
  pageUrl: string | null;
  conversationId?: string;
}

const TIMEOUT_MS = 10_000;

export const repairbillConfigured = (b: Business) => Boolean(b.repairbill_url && b.repairbill_key);

/** The address the owner typed, tidied to https://host[/path] without a trailing slash. */
export function normalizeRepairbillUrl(value: string) {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  // Plain http only for hosts listed for local testing (see website.ts).
  const testHost = (process.env.WEBSITE_FETCH_ALLOW_PRIVATE || '').split(',').map((h) => h.trim()).includes(url.hostname);
  if (url.protocol !== 'https:' && !(testHost && url.protocol === 'http:')) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function post(business: Business, lead: Lead) {
  const url = new URL(`${business.repairbill_url}/api/web-integration/leads`);
  await assertPublicHost(url);
  const link = process.env.PUBLIC_URL && lead.conversationId
    ? `${process.env.PUBLIC_URL.replace(/\/$/, '')}/?business=${business.id}&conversation=${lead.conversationId}`
    : undefined;
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${business.repairbill_key}` },
    body: JSON.stringify({
      customerName: lead.name,
      customerEmail: lead.email || undefined,
      customerPhone: lead.phone || undefined,
      message: lead.message,
      type: lead.type,
      metadata: { source: lead.pageUrl || 'Website chat', integratedVia: 'ChatBird', ...(link ? { chatdeskLink: link } : {}) },
    }),
  });
  if (res.status === 401) throw new Error('RepairBill didn’t accept the API key. Copy it again from RepairBill → Settings.');
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error || `RepairBill answered ${res.status}. Check the address.`);
  }
}

/** Forwards one lead and records the outcome for the Integrations page. Throws so a test can show the error. */
export async function sendLead(business: Business, lead: Lead) {
  try {
    await post(business, lead);
    run('UPDATE businesses SET repairbill_last_sent_at = ?, repairbill_last_error = NULL WHERE id = ?', now(), business.id);
  } catch (err) {
    const message = (err as Error).name === 'TimeoutError' ? 'RepairBill didn’t answer in time.' : (err as Error).message;
    run('UPDATE businesses SET repairbill_last_error = ? WHERE id = ?', message, business.id);
    throw new Error(message);
  }
}

/** Fire-and-forget version for new website conversations. */
export function forwardLead(business: Business, lead: Lead) {
  if (!repairbillConfigured(business)) return;
  sendLead(business, lead).catch((err) => console.error(`RepairBill forward failed for ${business.name}:`, err.message));
}
