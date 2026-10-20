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
    channel TEXT NOT NULL CHECK (channel IN ('webchat', 'sms')),
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
    channel TEXT NOT NULL CHECK (channel IN ('webchat', 'sms')),
    body TEXT NOT NULL,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
`);

export type Channel = 'webchat' | 'sms';

export interface Business {
  id: string;
  name: string;
  widget_key: string;
  color: string;
  greeting: string;
  sms_number: string | null;
  created_at: string;
}

export interface Contact {
  id: string;
  business_id: string;
  name: string;
  phone: string | null;
  email: string | null;
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
}

export interface Message {
  id: string;
  conversation_id: string;
  direction: 'in' | 'out';
  channel: Channel;
  body: string;
  author_id: string | null;
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

export function insertMessage(
  conversation: Conversation,
  direction: 'in' | 'out',
  channel: Channel,
  body: string,
  authorId: string | null = null,
): Message {
  const message: Message = {
    id: newId(),
    conversation_id: conversation.id,
    direction,
    channel,
    body,
    author_id: authorId,
    created_at: now(),
  };
  run(
    'INSERT INTO messages (id, conversation_id, direction, channel, body, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    message.id, message.conversation_id, direction, channel, body, authorId, message.created_at,
  );
  // A customer message reopens the conversation and counts as unread; a reply clears unread.
  if (direction === 'in') {
    run(
      "UPDATE conversations SET last_message_at = ?, status = 'open', unread_count = unread_count + 1 WHERE id = ?",
      message.created_at, conversation.id,
    );
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
