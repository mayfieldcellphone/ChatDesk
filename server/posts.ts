import express, { Router } from 'express';
import { all, db, get, newId, now, run, type Business, type Connection } from './db';
import { requireAuth } from './auth';
import { aiConfigured, anthropic } from './ai';
import { config } from './config';
import { googleConfigured, postToGoogle, type GoogleOffer } from './google';
import { metaConfigured, postToFacebook, postToInstagram } from './meta';
import { publicUrl } from './twilio';
import { rateLimit } from './rateLimit';

/**
 * Promotions: one post (an image and a caption, optionally an offer with dates) published to the
 * business's Google Business Profile locations, Facebook Pages and Instagram accounts, now or at a
 * set time. Images come from ChatBird's poster maker or the owner's own design (PosterMyWall, Canva),
 * converted to JPEG in the browser, and are served publicly so each platform can fetch them.
 */
export const postsRouter = Router();
export const mediaRouter = Router();

const TICK_MS = Number(process.env.POSTS_TICK_MS) || 30_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface PostRow {
  id: string;
  business_id: string;
  caption: string;
  media_id: string;
  offer: string | null;
  channels: string;
  scheduled_at: string | null;
  status: 'scheduled' | 'posting' | 'done' | 'partial' | 'failed' | 'cancelled';
  results: string;
  created_at: string;
}

type ChannelResult = { ok: true; url: string } | { ok: false; error: string };

const mediaUrl = (id: string) => `${publicUrl()}/media/${id}.jpg`;

// ---------- Public images ----------

mediaRouter.get('/:file', (req, res) => {
  const id = req.params.file.replace(/\.jpg$/, '');
  const row = db.prepare('SELECT mime, data FROM media WHERE id = ?').get(id) as { mime: string; data: Uint8Array } | undefined;
  if (!row) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type(row.mime).send(Buffer.from(row.data));
});

// ---------- Owner API ----------

postsRouter.use(requireAuth);

const channelsFor = (businessId: string) =>
  all<Connection>("SELECT * FROM connections WHERE business_id = ? AND provider IN ('google', 'facebook', 'instagram') ORDER BY provider, name", businessId);

const available = (c: Connection) => (c.provider === 'google' ? googleConfigured() : metaConfigured());

postsRouter.post('/media', express.raw({ type: ['image/jpeg'], limit: MAX_IMAGE_BYTES }), (req, res) => {
  const data = req.body as Buffer;
  // JPEG files start FF D8 FF; Instagram only takes JPEG, so the browser converts everything first.
  if (!Buffer.isBuffer(data) || data.length < 100 || data[0] !== 0xff || data[1] !== 0xd8) return res.status(400).json({ error: 'Upload a JPEG image' });
  const id = newId();
  db.prepare('INSERT INTO media (id, business_id, mime, data, created_at) VALUES (?, ?, ?, ?, ?)').run(id, req.session!.businessId, 'image/jpeg', data, now());
  res.status(201).json({ id, url: mediaUrl(id) });
});

function publicPost(p: PostRow) {
  return {
    id: p.id,
    caption: p.caption,
    imageUrl: mediaUrl(p.media_id),
    offer: p.offer ? (JSON.parse(p.offer) as GoogleOffer) : null,
    scheduledAt: p.scheduled_at,
    status: p.status,
    createdAt: p.created_at,
    results: JSON.parse(p.results) as Record<string, ChannelResult & { name: string; provider: string }>,
  };
}

postsRouter.get('/', (req, res) => {
  const { businessId } = req.session!;
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  const posts = all<PostRow>('SELECT * FROM social_posts WHERE business_id = ? ORDER BY created_at DESC LIMIT 50', businessId);
  res.json({
    channels: channelsFor(businessId).map((c) => ({ id: c.id, provider: c.provider, name: c.name, available: available(c), lastError: c.last_error })),
    posts: posts.map(publicPost),
    aiAvailable: aiConfigured(),
    business: { name: business.name, phone: business.widget_call_number, color: business.color, website: business.website_url },
  });
});

