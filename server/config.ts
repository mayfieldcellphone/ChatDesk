import { decrypt, encrypt } from './crypto';
import { all, get, run } from './db';

// Integration keys. Each is read from the environment (e.g. Railway variables) first, otherwise from
// the encrypted copy the owner saved on ChatBird's Integrations page, so keys can be managed without
// the hosting dashboard.

export const MANAGED_KEYS = [
  { name: 'META_APP_ID', group: 'Facebook & Instagram', secret: false },
  { name: 'META_APP_SECRET', group: 'Facebook & Instagram', secret: true },
  { name: 'META_LOGIN_CONFIG_ID', group: 'Facebook & Instagram', secret: false },
  { name: 'META_VERIFY_TOKEN', group: 'Facebook & Instagram', secret: false },
  { name: 'GOOGLE_CLIENT_ID', group: 'Google Business Profile', secret: false },
  { name: 'GOOGLE_CLIENT_SECRET', group: 'Google Business Profile', secret: true },
  { name: 'TWILIO_ACCOUNT_SID', group: 'Twilio (texts & calls)', secret: false },
  { name: 'TWILIO_AUTH_TOKEN', group: 'Twilio (texts & calls)', secret: true },
  { name: 'ANTHROPIC_API_KEY', group: 'AI replies (Anthropic)', secret: true },
  { name: 'OPENAI_API_KEY', group: 'Voicemail transcripts (OpenAI)', secret: true },
  { name: 'SMTP_HOST', group: 'Email alerts', secret: false },
  { name: 'SMTP_PORT', group: 'Email alerts', secret: false },
  { name: 'SMTP_USER', group: 'Email alerts', secret: false },
  { name: 'SMTP_PASS', group: 'Email alerts', secret: true },
  { name: 'SMTP_FROM', group: 'Email alerts', secret: false },
] as const;
export type ManagedKey = (typeof MANAGED_KEYS)[number]['name'];

const saved = new Map<string, string>();
for (const row of all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'cfg:%'")) {
  try {
    saved.set(row.key.slice(4), decrypt(row.value));
  } catch {
    console.error(`Couldn't decrypt saved key ${row.key.slice(4)} (encryption key changed?); enter it again.`);
  }
}

const listeners: (() => void)[] = [];
/** Runs when a saved key changes, e.g. to rebuild the email connection. */
export const onConfigChange = (fn: () => void) => listeners.push(fn);

export function config(name: ManagedKey | 'ANTHROPIC_MODEL' | 'OPENAI_TRANSCRIBE_MODEL'): string | undefined {
  return process.env[name] || saved.get(name) || undefined;
}

export function saveConfig(name: ManagedKey, value: string | null) {
  if (value) {
    run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", `cfg:${name}`, encrypt(value));
    saved.set(name, value);
  } else {
    run('DELETE FROM settings WHERE key = ?', `cfg:${name}`);
    saved.delete(name);
  }
  for (const fn of listeners) fn();
}

/** Which keys are set and where, without revealing secret values. */
export function configStatus() {
  return MANAGED_KEYS.map((k) => {
    const fromEnv = Boolean(process.env[k.name]);
    const value = config(k.name);
    return {
      name: k.name,
      group: k.group,
      secret: k.secret,
      source: fromEnv ? 'server' : value ? 'saved' : null,
      // Non-secret values are shown in full; secrets only by their last 4 characters.
      preview: value ? (k.secret ? `••••${value.slice(-4)}` : value) : null,
    };
  });
}

/** The ChatBird owner: anyone listed in ADMIN_EMAILS, or else the first account created. */
export function isAdmin(userId: string) {
  const user = get<{ email: string }>('SELECT email FROM users WHERE id = ?', userId);
  if (!user) return false;
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (admins.length > 0) return admins.includes(user.email.toLowerCase());
  return get<{ id: string }>('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1')?.id === userId;
}
