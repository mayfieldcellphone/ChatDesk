import { Router, type Request, type Response } from 'express';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { readSession, requireAuth, signOAuthState, verifyOAuthState } from './auth';
import { all, get, newId, now, run, type Business, type Connection } from './db';
import { decrypt, encrypt } from './crypto';
import { accessToken, GoogleError, googleApi, googleAuthUrl, googleConfigured, googleFetch, googleRedirectUri, locationPath, tokenRequest } from './google';
import { publicListing } from './listings';
import { DAYS, type Day } from './hours';
import { aiConfigured, anthropic } from './ai';
import { config } from './config';
import { rateLimit } from './rateLimit';
import { publicUrl } from './twilio';

/**
 * SEO: how the business shows up on Google and how its website is built.
 * - Google Profile score: a checklist of the things that help a Business Profile rank in Maps.
 * - Profile insights: searches, views, calls, website clicks and directions (Business Profile Performance API).
 * - Search Console: what people searched before clicking through to the website (its own read-only sign-in).
 * - Website check: reads a page, checks the basics Google looks at, and turns problems into a to-do list.
 * - Business details for Google (schema.org JSON-LD), built from Listings; the chat widget can add it to the site.
 */
export const seoRouter = Router();

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

// ---------- Business details for Google (schema.org) ----------

export const BUSINESS_TYPES = [
  { id: 'LocalBusiness', label: 'Local business (general)' },
  { id: 'MobilePhoneStore', label: 'Phone shop / phone repair' },
  { id: 'ElectronicsStore', label: 'Electronics shop / repair' },
  { id: 'ComputerStore', label: 'Computer shop / repair' },
  { id: 'Store', label: 'Shop' },
  { id: 'ProfessionalService', label: 'Professional service' },
  { id: 'HomeAndConstructionBusiness', label: 'Trades (home & construction)' },
  { id: 'AutoRepair', label: 'Car repair' },
  { id: 'HealthAndBeautyBusiness', label: 'Health & beauty' },
  { id: 'FoodEstablishment', label: 'Café / food' },
];

const SCHEMA_DAYS: Record<Day, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

/** "12 Main St, Mayfield NSW 2304" → the parts schema.org wants (Australian format; anything else stays one line). */
function postalAddress(address: string, country: string | null) {
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  const m = last.match(/^(.*?)\s+(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s+(\d{4})$/i);
  const out: Record<string, string> = { '@type': 'PostalAddress' };
  if (m && parts.length > 1) {
    out.streetAddress = parts.slice(0, -1).join(', ');
    out.addressLocality = m[1];
    out.addressRegion = m[2].toUpperCase();
    out.postalCode = m[3];
  } else {
    out.streetAddress = address;
  }
  if (country) out.addressCountry = country;
  return out;
}

/** The business's details as schema.org JSON-LD, from the main location in Listings. */
export function businessSchema(businessId: string) {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  const l = publicListing(businessId);
  const country = business.timezone.startsWith('Australia/') ? 'AU' : null;
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': business.seo_business_type || 'LocalBusiness',
    name: l.name,
  };
  if (l.website) schema.url = l.website;
  if (l.phone) schema.telephone = l.phone;
  if (l.address) schema.address = postalAddress(l.address, country);
  const main = get<{ description: string; google_connection_id: string | null; facebook_connection_id: string | null }>(
    'SELECT description, google_connection_id, facebook_connection_id FROM listing_profiles WHERE business_id = ? ORDER BY is_main DESC, created_at LIMIT 1',
    businessId,
  );
  if (main?.description) schema.description = main.description.slice(0, 750);
  const google = main?.google_connection_id
    ? get<Connection>('SELECT * FROM connections WHERE id = ?', main.google_connection_id)
    : get<Connection>("SELECT * FROM connections WHERE business_id = ? AND provider = 'google' ORDER BY created_at LIMIT 1", businessId);
  const mapsUri = google ? (JSON.parse(google.meta) as { mapsUri?: string }).mapsUri : undefined;
  if (mapsUri) schema.hasMap = mapsUri;
  const sameAs: string[] = [];
  if (mapsUri) sameAs.push(mapsUri);
  const facebook = main?.facebook_connection_id ? get<Connection>('SELECT * FROM connections WHERE id = ?', main.facebook_connection_id) : undefined;
  if (facebook) sameAs.push(`https://www.facebook.com/${facebook.external_id}`);
  if (sameAs.length) schema.sameAs = sameAs;
  const specs: Record<string, unknown>[] = [];
  if (l.hours) {
    for (const day of DAYS) {
      const h = l.hours[day];
      if (h) specs.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: SCHEMA_DAYS[day], opens: h.open, closes: h.close });
    }
  }
  for (const s of l.specialHours) {
    specs.push(
      s.closed
        ? { '@type': 'OpeningHoursSpecification', validFrom: s.date, validThrough: s.date, opens: '00:00', closes: '00:00' }
        : { '@type': 'OpeningHoursSpecification', validFrom: s.date, validThrough: s.date, opens: s.open, closes: s.close },
    );
  }
  if (specs.length) schema.openingHoursSpecification = specs;
  return schema;
}

// ---------- Fetching a website page safely ----------

function privateAddress(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return privateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/** Only public http(s) sites: the check must never be pointed at the server's own network. */
async function assertPublicUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new GoogleError('That doesn’t look like a web address.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new GoogleError('Only http and https addresses can be checked.');
  if (process.env.SEO_ALLOW_PRIVATE === '1') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new GoogleError(`Couldn’t find ${u.hostname}. Check the address.`);
  if (addresses.some((a) => privateAddress(a.address))) throw new GoogleError('That address isn’t a public website.');
  return u;
}

const UA = 'Mozilla/5.0 (compatible; ChatBirdSiteCheck/1.0)';

async function fetchPublic(raw: string, { maxBytes = 3_000_000, timeoutMs = 15_000 } = {}) {
  let url = raw;
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url).toString();
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const body = new TextDecoder().decode(Buffer.concat(chunks));
    return { url, status: res.status, headers: res.headers, body, redirects: hop };
  }
  throw new GoogleError('That page redirects too many times.');
}

// ---------- Website check ----------

type Status = 'pass' | 'warn' | 'fail' | 'skip';
interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
  fix: string;
  weight: number;
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const stripTags = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function attr(tag: string, name: string) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
}
function metaContent(html: string, key: string, by: 'name' | 'property' = 'name') {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if ((attr(tag, by) ?? '').toLowerCase() === key) return attr(tag, 'content');
  }
  return null;
}

const LOCAL_TYPES = /LocalBusiness|Store|Shop|Repair|Service|Restaurant|Cafe|Dentist|Salon|Business|Organization|Place/i;

function findSchemaTypes(html: string) {
  const types: string[] = [];
  let invalid = 0;
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (v: unknown) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (v && typeof v === 'object') {
          const t = (v as Record<string, unknown>)['@type'];
          if (typeof t === 'string') types.push(t);
          if (Array.isArray(t)) types.push(...t.filter((x): x is string => typeof x === 'string'));
          const graph = (v as Record<string, unknown>)['@graph'];
          if (graph) walk(graph);
        }
      };
      walk(JSON.parse(m[1].trim()));
    } catch {
      invalid++;
    }
  }
  return { types, invalid };
}

