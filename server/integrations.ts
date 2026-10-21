import { Router, type Response } from 'express';
import { readSession, requireAuth, signOAuthState, verifyOAuthState } from './auth';
import { all, get, run, type Business, type Connection, type Review } from './db';
import { aiConfigured, AiError, suggestReviewReply } from './ai';
import { connectGoogleLocations, googleAuthUrl, googleConfigured, replyToReview, reviewLink, syncReviews } from './google';
import { connectMetaAccounts, disconnectMeta, metaAuthUrl, metaConfigured } from './meta';
import { rateLimit } from './rateLimit';
import { publicUrl, smsConfigured } from './twilio';
import { configStatus, isAdmin, MANAGED_KEYS, saveConfig } from './config';

export const integrationsRouter = Router();

const redirectUri = (provider: 'google' | 'meta') => `${publicUrl()}/api/integrations/${provider}/callback`;

/** Back to the Integrations page with a message, after the provider's sign-in. */
function finish(res: Response, outcome: { ok: true; names: string[] } | { ok: false; error: string }) {
  const params = new URLSearchParams({ view: 'integrations' });
  if (outcome.ok) params.set('connected', outcome.names.join(', '));
  else params.set('error', outcome.error);
  res.redirect(`/?${params}`);
}

/**
 * Checks the OAuth callback's signed state, and that the person finishing sign-in is logged in to the
 * same business that started it, so nobody can trick an owner into linking their account to another business.
 */
function checkCallback(req: Parameters<typeof readSession>[0], provider: 'google' | 'meta') {
  const state = verifyOAuthState(String(req.query.state ?? ''));
  const session = readSession(req);
  if (!state || state.provider !== provider) return { error: 'That sign-in link expired. Try connecting again.' };
  if (!session || session.businessId !== state.businessId) return { error: 'Sign in to ChatBird in this browser, then try connecting again.' };
  return { state };
}

integrationsRouter.get('/google/callback', async (req, res) => {
  const { state, error } = checkCallback(req, 'google');
  if (!state) return finish(res, { ok: false, error: error! });
  if (req.query.error) return finish(res, { ok: false, error: 'Google sign-in was cancelled.' });
  try {
    const names = await connectGoogleLocations(state.businessId, String(req.query.code ?? ''), redirectUri('google'));
    // Pull reviews right away so the Reviews page isn't empty.
    for (const c of all<Connection>("SELECT * FROM connections WHERE business_id = ? AND provider = 'google'", state.businessId)) {
      syncReviews(c).catch((err) => console.error('First review sync failed:', (err as Error).message));
    }
    finish(res, { ok: true, names });
  } catch (err) {
    finish(res, { ok: false, error: (err as Error).message });
  }
});

integrationsRouter.get('/meta/callback', async (req, res) => {
  const { state, error } = checkCallback(req, 'meta');
  if (!state) return finish(res, { ok: false, error: error! });
  if (req.query.error) return finish(res, { ok: false, error: 'Facebook sign-in was cancelled.' });
  try {
    const names = await connectMetaAccounts(state.businessId, String(req.query.code ?? ''), redirectUri('meta'));
    finish(res, { ok: true, names });
  } catch (err) {
    finish(res, { ok: false, error: (err as Error).message });
  }
});

integrationsRouter.use(requireAuth);

// ---------- Server keys (owner only) ----------

integrationsRouter.get('/keys', (req, res) => {
  if (!isAdmin(req.session!.userId)) return res.status(403).json({ error: 'Only the ChatBird owner can see server keys' });
  res.json({ keys: configStatus() });
});

integrationsRouter.put('/keys/:name', (req, res) => {
  if (!isAdmin(req.session!.userId)) return res.status(403).json({ error: 'Only the ChatBird owner can change server keys' });
  const key = MANAGED_KEYS.find((k) => k.name === req.params.name);
  if (!key) return res.status(404).json({ error: 'Unknown key' });
  if (process.env[key.name]) return res.status(409).json({ error: 'This key is set on the server (Railway) and can only be changed there' });
  const value = req.body.value === null ? null : String(req.body.value ?? '').trim().slice(0, 2000);
  saveConfig(key.name, value || null);
  res.json({ keys: configStatus() });
});

integrationsRouter.get('/', (req, res) => {
  const { businessId } = req.session!;
  const connections = all<Connection>('SELECT * FROM connections WHERE business_id = ? ORDER BY provider, name', businessId);
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  res.json({
    publicUrlSet: Boolean(publicUrl()),
    google: { available: googleConfigured(), redirectUri: redirectUri('google') },
    meta: { available: metaConfigured(), redirectUri: redirectUri('meta'), webhookUrl: `${publicUrl()}/api/meta/webhook` },
    twilio: { available: smsConfigured(), number: business.sms_number },
    connections: connections.map((c) => ({
      id: c.id,
      provider: c.provider,
      name: c.name,
      lastSyncedAt: c.last_synced_at,
      lastError: c.last_error,
      createdAt: c.created_at,
    })),
  });
});

