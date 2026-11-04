import { get, type Conversation } from './db';

/**
 * Where a lead came from. Website chats and forms carry how the visitor reached the site (the
 * widget sends the referring page and any utm_/gclid/fbclid tags from the landing page); calls note
 * whether they came through the shop landline; everything else is the channel itself.
 */
export interface Visit {
  ref?: string;
  landing?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  gclid?: boolean | number;
  fbclid?: boolean | number;
}

const clean = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** How a website visitor found the site, as a short label, plus the detail behind it. */
export function classifyVisit(raw: unknown): { label: string; detail: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Visit;
  const source = clean(v.utm_source, 80).toLowerCase();
  const medium = clean(v.utm_medium, 80).toLowerCase();
  const campaign = clean(v.utm_campaign, 80);
  let refHost = '';
  let refPath = '';
  let landingHost = '';
  try {
    if (v.ref) ({ hostname: refHost, pathname: refPath } = new URL(clean(v.ref, 500)));
  } catch { /* not a URL */ }
  try {
    if (v.landing) landingHost = new URL(clean(v.landing, 500)).hostname;
  } catch { /* not a URL */ }
  const detail = [source && `utm_source=${source}`, medium && `utm_medium=${medium}`, campaign && `utm_campaign=${campaign}`, refHost && `from ${refHost}`]
    .filter(Boolean)
    .join(' · ');
  const label = (() => {
    if (/gbp|gmb|google.?business|googlemybusiness|business\.google/.test(`${source} ${medium} ${campaign.toLowerCase()}`)) return 'Google Business Profile';
    if (v.gclid || (/google/.test(source) && /cpc|ppc|paid|ads?/.test(medium))) return 'Google Ads';
    if (v.fbclid || /facebook|^fb$|meta/.test(source)) return /cpc|paid|ads?/.test(medium) ? 'Facebook ads' : 'Facebook';
    if (/instagram|^ig$/.test(source)) return 'Instagram';
    if (/sms|text/.test(source) || /sms/.test(medium)) return 'Text message link';
    if (/email|newsletter/.test(source) || medium === 'email') return 'Email link';
    if (source) return source.charAt(0).toUpperCase() + source.slice(1);
    if (!refHost || refHost === landingHost) return 'Direct (typed in or bookmarked)';
    if (/(^|\.)google\./.test(refHost)) return refPath.startsWith('/maps') || refHost.startsWith('maps.') ? 'Google Maps' : 'Google search';
    if (/(^|\.)(bing|duckduckgo|yahoo|ecosia)\./.test(refHost)) return 'Other search engine';
    if (/facebook\.com$|fb\.me$|fb\.com$/.test(refHost)) return 'Facebook';
    if (/instagram\.com$/.test(refHost)) return 'Instagram';
    return refHost.replace(/^www\./, '');
  })();
  return { label, detail };
}

const FORM_NAMES: Record<string, string> = { booking: 'booking form', quote: 'quote form', callback: 'call-back form', enquiry: 'enquiry form' };

/** One line for the conversation header, e.g. "Website chat · Google Maps · /iphone-screen-repair". */
export function leadSourceLine(conversation: Conversation & { referrer?: string | null }) {
  const first = get<{ kind: string; automated: number }>("SELECT kind, automated FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY created_at LIMIT 1", conversation.id);
  const call = get<{ forwarded_from: string | null; ai_handled: number }>('SELECT forwarded_from, ai_handled FROM calls WHERE conversation_id = ? ORDER BY created_at LIMIT 1', conversation.id);
  const parts: string[] = [];
  if (first?.kind === 'call' || first?.kind === 'voicemail') {
    parts.push(call?.forwarded_from ? 'Phone call to the shop landline' : 'Phone call');
  } else if (conversation.channel === 'webchat') {
    parts.push(first && FORM_NAMES[first.kind] ? `Website ${FORM_NAMES[first.kind]}` : 'Website chat');
  } else {
    parts.push({ sms: 'Text message', email: 'Email', facebook: 'Facebook Messenger', instagram: 'Instagram' }[conversation.channel] ?? conversation.channel);
  }
  if (conversation.referrer) parts.push(conversation.referrer);
  if (conversation.page_url) {
    try {
      const path = new URL(conversation.page_url).pathname.replace(/\/$/, '');
      if (path) parts.push(path);
    } catch { /* not a URL */ }
  }
  return parts.join(' · ');
}
