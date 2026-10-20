import type { NextFunction, Request, Response } from 'express';

/** Small in-memory fixed-window limiter, keyed by client IP. Enough for a single server. */
export function rateLimit(name: string, max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  setInterval(() => {
    const t = Date.now();
    for (const [key, hit] of hits) if (hit.resetAt <= t) hits.delete(key);
  }, windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${name}:${req.ip}`;
    const t = Date.now();
    let hit = hits.get(key);
    if (!hit || hit.resetAt <= t) hits.set(key, (hit = { count: 0, resetAt: t + windowMs }));
    if (++hit.count > max) {
      res.set('Retry-After', String(Math.ceil((hit.resetAt - t) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    next();
  };
}