const lastDigits = (phone: string) => phone.replace(/\D/g, '').replace(/^61/, '0').slice(-8);

interface PageSpeed {
  performance: number | null;
  seo: number | null;
  accessibility: number | null;
  lcpSeconds: number | null;
  cls: number | null;
  error?: string;
}

async function pageSpeed(url: string): Promise<PageSpeed> {
  const u = new URL(googleApi('www.googleapis.com/pagespeedonline/v5/runPagespeed'));
  u.searchParams.set('url', url);
  u.searchParams.set('strategy', 'mobile');
  for (const c of ['performance', 'seo', 'accessibility']) u.searchParams.append('category', c);
  const key = config('PAGESPEED_API_KEY');
  if (key) u.searchParams.set('key', key);
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(90_000) });
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      lighthouseResult?: { categories?: Record<string, { score?: number | null }>; audits?: Record<string, { numericValue?: number }> };
    };
    if (!res.ok || !data.lighthouseResult) {
      const msg = data.error?.message ?? `Google PageSpeed returned ${res.status}`;
      return { performance: null, seo: null, accessibility: null, lcpSeconds: null, cls: null, error: /quota/i.test(msg) ? 'Google’s free speed test is busy. Try again later, or add a PageSpeed key under Integrations → Server keys.' : msg.slice(0, 200) };
    }
    const cat = (k: string) => {
      const s = data.lighthouseResult!.categories?.[k]?.score;
      return typeof s === 'number' ? Math.round(s * 100) : null;
    };
    const audits = data.lighthouseResult.audits ?? {};
    const lcp = audits['largest-contentful-paint']?.numericValue;
    const cls = audits['cumulative-layout-shift']?.numericValue;
    return {
      performance: cat('performance'),
      seo: cat('seo'),
      accessibility: cat('accessibility'),
      lcpSeconds: typeof lcp === 'number' ? Math.round(lcp / 100) / 10 : null,
      cls: typeof cls === 'number' ? Math.round(cls * 1000) / 1000 : null,
    };
  } catch (err) {
    return { performance: null, seo: null, accessibility: null, lcpSeconds: null, cls: null, error: `The speed test didn’t finish (${(err as Error).message.slice(0, 100)}).` };
  }
}

