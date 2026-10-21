import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.DATABASE_FILE || path.join(process.cwd(), 'data', 'chatdesk.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    widget_key TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#2563eb',
    greeting TEXT NOT NULL DEFAULT 'Hi there! How can we help? Send us a message and we''ll reply right here or by text.',
    sms_number TEXT UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS contacts_phone ON contacts(business_id, phone);

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    visitor_token TEXT,
    page_url TEXT,
    unread_count INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS conversations_inbox ON conversations(business_id, status, last_message_at);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    channel TEXT NOT NULL,
    body TEXT NOT NULL,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS saved_replies (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS saved_replies_business ON saved_replies(business_id, title);
`);

// The first release limited channel to webchat/sms with a CHECK constraint, which SQLite can't alter.
// Rebuild those tables without it so Facebook and Instagram conversations fit (SQLite's documented
// create-copy-drop-rename procedure). The channel is validated in code instead.
function dropChannelCheck(table: string) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  if (!row || !/CHECK \(channel IN/.test(row.sql)) return;
  const sql = row.sql
    .replace(/\s*CHECK \(channel IN \([^)]*\)\)/, '')
    .replace(/^CREATE TABLE "?\w+"?/, `CREATE TABLE ${table}_rebuild`);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(sql);
    db.exec(`INSERT INTO ${table}_rebuild SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_rebuild RENAME TO ${table};`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
dropChannelCheck('conversations');
dropChannelCheck('messages');
// Dropping a table drops its indexes; recreate them.
db.exec(`
  CREATE INDEX IF NOT EXISTS conversations_inbox ON conversations(business_id, status, last_message_at);
  CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
`);

// Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS, so check first.
function addColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('businesses', 'hours_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('businesses', 'timezone', "TEXT NOT NULL DEFAULT 'Australia/Sydney'");
addColumn('businesses', 'hours', 'TEXT');
addColumn(
  'businesses',
  'away_message',
  "TEXT NOT NULL DEFAULT 'Thanks for your message! We''re closed right now, but we''ll reply as soon as we open.'",
);
addColumn('businesses', 'ai_notes', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'notify_email', 'INTEGER NOT NULL DEFAULT 1');
addColumn('conversations', 'last_auto_reply_at', 'TEXT');
addColumn('conversations', 'last_email_alert_at', 'TEXT');
addColumn('messages', 'automated', 'INTEGER NOT NULL DEFAULT 0');
// Phone calls. Calls and voicemails live in the conversation timeline as messages on the 'sms'
// (phone number) channel, distinguished by kind.
addColumn('messages', 'kind', "TEXT NOT NULL DEFAULT 'text'");
addColumn('messages', 'recording_sid', 'TEXT');
addColumn('messages', 'duration', 'INTEGER');
addColumn('businesses', 'forward_number', 'TEXT');
addColumn('businesses', 'ring_seconds', 'INTEGER NOT NULL DEFAULT 20');
addColumn(
  'businesses',
  'voicemail_greeting',
  "TEXT NOT NULL DEFAULT 'Thanks for calling. Sorry we can''t take your call right now. Please leave your name, number and a short message after the beep, and we''ll get back to you soon.'",
);
addColumn('businesses', 'missed_call_text_enabled', 'INTEGER NOT NULL DEFAULT 1');
addColumn(
  'businesses',
  'missed_call_text',
  "TEXT NOT NULL DEFAULT 'Sorry we missed your call! How can we help? Reply to this text and we''ll get back to you.'",
);
addColumn('users', 'phone', 'TEXT');
addColumn('conversations', 'last_missed_text_at', 'TEXT');
// Connected accounts (Google Business Profile, Facebook, Instagram) and reviews.
addColumn('contacts', 'facebook_id', 'TEXT');
addColumn('conversations', 'connection_id', 'TEXT');
addColumn('contacts', 'instagram_id', 'TEXT');
addColumn('messages', 'external_id', 'TEXT');
addColumn('businesses', 'review_link', 'TEXT');
addColumn('businesses', 'website_url', 'TEXT');
addColumn('businesses', 'website_imported_at', 'TEXT');
addColumn(
  'businesses',
  'review_request_text',
  "TEXT NOT NULL DEFAULT 'Hi {name}, thanks for choosing {business}! If you have a minute, we''d really appreciate a quick review: {link}'",
);

// Widget placement and menu, and forwarding website enquiries to a RepairBill dashboard.
addColumn('businesses', 'widget_position', "TEXT NOT NULL DEFAULT 'right'");
addColumn('businesses', 'widget_offset_x', 'INTEGER NOT NULL DEFAULT 20');
addColumn('businesses', 'widget_offset_y', 'INTEGER NOT NULL DEFAULT 20');
addColumn('businesses', 'widget_quote', 'INTEGER NOT NULL DEFAULT 1');
addColumn('businesses', 'widget_callback', 'INTEGER NOT NULL DEFAULT 1');
addColumn('businesses', 'widget_call_number', 'TEXT');
addColumn('businesses', 'repairbill_url', 'TEXT');
addColumn('businesses', 'repairbill_key', 'TEXT');
addColumn('businesses', 'repairbill_last_sent_at', 'TEXT');
addColumn('businesses', 'repairbill_last_error', 'TEXT');

db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    call_sid TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('ringing', 'answered', 'missed')),
    has_voicemail INTEGER NOT NULL DEFAULT 0,
    -- Set once the call-ended webhook has been handled; Twilio may send it before or after the voicemail.
    ended INTEGER NOT NULL DEFAULT 0,
    duration INTEGER,
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS contacts_facebook ON contacts(business_id, facebook_id);
  CREATE INDEX IF NOT EXISTS contacts_instagram ON contacts(business_id, instagram_id);
  -- Meta can deliver the same message more than once; the unique index makes a second copy fail.
  DROP INDEX IF EXISTS messages_external;
  CREATE UNIQUE INDEX IF NOT EXISTS messages_external_unique ON messages(external_id) WHERE external_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google', 'facebook', 'instagram')),
    -- Google: accounts/{a}/locations/{l}; Facebook: Page ID; Instagram: Instagram account ID.
    external_id TEXT NOT NULL,
    name TEXT NOT NULL,
    -- Encrypted (see crypto.ts). Google keeps a refresh token; Meta uses a non-expiring Page token.
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_expires_at TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    last_synced_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (provider, external_id)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    -- Google's resource name: accounts/{a}/locations/{l}/reviews/{r}
    external_id TEXT NOT NULL UNIQUE,
    author_name TEXT NOT NULL,
    author_photo TEXT,
    rating INTEGER NOT NULL,
    comment TEXT,
    reply TEXT,
    reply_updated_at TEXT,
    review_created_at TEXT NOT NULL,
    review_updated_at TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reviews_business ON reviews(business_id, review_updated_at);

  -- One login can run several businesses (e.g. several websites). users.business_id is the one
  -- they last had open.
  CREATE TABLE IF NOT EXISTS memberships (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, business_id)
  );
  INSERT OR IGNORE INTO memberships (user_id, business_id, created_at) SELECT id, business_id, created_at FROM users;

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Server-wide values ChatDesk generates for itself (e.g. push notification keys).
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export type Channel = 'webchat' | 'sms' | 'facebook' | 'instagram';

export interface Business {
  id: string;
  name: string;
  widget_key: string;
  color: string;
  greeting: string;
  sms_number: string | null;
  hours_enabled: number;
  timezone: string;
  /** JSON-encoded WeeklyHours (see hours.ts); null means the default hours. */
  hours: string | null;
  away_message: string;
  ai_notes: string;
  forward_number: string | null;
  ring_seconds: number;
  voicemail_greeting: string;
  missed_call_text_enabled: number;
  missed_call_text: string;
  review_link: string | null;
  review_request_text: string;
  website_url: string | null;
  website_imported_at: string | null;
  widget_position: 'left' | 'right';
  widget_offset_x: number;
  widget_offset_y: number;
  widget_quote: number;
  widget_callback: number;
  widget_call_number: string | null;
  repairbill_url: string | null;
  repairbill_key: string | null;
  repairbill_last_sent_at: string | null;
  repairbill_last_error: string | null;
  created_at: string;
}

export interface Contact {
  id: string;
  business_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  facebook_id?: string | null;
  instagram_id?: string | null;
}

export interface Conversation {
  id: string;
  business_id: string;
  contact_id: string;
  channel: Channel;
  status: 'open' | 'closed';
  visitor_token: string | null;
  page_url: string | null;
  unread_count: number;
  last_message_at: string;
  created_at: string;
  /** For Facebook/Instagram conversations: the connected Page or account the customer messaged. */
  connection_id?: string | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  direction: 'in' | 'out';
  channel: Channel;
  body: string;
  author_id: string | null;
  automated: number;
  kind: MessageKind;
  recording_sid: string | null;
  duration: number | null;
  external_id: string | null;
  created_at: string;
}

export type Provider = 'google' | 'facebook' | 'instagram';

export interface Connection {
  id: string;
  business_id: string;
  provider: Provider;
  external_id: string;
  name: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  meta: string;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface Review {
  id: string;
  business_id: string;
  connection_id: string;
  external_id: string;
  author_name: string;
  author_photo: string | null;
  rating: number;
  comment: string | null;
  reply: string | null;
  reply_updated_at: string | null;
  review_created_at: string;
  review_updated_at: string;
  seen: number;
  created_at: string;
}

/** quote and callback: requests sent from the website widget's menu. */
export type MessageKind = 'text' | 'call' | 'voicemail' | 'quote' | 'callback';

export interface Call {
  id: string;
  business_id: string;
  conversation_id: string;
  call_sid: string;
  status: 'ringing' | 'answered' | 'missed';
  has_voicemail: number;
  ended: number;
  duration: number | null;
  message_id: string | null;
  created_at: string;
}

export interface SavedReply {
  id: string;
  business_id: string;
  title: string;
  body: string;
  created_at: string;
}

export const now = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

export function get<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: (string | number | null)[]) {
  return db.prepare(sql).run(...params);
}

export interface MessageOptions {
  authorId?: string | null;
  automated?: boolean;
  kind?: MessageKind;
  recordingSid?: string | null;
  duration?: number | null;
  externalId?: string | null;
}

export function insertMessage(
  conversation: Conversation,
  direction: 'in' | 'out',
  channel: Channel,
  body: string,
  { authorId = null, automated = false, kind = 'text', recordingSid = null, duration = null, externalId = null }: MessageOptions = {},
): Message {
  const message: Message = {
    id: newId(),
    conversation_id: conversation.id,
    direction,
    channel,
    body,
    author_id: authorId,
    automated: automated ? 1 : 0,
    kind,
    recording_sid: recordingSid,
    duration,
    external_id: externalId,
    created_at: now(),
  };
  run(
    `INSERT INTO messages (id, conversation_id, direction, channel, body, author_id, automated, kind, recording_sid, duration, external_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    message.id, message.conversation_id, direction, channel, body, authorId, message.automated, kind, recordingSid, duration, externalId, message.created_at,
  );
  // A customer message reopens the conversation and counts as unread; a staff reply clears unread.
  // Automated replies (away messages) leave unread alone so the team still sees the chat needs an answer.
  if (direction === 'in') {
    run(
      "UPDATE conversations SET last_message_at = ?, status = 'open', unread_count = unread_count + 1 WHERE id = ?",
      message.created_at, conversation.id,
    );
  } else if (automated) {
    run('UPDATE conversations SET last_message_at = ? WHERE id = ?', message.created_at, conversation.id);
  } else {
    run('UPDATE conversations SET last_message_at = ?, unread_count = 0 WHERE id = ?', message.created_at, conversation.id);
  }
  return message;
}

/** Finds a contact by phone or email within a business, creating one if none matches. */
export function upsertContact(businessId: string, name: string, phone: string | null, email: string | null): Contact {
  const existing =
    (phone && get<Contact>('SELECT * FROM contacts WHERE business_id = ? AND phone = ?', businessId, phone)) ||
    (email && get<Contact>('SELECT * FROM contacts WHERE business_id = ? AND email = ?', businessId, email)) ||
    undefined;
  if (existing) {
    run(
      'UPDATE contacts SET name = ?, phone = COALESCE(?, phone), email = COALESCE(?, email) WHERE id = ?',
      name || existing.name, phone, email, existing.id,
    );
    return get<Contact>('SELECT * FROM contacts WHERE id = ?', existing.id)!;
  }
  const contact: Contact = { id: newId(), business_id: businessId, name, phone, email };
  run(
    'INSERT INTO contacts (id, business_id, name, phone, email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    contact.id, businessId, name, phone, email, now(),
  );
  return contact;
}

/** Normalizes a typed phone number to E.164 (e.g. +61400123456), or null if it can't be. */
export function normalizePhone(input: string | undefined | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  let e164: string;
  if (trimmed.startsWith('+')) {
    e164 = '+' + digits;
  } else if (trimmed.startsWith('00')) {
    e164 = '+' + digits.slice(2);
  } else {
    const cc = process.env.DEFAULT_COUNTRY_CODE;
    if (!cc) return null;
    e164 = cc.replace(/[^\d+]/g, '') + digits.replace(/^0+/, '');
  }
  return /^\+\d{8,15}$/.test(e164) ? e164 : null;
}
