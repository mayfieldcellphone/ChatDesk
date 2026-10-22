import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { authRouter } from './auth';
import { inboxRouter } from './inbox';
import { integrationsRouter, reviewsRouter } from './integrations';
import { metaWebhookRouter } from './meta';
import { startReviewSync } from './google';
import { smsRouter } from './sms';
import { voiceRouter } from './voice';
import { widgetRouter } from './widget';
import { leadsRouter } from './leads';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Twilio posts form-encoded bodies; these routers parse their own.
app.use('/api/sms', smsRouter);
app.use('/api/voice', voiceRouter);
// Meta signs the raw request body, so this router reads it before the JSON parser.
app.use('/api/meta', metaWebhookRouter);
app.use(express.json({ limit: '50kb' }));
app.use('/api/auth', authRouter);
app.use('/api/widget', widgetRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api', inboxRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.use('/api', (err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong' : 'Bad request' });
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(process.cwd(), 'dist');
  // Browsers must always re-check the service worker, or the installed app could keep an old one.
  app.use('/sw.js', (_req, res, next) => {
    res.set('Cache-Control', 'no-cache');
    next();
  });
  app.use('/widget.js', (_req, res, next) => {
    res.set('Cache-Control', 'public, max-age=300');
    next();
  });
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

startReviewSync();

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`ChatBird running on http://localhost:${port}`));
