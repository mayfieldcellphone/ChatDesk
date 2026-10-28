import { decrypt, encrypt } from './crypto';
import { all, get, newId, now, run, type Business, type Connection, type Review } from './db';
import { publish } from './events';
import { emailReviewAlert } from './notify';
import { pushToBusiness } from './push';
import { config } from './config';
import { publicUrl } from './twilio';

// Google Business Profile: connect locations, sync reviews, reply to them.
// Setup (Google Cloud project + Business Profile API access): docs/INTEGRATIONS.md.

const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const SYNC_EVERY_MS = 15 * 60 * 1000;
// Overridable so tests can point at a fake Google.
const api = (host: string) => process.env.GOOGLE_API_BASE ? `${process.env.GOOGLE_API_BASE.replace(/\/$/, '')}/${host}` : `https://${host}`;

export const googleConfigured = () => Boolean(config('GOOGLE_CLIENT_ID') && config('GOOGLE_CLIENT_SECRET'));

export function googleRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || config('GOOGLE_REDIRECT_URI') || `${publicUrl()}/api/google/callback`;
}

export class GoogleError extends Error {}

export function googleAuthUrl(redirectUri: string, state: string) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config('GOOGLE_CLIENT_ID')!);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('access_type', 'offline'); // get a refresh token so syncing keeps working
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

async function tokenRequest(params: Record<string, string>) {
  const clientId = config('GOOGLE_CLIENT_ID');
  const clientSecret = config('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new GoogleError('Google Client ID and Secret are not configured.');

  const res = await fetch(api('oauth2.googleapis.com/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    const desc = data.error_description || data.error || `Google sign-in failed (${res.status})`;
    throw new GoogleError(desc);
  }
  return data as { access_token: string; refresh_token?: string; expires_in: number };
}

async function googleFetch<T>(token: string, url: string, init: { method?: string; body?: unknown } = {}, retryCount = 0): Promise<T> {
  const maxRetries = 3;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (netErr) {
    if (retryCount < maxRetries) {
      const waitMs = 1000 * Math.pow(2, retryCount);
      console.warn(`[Google API] Network error (${(netErr as Error).message}). Retrying in ${waitMs}ms...`);
      await new Promise((r) => setTimeout(r, waitMs));
      return googleFetch<T>(token, url, init, retryCount + 1);
    }
    throw netErr;
  }

  // Handle 429 rate limit with exponential backoff
  if (res.status === 429) {
    if (retryCount < maxRetries) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      const waitMs = !isNaN(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * Math.pow(2, retryCount);
      console.warn(`[Google API] 429 rate limit for ${url}. Backing off for ${waitMs}ms (retry ${retryCount + 1}/${maxRetries})...`);
      await new Promise((r) => setTimeout(r, waitMs));
      return googleFetch<T>(token, url, init, retryCount + 1);
    }
    throw new GoogleError('Google rate limit exceeded (429). Please try again shortly.');
  }

  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string; code?: number } };
  if (!res.ok) {
    const message = data.error?.message || `Google returned ${res.status}`;
    if (res.status === 401) {
      throw new GoogleError(`Reconnect Google: authentication failed (${message})`);
    }
    if (res.status === 403) {
      throw new GoogleError(`${message} (check that the Business Profile APIs are enabled and your API access request is approved)`);
    }
    throw new GoogleError(message);
  }
  return data;
}

