/**
 * Reads a customer list in the browser, so only names, numbers, emails and last-contact dates are sent
 * to ChatBird, never message text. Understands:
 * - Android "SMS Backup & Restore" XML (one row per text; grouped into one customer per number)
 * - CSV/TSV exports (Birdeye, RepairBill, iMazing message exports, spreadsheets), by their column names
 * - a plain list of numbers or emails, one per line
 */

export interface ImportRow {
  phone?: string;
  email?: string;
  name?: string;
  lastContactAt?: string;
  /** Saved in the phone's contacts under a name (likely a friend or family member, not a customer). */
  saved?: boolean;
  messages?: number;
}

export interface ParsedFile {
  kind: 'sms-backup' | 'table' | 'list';
  rows: ImportRow[];
  ignored: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A grouping key for a number: digits only, Australian +61 shown as 0. */
export function phoneKey(raw: string) {
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+61')) d = '0' + d.slice(3);
  else if (d.startsWith('61') && d.length === 11) d = '0' + d.slice(2);
  return d.replace(/\D/g, '');
}

/** Australian mobile (04…), or any international number with a + that isn't Australian. */
export const isMobileNumber = (raw: string) => {
  const key = phoneKey(raw);
  return /^04\d{8}$/.test(key) || (raw.trim().startsWith('+') && !raw.trim().startsWith('+61') && key.length >= 8);
};

// "Hi, this is Sarah", "my name is John Smith", "It's Mike here", "Thanks, Priya"
const NAME_IN_TEXT = /\b(?:[Tt]his is|[Mm]y name is|[Mm]y name['’]s|[Ii]t['’]?s|I am|I['’]m)\s+([A-Z][a-z]{1,15})(?:\s+([A-Z][a-z]{1,20}))?\b/;
const NOT_NAMES = new Set(['Just', 'Sorry', 'Still', 'Here', 'Coming', 'Ready', 'Fine', 'Good', 'Great', 'Okay', 'Ok', 'Not', 'Going', 'Running', 'Outside', 'On', 'At', 'The', 'Your', 'My', 'Me', 'Is', 'In', 'Apple', 'Samsung', 'Iphone', 'Ipad']);

function nameFromText(text: string) {
  const m = text.match(NAME_IN_TEXT);
  if (!m || NOT_NAMES.has(m[1])) return undefined;
  return m[2] && !NOT_NAMES.has(m[2]) ? `${m[1]} ${m[2]}` : m[1];
}

const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()],
  );

function attrs(tag: string) {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-z_]+)="([^"]*)"/gi)) out[m[1]] = decode(m[2]);
  return out;
}

/** Android SMS Backup & Restore: <sms address date type body contact_name/> and <mms address date …>. */
function parseSmsBackup(text: string): ParsedFile {
  const byNumber = new Map<string, ImportRow & { key: string }>();
  let ignored = 0;
  for (const m of text.matchAll(/<(sms|mms)\s[^>]*?>/g)) {
    const a = attrs(m[0]);
    // Group chats list several numbers separated by "~"; skip them.
    if (!a.address || a.address.includes('~')) {
      ignored++;
      continue;
    }
    const key = phoneKey(a.address);
    if (key.length < 8) {
      ignored++; // short codes: banks, delivery services, one-time codes
      continue;
    }
    const at = Number(a.date);
    const row = byNumber.get(key) ?? { key, phone: a.address, messages: 0 };
    row.messages = (row.messages ?? 0) + 1;
    if (at && (!row.lastContactAt || at > Date.parse(row.lastContactAt))) row.lastContactAt = new Date(at).toISOString();
    if (a.contact_name && a.contact_name !== '(Unknown)' && a.contact_name !== 'null') {
      row.saved = true;
      row.name = a.contact_name;
    }
    // type 1 = received: the customer may have said their name.
    if (!row.name && m[1] === 'sms' && a.type === '1' && a.body) row.name = nameFromText(a.body);
    byNumber.set(key, row);
  }
  return { kind: 'sms-backup', rows: [...byNumber.values()].map(({ key: _key, ...r }) => r), ignored };
}

