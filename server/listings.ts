import { Router } from 'express';
import { all, get, newId, now, run, type Business, type Connection } from './db';
import { requireAuth } from './auth';
import { readGoogleListing, updateGoogleListing, type ListingDetails } from './google';
import { metaConfigured, updatePageDetails } from './meta';
import { parseHours, parseSpecialDays, validateHours, validateSpecialDays, type WeeklyHours } from './hours';
import { publish } from './events';

/**
 * Listings: one place for each location's details. "Update everywhere" sends hours, holiday hours,
 * phone, website and description to Google and the Facebook Page; the main location also updates
 * ChatBird itself (office hours, address, phone, website), which the website snippet, the AI
 * receptionist, the chat assistant and saved replies all read. Sites with no way to update them
 * from outside (Apple Maps, Yelp, Yellow Pages…) get a checklist with their details to copy.
 */
export const listingsRouter = Router();
listingsRouter.use(requireAuth);

interface ProfileRow {
  id: string;
  business_id: string;
  google_connection_id: string | null;
  facebook_connection_id: string | null;
  is_main: number;
  name: string;
  address: string;
  phone: string;
  website: string;
  description: string;
  hours: string | null;
  special_hours: string;
  checklist: string;
  published_at: string | null;
  publish_results: string;
  created_at: string;
  updated_at: string;
}

/** Listing sites with no way for ChatBird to update them: kept up to date by hand from the checklist. */
export const MANUAL_SITES = [
  { id: 'apple', name: 'Apple Maps', url: 'https://businessconnect.apple.com', tip: 'Apple Business Connect. iPhone users see this in Maps and Siri.' },
  { id: 'bing', name: 'Bing Places', url: 'https://www.bingplaces.com', tip: 'Choose “Import from Google Business Profile” to copy your Google details.' },
  { id: 'yelp', name: 'Yelp', url: 'https://biz.yelp.com.au', tip: 'Yelp for Business: edit Business information.' },
  { id: 'yellow', name: 'Yellow Pages', url: 'https://www.yellow.com.au', tip: 'Search for your business and claim or edit the free listing.' },
  { id: 'truelocal', name: 'True Local', url: 'https://www.truelocal.com.au', tip: 'Claim the listing, then edit hours and contact details.' },
  { id: 'hotfrog', name: 'Hotfrog', url: 'https://www.hotfrog.com.au', tip: 'Free listing: edit your business page.' },
  { id: 'startlocal', name: 'StartLocal', url: 'https://www.startlocal.com.au', tip: 'Free listing: edit your business page.' },
];

const connection = (id: string | null, businessId: string) => (id ? get<Connection>('SELECT * FROM connections WHERE id = ? AND business_id = ?', id, businessId) : undefined);

function publicProfile(p: ProfileRow) {
  const checklist = JSON.parse(p.checklist || '{}') as Record<string, string>;
  return {
    id: p.id,
    isMain: Boolean(p.is_main),
    googleConnectionId: p.google_connection_id,
    facebookConnectionId: p.facebook_connection_id,
    name: p.name,
    address: p.address,
    phone: p.phone,
    website: p.website,
    description: p.description,
    hours: p.hours ? parseHours(p.hours) : null,
    specialHours: parseSpecialDays(p.special_hours),
    // A site is out of date when the details changed after it was last ticked.
    checklist: MANUAL_SITES.map((s) => ({ ...s, doneAt: checklist[s.id] ?? null, outOfDate: Boolean(checklist[s.id] && checklist[s.id] < p.updated_at) })),
    publishedAt: p.published_at,
    publishResults: JSON.parse(p.publish_results || '{}') as Record<string, { ok: boolean; error?: string; at: string }>,
    unpublishedChanges: !p.published_at || p.published_at < p.updated_at,
    updatedAt: p.updated_at,
  };
}