async function robotsAndSitemap(origin: string) {
  let robots: string | null = null;
  try {
    const r = await fetchPublic(`${origin}/robots.txt`, { maxBytes: 200_000, timeoutMs: 10_000 });
    if (r.status === 200 && !/<html/i.test(r.body.slice(0, 500))) robots = r.body;
  } catch {
    /* no robots.txt */
  }
  let blocksAll = false;
  if (robots) {
    // Rules for every crawler (User-agent: *) that block the whole site.
    let applies = false;
    for (const line of robots.split(/\r?\n/)) {
      const [k, ...rest] = line.split(':');
      const key = k.trim().toLowerCase();
      const value = rest.join(':').trim();
      if (key === 'user-agent') applies = value === '*';
      else if (applies && key === 'disallow' && value === '/') blocksAll = true;
    }
  }
  const listed = robots ? [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]) : [];
  let sitemap: string | null = null;
  for (const candidate of [...listed, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`]) {
    try {
      const r = await fetchPublic(candidate, { maxBytes: 100_000, timeoutMs: 10_000 });
      if (r.status === 200 && /<(urlset|sitemapindex)\b/i.test(r.body)) {
        sitemap = r.url;
        break;
      }
    } catch {
      /* try the next one */
    }
  }
  return { robots: Boolean(robots), blocksAll, sitemap };
}

interface AuditResult {
  url: string;
  finalUrl: string;
  checkedAt: string;
  score: number;
  checks: Check[];
  speed: PageSpeed;
  page: { title: string; description: string; h1: string[]; h2: string[]; words: number };
  links: string[];
  summary: string;
  todo: { priority: 'high' | 'medium' | 'low'; title: string; why: string; how: string; paste?: string }[];
  suggested: { title: string; description: string } | null;
  aiUsed: boolean;
}

const statusScore: Record<Status, number> = { pass: 1, warn: 0.5, fail: 0, skip: 0 };

async function auditPage(business: Business, rawUrl: string): Promise<AuditResult> {
  const page = await fetchPublic(rawUrl);
  if (page.status >= 400) throw new GoogleError(`The page answered with error ${page.status}. Check the address.`);
  const html = page.body;
  const final = new URL(page.url);
  const listing = publicListing(business.id);
  const [speed, site] = await Promise.all([pageSpeed(page.url), robotsAndSitemap(final.origin)]);

  const head = html.match(/<head\b[\s\S]*?<\/head>/i)?.[0] ?? html;
  const title = stripTags(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const description = (metaContent(head, 'description') ?? '').trim();
  const body = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  const h1 = [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => stripTags(m[1])).filter(Boolean);
  const h2 = [...body.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => stripTags(m[1])).filter(Boolean);
  const text = stripTags(body.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? body);
  const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length;
  const imgs = body.match(/<img\b[^>]*>/gi) ?? [];
  const noAlt = imgs.filter((t) => !(attr(t, 'alt') ?? '').trim()).length;
  const robotsMeta = `${metaContent(head, 'robots') ?? ''} ${page.headers.get('x-robots-tag') ?? ''}`.toLowerCase();
  const canonical = (head.match(/<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i)?.[0] ?? '');
  const lang = attr(html.match(/<html\b[^>]*>/i)?.[0] ?? '', 'lang');
  const viewport = metaContent(head, 'viewport');
  const ogTitle = metaContent(head, 'og:title', 'property');
  const ogImage = metaContent(head, 'og:image', 'property');
  const telLinks = (body.match(/href\s*=\s*["']tel:/gi) ?? []).length;
  const schema = findSchemaTypes(html);
  const localSchema = schema.types.filter((t) => LOCAL_TYPES.test(t));

  // Internal links, so other pages (services, contact) can be checked too.
  const links = new Set<string>();
  for (const m of body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]), final);
      if (u.host !== final.host || !/^https?:$/.test(u.protocol) || /\.(jpe?g|png|gif|webp|svg|pdf|zip)$/i.test(u.pathname)) continue;
      u.hash = '';
      for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
      if (u.toString() !== final.toString()) links.add(u.toString());
    } catch {
      /* not a link */
    }
  }

  const suburb = (listing.address.match(/,\s*([^,]+?)\s+(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s+\d{4}\s*$/i)?.[1] ?? '').trim();
  const nameWords = business.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const lowerTitle = title.toLowerCase();
  const pageDigits = html.replace(/[\s\-().]/g, '').replace(/\+61/g, '0');
  const phone = listing.phone ? lastDigits(listing.phone) : '';
  const streetNumber = listing.address.match(/\b\d+[a-z]?\b/i)?.[0] ?? '';
  const lowerText = text.toLowerCase();

  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  add({
    id: 'https', label: 'Secure (https)', weight: 2,
    status: final.protocol === 'https:' ? 'pass' : 'fail',
    detail: final.protocol === 'https:' ? 'The page loads over https.' : 'The page loads over plain http.',
    fix: 'Turn on SSL (https) with your web host and redirect http to https. Google ranks secure sites higher and browsers warn on insecure ones.',
  });
  add({
    id: 'indexable', label: 'Google is allowed to list this page', weight: 4,
    status: robotsMeta.includes('noindex') || site.blocksAll ? 'fail' : 'pass',
    detail: robotsMeta.includes('noindex') ? 'The page tells Google not to list it (noindex).' : site.blocksAll ? 'robots.txt blocks every search engine from the whole site.' : 'Nothing stops Google listing it.',
    fix: robotsMeta.includes('noindex')
      ? 'Remove the “noindex” robots setting. In WordPress: Settings → Reading → untick “Discourage search engines”, or check the page’s SEO plugin settings.'
      : 'Remove “Disallow: /” for “User-agent: *” from robots.txt.',
  });
  add({
    id: 'title', label: 'Page title', weight: 3,
    status: !title ? 'fail' : title.length < 15 || title.length > 65 ? 'warn' : (suburb && lowerTitle.includes(suburb.toLowerCase())) || nameWords.some((w) => lowerTitle.includes(w)) ? 'pass' : 'warn',
    detail: title ? `“${title.slice(0, 120)}” (${title.length} characters)` : 'The page has no title.',
    fix: `Use 30–60 characters with the main service and suburb first, then the business name, e.g. “Phone & iPhone Repairs ${suburb || 'in your suburb'} | ${business.name}”.`,
  });
  add({
    id: 'description', label: 'Search result description', weight: 2,
    status: !description ? 'fail' : description.length < 70 || description.length > 165 ? 'warn' : 'pass',
    detail: description ? `${description.length} characters: “${description.slice(0, 160)}”` : 'No meta description, so Google picks any text from the page.',
    fix: 'Write 120–155 characters that say what you do, where, and why choose you, ending with a call to action (e.g. “Walk in or book online”).',
  });
  add({
    id: 'h1', label: 'One main heading (H1)', weight: 2,
    status: h1.length === 1 ? 'pass' : h1.length === 0 ? 'fail' : 'warn',
    detail: h1.length ? `${h1.length} found: ${h1.slice(0, 3).map((h) => `“${h.slice(0, 80)}”`).join(', ')}` : 'No H1 heading.',
    fix: 'Give the page exactly one H1 that names the main service and area (e.g. “Phone repairs in Mayfield”). Use H2 for sections.',
  });
  add({
    id: 'mobile', label: 'Set up for phones', weight: 3,
    status: viewport && /width\s*=\s*device-width/i.test(viewport) ? 'pass' : 'fail',
    detail: viewport ? `Viewport: ${viewport}` : 'No mobile viewport tag.',
    fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the page head (most themes have it; an old theme may need replacing).',
  });
  add({
    id: 'schema', label: 'Business details Google can read (schema)', weight: 3,
    status: localSchema.length ? 'pass' : business.seo_schema_inject ? 'pass' : schema.types.length ? 'warn' : 'fail',
    detail: localSchema.length
      ? `Found: ${[...new Set(localSchema)].slice(0, 4).join(', ')}.`
      : business.seo_schema_inject
      ? 'ChatBird adds your business details through the chat widget.'
      : schema.types.length
      ? `Only ${[...new Set(schema.types)].slice(0, 3).join(', ')}, no business details.`
      : 'None found.',
    fix: 'Turn on “Add business details to my website” on the SEO page (needs the ChatBird chat widget on the site), or paste the business details code into the page head.',
  });
  add({
    id: 'phone', label: 'Phone number on the page matches Listings', weight: 2,
    status: !phone ? 'skip' : pageDigits.includes(phone) ? 'pass' : 'fail',
    detail: !phone ? 'No phone number in Listings yet.' : pageDigits.includes(phone) ? `${listing.phone} is on the page.` : `${listing.phone} isn’t on the page.`,
    fix: `Show ${listing.phone || 'your phone number'} on every page (header or footer), the same as on Google. Matching details across the web help local ranking.`,
  });
  add({
    id: 'address', label: 'Address on the page', weight: 2,
    status: !listing.address ? 'skip' : (suburb ? lowerText.includes(suburb.toLowerCase()) : true) && (!streetNumber || lowerText.includes(streetNumber.toLowerCase())) ? 'pass' : 'warn',
    detail: listing.address ? `Listings address: ${listing.address}` : 'No address in Listings yet.',
    fix: 'Show the full address (as on Google) in the footer or contact section, ideally with an embedded Google map.',
  });
  add({
    id: 'tel', label: 'Tap-to-call link', weight: 1,
    status: telLinks ? 'pass' : 'warn',
    detail: telLinks ? `${telLinks} tap-to-call link${telLinks === 1 ? '' : 's'}.` : 'No tap-to-call link.',
    fix: `Link the phone number so mobile visitors can tap it: <a href="tel:${(listing.phone || '').replace(/[^\d+]/g, '')}">${listing.phone || 'phone'}</a>`,
  });
  add({
    id: 'content', label: 'Enough text about your services', weight: 2,
    status: words >= 300 ? 'pass' : words >= 150 ? 'warn' : 'fail',
    detail: `About ${words} words of text.`,
    fix: 'Aim for 300+ words: the services you offer (by device and repair), prices or “from” prices, turnaround time, warranty, and the suburbs you serve.',
  });
  add({
    id: 'alt', label: 'Image descriptions (alt text)', weight: 1,
    status: !imgs.length ? 'skip' : noAlt === 0 ? 'pass' : noAlt / imgs.length <= 0.3 ? 'warn' : 'fail',
    detail: imgs.length ? `${imgs.length - noAlt} of ${imgs.length} images have a description.` : 'No images.',
    fix: 'Describe each image in a few words (e.g. “iPhone 14 screen replacement”). In WordPress: Media → each image → Alternative text.',
  });
  add({
    id: 'canonical', label: 'Main address set (canonical)', weight: 1,
    status: canonical ? 'pass' : 'warn',
    detail: canonical ? `Canonical: ${attr(canonical, 'href') ?? ''}` : 'No canonical link.',
    fix: 'Add <link rel="canonical" href="(this page’s address)">. SEO plugins such as Yoast or Rank Math do it automatically.',
  });
  add({
    id: 'sitemap', label: 'Sitemap', weight: 1,
    status: site.sitemap ? 'pass' : 'warn',
    detail: site.sitemap ? `Found ${site.sitemap}` : 'No sitemap found.',
    fix: 'Create a sitemap (WordPress makes one at /wp-sitemap.xml; SEO plugins too) and submit it in Google Search Console → Sitemaps.',
  });
  add({
    id: 'social', label: 'Preview for Facebook and messages', weight: 1,
    status: ogTitle && ogImage ? 'pass' : 'warn',
    detail: ogTitle && ogImage ? 'Has a share title and image.' : 'Missing a share title or image (og:title / og:image).',
    fix: 'Add Open Graph tags (og:title, og:description, og:image) so links shared on Facebook and in texts show a proper preview. SEO plugins do this.',
  });
  add({
    id: 'lang', label: 'Page language set', weight: 1,
    status: lang ? 'pass' : 'warn',
    detail: lang ? `lang="${lang}"` : 'No language on the page.',
    fix: 'Add lang="en-AU" to the <html> tag.',
  });
  const perf = speed.performance;
  add({
    id: 'speed', label: 'Speed on mobile', weight: 3,
    status: perf === null ? 'skip' : perf >= 70 ? 'pass' : perf >= 45 ? 'warn' : 'fail',
    detail: perf === null ? speed.error ?? 'Speed test unavailable.' : `Google score ${perf}/100${speed.lcpSeconds !== null ? `, main content shows after ${speed.lcpSeconds}s` : ''}.`,
    fix: 'Compress and resize large images (WebP, under 200 KB), remove unused plugins and sliders, and turn on caching. Main content should show within 2.5 seconds.',
  });

  const counted = checks.filter((c) => c.status !== 'skip');
  const total = counted.reduce((s, c) => s + c.weight, 0);
  const score = total ? Math.round((counted.reduce((s, c) => s + c.weight * statusScore[c.status], 0) / total) * 100) : 0;

  const result: AuditResult = {
    url: rawUrl,
    finalUrl: page.url,
    checkedAt: now(),
    score,
    checks,
    speed,
    page: { title, description, h1, h2: h2.slice(0, 15), words },
    links: [...links].slice(0, 40),
    summary: '',
    todo: [],
    suggested: null,
    aiUsed: false,
  };
  const problems = checks.filter((c) => c.status === 'fail' || c.status === 'warn');
  // Without AI: the problems in order of weight, with the standard fix.
  result.todo = problems
    .sort((a, b) => statusScore[a.status] - statusScore[b.status] || b.weight - a.weight)
    .map((c) => ({ priority: c.status === 'fail' && c.weight >= 2 ? 'high' : c.status === 'fail' || c.weight >= 3 ? 'medium' : 'low', title: c.label, why: c.detail, how: c.fix }));
  result.summary = problems.length ? `${problems.length} thing${problems.length === 1 ? '' : 's'} to improve on this page.` : 'This page covers the basics. Keep adding helpful content.';

  if (aiConfigured()) {
    try {
      await improveWithAi(business, result, text, suburb);
    } catch (err) {
      console.error('SEO to-do (AI) failed:', (err as Error).message);
    }
  }
  return result;
}

const TODO_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    todo: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
          why: { type: 'string' },
          how: { type: 'string' },
          paste: { type: 'string' },
        },
        required: ['priority', 'title', 'why', 'how', 'paste'],
        additionalProperties: false,
      },
    },
    suggestedTitle: { type: 'string' },
    suggestedDescription: { type: 'string' },
  },
  required: ['summary', 'todo', 'suggestedTitle', 'suggestedDescription'],
  additionalProperties: false,
};

async function improveWithAi(business: Business, result: AuditResult, text: string, suburb: string) {
  const listing = publicListing(business.id);
  const system = `You are a local SEO adviser for small businesses in Australia. You turn a website check into a short, practical to-do list for a busy owner who is not technical.
Rules:
- Use only the facts given (check results, page text, business details). Never invent services, prices, awards or reviews.
- At most 8 items, most valuable first. Merge related checks. Skip checks that passed.
- "why": one sentence on what it costs them in Google results or customers. "how": plain steps (mention WordPress menus only if the page looks like WordPress).
- "paste": ready-to-use text when it helps (a new page title, description, H1, a paragraph of service text, an HTML snippet); otherwise "".
- suggestedTitle: 30-60 characters, main service + suburb + business name. suggestedDescription: 120-155 characters with a call to action.
- Australian English, no markdown.`;
  const checks = result.checks.map((c) => `- [${c.status}] ${c.label}: ${c.detail}`).join('\n');
  const prompt = `Business: ${business.name}
Address: ${listing.address || 'not set'}${suburb ? ` (suburb: ${suburb})` : ''}
Phone: ${listing.phone || 'not set'}
About the business: ${(business.ai_notes || '').slice(0, 1500) || 'not given'}

Page: ${result.finalUrl}
Title: ${result.page.title || '(none)'}
Description: ${result.page.description || '(none)'}
H1: ${result.page.h1.join(' | ') || '(none)'}
H2: ${result.page.h2.join(' | ') || '(none)'}

Check results:
${checks}

<page_text>
${text.slice(0, 6000)}
</page_text>`;
  const response = await anthropic().messages.create({
    model: config('ANTHROPIC_MODEL') || 'claude-opus-5-5',
    max_tokens: 6000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: TODO_SCHEMA } },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return;
  const d = JSON.parse(response.content.map((b) => (b.type === 'text' ? b.text : '')).join('')) as {
    summary: string;
    todo: AuditResult['todo'];
    suggestedTitle: string;
    suggestedDescription: string;
  };
  if (!Array.isArray(d.todo)) return;
  result.summary = String(d.summary ?? '').slice(0, 600);
  result.todo = d.todo.slice(0, 8).map((t) => ({
    priority: (['high', 'medium', 'low'] as const).includes(t.priority) ? t.priority : 'medium',
    title: String(t.title).slice(0, 120),
    why: String(t.why).slice(0, 400),
    how: String(t.how).slice(0, 1200),
    ...(t.paste?.trim() ? { paste: t.paste.trim().slice(0, 3000) } : {}),
  }));
  result.suggested = { title: String(d.suggestedTitle ?? '').slice(0, 80), description: String(d.suggestedDescription ?? '').slice(0, 200) };
  result.aiUsed = true;
}

// ---------- Google Profile score ----------

interface ProfileCheck {
  id: string;
  label: string;
  status: Status;
  detail: string;
  fix: string;
  weight: number;
  /** The ChatBird page that fixes it. */
  page?: 'listings' | 'marketing' | 'reviews';
  link?: string;
}

async function profileScore(business: Business, connection: Connection) {
  const token = await accessToken(connection);
  const url = new URL(googleApi(`mybusinessbusinessinformation.googleapis.com/v1/${locationPath(connection)}`));
  url.searchParams.set('readMask', 'title,categories,profile,regularHours,specialHours,websiteUri,phoneNumbers,serviceItems,storefrontAddress,metadata');
  const g = await googleFetch<{
    title?: string;
    categories?: { primaryCategory?: { displayName?: string }; additionalCategories?: { displayName?: string }[] };
    profile?: { description?: string };
    regularHours?: { periods?: unknown[] };
    specialHours?: { specialHourPeriods?: { startDate: { year: number; month: number; day: number } }[] };
    websiteUri?: string;
    phoneNumbers?: { primaryPhone?: string };
    serviceItems?: unknown[];
    metadata?: { mapsUri?: string };
  }>(token, url.toString());

  // Photos and posts come from the older v4 API; if Google refuses, those checks are skipped.
  let photos: number | null = null;
  let lastPost: string | null = null;
  try {
    const m = await googleFetch<{ totalMediaItemCount?: number; mediaItems?: unknown[] }>(token, googleApi(`mybusiness.googleapis.com/v4/${connection.external_id}/media?pageSize=1`));
    photos = m.totalMediaItemCount ?? m.mediaItems?.length ?? 0;
  } catch {
    /* unknown */
  }
  try {
    const p = await googleFetch<{ localPosts?: { createTime?: string }[] }>(token, googleApi(`mybusiness.googleapis.com/v4/${connection.external_id}/localPosts?pageSize=5`));
    lastPost = (p.localPosts ?? []).map((x) => x.createTime ?? '').sort().pop() || null;
  } catch {
    /* unknown */
  }
  // Posts ChatBird made count too.
  for (const row of all<{ results: string; created_at: string }>("SELECT results, created_at FROM social_posts WHERE business_id = ? AND status IN ('done', 'partial') ORDER BY created_at DESC LIMIT 20", business.id)) {
    const results = JSON.parse(row.results) as Record<string, { ok: boolean; provider: string }>;
    if (Object.entries(results).some(([id, r]) => r.ok && r.provider === 'google' && id === connection.id)) {
      if (!lastPost || row.created_at > lastPost) lastPost = row.created_at;
      break;
    }
  }

  const reviews = get<{ total: number; avg: number | null; newest: string | null }>(
    'SELECT COUNT(*) AS total, AVG(NULLIF(rating, 0)) AS avg, MAX(review_created_at) AS newest FROM reviews WHERE connection_id = ?',
    connection.id,
  )!;
  const since = daysAgo(90).toISOString();
  const recent = get<{ total: number; replied: number }>(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN reply IS NOT NULL THEN 1 ELSE 0 END) AS replied FROM reviews WHERE connection_id = ? AND review_created_at >= ?',
    connection.id, since,
  )!;

  const description = g.profile?.description ?? '';
  const extraCats = g.categories?.additionalCategories?.length ?? 0;
  const services = g.serviceItems?.length ?? 0;
  const today = ymd(new Date());
  const upcomingSpecial = (g.specialHours?.specialHourPeriods ?? []).filter((p) => {
    const d = `${p.startDate.year}-${String(p.startDate.month).padStart(2, '0')}-${String(p.startDate.day).padStart(2, '0')}`;
    return d >= today;
  }).length;
  const month = new Date().getMonth() + 1;
  const holidaySeason = month === 12 || month === 1 || (month === 11 && new Date().getDate() >= 15) || month === 3 || month === 4;
  const postAge = lastPost ? Math.floor((Date.now() - Date.parse(lastPost)) / DAY_MS) : null;
  const newestAge = reviews.newest ? Math.floor((Date.now() - Date.parse(reviews.newest)) / DAY_MS) : null;
  const replyRate = recent.total ? Math.round(((recent.replied ?? 0) / recent.total) * 100) : null;
  const avg = reviews.avg ? Math.round(reviews.avg * 10) / 10 : null;

  const checks: ProfileCheck[] = [
    {
      id: 'description', label: 'Business description', weight: 2, page: 'listings',
      status: description.length >= 250 ? 'pass' : description.length >= 80 ? 'warn' : 'fail',
      detail: description ? `${description.length} of 750 characters used.` : 'No description.',
      fix: 'Write 400–750 characters: what you fix or sell, the brands, your area and what makes you different. Edit it in Listings and press Update everywhere.',
    },
    {
      id: 'category', label: 'Main category', weight: 3,
      status: g.categories?.primaryCategory?.displayName ? 'pass' : 'fail',
      detail: g.categories?.primaryCategory?.displayName ?? 'No category.',
      fix: 'Pick the category that matches your main service exactly (e.g. “Mobile phone repair shop”) in Google Business Profile → Edit profile → Business category.',
      link: 'https://business.google.com/',
    },
    {
      id: 'extra-categories', label: 'Extra categories', weight: 1,
      status: extraCats >= 2 ? 'pass' : extraCats === 1 ? 'warn' : 'fail',
      detail: extraCats ? `${extraCats}: ${(g.categories?.additionalCategories ?? []).map((c) => c.displayName).filter(Boolean).slice(0, 5).join(', ')}` : 'None.',
      fix: 'Add 2–5 extra categories for your other services (e.g. “Computer repair service”, “Electronics repair shop”). Each one lets you show for more searches.',
      link: 'https://business.google.com/',
    },
    {
      id: 'services', label: 'Services listed', weight: 2,
      status: services >= 8 ? 'pass' : services >= 3 ? 'warn' : 'fail',
      detail: `${services} service${services === 1 ? '' : 's'} on the profile.`,
      fix: 'List every service with a short description (e.g. “iPhone screen replacement”, “Samsung battery replacement”, “Water damage repair”) in Edit profile → Services.',
      link: 'https://business.google.com/',
    },
    {
      id: 'hours', label: 'Opening hours', weight: 2, page: 'listings',
      status: g.regularHours?.periods?.length ? 'pass' : 'fail',
      detail: g.regularHours?.periods?.length ? 'Set.' : 'Not set.',
      fix: 'Add your opening hours in Listings and press Update everywhere.',
    },
    {
      id: 'holiday-hours', label: 'Holiday hours', weight: 1, page: 'listings',
      status: upcomingSpecial ? 'pass' : holidaySeason ? 'warn' : 'skip',
      detail: upcomingSpecial ? `${upcomingSpecial} upcoming day${upcomingSpecial === 1 ? '' : 's'} set.` : 'None set for the coming holidays.',
      fix: 'Add your public holiday hours in Listings (Christmas, New Year, Easter…). Google shows “hours might differ” without them.',
    },
    {
      id: 'website', label: 'Website link', weight: 1, page: 'listings',
      status: g.websiteUri ? 'pass' : 'fail',
      detail: g.websiteUri ?? 'No website.',
      fix: 'Add your website in Listings and press Update everywhere.',
    },
    {
      id: 'phone', label: 'Phone number', weight: 1, page: 'listings',
      status: g.phoneNumbers?.primaryPhone ? 'pass' : 'fail',
      detail: g.phoneNumbers?.primaryPhone ?? 'No phone number.',
      fix: 'Add your phone number in Listings and press Update everywhere.',
    },
    {
      id: 'photos', label: 'Photos', weight: 2,
      status: photos === null ? 'skip' : photos >= 25 ? 'pass' : photos >= 10 ? 'warn' : 'fail',
      detail: photos === null ? 'Couldn’t count photos.' : `${photos} photo${photos === 1 ? '' : 's'}.`,
      fix: 'Add real photos every month: shopfront (so people find you), inside, team, and before/after repairs. Profiles with more photos get more direction requests.',
      link: 'https://business.google.com/',
    },
    {
      id: 'posts', label: 'Posting regularly', weight: 2, page: 'marketing',
      status: postAge === null ? 'fail' : postAge <= 7 ? 'pass' : postAge <= 30 ? 'warn' : 'fail',
      detail: postAge === null ? 'No Google posts found.' : postAge === 0 ? 'Last post today.' : `Last post ${postAge} day${postAge === 1 ? '' : 's'} ago.`,
      fix: 'Post at least once a week. Set up Auto posts in Marketing → Promotions and ChatBird will post for you.',
    },
    {
      id: 'review-count', label: 'Number of reviews', weight: 3, page: 'reviews',
      status: reviews.total >= 100 ? 'pass' : reviews.total >= 20 ? 'warn' : 'fail',
      detail: `${reviews.total} review${reviews.total === 1 ? '' : 's'}.`,
      fix: 'Turn on automatic review requests and put the review QR code on the counter (Reviews page).',
    },
    {
      id: 'rating', label: 'Average rating', weight: 2, page: 'reviews',
      status: avg === null ? 'skip' : avg >= 4.6 ? 'pass' : avg >= 4.2 ? 'warn' : 'fail',
      detail: avg === null ? 'No ratings yet.' : `${avg}★ average.`,
      fix: 'Ask every happy customer for a review straight after the repair, and reply calmly to low ratings so readers see you care.',
    },
    {
      id: 'fresh-reviews', label: 'Recent reviews', weight: 2, page: 'reviews',
      status: newestAge === null ? 'fail' : newestAge <= 14 ? 'pass' : newestAge <= 45 ? 'warn' : 'fail',
      detail: newestAge === null ? 'No reviews yet.' : `Newest review ${newestAge} day${newestAge === 1 ? '' : 's'} ago.`,
      fix: 'Google favours a steady flow of new reviews. Automatic review requests after each repair keep it going.',
    },
    {
      id: 'replies', label: 'Replying to reviews', weight: 2, page: 'reviews',
      status: replyRate === null ? 'skip' : replyRate >= 90 ? 'pass' : replyRate >= 50 ? 'warn' : 'fail',
      detail: replyRate === null ? 'No reviews in the last 90 days.' : `${replyRate}% of reviews in the last 90 days have a reply.`,
      fix: 'Reply to every review. Turn on automatic AI replies for 4–5★ reviews on the Reviews page.',
    },
  ];
  const counted = checks.filter((c) => c.status !== 'skip');
  const total = counted.reduce((s, c) => s + c.weight, 0);
  const score = total ? Math.round((counted.reduce((s, c) => s + c.weight * statusScore[c.status], 0) / total) * 100) : 0;
  return { location: g.title ?? connection.name, mapsUri: g.metadata?.mapsUri ?? null, score, checks };
}

// ---------- Profile insights (Business Profile Performance API) ----------

const METRICS = {
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'searchViews',
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'searchViews',
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'mapsViews',
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'mapsViews',
  CALL_CLICKS: 'calls',
  WEBSITE_CLICKS: 'websiteClicks',
  BUSINESS_DIRECTION_REQUESTS: 'directions',
} as const;
type Metric = (typeof METRICS)[keyof typeof METRICS];
const METRIC_NAMES: Metric[] = ['searchViews', 'mapsViews', 'calls', 'websiteClicks', 'directions'];

const dateParts = (prefix: string, d: Date) => ({ [`${prefix}.year`]: String(d.getUTCFullYear()), [`${prefix}.month`]: String(d.getUTCMonth() + 1), [`${prefix}.day`]: String(d.getUTCDate()) });

async function profileInsights(connection: Connection, days: number) {
  const token = await accessToken(connection);
  // Google's numbers arrive a few days late; stop 3 days ago so the two periods compare fairly.
  const end = daysAgo(3);
  const start = new Date(end.getTime() - (days * 2 - 1) * DAY_MS);
  const split = ymd(new Date(end.getTime() - (days - 1) * DAY_MS));
  const url = new URL(googleApi(`businessprofileperformance.googleapis.com/v1/${locationPath(connection)}:fetchMultiDailyMetricsTimeSeries`));
  for (const m of Object.keys(METRICS)) url.searchParams.append('dailyMetrics', m);
  for (const [k, v] of Object.entries({ ...dateParts('dailyRange.start_date', start), ...dateParts('dailyRange.end_date', end) })) url.searchParams.set(k, v);
  const data = await googleFetch<{
    multiDailyMetricTimeSeries?: { dailyMetricTimeSeries?: { dailyMetric: string; timeSeries?: { datedValues?: { date: { year: number; month: number; day: number }; value?: string }[] } }[] }[];
  }>(token, url.toString());

  const blank = () => Object.fromEntries(METRIC_NAMES.map((m) => [m, 0])) as Record<Metric, number>;
  const current = blank();
  const previous = blank();
  const daily = new Map<string, Record<Metric, number>>();
  for (const group of data.multiDailyMetricTimeSeries ?? []) {
    for (const series of group.dailyMetricTimeSeries ?? []) {
      const metric = METRICS[series.dailyMetric as keyof typeof METRICS];
      if (!metric) continue;
      for (const dv of series.timeSeries?.datedValues ?? []) {
        const date = `${dv.date.year}-${String(dv.date.month).padStart(2, '0')}-${String(dv.date.day).padStart(2, '0')}`;
        const value = Number(dv.value ?? 0) || 0;
        if (date >= split) {
          current[metric] += value;
          if (!daily.has(date)) daily.set(date, blank());
          daily.get(date)![metric] += value;
        } else previous[metric] += value;
      }
    }
  }
  const series: ({ date: string } & Record<Metric, number>)[] = [];
  for (let t = Date.parse(`${split}T00:00:00Z`); t <= end.getTime(); t += DAY_MS) {
    const date = ymd(new Date(t));
    series.push({ date, ...(daily.get(date) ?? blank()) });
  }

  // What people searched to find the profile (monthly; Google hides small numbers).
  let keywords: { keyword: string; count: number | null; under: number | null }[] = [];
  let keywordMonths = '';
  try {
    const last = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1));
    const first = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - 2, 1));
    keywordMonths = `${first.toLocaleDateString('en-AU', { month: 'short', timeZone: 'UTC' })}–${last.toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
    let pageToken = '';
    let pages = 0;
    do {
      const k = new URL(googleApi(`businessprofileperformance.googleapis.com/v1/${locationPath(connection)}/searchkeywords/impressions/monthly`));
      k.searchParams.set('monthlyRange.start_month.year', String(first.getUTCFullYear()));
      k.searchParams.set('monthlyRange.start_month.month', String(first.getUTCMonth() + 1));
      k.searchParams.set('monthlyRange.end_month.year', String(last.getUTCFullYear()));
      k.searchParams.set('monthlyRange.end_month.month', String(last.getUTCMonth() + 1));
      k.searchParams.set('pageSize', '100');
      if (pageToken) k.searchParams.set('pageToken', pageToken);
      const page = await googleFetch<{ searchKeywordsCounts?: { searchKeyword: string; insightsValue?: { value?: string; threshold?: string } }[]; nextPageToken?: string }>(token, k.toString());
      for (const row of page.searchKeywordsCounts ?? []) {
        keywords.push({
          keyword: row.searchKeyword,
          count: row.insightsValue?.value ? Number(row.insightsValue.value) : null,
          under: row.insightsValue?.threshold ? Number(row.insightsValue.threshold) : null,
        });
      }
      pageToken = page.nextPageToken ?? '';
    } while (pageToken && ++pages < 3);
    keywords = keywords.sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 30);
  } catch (err) {
    console.error('Search keywords failed:', (err as Error).message);
  }

  return { from: split, to: ymd(end), current, previous, daily: series, keywords, keywordMonths };
}

