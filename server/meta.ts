import express, { Router, type Request } from 'express';
import crypto from 'node:crypto';
import { decrypt, encrypt } from './crypto';
import {
  all, get, insertMessage, newId, now, run, upsertContact,
  type Business, type Connection, type Contact, type Conversation,
} from './db';
import { publish } from './events';
import { onInboundMessage } from './inbound';

// Facebook Messenger and Instagram messaging, via a Meta app using Facebook Login.
// Setup: docs/INTEGRATIONS.md.

const version = () => process.env.META_GRAPH_VERSION || 'v25.0';
const graphBase = () => (process.env.META_GRAPH_BASE || 'https://graph.facebook.com').replace(/\/$/, ''); // overridable for tests
const graphUrl = (path: string) => `${graphBase()}/${version()}${path}`;

export const metaConfigured = () => Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_VERIFY_TOKEN);

export const META_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'business_management',
  'instagram_basic',
  'instagram_manage_messages',
];

export class MetaError extends Error {}

async function graph<T>(path: string, init: { method?: string; token?: string; params?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  const url = new URL(graphUrl(path));
  for (const [k, v] of Object.entries(init.params ?? {})) url.searchParams.set(k, v);
  if (init.token) url.searchParams.set('access_token', init.token);
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok || data.error) throw new MetaError(data.error?.message || `Facebook returned ${res.status}`);
  return data;
}

export function metaAuthUrl(redirectUri: string, state: string) {
  const url = new URL(`https://www.facebook.com/${version()}/dialog/oauth`);
  url.searchParams.set('client_id', process.env.META_APP_ID!);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', META_SCOPES.join(','));
  url.searchParams.set('response_type', 'code');
  return url.toString();
}

interface PageInfo {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string; name?: string };
}

/**
 * Finishes Facebook Login: swaps the code for a long-lived user token, then saves each Page the
 * owner granted (and its linked Instagram account). Page tokens from a long-lived user token don't expire.
 */
export async function connectMetaAccounts(businessId: string, code: string, redirectUri: string) {
  const short = await graph<{ access_token: string }>('/oauth/access_token', {
    params: { client_id: process.env.META_APP_ID!, client_secret: process.env.META_APP_SECRET!, redirect_uri: redirectUri, code },
  });
  const long = await graph<{ access_token: string }>('/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID!,
      client_secret: process.env.META_APP_SECRET!,
      fb_exchange_token: short.access_token,
    },
  });
  const pages = await graph<{ data: PageInfo[] }>('/me/accounts', {
    token: long.access_token,
    params: { fields: 'id,name,access_token,instagram_business_account{id,username,name}', limit: '100' },
  });
  if (pages.data.length === 0) throw new MetaError('No Facebook Pages were shared. Choose at least one Page when Facebook asks.');

  const connected: string[] = [];
  for (const page of pages.data) {
    // Ask Facebook to send this Page's messages to our webhook.
    await graph(`/${page.id}/subscribed_apps`, {
      method: 'POST',
      token: page.access_token,
      params: { subscribed_fields: 'messages,messaging_postbacks,message_echoes' },
    });
    saveConnection(businessId, 'facebook', page.id, page.name, page.access_token, { pageId: page.id });
    connected.push(page.name);

    const ig = page.instagram_business_account;
    if (ig) {
      saveConnection(businessId, 'instagram', ig.id, ig.username ? `@${ig.username}` : ig.name || 'Instagram', page.access_token, { pageId: page.id });
      connected.push(ig.username ? `@${ig.username}` : 'Instagram');
    }
  }
  return connected;
}

function saveConnection(businessId: string, provider: 'facebook' | 'instagram', externalId: string, name: string, token: string, meta: object) {
  const existing = get<Connection>('SELECT * FROM connections WHERE provider = ? AND external_id = ?', provider, externalId);
  if (existing && existing.business_id !== businessId) {
    throw new MetaError(`${name} is already connected to another ChatDesk business. Disconnect it there first.`);
  }
  if (existing) {
    run('UPDATE connections SET name = ?, access_token = ?, meta = ?, last_error = NULL WHERE id = ?', name, encrypt(token), JSON.stringify(meta), existing.id);
  } else {
    run(
      'INSERT INTO connections (id, business_id, provider, external_id, name, access_token, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId(), businessId, provider, externalId, name, encrypt(token), JSON.stringify(meta), now(),
    );
  }
}