/** The website without tracking tags (utm_…), optionally tagged for one site so Reports can tell visits apart. */
export function websiteFor(url: string, source?: string) {
  if (!url) return url;
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
    if (source) u.searchParams.set('utm_source', source);
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

const loadProfile = (id: string, businessId: string) => get<ProfileRow>('SELECT * FROM listing_profiles WHERE id = ? AND business_id = ?', id, businessId);

listingsRouter.get('/', (req, res) => {
  const { businessId } = req.session!;
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  const profiles = all<ProfileRow>('SELECT * FROM listing_profiles WHERE business_id = ? ORDER BY is_main DESC, created_at', businessId);
  const used = new Set(profiles.map((p) => p.google_connection_id));
  res.json({
    profiles: profiles.map(publicProfile),
    googleLocations: all<Connection>("SELECT * FROM connections WHERE business_id = ? AND provider = 'google' ORDER BY created_at", businessId).map((c) => ({ id: c.id, name: c.name, used: used.has(c.id) })),
    facebookPages: metaConfigured() ? all<Connection>("SELECT * FROM connections WHERE business_id = ? AND provider = 'facebook' ORDER BY name", businessId).map((c) => ({ id: c.id, name: c.name })) : [],
    widgetKey: business.widget_key,
  });
});

/** Adds a location, starting from its details on Google (or ChatBird's own settings if Google can't be read). */
listingsRouter.post('/', async (req, res) => {
  const { businessId } = req.session!;
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  const google = connection(String(req.body.googleConnectionId ?? ''), businessId);
  if (!google || google.provider !== 'google') return res.status(400).json({ error: 'Choose a Google location' });
  if (get('SELECT 1 FROM listing_profiles WHERE business_id = ? AND google_connection_id = ?', businessId, google.id)) return res.status(400).json({ error: 'That location is already set up' });
  let details: ListingDetails;
  let warning = '';
  try {
    details = await readGoogleListing(google);
  } catch (err) {
    warning = `Couldn’t read the details from Google (${(err as Error).message}); started from ChatBird’s settings instead.`;
    details = { name: google.name, address: business.address, phone: business.widget_call_number ?? '', website: business.website_url ?? '', description: '', hours: business.hours_enabled ? parseHours(business.hours) : null, special: [] };
  }
  const isMain = !get('SELECT 1 FROM listing_profiles WHERE business_id = ?', businessId);
  const facebook = get<Connection>("SELECT * FROM connections WHERE business_id = ? AND provider = 'facebook' ORDER BY created_at", businessId);
  const id = newId();
  const t = now();
  run(
    `INSERT INTO listing_profiles (id, business_id, google_connection_id, facebook_connection_id, is_main, name, address, phone, website, description, hours, special_hours, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, businessId, google.id, isMain ? facebook?.id ?? null : null, isMain ? 1 : 0, details.name, details.address, details.phone, details.website, details.description,
    details.hours ? JSON.stringify(details.hours) : null, JSON.stringify(details.special), t, t,
  );
  res.status(201).json({ profile: publicProfile(loadProfile(id, businessId)!), warning });
});

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

listingsRouter.patch('/:id', (req, res) => {
  const { businessId } = req.session!;
  const p = loadProfile(req.params.id, businessId);
  if (!p) return res.status(404).json({ error: 'Location not found' });
  const b = (req.body ?? {}) as Record<string, unknown>;
  let hours = p.hours;
  if (b.hours !== undefined) {
    if (b.hours === null) hours = null;
    else {
      const valid = validateHours(b.hours);
      if (!valid) return res.status(400).json({ error: 'Check the opening hours: each day needs an opening time before its closing time' });
      hours = JSON.stringify(valid);
    }
  }
  let special = p.special_hours;
  if (b.specialHours !== undefined) {
    const valid = validateSpecialDays(b.specialHours);
    if (!valid) return res.status(400).json({ error: 'Check the holiday hours: each needs a date, and opening before closing' });
    special = JSON.stringify(valid);
  }
  const phone = text(b.phone, 30) ?? p.phone;
  const website = text(b.website, 300) ?? p.website;
  if (website && !/^https?:\/\/[^\s]+\.[^\s]+$/.test(website)) return res.status(400).json({ error: 'The website must start with https://' });
  const description = text(b.description, 750) ?? p.description;
  let facebookId = p.facebook_connection_id;
  if (b.facebookConnectionId !== undefined) {
    facebookId = b.facebookConnectionId ? connection(String(b.facebookConnectionId), businessId)?.id ?? null : null;
    if (b.facebookConnectionId && !facebookId) return res.status(400).json({ error: 'Choose a connected Facebook Page' });
  }
  const changed = phone !== p.phone || website !== p.website || description !== p.description || hours !== p.hours || special !== p.special_hours;
  run(
    'UPDATE listing_profiles SET phone = ?, website = ?, description = ?, hours = ?, special_hours = ?, facebook_connection_id = ?, updated_at = ? WHERE id = ?',
    phone, website, description, hours, special, facebookId, changed ? now() : p.updated_at, p.id,
  );
  res.json({ profile: publicProfile(loadProfile(p.id, businessId)!) });
});

/** Ticks a manual site as updated (or unticks it). */
listingsRouter.post('/:id/checklist', (req, res) => {
  const { businessId } = req.session!;
  const p = loadProfile(req.params.id, businessId);
  const site = String(req.body.site ?? '');
  if (!p || !MANUAL_SITES.some((s) => s.id === site)) return res.status(404).json({ error: 'Not found' });
  const checklist = JSON.parse(p.checklist || '{}') as Record<string, string>;
  if (req.body.done) checklist[site] = now();
  else delete checklist[site];
  run('UPDATE listing_profiles SET checklist = ? WHERE id = ?', JSON.stringify(checklist), p.id);
  res.json({ profile: publicProfile(loadProfile(p.id, businessId)!) });
});

/** Re-reads the details from Google, replacing what's in ChatBird (e.g. after editing Google directly). */
listingsRouter.post('/:id/refresh', async (req, res) => {
  const { businessId } = req.session!;
  const p = loadProfile(req.params.id, businessId);
  const google = p && connection(p.google_connection_id, businessId);
  if (!p || !google) return res.status(404).json({ error: 'This location isn’t linked to Google' });
  try {
    const d = await readGoogleListing(google);
    run(
      'UPDATE listing_profiles SET name = ?, address = ?, phone = ?, website = ?, description = ?, hours = ?, special_hours = ?, updated_at = ? WHERE id = ?',
      d.name, d.address, d.phone, d.website, d.description, d.hours ? JSON.stringify(d.hours) : null, JSON.stringify(d.special), now(), p.id,
    );
    res.json({ profile: publicProfile(loadProfile(p.id, businessId)!) });
  } catch (err) {
    res.status(502).json({ error: `Google: ${(err as Error).message}` });
  }
});

/** "Update everywhere": Google, the Facebook Page, and (main location) ChatBird's own settings. */
listingsRouter.post('/:id/publish', async (req, res) => {
  const { businessId } = req.session!;
  const p = loadProfile(req.params.id, businessId);
  if (!p) return res.status(404).json({ error: 'Location not found' });
  const hours = p.hours ? (JSON.parse(p.hours) as WeeklyHours) : null;
  const special = parseSpecialDays(p.special_hours);
  const at = now();
  const results: Record<string, { ok: boolean; error?: string; at: string }> = {};

  const google = connection(p.google_connection_id, businessId);
  if (google) {
    try {
      await updateGoogleListing(google, { phone: p.phone, website: p.website, description: p.description, hours, special });
      results.google = { ok: true, at };
    } catch (err) {
      results.google = { ok: false, error: (err as Error).message.slice(0, 300), at };
    }
  }
  const facebook = connection(p.facebook_connection_id, businessId);
  if (facebook && metaConfigured()) {
    try {
      const problems = await updatePageDetails(facebook, { phone: p.phone, website: websiteFor(p.website, 'facebook'), description: p.description, hours });
      results.facebook = problems.length ? { ok: false, error: problems.join('; ').slice(0, 300), at } : { ok: true, at };
    } catch (err) {
      results.facebook = { ok: false, error: (err as Error).message.slice(0, 300), at };
    }
  }
  if (p.is_main) {
    // ChatBird itself: office hours (receptionist, away message, website snippet), holiday hours, address, phone, website.
    run(
      `UPDATE businesses SET hours = COALESCE(?, hours), hours_enabled = CASE WHEN ? IS NULL THEN hours_enabled ELSE 1 END, special_hours = ?,
         address = CASE WHEN ? = '' THEN address ELSE ? END, widget_call_number = CASE WHEN ? = '' THEN widget_call_number ELSE ? END,
         website_url = CASE WHEN ? = '' THEN website_url ELSE ? END WHERE id = ?`,
      p.hours, p.hours, JSON.stringify(special), p.address, p.address, p.phone, p.phone, websiteFor(p.website), websiteFor(p.website), businessId,
    );
    results.chatbird = { ok: true, at };
    publish(`biz:${businessId}`, { type: 'business' });
  }
  const allOk = Object.values(results).every((r) => r.ok);
  run('UPDATE listing_profiles SET publish_results = ?, published_at = ? WHERE id = ?', JSON.stringify(results), allOk ? at : p.published_at, p.id);
  res.json({ profile: publicProfile(loadProfile(p.id, businessId)!), results });
});

listingsRouter.delete('/:id', (req, res) => {
  const { businessId } = req.session!;
  const p = loadProfile(req.params.id, businessId);
  if (!p) return res.status(404).json({ error: 'Location not found' });
  if (p.is_main) return res.status(400).json({ error: 'The main location can’t be removed' });
  run('DELETE FROM listing_profiles WHERE id = ?', p.id);
  res.json({ ok: true });
});

// ---------- Public: the website hours snippet (public/hours.js) ----------

export function publicListing(businessId: string, locationId?: string) {
  const p =
    (locationId && get<ProfileRow>('SELECT * FROM listing_profiles WHERE id = ? AND business_id = ?', locationId, businessId)) ||
    get<ProfileRow>('SELECT * FROM listing_profiles WHERE business_id = ? ORDER BY is_main DESC, created_at LIMIT 1', businessId);
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: business.timezone });
  return {
    name: p?.name ?? business.name,
    address: p?.address || business.address,
    phone: p?.phone || business.widget_call_number || '',
    website: websiteFor(p?.website || business.website_url || ''),
    color: business.color,
    timezone: business.timezone,
    hours: p?.hours ? parseHours(p.hours) : business.hours_enabled ? parseHours(business.hours) : null,
    specialHours: parseSpecialDays(p?.special_hours ?? business.special_hours).filter((s) => s.date >= today).slice(0, 10),
  };
}