// ---------- Search Console ----------

interface GscLink {
  business_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  site_url: string | null;
  last_error: string | null;
  connected_at: string;
}

export function searchConsoleAuthUrl(businessId: string, userId: string) {
  return googleAuthUrl(googleRedirectUri(), signOAuthState({ businessId, userId, provider: 'search_console' }), GSC_SCOPE);
}

/**
 * Google sends every sign-in back to the one registered callback address (/api/google/callback or
 * /api/integrations/google/callback). This handles it when the sign-in was for Search Console; returns
 * false for anything else so the Business Profile sign-in carries on as before.
 */
export async function handleSearchConsoleCallback(req: Request, res: Response) {
  const state = verifyOAuthState(String(req.query.state ?? ''));
  if (state?.provider !== 'search_console') return false;
  const back = (q: string) => res.redirect(`/?view=seo&${q}`);
  if (readSession(req)?.userId !== state.userId) back('error=' + encodeURIComponent('That sign-in link expired. Try connecting again.'));
  else if (req.query.error) back('error=' + encodeURIComponent('Search Console sign-in was cancelled.'));
  else {
    try {
      await connectSearchConsole(state.businessId, String(req.query.code ?? ''));
      back('connected=' + encodeURIComponent('Google Search Console'));
    } catch (err) {
      back('error=' + encodeURIComponent((err as Error).message));
    }
  }
  return true;
}

