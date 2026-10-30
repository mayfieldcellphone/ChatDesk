import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { authRouter, readSession, signOAuthState, verifyOAuthState } from './auth';
import { inboxRouter } from './inbox';
import { integrationsRouter, reviewsRouter } from './integrations';
import { metaWebhookRouter } from './meta';
import { connectGoogleLocations, googleAuthUrl, googleRedirectUri, startReviewSync, syncReviews } from './google';
import { smsRouter } from './sms';
import { voiceRouter } from './voice';
import { widgetRouter } from './widget';
import { leadsRouter } from './leads';
import { reportsRouter, startWeeklyReports } from './reports';
import { marketingRouter, startCampaigns, unsubscribeRouter } from './campaigns';
import { attachReceptionist, receptionistRouter } from './receptionist';
import { mediaRouter, postsRouter, startScheduledPosts } from './posts';
import { all, type Connection } from './db';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Google Business Profile OAuth routes (exact paths specified in requirements)
app.get('/api/google/connect', (req, res) => {
  // Only a signed-in owner can connect Google to their own business.
  const session = readSession(req);
  if (!session) return res.redirect('/?error=' + encodeURIComponent('Please sign in to ChatBird first.'));
  const state = signOAuthState({ provider: 'google', businessId: session.businessId, userId: session.userId });
  const redirectUri = googleRedirectUri();
  res.redirect(googleAuthUrl(redirectUri, state));
});

app.get('/api/google/callback', async (req, res) => {
  const state = verifyOAuthState(String(req.query.state ?? ''));
  // The person finishing sign-in must be the one who started it (as on the Integrations page).
  if (!state || state.provider !== 'google' || readSession(req)?.userId !== state.userId) {
    return res.redirect('/?view=integrations&error=' + encodeURIComponent('That sign-in link expired. Try connecting again.'));
  }
  if (req.query.error) {
    return res.redirect('/?view=integrations&error=' + encodeURIComponent(`Google sign-in was cancelled: ${req.query.error}`));
  }
  try {
    const code = String(req.query.code ?? '');
    const names = await connectGoogleLocations(state.businessId, code, googleRedirectUri());
    // Immediately pull reviews so Reviews tab is populated
    for (const c of all<Connection>("SELECT * FROM connections WHERE business_id = ? AND provider = 'google'", state.businessId)) {
      syncReviews(c).catch((err) => console.error('Initial review sync failed:', (err as Error).message));
    }
    res.redirect(`/?view=reviews&connected=${encodeURIComponent(names.join(', '))}`);
  } catch (err) {
    console.error('Google callback error:', err);
    res.redirect(`/?view=integrations&error=${encodeURIComponent((err as Error).message)}`);
  }
});

// Twilio posts form-encoded bodies; these routers parse their own.
app.use('/api/sms', smsRouter);
app.use('/api/voice', voiceRouter);
// Meta signs the raw request body, so this router reads it before the JSON parser.
app.use('/api/meta', metaWebhookRouter);
// Customer imports send up to 2,000 rows at a time.
app.use('/api/marketing/contacts/import', express.json({ limit: '2mb' }));
app.use(express.json({ limit: '50kb' }));
app.use('/api/unsubscribe', unsubscribeRouter);
// Post images, fetched by Google, Facebook and Instagram.
app.use('/media', mediaRouter);
app.use('/api/auth', authRouter);
app.use('/api/widget', widgetRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/marketing', marketingRouter);
app.use('/api/receptionist', receptionistRouter);
app.use('/api/posts', postsRouter);
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
startWeeklyReports();
startCampaigns();
startScheduledPosts();

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => console.log(`ChatBird running on http://localhost:${port}`));
// Live phone calls with the AI receptionist (Twilio ConversationRelay WebSocket).
attachReceptionist(server);
