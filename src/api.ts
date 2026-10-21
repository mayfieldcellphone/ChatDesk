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
  user: { id: string; name: string; email: string; notifyEmail: boolean; phone: string | null };
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

export type Channel = 'webchat' | 'sms' | 'facebook' | 'instagram';

export const CHANNEL_LABELS: Record<Channel, string> = { webchat: 'Chat', sms: 'Text', facebook: 'Messenger', instagram: 'Instagram' };

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
}

export interface Message {
  id: string;
  direction: 'in' | 'out';
  channel: Channel;
  body: string;
  author_name: string | null;
  automated: number;
  kind: 'text' | 'call' | 'voicemail';
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