integrationsRouter.get('/:provider/start', (req, res) => {
  const { businessId, userId } = req.session!;
  const provider = req.params.provider;
  if (!publicUrl()) return finish(res, { ok: false, error: 'Set PUBLIC_URL on the server first.' });
  if (provider === 'google' && googleConfigured()) {
    return res.redirect(googleAuthUrl(redirectUri('google'), signOAuthState({ businessId, userId, provider: 'google' })));
  }
  if (provider === 'meta' && metaConfigured()) {
    return res.redirect(metaAuthUrl(redirectUri('meta'), signOAuthState({ businessId, userId, provider: 'meta' })));
  }
  finish(res, { ok: false, error: 'That connection isn’t set up on the server yet. See the instructions on this page.' });
});

const loadConnection = (businessId: string, id: string) =>
  get<Connection>('SELECT * FROM connections WHERE id = ? AND business_id = ?', id, businessId);

integrationsRouter.delete('/:id', async (req, res) => {
  const connection = loadConnection(req.session!.businessId, req.params.id);
  if (!connection) return res.status(404).json({ error: 'Connection not found' });
  if (connection.provider === 'google') run('DELETE FROM connections WHERE id = ?', connection.id);
  else await disconnectMeta(connection);
  res.json({ ok: true });
});

integrationsRouter.post('/:id/sync', rateLimit('review-sync', 10, 10 * 60 * 1000), async (req, res) => {
  const connection = loadConnection(req.session!.businessId, req.params.id);
  if (!connection || connection.provider !== 'google') return res.status(404).json({ error: 'Connection not found' });
  try {
    const added = await syncReviews(connection);
    res.json({ added });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// ---------- Reviews ----------

export const reviewsRouter = Router();
reviewsRouter.use(requireAuth);

const publicReview = (r: Review & { location: string }) => ({
  id: r.id,
  location: r.location,
  authorName: r.author_name,
  authorPhoto: r.author_photo,
  rating: r.rating,
  comment: r.comment,
  reply: r.reply,
  replyUpdatedAt: r.reply_updated_at,
  createdAt: r.review_created_at,
  updatedAt: r.review_updated_at,
  seen: Boolean(r.seen),
});

reviewsRouter.get('/', (req, res) => {
  const { businessId } = req.session!;
  const filter = String(req.query.filter ?? 'all');
  const where =
    filter === 'unreplied' ? 'AND r.reply IS NULL' : filter === 'low' ? 'AND r.rating BETWEEN 1 AND 3' : '';
  const reviews = all<Review & { location: string }>(
    `SELECT r.*, c.name AS location FROM reviews r JOIN connections c ON c.id = r.connection_id
      WHERE r.business_id = ? ${where} ORDER BY r.review_updated_at DESC LIMIT 300`,
    businessId,
  );
  const summary = get<{ count: number; average: number | null; unreplied: number; unseen: number }>(
    `SELECT COUNT(*) AS count, AVG(NULLIF(rating, 0)) AS average,
            SUM(CASE WHEN reply IS NULL THEN 1 ELSE 0 END) AS unreplied, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unseen
       FROM reviews WHERE business_id = ?`,
    businessId,
  )!;
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  res.json({
    reviews: reviews.map(publicReview),
    summary: { count: summary.count, average: summary.average, unreplied: summary.unreplied ?? 0, unseen: summary.unseen ?? 0 },
    reviewLink: reviewLink(business),
    aiAvailable: aiConfigured(),
  });
});

reviewsRouter.post('/seen', (req, res) => {
  run('UPDATE reviews SET seen = 1 WHERE business_id = ? AND seen = 0', req.session!.businessId);
  res.json({ ok: true });
});

const loadReview = (businessId: string, id: string) => get<Review>('SELECT * FROM reviews WHERE id = ? AND business_id = ?', id, businessId);

reviewsRouter.put('/:id/reply', async (req, res) => {
  const review = loadReview(req.session!.businessId, req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const comment = String(req.body.comment ?? '').trim();
  if (!comment) return res.status(400).json({ error: 'Write a reply first' });
  if (comment.length > 4000) return res.status(400).json({ error: 'Google allows replies up to 4,000 characters' });
  try {
    await replyToReview(review, comment);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Google didn’t accept the reply: ${(err as Error).message}` });
  }
});

reviewsRouter.delete('/:id/reply', async (req, res) => {
  const review = loadReview(req.session!.businessId, req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  try {
    await replyToReview(review, null);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Couldn’t delete the reply on Google: ${(err as Error).message}` });
  }
});

reviewsRouter.post('/:id/suggest', rateLimit('ai-review', 30, 10 * 60 * 1000), async (req, res) => {
  const { businessId } = req.session!;
  if (!aiConfigured()) return res.status(400).json({ error: 'AI replies are not set up. Add ANTHROPIC_API_KEY on the server.' });
  const review = loadReview(businessId, req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  try {
    const suggestion = await suggestReviewReply(get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!, review);
    res.json({ suggestion });
  } catch (err) {
    if (err instanceof AiError) return res.status(502).json({ error: err.message });
    console.error('Review suggestion failed:', err);
    res.status(500).json({ error: 'Could not get a suggestion. Try again.' });
  }
});
