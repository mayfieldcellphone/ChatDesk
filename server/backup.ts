import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { all, databaseFile, db } from './db';
import { requireAuth } from './auth';
import { isAdmin, config } from './config';
import { emailConfigured } from './notify';
import nodemailer from 'nodemailer';

/**
 * Daily backups of the whole database, kept next to it on the server (the last 14 days), plus a
 * copy emailed to the ChatBird owner every Monday so one exists off the server. Settings → Backups
 * lists them, makes one on demand and downloads them.
 */
const dir = path.join(path.dirname(databaseFile), 'backups');
const KEEP = Number(process.env.BACKUP_KEEP) || 14;
const EMAIL_MAX_BYTES = 20 * 1024 * 1024; // Gmail and most mail servers take up to 25 MB
const TICK_MS = Number(process.env.BACKUP_TICK_MS) || 60 * 60 * 1000;
const NAME = /^chatdesk-\d{4}-\d{2}-\d{2}(-\d{6})?\.db\.gz$/;

const sydneyDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: process.env.BACKUP_TIMEZONE || 'Australia/Sydney' });
const sydneyHour = () => Number(new Date().toLocaleString('en-AU', { timeZone: process.env.BACKUP_TIMEZONE || 'Australia/Sydney', hour: '2-digit', hour12: false }));

export function listBackups() {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => NAME.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, bytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A consistent copy of the live database (VACUUM INTO), gzipped. Older ones beyond KEEP are removed. */
export async function runBackup(manual = false) {
  if (databaseFile === ':memory:') throw new Error('No database file to back up');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = manual ? `${sydneyDate()}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}` : sydneyDate();
  const raw = path.join(dir, `chatdesk-${stamp}.db`);
  if (fs.existsSync(raw)) fs.unlinkSync(raw);
  db.exec(`VACUUM INTO '${raw.replace(/'/g, "''")}'`);
  await pipeline(fs.createReadStream(raw), zlib.createGzip({ level: 9 }), fs.createWriteStream(`${raw}.gz`));
  fs.unlinkSync(raw);
  // Keep the newest daily ones; on-demand copies count too.
  for (const old of listBackups().slice(KEEP)) fs.unlinkSync(path.join(dir, old.name));
  return listBackups()[0];
}

const owners = () =>
  all<{ id: string; email: string }>('SELECT id, email FROM users ORDER BY created_at').filter((u) => isAdmin(u.id)).map((u) => u.email);

/** Emails the backup to the ChatBird owner, or a note if it's too big for email. */
async function emailBackup(file: { name: string; bytes: number }) {
  if (!emailConfigured()) return false;
  const to = owners();
  if (to.length === 0) return false;
  const port = Number(config('SMTP_PORT')) || 587;
  const mailer = nodemailer.createTransport({
    host: config('SMTP_HOST'),
    port,
    secure: port === 465,
    auth: config('SMTP_USER') ? { user: config('SMTP_USER'), pass: config('SMTP_PASS') } : undefined,
  });
  const mb = (file.bytes / 1024 / 1024).toFixed(1);
  const small = file.bytes <= EMAIL_MAX_BYTES;
  await mailer.sendMail({
    from: config('SMTP_FROM'),
    to,
    subject: `ChatBird weekly backup ${file.name} (${mb} MB)`,
    text: small
      ? `This week's ChatBird backup is attached. Keep this email: if the server is ever lost, ChatBird can be restored from this file.\n\nBackups are also kept on the server for ${KEEP} days (Settings → Backups).`
      : `This week's ChatBird backup is ${mb} MB, too big to email. Download it from ChatBird (Settings → Backups) and keep it somewhere safe, e.g. Google Drive.`,
    attachments: small ? [{ filename: file.name, path: path.join(dir, file.name) }] : [],
  });
  return true;
}

let busy = false;
let emailedOn = '';
async function tick() {
  if (busy || databaseFile === ':memory:') return;
  busy = true;
  try {
    const today = sydneyDate();
    // Once a day, after 3am when the shop is quiet.
    if (sydneyHour() >= 3 && !listBackups().some((b) => b.name === `chatdesk-${today}.db.gz`)) {
      const made = await runBackup();
      console.log(`Backup saved: ${made.name} (${(made.bytes / 1024 / 1024).toFixed(1)} MB)`);
      const monday = new Date().toLocaleDateString('en-AU', { timeZone: process.env.BACKUP_TIMEZONE || 'Australia/Sydney', weekday: 'short' }) === 'Mon';
      if ((monday || process.env.BACKUP_EMAIL_DAILY) && emailedOn !== today) {
        emailedOn = today;
        await emailBackup(made).catch((err) => console.error('Backup email failed:', err.message));
      }
    }
  } catch (err) {
    console.error('Backup failed:', err);
  } finally {
    busy = false;
  }
}

export function startBackups() {
  setTimeout(tick, Math.min(30_000, TICK_MS)).unref();
  setInterval(tick, TICK_MS).unref();
}

// ---------- Settings → Backups (ChatBird owner only) ----------

export const backupRouter = Router();
backupRouter.use(requireAuth, (req, res, next) => (isAdmin(req.session!.userId) ? next() : res.status(403).json({ error: 'Only the ChatBird owner can see backups' })));

backupRouter.get('/', (_req, res) => res.json({ backups: listBackups(), keep: KEEP, emailConfigured: emailConfigured(), owners: owners() }));

backupRouter.post('/', async (_req, res) => {
  try {
    res.status(201).json({ backup: await runBackup(true) });
  } catch (err) {
    res.status(500).json({ error: `Backup failed: ${(err as Error).message}` });
  }
});

backupRouter.post('/email', async (_req, res) => {
  const latest = listBackups()[0];
  if (!latest) return res.status(400).json({ error: 'Make a backup first' });
  if (!emailConfigured()) return res.status(400).json({ error: 'Email isn’t set up (Integrations → Server keys → SMTP)' });
  try {
    await emailBackup(latest);
    res.json({ ok: true, to: owners() });
  } catch (err) {
    res.status(502).json({ error: `Email failed: ${(err as Error).message}` });
  }
});

backupRouter.get('/:name', (req, res) => {
  if (!NAME.test(req.params.name) || !fs.existsSync(path.join(dir, req.params.name))) return res.sendStatus(404);
  res.download(path.join(dir, req.params.name));
});