/** Sends a text reply over Messenger or Instagram. Returns Meta's message ID. */
export async function sendMetaMessage(connection: Connection, recipientId: string, text: string) {
  const { pageId } = JSON.parse(connection.meta) as { pageId: string };
  try {
    const res = await graph<{ message_id: string }>(`/${pageId}/messages`, {
      method: 'POST',
      token: decrypt(connection.access_token),
      body: { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } },
    });
    return res.message_id;
  } catch (err) {
    const message = (err as Error).message;
    // Meta only allows replies within 24 hours of the customer's last message.
    if (/outside of allowed window|24 hour/i.test(message)) {
      throw new MetaError('It’s been more than 24 hours since their last message, so Meta won’t deliver a reply. Ask them to message you again, or contact them another way.');
    }
    throw new MetaError(message);
  }
}

// ---------- Webhook ----------

export const metaWebhookRouter = Router();

// Meta calls this once when you save the webhook URL, to check it's yours.
metaWebhookRouter.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.META_VERIFY_TOKEN && metaConfigured()) {
    return res.send(String(req.query['hub.challenge'] ?? ''));
  }
  res.sendStatus(403);
});

function validSignature(req: Request & { body: Buffer }) {
  const header = req.get('X-Hub-Signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET || '').update(req.body).digest('hex');
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

interface MessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: { mid: string; text?: string; is_echo?: boolean; attachments?: { type: string }[] };
}

// The signature covers the exact bytes Meta sent, so read the body raw.
metaWebhookRouter.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!metaConfigured()) return res.sendStatus(503);
  if (!validSignature(req as Request & { body: Buffer })) return res.sendStatus(403);
  res.sendStatus(200); // Acknowledge fast; Meta retries slow webhooks.

  let payload: { object?: string; entry?: { id: string; messaging?: MessagingEvent[] }[] };
  try {
    payload = JSON.parse((req.body as Buffer).toString('utf8'));
  } catch {
    return;
  }
  const provider = payload.object === 'instagram' ? 'instagram' : payload.object === 'page' ? 'facebook' : null;
  if (!provider) return;

  for (const entry of payload.entry ?? []) {
    const connection = get<Connection>('SELECT * FROM connections WHERE provider = ? AND external_id = ?', provider, entry.id);
    if (!connection) continue;
    for (const event of entry.messaging ?? []) {
      const customerId = event.message?.is_echo ? event.recipient.id : event.sender.id;
      oneAtATime(`${connection.id}:${customerId}`, () => handleMessagingEvent(connection, event));
    }
  }
});

// Events for the same customer are handled in order, one at a time, so a repeated delivery can't
// slip past the duplicate check while the first copy is still looking up the customer's name.
const queues = new Map<string, Promise<void>>();
function oneAtATime(key: string, task: () => Promise<void>) {
  const run = (queues.get(key) ?? Promise.resolve())
    .then(task)
    .catch((err) => console.error('Meta webhook failed:', err))
    .finally(() => {
      if (queues.get(key) === run) queues.delete(key);
    });
  queues.set(key, run);
}

/** insertMessage, but a message Meta already delivered (same mid) is skipped rather than stored twice. */
function insertOnce(...args: Parameters<typeof insertMessage>) {
  try {
    return insertMessage(...args);
  } catch (err) {
    if (/UNIQUE constraint failed: messages\.external_id/.test((err as Error).message)) return null;
    throw err;
  }
}

function describeMessage(message: NonNullable<MessagingEvent['message']>) {
  if (message.text) return message.text.slice(0, 2000);
  const type = message.attachments?.[0]?.type;
  return type === 'image' ? '[Photo]' : type === 'video' ? '[Video]' : type === 'audio' ? '[Voice message]' : '[Attachment]';
}