/** Finishes the Search Console sign-in. */
export async function connectSearchConsole(businessId: string, code: string) {
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: googleRedirectUri() });
  const existing = get<GscLink>('SELECT * FROM search_console_links WHERE business_id = ?', businessId);
  const refresh = tokens.refresh_token ?? (existing ? decrypt(existing.refresh_token) : null);
  if (!refresh) throw new GoogleError('Google didn’t return a refresh token. Remove ChatBird at myaccount.google.com/permissions and connect again.');
  const expires = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  run(
    `INSERT INTO search_console_links (business_id, access_token, refresh_token, token_expires_at, site_url, connected_at) VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT(business_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, token_expires_at = excluded.token_expires_at, last_error = NULL`,
    businessId, encrypt(tokens.access_token), encrypt(refresh), expires, now(),
  );
  const link = get<GscLink>('SELECT * FROM search_console_links WHERE business_id = ?', businessId)!;
  if (!link.site_url) {
    // Pick the property that matches the business's website.
    const sites = await listSites(link).catch(() => []);
    const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
    const host = hostOf(publicListing(businessId).website || business.website_url || '');
    const match = sites.find((s) => hostOf(s.siteUrl) === host) ?? (sites.length === 1 ? sites[0] : undefined);
    if (match) run('UPDATE search_console_links SET site_url = ? WHERE business_id = ?', match.siteUrl, businessId);
  }
}

