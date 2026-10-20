export interface Business {
  id: string;
  name: string;
  widgetKey: string;
  color: string;
  greeting: string;
  smsNumber: string | null;
  smsAvailable: boolean;
}

export interface Me {
  user: { id: string; name: string; email: string };
  business: Business;
}

export type Channel = 'webchat' | 'sms';

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
  online: boolean;
}

export interface Message {
  id: string;
  direction: 'in' | 'out';
  channel: Channel;
  body: string;
  author_name: string | null;
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
}

/** Events pushed over /api/stream. */
export type InboxEvent =
  | { type: 'message'; conversationId: string; message: Message }
  | { type: 'read'; conversationId: string }
  | { type: 'status'; conversationId: string; status: 'open' | 'closed' }
  | { type: 'presence'; conversationId: string; online: boolean };

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