/** Finishes Google sign-in and saves every Business Profile location the account manages. */
export async function connectGoogleLocations(businessId: string, code: string, redirectUri: string) {
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  let refreshToken = tokens.refresh_token;
  if (!refreshToken) {
    // If Google didn't return a new refresh token, preserve existing one if present
    const existingConn = get<Connection>(
      "SELECT * FROM connections WHERE business_id = ? AND provider = 'google' AND refresh_token IS NOT NULL",
      businessId,
    );
    if (existingConn?.refresh_token) {
      try {
        refreshToken = decrypt(existingConn.refresh_token);
      } catch {
        refreshToken = undefined;
      }
    }
    if (!refreshToken) {
      throw new GoogleError('Google didn’t return a refresh token. Remove ChatBird from your Google account permissions at myaccount.google.com/permissions and connect again.');
    }
  }
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  const { accounts = [] } = await googleFetch<{ accounts?: { name: string }[] }>(tokens.access_token, api('mybusinessaccountmanagement.googleapis.com/v1/accounts'));
  const connected: string[] = [];
  for (const account of accounts) {
    let pageToken = '';
    do {
      const url = new URL(api(`mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations`));
      url.searchParams.set('readMask', 'name,title,metadata');
      url.searchParams.set('pageSize', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await googleFetch<{
        locations?: { name: string; title: string; metadata?: { placeId?: string; newReviewUri?: string; mapsUri?: string } }[];
        nextPageToken?: string;
      }>(tokens.access_token, url.toString());

      for (const location of page.locations ?? []) {
        // Reviews live under the v4 path accounts/{a}/locations/{l}.
        const externalId = `${account.name}/${location.name}`;
        const meta = JSON.stringify({ placeId: location.metadata?.placeId, newReviewUri: location.metadata?.newReviewUri, mapsUri: location.metadata?.mapsUri });
        const existing = get<Connection>("SELECT * FROM connections WHERE provider = 'google' AND external_id = ?", externalId);
        if (existing && existing.business_id !== businessId) {
          throw new GoogleError(`${location.title} is already connected to another ChatBird business.`);
        }
        if (existing) {
          run(
            'UPDATE connections SET name = ?, access_token = ?, refresh_token = ?, token_expires_at = ?, meta = ?, last_error = NULL WHERE id = ?',
            location.title, encrypt(tokens.access_token), encrypt(refreshToken), expiresAt, meta, existing.id,
          );
        } else {
          run(
            `INSERT INTO connections (id, business_id, provider, external_id, name, access_token, refresh_token, token_expires_at, meta, created_at)
             VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?)`,
            newId(), businessId, externalId, location.title, encrypt(tokens.access_token), encrypt(refreshToken), expiresAt, meta, now(),
          );
        }
        connected.push(location.title);
      }
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);
  }
  if (connected.length === 0) throw new GoogleError('That Google account doesn’t manage any Business Profile locations. Sign in with the account that owns your profile.');
  return connected;
}

/** A valid access token for the connection, refreshing it when it's about to expire. */
async function accessToken(connection: Connection): Promise<string> {
  if (connection.token_expires_at && Date.parse(connection.token_expires_at) - Date.now() > 60_000) {
    try {
      return decrypt(connection.access_token);
    } catch {
      // Fall through to refresh
    }
  }
  if (!connection.refresh_token) {
    const errorMsg = 'Reconnect Google: the saved sign-in has no refresh token.';
    run('UPDATE connections SET last_error = ? WHERE id = ?', errorMsg, connection.id);
    throw new GoogleError(errorMsg);
  }
  try {
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(connection.refresh_token) });
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    run('UPDATE connections SET access_token = ?, token_expires_at = ?, last_error = NULL WHERE id = ?', encrypt(tokens.access_token), expiresAt, connection.id);
    connection.access_token = encrypt(tokens.access_token);
    connection.token_expires_at = expiresAt;
    connection.last_error = null;
    return tokens.access_token;
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('invalid_grant') || msg.includes('revoked') || msg.includes('expired')) {
      const errorMsg = 'Reconnect Google: access was revoked or expired.';
      run('UPDATE connections SET last_error = ? WHERE id = ?', errorMsg, connection.id);
      throw new GoogleError(errorMsg);
    }
    run('UPDATE connections SET last_error = ? WHERE id = ?', msg.slice(0, 500), connection.id);
    throw err;
  }
}

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

interface GoogleReview {
  name: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean };
  starRating?: string;
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: { comment: string; updateTime: string };
}