const hostOf = (url: string) => {
  if (url.startsWith('sc-domain:')) return url.slice(10).replace(/^www\./, '').toLowerCase();
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};

async function gscToken(link: GscLink) {
  if (Date.parse(link.token_expires_at) - Date.now() > 60_000) return decrypt(link.access_token);
  try {
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(link.refresh_token) });
    const expires = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    run('UPDATE search_console_links SET access_token = ?, token_expires_at = ?, last_error = NULL WHERE business_id = ?', encrypt(tokens.access_token), expires, link.business_id);
    return tokens.access_token;
  } catch (err) {
    const msg = /invalid_grant|revoked|expired/i.test((err as Error).message) ? 'Reconnect Search Console: access was revoked or expired.' : (err as Error).message;
    run('UPDATE search_console_links SET last_error = ? WHERE business_id = ?', msg.slice(0, 300), link.business_id);
    throw new GoogleError(msg);
  }
}

async function listSites(link: GscLink) {
  const token = await gscToken(link);
  const data = await googleFetch<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(token, googleApi('www.googleapis.com/webmasters/v3/sites'));
  return (data.siteEntry ?? []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
}

interface GscRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

async function gscQuery(link: GscLink, body: Record<string, unknown>) {
  const token = await gscToken(link);
  const data = await googleFetch<{ rows?: GscRow[] }>(
    token,
    googleApi(`www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(link.site_url!)}/searchAnalytics/query`),
    { method: 'POST', body },
  );
  return data.rows ?? [];
}

async function searchConsoleReport(link: GscLink, days: number) {
  // Search Console data is 2-3 days behind.
  const end = daysAgo(3);
  const split = new Date(end.getTime() - (days - 1) * DAY_MS);
  const start = new Date(end.getTime() - (days * 2 - 1) * DAY_MS);
  const [byDate, queries, pages] = await Promise.all([
    gscQuery(link, { startDate: ymd(start), endDate: ymd(end), dimensions: ['date'], rowLimit: 500 }),
    gscQuery(link, { startDate: ymd(split), endDate: ymd(end), dimensions: ['query'], rowLimit: 250 }),
    gscQuery(link, { startDate: ymd(split), endDate: ymd(end), dimensions: ['page'], rowLimit: 15 }),
  ]);
  const sum = (rows: GscRow[]) => {
    const clicks = rows.reduce((s, r) => s + r.clicks, 0);
    const impressions = rows.reduce((s, r) => s + r.impressions, 0);
    const position = impressions ? rows.reduce((s, r) => s + r.position * r.impressions, 0) / impressions : 0;
    return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: Math.round(position * 10) / 10 };
  };
  const cur = byDate.filter((r) => (r.keys?.[0] ?? '') >= ymd(split));
  const prev = byDate.filter((r) => (r.keys?.[0] ?? '') < ymd(split));
  const row = (r: GscRow) => ({ key: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: Math.round(r.position * 10) / 10 });
  return {
    siteUrl: link.site_url,
    from: ymd(split),
    to: ymd(end),
    current: sum(cur),
    previous: sum(prev),
    daily: cur.map((r) => ({ date: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions })).sort((a, b) => a.date.localeCompare(b.date)),
    queries: queries.slice(0, 50).map(row),
    pages: pages.map(row),
    // Searches where the site is close to the top: small changes can bring a lot more clicks.
    opportunities: queries
      .filter((r) => r.position >= 4 && r.position <= 20 && r.impressions >= 10)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10)
      .map(row),
  };
}

