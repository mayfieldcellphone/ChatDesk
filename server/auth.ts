import { Router, type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { get, newId, now, run, type Business } from './db';
import { rateLimit } from './rateLimit';

const isProd = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET && isProd) throw new Error('JWT_SECRET must be set in production');
const secret = JWT_SECRET || 'dev-only-insecure-secret';

const COOKIE = 'chatdesk_session';
const SESSION_DAYS = 30;

export interface Session {
  userId: string;
  businessId: string;
}

declare global {
  namespace Express {
    interface Request {
      session?: Session;
    }
  }
}

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setSession(res: Response, session: Session) {
  const token = jwt.sign(session, secret, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, COOKIE);
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const { userId, businessId } = jwt.verify(token, secret) as Session;
    // The user may have been deleted since the cookie was issued.
    if (!get('SELECT id FROM users WHERE id = ? AND business_id = ?', userId, businessId)) {
      return res.status(401).json({ error: 'Not signed in' });
    }
    req.session = { userId, businessId };
    next();
  } catch {
    res.status(401).json({ error: 'Not signed in' });
  }
}

export const authRouter = Router();
authRouter.use(rateLimit('auth', 20, 15 * 60 * 1000));

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

authRouter.post('/signup', async (req, res) => {
  const businessName = str(req.body.businessName);
  const name = str(req.body.name);
  const email = str(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!businessName || !name) return res.status(400).json({ error: 'Business name and your name are required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (get('SELECT id FROM users WHERE email = ?', email)) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const business: Pick<Business, 'id' | 'name' | 'widget_key'> = {
    id: newId(),
    name: businessName,
    widget_key: crypto.randomBytes(12).toString('base64url'),
  };
  const userId = newId();
  const hash = await bcrypt.hash(password, 12);
  run('INSERT INTO businesses (id, name, widget_key, created_at) VALUES (?, ?, ?, ?)', business.id, business.name, business.widget_key, now());
  run(
    'INSERT INTO users (id, business_id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    userId, business.id, name, email, hash, now(),
  );

  setSession(res, { userId, businessId: business.id });
  res.status(201).json({ ok: true });
});

authRouter.post('/login', async (req, res) => {
  const email = str(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = get<{ id: string; business_id: string; password_hash: string }>(
    'SELECT id, business_id, password_hash FROM users WHERE email = ?',
    email,
  );
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  setSession(res, { userId: user.id, businessId: user.business_id });
  res.json({ ok: true });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});