/** A caption written by Claude from the offer details. */
postsRouter.post('/caption', rateLimit('post-caption', 30, 10 * 60 * 1000), async (req, res) => {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', req.session!.businessId)!;
  if (!aiConfigured()) return res.status(400).json({ error: 'Add ANTHROPIC_API_KEY under Integrations → Server keys first' });
  const idea = String(req.body.idea ?? '').trim().slice(0, 600);
  if (!idea) return res.status(400).json({ error: 'Say what the post is about' });
  const system = `You write social media posts for ${business.name}, a local business in Australia. The post goes on Facebook, Instagram and Google Business Profile with an image.
- 2-4 short lines, friendly and upbeat, Australian English. Then a clear call to action${business.widget_call_number ? ` (call ${business.widget_call_number})` : ''}${business.website_url ? ` or visit ${business.website_url}` : ''}.
- Include the exact offer, price and dates given. Never invent prices, discounts, dates or conditions that aren't in the brief.
- End with 3-5 relevant hashtags. At most two emoji. No markdown.
- Output only the post text.
${business.ai_notes.trim() ? `\nAbout the business:\n${business.ai_notes.trim()}` : ''}`;
  try {
    const response = await anthropic().messages.create({
      model: config('ANTHROPIC_MODEL') || 'claude-opus-5-5',
      max_tokens: 1500,
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: `Brief from the owner:\n<brief>\n${idea}\n</brief>\n\nWrite the post.` }],
    });
    const caption = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    if (!caption) return res.status(502).json({ error: 'The AI returned nothing. Try again.' });
    res.json({ caption: caption.slice(0, 2000) });
  } catch (err) {
    console.error('Caption failed:', err);
    res.status(502).json({ error: 'The AI service had a problem. Try again shortly.' });
  }
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    big: { type: 'string', description: 'The poster’s big text, at most 14 characters, e.g. "25% OFF" or "$99"' },
    headline: { type: 'string', description: 'What it is, at most 45 characters, e.g. "iPhone back glass replacement"' },
    details: { type: 'string', description: 'One supporting line, at most 70 characters, e.g. "iPhone X to iPhone 15 · while you wait"' },
    icon: { type: 'string', enum: ['phone', 'screen', 'back', 'battery', 'port', 'water', 'camera', 'tablet', 'tools'], description: 'The picture that best fits the repair: screen (cracked screen), back (back glass), battery, port (charging port), water (water damage), camera, tablet (iPad), tools (general repair), phone (anything else)' },
    caption: { type: 'string', description: 'The social media post text' },
    isOffer: { type: 'boolean', description: 'True if it is a discount, deal or limited-time offer' },
    offerTitle: { type: 'string', description: 'Offer title for Google, at most 58 characters' },
    start: { type: 'string', description: 'Offer start date, YYYY-MM-DD' },
    end: { type: 'string', description: 'Offer end date, YYYY-MM-DD' },
    terms: { type: 'string', description: 'Short offer conditions taken from the brief, or empty' },
  },
  required: ['big', 'headline', 'details', 'icon', 'caption', 'isOffer', 'offerTitle', 'start', 'end', 'terms'],
  additionalProperties: false,
};

const sydneyDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

/** Turns a one-line brief ("iPhone back glass 25% off, X to 15") into the poster text, post text and offer. */
postsRouter.post('/draft', rateLimit('post-caption', 30, 10 * 60 * 1000), async (req, res) => {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', req.session!.businessId)!;
  if (!aiConfigured()) return res.status(400).json({ error: 'Add ANTHROPIC_API_KEY under Integrations → Server keys first' });
  const idea = String(req.body.idea ?? '').trim().slice(0, 600);
  if (!idea) return res.status(400).json({ error: 'Say what the post is about' });
  const now = new Date();
  const today = sydneyDate(now);
  const weekday = now.toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'long' });
  const system = `You prepare promotional posts for ${business.name}, a local business in Australia. From the owner's brief, write the text for a square poster, the post text for Facebook, Instagram and Google Business Profile, and the offer details.
Today is ${weekday} ${today} (Sydney time).
Rules:
- Use only facts in the brief: never invent prices, discounts, models, dates or conditions.
- Poster text is short and punchy; keep the exact discount or price in the big text. Keep model ranges as given (e.g. "iPhone X to iPhone 15").
- Post text: 2-4 short lines, friendly, Australian English, the exact offer, then a call to action${business.widget_call_number ? ` (call ${business.widget_call_number})` : ''}${business.website_url ? ` or visit ${business.website_url}` : ''}. End with 3-5 relevant hashtags. At most two emoji. No markdown. Only mention dates if the brief gives them.
- Offer dates: work out real dates from the brief ("this weekend", "until Sunday", "all November"). If the brief gives none, start today and end 7 days from today.
- If it isn't an offer, set isOffer false and still fill the offer fields sensibly.
${business.ai_notes.trim() ? `\nAbout the business:\n${business.ai_notes.trim()}` : ''}`;
  try {
    const response = await anthropic().messages.create({
      model: config('ANTHROPIC_MODEL') || 'claude-opus-5-5',
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
      system,
      messages: [{ role: 'user', content: `Brief from the owner:\n<brief>\n${idea}\n</brief>` }],
    });
    const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const d = JSON.parse(text) as Record<string, unknown>;
    const str = (k: string, max: number) => String(d[k] ?? '').trim().slice(0, max);
    let start = str('start', 10);
    let end = str('end', 10);
    if (!DATE.test(start) || start < today) start = today;
    if (!DATE.test(end) || end < start) end = sydneyDate(new Date(Date.parse(`${start}T12:00:00Z`) + 7 * 86_400_000));
    res.json({
      big: str('big', 30),
      headline: str('headline', 60),
      details: str('details', 90),
      icon: str('icon', 20),
      caption: str('caption', 2000),
      offer: d.isOffer ? { title: str('offerTitle', 58), start, end, terms: str('terms', 1500) } : null,
    });
  } catch (err) {
    console.error('Post draft failed:', err);
    res.status(502).json({ error: 'The AI service had a problem. Try again shortly.' });
  }
});