// ---------- Routes ----------

seoRouter.use(requireAuth);

const loadBusiness = (req: Request) => get<Business>('SELECT * FROM businesses WHERE id = ?', req.session!.businessId)!;
const googleLocations = (businessId: string) =>
  all<Connection>("SELECT * FROM connections WHERE business_id = ? AND provider = 'google' ORDER BY created_at", businessId);
const pickLocation = (businessId: string, id: unknown) => {
  const list = googleLocations(businessId);
  return (typeof id === 'string' && list.find((c) => c.id === id)) || list[0];
};

seoRouter.get('/', (req, res) => {
  const business = loadBusiness(req);
  const link = get<GscLink>('SELECT * FROM search_console_links WHERE business_id = ?', business.id);
  const listing = publicListing(business.id);
  res.json({
    googleAvailable: googleConfigured(),
    aiAvailable: aiConfigured(),
    pagespeedKey: Boolean(config('PAGESPEED_API_KEY')),
    locations: googleLocations(business.id).map((c) => ({ id: c.id, name: c.name })),
    website: listing.website || business.website_url || '',
    searchConsole: link ? { connected: true, siteUrl: link.site_url, error: link.last_error } : { connected: false, siteUrl: null, error: null },
    schemaInject: Boolean(business.seo_schema_inject),
    businessType: business.seo_business_type,
    businessTypes: BUSINESS_TYPES,
    schema: businessSchema(business.id),
    audits: all<{ id: string; url: string; score: number; created_at: string }>(
      'SELECT id, url, score, created_at FROM seo_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 20',
      business.id,
    ),
  });
});