/** Splits CSV or tab-separated text into rows, honouring quoted cells. */
export function parseTable(text: string): string[][] {
  const firstLine = text.split('\n', 1)[0];
  const sep = firstLine.includes('\t') ? '\t' : firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const find = (header: string[], patterns: RegExp[], not?: RegExp) => {
  for (const p of patterns) {
    const i = header.findIndex((h) => p.test(h) && !(not && not.test(h)));
    if (i >= 0) return i;
  }
  return -1;
};

function parseDate(value: string) {
  const v = value.trim();
  if (!v) return undefined;
  // 21/10/2026 or 21/10/2026 14:05 (Australian day-first)
  const au = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2}))?/);
  if (au) {
    const year = au[3].length === 2 ? 2000 + Number(au[3]) : Number(au[3]);
    const d = new Date(year, Number(au[2]) - 1, Number(au[1]), Number(au[4] ?? 12), Number(au[5] ?? 0));
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (/^\d{12,13}$/.test(v)) return new Date(Number(v)).toISOString();
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function parseCsv(text: string): ParsedFile {
  const table = parseTable(text);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const phoneCol = find(header, [/^(mobile|mobile phone|mobile number|cell|cell phone)$/, /mobile/, /phone/, /^(number|contact number)$/, /^chat session$/, /sender|address|handle|from|recipient/], /type|label|home|work|office|fax/);
  const emailCol = find(header, [/^e-?mail( address)?$/, /e-?mail/]);
  const nameCol = find(header, [/^(name|full name|customer name|contact name|customer|contact)$/, /^display name$/, /(^| )name$/], /first|last|given|family|sur|business|company|chat/);
  const firstCol = find(header, [/^first( name)?$/, /first|given/]);
  const lastCol = find(header, [/^last( name)?$/, /surname|family|last name/]);
  const dateCol = find(header, [/last (contact|visit|activity|message|seen)/, /^(date|message date|sent|time|timestamp)$/, /date|time/], /birth|dob|created/);
  if (phoneCol < 0 && emailCol < 0) return parseList(text);

  const byKey = new Map<string, ImportRow>();
  let ignored = 0;
  for (const cells of table.slice(1)) {
    const phone = phoneCol >= 0 ? (cells[phoneCol] ?? '').trim() : '';
    const emailRaw = emailCol >= 0 ? (cells[emailCol] ?? '').trim().toLowerCase() : '';
    const email = EMAIL.test(emailRaw) ? emailRaw : undefined;
    const pKey = phone ? phoneKey(phone) : '';
    if ((!pKey || pKey.length < 8) && !email) {
      ignored++;
      continue;
    }
    const key = pKey.length >= 8 ? pKey : email!;
    const name =
      (nameCol >= 0 && cells[nameCol]?.trim()) ||
      [firstCol >= 0 ? cells[firstCol] : '', lastCol >= 0 ? cells[lastCol] : ''].map((s) => (s ?? '').trim()).filter(Boolean).join(' ') ||
      undefined;
    const last = dateCol >= 0 ? parseDate(cells[dateCol] ?? '') : undefined;
    const row = byKey.get(key) ?? { messages: 0 };
    row.phone ||= pKey.length >= 8 ? phone : undefined;
    row.email ||= email;
    if (name && !/^\+?[\d\s()-]+$/.test(name)) row.name ||= name;
    if (last && (!row.lastContactAt || last > row.lastContactAt)) row.lastContactAt = last;
    row.messages = (row.messages ?? 0) + 1;
    byKey.set(key, row);
  }
  return { kind: 'table', rows: [...byKey.values()], ignored };
}

function parseList(text: string): ParsedFile {
  const seen = new Map<string, ImportRow>();
  let ignored = 0;
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim().replace(/^"|"$/g, '');
    if (!value) continue;
    if (EMAIL.test(value.toLowerCase())) seen.set(value.toLowerCase(), { email: value.toLowerCase() });
    else if (phoneKey(value).length >= 8 && phoneKey(value).length <= 15) seen.set(phoneKey(value), { phone: value });
    else ignored++;
  }
  return { kind: 'list', rows: [...seen.values()], ignored };
}

export function parseContactsFile(text: string): ParsedFile {
  const head = text.slice(0, 2000);
  if (/<smses|<sms\s/i.test(head) || /<sms\s[^>]*address=/i.test(text.slice(0, 200_000))) return parseSmsBackup(text);
  if (/[,;\t]/.test(text.split('\n', 1)[0])) return parseCsv(text);
  return parseList(text);
}