/** Pulls the location's reviews into ChatBird. Alerts about new ones after the first sync. */
export async function syncReviews(connection: Connection) {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', connection.business_id)!;
  const firstSync = !connection.last_synced_at;
  const added: Review[] = [];
  try {
    const token = await accessToken(connection);
    let pageToken = '';
    let pages = 0;
    do {
      const url = new URL(api(`mybusiness.googleapis.com/v4/${connection.external_id}/reviews`));
      url.searchParams.set('pageSize', '50');
      url.searchParams.set('orderBy', 'updateTime desc');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await googleFetch<{ reviews?: GoogleReview[]; nextPageToken?: string }>(token, url.toString());

      let unchanged = 0;
      for (const r of page.reviews ?? []) {
        const existing = get<Review>('SELECT * FROM reviews WHERE external_id = ?', r.name);
        const fields = [
          r.reviewer?.isAnonymous ? 'A Google user' : r.reviewer?.displayName || 'A Google user',
          r.reviewer?.profilePhotoUrl ?? null,
          STARS[r.starRating ?? ''] ?? 0,
          r.comment ?? null,
          r.reviewReply?.comment ?? null,
          r.reviewReply?.updateTime ?? null,
          r.createTime,
          r.updateTime,
        ] as const;
        if (existing) {
          if (existing.review_updated_at === r.updateTime && existing.reply === (r.reviewReply?.comment ?? null)) unchanged++;
          run(
            `UPDATE reviews SET author_name = ?, author_photo = ?, rating = ?, comment = ?, reply = ?, reply_updated_at = ?,
               review_created_at = ?, review_updated_at = ? WHERE id = ?`,
            ...fields, existing.id,
          );
        } else {
          const id = newId();
          run(
            `INSERT INTO reviews (id, business_id, connection_id, external_id, author_name, author_photo, rating, comment, reply, reply_updated_at,
               review_created_at, review_updated_at, seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, business.id, connection.id, r.name, ...fields, firstSync ? 1 : 0, now(),
          );
          if (!firstSync) added.push(get<Review>('SELECT * FROM reviews WHERE id = ?', id)!);
        }
      }
      // Reviews come newest-first; once a whole page is already up to date, older pages are too.
      const pageSize = page.reviews?.length ?? 0;
      pageToken = pageSize > 0 && unchanged === pageSize && !firstSync ? '' : page.nextPageToken ?? '';
    } while (pageToken && ++pages < 20);

    run('UPDATE connections SET last_synced_at = ?, last_error = NULL WHERE id = ?', now(), connection.id);
  } catch (err) {
    run('UPDATE connections SET last_error = ? WHERE id = ?', (err as Error).message.slice(0, 500), connection.id);
    throw err;
  }

  if (added.length > 0) {
    publish(`biz:${business.id}`, { type: 'review', count: added.length });
    emailReviewAlert(business, added).catch((err) => console.error('Review email failed:', err));
    const first = added[0];
    const hasLowRating = added.some((r) => r.rating > 0 && r.rating <= 3);
    pushToBusiness(business.id, {
      title: hasLowRating
        ? `⚠️ ${first.rating}★ review needs attention · ${business.name}`
        : added.length === 1
        ? `New ${first.rating}★ review · ${business.name}`
        : `${added.length} new reviews · ${business.name}`,
      body: added.length === 1 ? `${first.author_name}: ${first.comment || '(rating only)'}`.slice(0, 200) : added.map((r) => `${r.rating}★ ${r.author_name}`).join(', '),
      url: `/?business=${business.id}&view=reviews`,
      tag: `reviews-${business.id}`,
    }).catch((err) => console.error('Push failed:', err));
  }
  return added.length;
}

export async function replyToReview(review: Review, comment: string | null) {
  const connection = get<Connection>('SELECT * FROM connections WHERE id = ?', review.connection_id);
  if (!connection) throw new GoogleError('This location is no longer connected.');
  const token = await accessToken(connection);
  const url = api(`mybusiness.googleapis.com/v4/${review.external_id}/reply`);
  if (comment === null) {
    await googleFetch(token, url, { method: 'DELETE' });
    run('UPDATE reviews SET reply = NULL, reply_updated_at = NULL WHERE id = ?', review.id);
  } else {
    const saved = await googleFetch<{ comment: string; updateTime?: string }>(token, url, { method: 'PUT', body: { comment } });
    run('UPDATE reviews SET reply = ?, reply_updated_at = ? WHERE id = ?', saved.comment ?? comment, saved.updateTime ?? now(), review.id);
  }
}

/** The link customers use to write a review: the owner's own link, or the one Google gives the location. */
export function reviewLink(business: Business) {
  if (business.review_link) return business.review_link;
  for (const c of all<Connection>("SELECT * FROM connections WHERE business_id = ? AND provider = 'google' ORDER BY created_at", business.id)) {
    const meta = JSON.parse(c.meta) as { placeId?: string; newReviewUri?: string };
    if (meta.newReviewUri) return meta.newReviewUri;
    if (meta.placeId) return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(meta.placeId)}`;
  }
  return null;
}

/** Syncs every connected location every 15 minutes (Google has no push for reviews without Pub/Sub). */
export function startReviewSync() {
  const runAll = async () => {
    if (!googleConfigured()) return;
    for (const connection of all<Connection>("SELECT * FROM connections WHERE provider = 'google'")) {
      await syncReviews(connection).catch((err) => console.error(`Review sync failed for ${connection.name}:`, (err as Error).message));
    }
  };
  setTimeout(runAll, 15_000).unref();
  setInterval(runAll, SYNC_EVERY_MS).unref();
}
