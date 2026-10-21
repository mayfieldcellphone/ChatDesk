import { useCallback, useEffect, useRef, useState } from 'react';
import { api, CHANNEL_LABELS, timeAgo, type Business, type BusinessSummary, type ConversationSummary, type InboxEvent } from '../api';
import { playChime, showDesktopAlert } from '../alerts';
import { usePush } from '../push';
import Thread from './Thread';

interface Props {
  business: Business;
  businesses: BusinessSummary[];
  /** Conversation to open first (from a notification). */
  initialConversationId: string | null;
  onSwitchBusiness: (businessId: string) => Promise<void>;
  /** Something changed (new message, read…), so unread counts elsewhere may be stale. */
  onActivity: () => void;
  onOpenSettings: () => void;
}

export default function Inbox({ business, businesses, initialConversationId, onSwitchBusiness, onActivity, onOpenSettings }: Props) {
  const multi = businesses.length > 1;
  // With several businesses, start on the combined inbox.
  const [scope, setScope] = useState<'all' | 'current'>(multi ? 'all' : 'current');
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [query, setQuery] = useState('');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialConversationId);
  const [lastEvent, setLastEvent] = useState<InboxEvent | null>(null);
  const [connected, setConnected] = useState(true);
  const push = usePush();

  const loadList = useCallback(() => {
    const params = new URLSearchParams({ status, q: query, scope: multi ? scope : 'current' });
    api<{ conversations: ConversationSummary[] }>(`/conversations?${params}`)
      .then((d) => setConversations(d.conversations))
      .catch(console.error);
  }, [status, query, scope, multi, business.id]);

  // Conversations belong to a business; open that business first so replies and settings match.
  const open = async (c: ConversationSummary) => {
    if (c.businessId !== business.id) await onSwitchBusiness(c.businessId);
    setSelectedId(c.id);
  };

  useEffect(() => {
    const t = setTimeout(loadList, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadList, query]);

  // The long-lived EventSource reads these through refs so it always sees current state.
  const loadListRef = useRef(loadList);
  loadListRef.current = loadList;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const activityRef = useRef(onActivity);
  activityRef.current = onActivity;
  const businessesRef = useRef(businesses);
  businessesRef.current = businesses;

  const alertNewMessage = (event: Extract<InboxEvent, { type: 'message' }>) => {
    if (event.message.direction !== 'in') return;
    const watching = !document.hidden && selectedRef.current === event.conversationId;
    if (watching) return;
    playChime();
    if (document.hidden) {
      const name = conversationsRef.current.find((c) => c.id === event.conversationId)?.contactName ?? 'a customer';
      const site = businessesRef.current.length > 1 ? businessesRef.current.find((b) => b.id === event.businessId)?.name : null;
      showDesktopAlert(`New message from ${name}${site ? ` · ${site}` : ''}`, event.message.body, () => {
        const c = conversationsRef.current.find((x) => x.id === event.conversationId);
        if (c) open(c);
      });
    }
  };

  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as InboxEvent;
      setLastEvent(event);
      activityRef.current();
      if (event.type === 'message') alertNewMessage(event);
      if (event.type === 'presence') {
        setConversations((list) => list.map((c) => (c.id === event.conversationId ? { ...c, online: event.online } : c)));
      } else {
        loadListRef.current();
      }
    };
    return () => source.close();
  }, []);

  const totalUnread = conversations.reduce((n, c) => n + c.unreadCount, 0);
  useEffect(() => {
    document.title = totalUnread ? `(${totalUnread}) ChatBird Inbox` : 'ChatBird Inbox';
  }, [totalUnread]);

  return (
    <div className="flex h-full">
      {/* On a phone, show the list or the open conversation, not both. */}
      <section className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-slate-200 bg-white md:w-80`}>
        <div className="space-y-3 border-b border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold">Inbox</h1>
            {!connected && <span className="text-xs text-amber-600">Reconnecting…</span>}
          </div>
          {(push.state === 'off' || push.state === 'needs-install') && (
            <button
              onClick={push.state === 'off' ? push.enable : onOpenSettings}
              className="w-full rounded-md bg-amber-50 px-3 py-2 text-left text-xs text-amber-800 hover:bg-amber-100"
            >
              🔔 {push.state === 'off' ? 'Turn on notifications on this device so you don’t miss messages' : 'Add ChatBird to your Home Screen to get notifications (see Settings)'}
            </button>
          )}
          {multi && (
            <div className="flex rounded-md bg-slate-100 p-1 text-sm">
              {([['all', 'All businesses'], ['current', business.name]] as const).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setScope(value)}
                  className={`flex-1 truncate rounded px-2 py-1 ${scope === value ? 'bg-white font-medium shadow-sm' : 'text-slate-500'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="flex rounded-md bg-slate-100 p-1 text-sm">
            {(['open', 'closed'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`flex-1 rounded px-2 py-1 capitalize ${status === s ? 'bg-white font-medium shadow-sm' : 'text-slate-500'}`}
              >
                {s}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or number"
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <ul className="flex-1 overflow-y-auto">
          {conversations.length === 0 && (
            <li className="p-6 text-center text-sm text-slate-500">
              {status === 'open' ? (
                <>
                  No open conversations.{' '}
                  <button onClick={onOpenSettings} className="text-blue-600 hover:underline">
                    Install the widget
                  </button>{' '}
                  to start chatting.
                </>
              ) : (
                'No closed conversations.'
              )}
            </li>
          )}
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => open(c)}
                className={`block w-full border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50 ${
                  selectedId === c.id ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`truncate text-sm ${c.unreadCount ? 'font-bold' : 'font-medium'}`}>{c.contactName}</span>
                  {c.online && <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" title="On your website now" />}
                  <span className="ml-auto shrink-0 text-xs text-slate-400">{timeAgo(c.lastMessageAt)}</span>
                </div>
                {multi && scope === 'all' && (
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                    <span className="h-2 w-2 rounded-full" style={{ background: c.businessColor }} />
                    {c.businessName}
                  </div>
                )}
                <div className="mt-0.5 flex items-center gap-2">
                  <span className={`truncate text-xs ${c.unreadCount ? 'text-slate-800' : 'text-slate-500'}`}>
                    {c.lastDirection === 'out' && 'You: '}
                    {c.lastMessage}
                  </span>
                  <span className="ml-auto shrink-0 rounded bg-slate-100 px-1.5 text-[10px] uppercase text-slate-500">
                    {CHANNEL_LABELS[c.channel]}
                  </span>
                  {c.unreadCount > 0 && (
                    <span className="shrink-0 rounded-full bg-blue-600 px-1.5 text-[10px] font-bold text-white">{c.unreadCount}</span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className={`${selectedId ? 'block' : 'hidden md:block'} min-w-0 flex-1`}>
        {selectedId ? (
          <Thread key={selectedId} conversationId={selectedId} business={business} lastEvent={lastEvent} onChanged={loadList} onBack={() => setSelectedId(null)} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">Select a conversation</div>
        )}
      </section>
    </div>
  );
}