postsRouter.post('/', async (req, res) => {
  const { businessId, userId } = req.session!;
  const caption = String(req.body.caption ?? '').trim();
  if (!caption) return res.status(400).json({ error: 'Write the post text' });
  if (caption.length > 2000) return res.status(400).json({ error: 'The post text is too long (2,000 characters max)' });
  const media = get<{ id: string }>('SELECT id FROM media WHERE id = ? AND business_id = ?', String(req.body.mediaId ?? ''), businessId);
  if (!media) return res.status(400).json({ error: 'Add an image first' });
  const mine = new Map(channelsFor(businessId).map((c) => [c.id, c]));
  const channels = (Array.isArray(req.body.channels) ? req.body.channels : []).map(String).filter((id: string) => mine.has(id));
  if (channels.length === 0) return res.status(400).json({ error: 'Choose where to post' });
  let offer: GoogleOffer | null = null;
  if (req.body.offer) {
    const o = req.body.offer as Record<string, unknown>;
    offer = { title: String(o.title ?? '').trim().slice(0, 58), start: String(o.start ?? ''), end: String(o.end ?? ''), terms: String(o.terms ?? '').trim().slice(0, 1500) || undefined };
    if (!offer.title || !DATE.test(offer.start) || !DATE.test(offer.end) || offer.end < offer.start) return res.status(400).json({ error: 'An offer needs a title and valid start and end dates' });
  }
  let scheduledAt: string | null = null;
  if (req.body.scheduledAt) {
    const t = Date.parse(String(req.body.scheduledAt));
    if (Number.isNaN(t)) return res.status(400).json({ error: 'Choose a valid time' });
    if (t > Date.now() + 60_000) scheduledAt = new Date(t).toISOString();
  }
  const id = newId();
  run(
    'INSERT INTO social_posts (id, business_id, caption, media_id, offer, channels, scheduled_at, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, businessId, caption, media.id, offer ? JSON.stringify(offer) : null, JSON.stringify(channels), scheduledAt, scheduledAt ? 'scheduled' : 'posting', userId, now(),
  );
  if (!scheduledAt) await publish(id);
  res.status(201).json({ post: publicPost(get<PostRow>('SELECT * FROM social_posts WHERE id = ?', id)!) });
});

postsRouter.post('/:id/cancel', (req, res) => {
  const result = run("UPDATE social_posts SET status = 'cancelled' WHERE id = ? AND business_id = ? AND status = 'scheduled'", req.params.id, req.session!.businessId);
  if (!result.changes) return res.status(400).json({ error: 'Only a scheduled post can be cancelled' });
  res.json({ ok: true });
});

// ---------- Publishing ----------

/** Posts to every chosen channel; one failing doesn't stop the others. */
export async function publish(postId: string) {
  const post = get<PostRow>('SELECT * FROM social_posts WHERE id = ?', postId);
  if (!post) return;
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', post.business_id)!;
  const offer = post.offer ? (JSON.parse(post.offer) as GoogleOffer) : null;
  const imageUrl = mediaUrl(post.media_id);
  const results: Record<string, ChannelResult & { name: string; provider: string }> = {};
  for (const id of JSON.parse(post.channels) as string[]) {
    const c = get<Connection>('SELECT * FROM connections WHERE id = ? AND business_id = ?', id, post.business_id);
    if (!c) continue;
    try {
      const url =
        c.provider === 'google'
          ? await postToGoogle(c, { summary: post.caption, imageUrl, offer, website: business.website_url })
          : c.provider === 'facebook'
            ? await postToFacebook(c, imageUrl, post.caption)
            : await postToInstagram(c, imageUrl, post.caption);
      results[id] = { ok: true, url, name: c.name, provider: c.provider };
    } catch (err) {
      results[id] = { ok: false, error: (err as Error).message.slice(0, 300), name: c.name, provider: c.provider };
    }
  }
  const outcomes = Object.values(results);
  const status = outcomes.every((r) => r.ok) ? 'done' : outcomes.some((r) => r.ok) ? 'partial' : 'failed';
  run('UPDATE social_posts SET status = ?, results = ? WHERE id = ?', status, JSON.stringify(results), postId);
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const due = all<{ id: string }>("SELECT id FROM social_posts WHERE status = 'scheduled' AND scheduled_at <= ?", now());
    for (const p of due) {
      // Claim it first so a slow publish can't be picked up twice.
      if (run("UPDATE social_posts SET status = 'posting' WHERE id = ? AND status = 'scheduled'", p.id).changes) await publish(p.id);
    }
  } catch (err) {
    console.error('Scheduled posts failed:', err);
  } finally {
    busy = false;
  }
}

export function startScheduledPosts() {
  setInterval(tick, TICK_MS).unref();
}