async function handleMessagingEvent(connection: Connection, event: MessagingEvent) {
  const message = event.message;
  if (!message?.mid || get('SELECT id FROM messages WHERE external_id = ?', message.mid)) return;

  const provider = connection.provider as 'facebook' | 'instagram';
  // Echoes are messages the business sent: from ChatDesk (already stored, skipped above) or from
  // Facebook / Instagram's own apps, which we record so the thread stays complete.
  const customerId = message.is_echo ? event.recipient.id : event.sender.id;
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', connection.business_id)!;
  const conversation = await socialConversation(business, connection, customerId);

  if (message.is_echo) {
    const saved = insertOnce(conversation, 'out', provider, describeMessage(message), { externalId: message.mid });
    if (!saved) return;
    publish(`biz:${business.id}`, { type: 'message', conversationId: conversation.id, message: { ...saved, author_name: null } });
    return;
  }
  const saved = insertOnce(conversation, 'in', provider, describeMessage(message), { externalId: message.mid });
  if (saved) onInboundMessage(business, conversation, saved);
}

/** The customer's conversation for this Page/account, creating the contact (with their name) if new. */
async function socialConversation(business: Business, connection: Connection, customerId: string): Promise<Conversation> {
  const column = connection.provider === 'instagram' ? 'instagram_id' : 'facebook_id';
  let contact = get<Contact>(`SELECT * FROM contacts WHERE business_id = ? AND ${column} = ?`, business.id, customerId);
  if (!contact) {
    const name = await fetchProfileName(connection, customerId);
    contact = upsertContact(business.id, name, null, null);
    run(`UPDATE contacts SET ${column} = ? WHERE id = ?`, customerId, contact.id);
  }

  const existing = get<Conversation>(
    'SELECT * FROM conversations WHERE contact_id = ? AND connection_id = ? ORDER BY last_message_at DESC LIMIT 1',
    contact.id, connection.id,
  );
  if (existing) return existing;

  const t = now();
  const conversation: Conversation = {
    id: newId(), business_id: business.id, contact_id: contact.id, channel: connection.provider as 'facebook' | 'instagram',
    status: 'open', visitor_token: null, page_url: null, unread_count: 0, last_message_at: t, created_at: t, connection_id: connection.id,
  };
  run(
    "INSERT INTO conversations (id, business_id, contact_id, channel, status, connection_id, last_message_at, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)",
    conversation.id, business.id, contact.id, conversation.channel, connection.id, t, t,
  );
  return conversation;
}

async function fetchProfileName(connection: Connection, customerId: string) {
  const fallback = connection.provider === 'instagram' ? 'Instagram user' : 'Facebook user';
  try {
    const fields = connection.provider === 'instagram' ? 'name,username' : 'first_name,last_name';
    const p = await graph<{ first_name?: string; last_name?: string; name?: string; username?: string }>(`/${customerId}`, {
      token: decrypt(connection.access_token),
      params: { fields },
    });
    return (connection.provider === 'instagram' ? p.name || (p.username && `@${p.username}`) : [p.first_name, p.last_name].filter(Boolean).join(' ')) || fallback;
  } catch {
    return fallback; // Profile access can be restricted; the name can be edited in the inbox.
  }
}

/** Removes Facebook/Instagram connections for a Page and tells Meta to stop sending its messages. */
export async function disconnectMeta(connection: Connection) {
  const { pageId } = JSON.parse(connection.meta) as { pageId: string };
  const siblings = all<Connection>("SELECT * FROM connections WHERE business_id = ? AND provider IN ('facebook', 'instagram')", connection.business_id)
    .filter((c) => (JSON.parse(c.meta) as { pageId: string }).pageId === pageId);
  try {
    await graph(`/${pageId}/subscribed_apps`, { method: 'DELETE', token: decrypt(connection.access_token) });
  } catch (err) {
    console.error('Unsubscribing the Page failed (continuing):', err);
  }
  for (const c of siblings) run('DELETE FROM connections WHERE id = ?', c.id);
}
