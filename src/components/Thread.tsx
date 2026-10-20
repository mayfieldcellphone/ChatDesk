import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type Business, type Channel, type ConversationDetail, type InboxEvent, type Message } from '../api';

interface Props {
  conversationId: string;
  business: Business;
  lastEvent: InboxEvent | null;
  onChanged: () => void;
}

export default function Thread({ conversationId, business, lastEvent, onChanged }: Props) {
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [channel, setChannel] = useState<Channel>('webchat');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const load = () =>
    api<{ conversation: ConversationDetail; messages: Message[] }>(`/conversations/${conversationId}`).then((d) => {
      setConversation(d.conversation);
      setMessages(d.messages);
      return d.conversation;
    });

  useEffect(() => {
    load()
      .then((c) => {
        // Default to whichever channel the customer can see: chat while they're on the site, otherwise text.
        setChannel(c.channel === 'sms' || (!c.online && canText(c)) ? 'sms' : 'webchat');
        onChanged();
      })
      .catch((err) => setError(err.message));
  }, [conversationId]);

  useEffect(() => {
    if (!lastEvent || lastEvent.conversationId !== conversationId) return;
    if (lastEvent.type === 'message') {
      setMessages((list) => (list.some((m) => m.id === lastEvent.message.id) ? list : [...list, lastEvent.message]));
      // Opening the conversation again marks the new message as read.
      if (lastEvent.message.direction === 'in') load().then(onChanged).catch(console.error);
    } else if (lastEvent.type === 'presence') {
      setConversation((c) => (c ? { ...c, online: lastEvent.online } : c));
    } else if (lastEvent.type === 'status') {
      setConversation((c) => (c ? { ...c, status: lastEvent.status } : c));
    }
  }, [lastEvent]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const canText = (c: ConversationDetail) => Boolean(business.smsAvailable && business.smsNumber && c.contact.phone);
  // A conversation that started by text has no widget session to deliver chat replies to.
  const canChat = (c: ConversationDetail) => c.channel === 'webchat' || messages.some((m) => m.channel === 'webchat');

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError('');
    try {
      const { message } = await api<{ message: Message }>(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: { body, channel },
      });
      setMessages((list) => (list.some((m) => m.id === message.id) ? list : [...list, message]));
      setDraft('');
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const setStatus = async (status: 'open' | 'closed') => {
    await api(`/conversations/${conversationId}`, { method: 'PATCH', body: { status } });
    setConversation((c) => (c ? { ...c, status } : c));
    onChanged();
  };

  if (!conversation) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-400">{error || 'Loading…'}</div>;
  }

  const { contact } = conversation;
  const textable = canText(conversation);
  const chattable = canChat(conversation);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-slate-200 bg-white px-6 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-semibold">{contact.name}</h2>
            {conversation.online ? (
              <span className="rounded-full bg-green-100 px-2 text-xs text-green-700">On your website</span>
            ) : (
              <span className="rounded-full bg-slate-100 px-2 text-xs text-slate-500">Offline</span>
            )}
          </div>
          <div className="truncate text-xs text-slate-500">
            {[contact.phone, contact.email].filter(Boolean).join(' · ')}
            {conversation.pageUrl && (
              <>
                {' · from '}
                <a href={conversation.pageUrl} target="_blank" rel="noreferrer noopener" className="text-blue-600 hover:underline">
                  {conversation.pageUrl.replace(/^https?:\/\//, '').slice(0, 60)}
                </a>
              </>
            )}
          </div>
        </div>
        <button
          onClick={() => setStatus(conversation.status === 'open' ? 'closed' : 'open')}
          className="ml-auto shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          {conversation.status === 'open' ? 'Close' : 'Reopen'}
        </button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-6 py-4">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
            <div className="max-w-[70%]">
              <div
                className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-2 text-sm ${
                  m.direction === 'out' ? 'rounded-br-sm bg-blue-600 text-white' : 'rounded-bl-sm border border-slate-200 bg-white'
                }`}
              >
                {m.body}
              </div>
              <div className={`mt-1 text-[11px] text-slate-400 ${m.direction === 'out' ? 'text-right' : ''}`}>
                {m.direction === 'out' && m.author_name ? `${m.author_name} · ` : ''}
                {m.channel === 'sms' ? 'Text' : 'Chat'} · {new Date(m.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <form onSubmit={send} className="border-t border-slate-200 bg-white p-4">
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className="text-slate-500">Reply by</span>
          <button
            type="button"
            disabled={!chattable}
            onClick={() => setChannel('webchat')}
            className={`rounded-full px-3 py-1 ${channel === 'webchat' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'} disabled:opacity-40`}
          >
            Web chat
          </button>
          <button
            type="button"
            disabled={!textable}
            onClick={() => setChannel('sms')}
            title={textable ? undefined : 'Add your Twilio number in Settings to reply by text'}
            className={`rounded-full px-3 py-1 ${channel === 'sms' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'} disabled:opacity-40`}
          >
            Text {contact.phone ?? ''}
          </button>
          {channel === 'webchat' && !conversation.online && (
            <span className="text-amber-600">They'll see this next time they open your website.</span>
          )}
        </div>
        <div className="flex gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            maxLength={1600}
            placeholder="Type a reply… (Enter to send, Shift+Enter for a new line)"
            className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
          <button
            disabled={sending || !draft.trim()}
            className="rounded-md bg-blue-600 px-5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
