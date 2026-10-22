export interface Business {
  id: string;
  name: string;
  widgetKey: string;
  color: string;
  greeting: string;
  smsNumber: string | null;
  smsAvailable: boolean;
  hoursEnabled: boolean;
  timezone: string;
  hours: WeeklyHours;
  awayMessage: string;
  openNow: boolean;
  aiNotes: string;
  aiAvailable: boolean;
  emailAvailable: boolean;
  forwardNumber: string | null;
  ringSeconds: number;
  voicemailGreeting: string;
  missedCallTextEnabled: boolean;
  missedCallText: string;
  reviewLink: string | null;
  /** The link review requests use: the owner's own, or the one from Google Business Profile. */
  reviewLinkEffective: string | null;
  reviewRequestText: string;
  websiteUrl: string | null;
  websiteImportedAt: string | null;
  widgetPosition: 'left' | 'right';
  widgetOffsetX: number;
  widgetOffsetY: number;
  widgetQuote: boolean;
  widgetCallback: boolean;
  widgetCallNumber: string | null;
  repairbillUrl: string | null;
  /** Last characters of the saved RepairBill key, e.g. ••••a1b2. */
  repairbillKeyHint: string | null;
  repairbillLastSentAt: string | null;
  repairbillLastError: string | null;
  replyEmail: string | null;
  /** Where customers' answers to emails go: replyEmail, or the owner's login email. */
  replyEmailEffective: string | null;
}

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];
export type WeeklyHours = Record<Day, { open: string; close: string } | null>;

export interface BusinessSummary {
  id: string;
  name: string;
  color: string;
  unread: number;
}

export interface Me {
  businesses: BusinessSummary[];
  user: { id: string; name: string; email: string; notifyEmail: boolean; phone: string | null; isAdmin: boolean };
  business: Business;
}

export interface SavedReply {
  id: string;
  title: string;
  body: string;
}

/** Fills {name} (customer's first name) and {business} placeholders in a saved reply. */
export function fillReply(body: string, contactName: string, businessName: string) {
  const first = contactName.trim().split(/\s+/)[0] || 'there';
  return body.replace(/\{name\}/gi, first).replace(/\{business\}/gi, businessName);
}

export type Channel = 'webchat' | 'sms' | 'facebook' | 'instagram' | 'email';

export const CHANNEL_LABELS: Record<Channel, string> = { webchat: 'Chat', sms: 'Text', facebook: 'Messenger', instagram: 'Instagram', email: 'Email' };

export interface ConversationSummary {
  id: string;
  channel: Channel;
  status: 'open' | 'closed';
  unreadCount: number;
  lastMessageAt: string;
  lastMessage: string | null;
  lastDirection: 'in' | 'out' | null;
  contactName: string;
  contactPhone: string | null;
  businessId: string;
  businessName: string;
  businessColor: string;
  online: boolean;
  tags: Tag[];
}

export interface Message {
  id: string;
  direction: 'in' | 'out';
  channel: Channel;
  body: string;
  author_name: string | null;
  automated: number;
  kind: 'text' | 'call' | 'voicemail' | 'quote' | 'callback';
  duration: number | null;
  created_at: string;
}

export interface ConversationDetail {
  id: string;
  channel: Channel;
  status: 'open' | 'closed';
  pageUrl: string | null;
  createdAt: string;
  online: boolean;
  contact: { id: string; name: string; phone: string | null; email: string | null };
  replyChannels: Channel[];
  defaultChannel: Channel | null;
  tags: Tag[];
}

/** An internal, colour-coded label on conversations. Customers never see tags. */
export interface Tag {
  id: string;
  name: string;
  color: string;
  /** How many conversations have it (only from GET /tags). */
  uses?: number;
}

/** The colour choices offered when creating or recolouring a tag. */
export const TAG_COLORS = ['#2563eb', '#0891b2', '#16a34a', '#65a30d', '#ca8a04', '#ea580c', '#dc2626', '#db2777', '#9333ea', '#475569'];

/** White or dark text, whichever reads better on the given background colour (WCAG contrast). */
export function tagTextColor(hex: string) {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Contrast against white is 1.05 / (L + 0.05); against near-black (#0f172a, L≈0.009) it's (L + 0.05) / 0.059.
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.059 ? '#ffffff' : '#0f172a';
}

/** Events pushed over /api/stream. */
export type InboxEvent = (
  | { type: 'message'; conversationId: string; message: Message }
  | { type: 'message-updated'; conversationId: string; message: Message }
  | { type: 'read'; conversationId: string }
  | { type: 'contact'; contactId: string; conversationId?: undefined }
  | { type: 'status'; conversationId: string; status: 'open' | 'closed' }
  | { type: 'presence'; conversationId: string; online: boolean }
  | { type: 'review'; count: number; conversationId?: undefined }
  | { type: 'tags'; conversationId?: string }
) & { /** Which business the event is for (the stream follows all of them). */ businessId: string };

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Something went wrong', res.status);
  return data as T;
}

export function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