seoRouter.put('/settings', (req, res) => {
  const business = loadBusiness(req);
  if (typeof req.body.schemaInject === 'boolean') run('UPDATE businesses SET seo_schema_inject = ? WHERE id = ?', req.body.schemaInject ? 1 : 0, business.id);
  if (typeof req.body.businessType === 'string') {
    if (!BUSINESS_TYPES.some((t) => t.id === req.body.businessType)) return res.status(400).json({ error: 'Unknown business type' });
    run('UPDATE businesses SET seo_business_type = ? WHERE id = ?', req.body.businessType, business.id);
  }
  const updated = loadBusiness(req);
  res.json({ schemaInject: Boolean(updated.seo_schema_inject), businessType: updated.seo_business_type, schema: businessSchema(business.id) });
});

const googleError = (err: unknown) => {
  const msg = (err as Error).message || 'Google didn’t answer. Try again shortly.';
  if (/has not been used|is disabled|SERVICE_DISABLED|not been enabled/i.test(msg)) {
    return `${msg.split('. ')[0]}. Turn this API on in Google Cloud (see the note on this page), wait a few minutes, then try again.`;
  }
  return msg;
};

seoRouter.get('/profile-score', rateLimit('seo-google', 60, 10 * 60 * 1000), async (req, res) => {
  const business = loadBusiness(req);
  const location = pickLocation(business.id, req.query.location);
  if (!location) return res.status(400).json({ error: 'Connect Google Business Profile on the Integrations page first' });
  try {
    res.json(await profileScore(business, location));
  } catch (err) {
    res.status(502).json({ error: googleError(err) });
  }
});

seoRouter.get('/insights', rateLimit('seo-google', 60, 10 * 60 * 1000), async (req, res) => {
  const business = loadBusiness(req);
  const location = pickLocation(business.id, req.query.location);
  if (!location) return res.status(400).json({ error: 'Connect Google Business Profile on the Integrations page first' });
  const days = [7, 28, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 28;
  try {
    res.json(await profileInsights(location, days));
  } catch (err) {
    res.status(502).json({ error: googleError(err) });
  }
});

seoRouter.get('/search-console/connect', (req, res) => {
  if (!googleConfigured()) return res.redirect('/?view=seo&error=' + encodeURIComponent('Google isn’t set up on the server yet (Integrations → Server keys).'));
  if (!publicUrl() && !process.env.GOOGLE_REDIRECT_URI && !config('GOOGLE_REDIRECT_URI')) return res.redirect('/?view=seo&error=' + encodeURIComponent('Set PUBLIC_URL on the server first.'));
  res.redirect(searchConsoleAuthUrl(req.session!.businessId, req.session!.userId));
});

seoRouter.get('/search-console/sites', async (req, res) => {
  const link = get<GscLink>('SELECT * FROM search_console_links WHERE business_id = ?', req.session!.businessId);
  if (!link) return res.status(400).json({ error: 'Connect Search Console first' });
  try {
    res.json({ sites: await listSites(link) });
  } catch (err) {
    res.status(502).json({ error: googleError(err) });
  }
});

seoRouter.put('/search-console/site', async (req, res) => {
  const link = get<GscLink>('SELECT * FROM search_console_links WHERE business_id = ?', req.session!.businessId);
  if (!link) return res.status(400).json({ error: 'Connect Search Console first' });
  const siteUrl = String(req.body.siteUrl ?? '');
  try {
    if (!(await listSites(link)).some((s) => s.siteUrl === siteUrl)) return res.status(400).json({ error: 'That website isn’t in this Search Console account' });
  } catch (err) {
    return res.status(502).json({ error: googleError(err) });
  }
  run('UPDATE search_console_links SET site_url = ? WHERE business_id = ?', siteUrl, link.business_id);
  res.json({ siteUrl });
});

seoRouter.delete('/search-console', (req, res) => {
  run('DELETE FROM search_console_links WHERE business_id = ?', req.session!.businessId);
  res.json({ ok: true });
});

seoRouter.get('/search-console', rateLimit('seo-google', 60, 10 * 60 * 1000), async (req, res) => {
  const link = get<GscLink>('SELECT * FROM search_console_links WHERE business_id = ?', req.session!.businessId);
  if (!link) return res.status(400).json({ error: 'Connect Search Console first' });
  if (!link.site_url) return res.status(400).json({ error: 'Choose your website first' });
  const days = [7, 28, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 28;
  try {
    res.json(await searchConsoleReport(link, days));
  } catch (err) {
    const msg = googleError(err);
    run('UPDATE search_console_links SET last_error = ? WHERE business_id = ?', msg.slice(0, 300), link.business_id);
    res.status(502).json({ error: msg });
  }
});

seoRouter.post('/audit', rateLimit('seo-audit', 15, 60 * 60 * 1000), async (req, res) => {
  const business = loadBusiness(req);
  let url = String(req.body.url ?? '').trim().slice(0, 500);
  if (!url) url = publicListing(business.id).website || business.website_url || '';
  if (!url) return res.status(400).json({ error: 'Enter your website address' });
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Only http and https addresses can be checked.' });
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const result = await auditPage(business, url);
    const id = newId();
    run('INSERT INTO seo_audits (id, business_id, url, score, result, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, business.id, result.finalUrl, result.score, JSON.stringify(result), result.checkedAt);
    // Keep the latest 50 checks.
    run('DELETE FROM seo_audits WHERE business_id = ? AND id NOT IN (SELECT id FROM seo_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 50)', business.id, business.id);
    res.json({ id, ...result });
  } catch (err) {
    const msg = err instanceof GoogleError ? err.message : (err as Error).name === 'TimeoutError' ? 'The website took too long to answer.' : `Couldn’t open that page (${(err as Error).message.slice(0, 120)}).`;
    res.status(400).json({ error: msg });
  }
});

seoRouter.get('/audits/:id', (req, res) => {
  const row = get<{ id: string; result: string }>('SELECT id, result FROM seo_audits WHERE id = ? AND business_id = ?', req.params.id, req.session!.businessId);
  if (!row) return res.status(404).json({ error: 'Check not found' });
  res.json({ id: row.id, ...(JSON.parse(row.result) as AuditResult) });
});
