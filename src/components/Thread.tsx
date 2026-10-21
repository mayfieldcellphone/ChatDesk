import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, CHANNEL_LABELS, fillReply, type Business, type Channel, type ConversationDetail, type InboxEvent, type Message, type SavedReply } from '../api';

interface Props {
  conversationId: string;
  business: Business;
  lastEvent: InboxEvent | null;
  onChanged: () => void;
  /** Back to the conversation list (phone layout). */
  onBack: () => void;
}

export default function Thread({ conversationId, business, lastEvent, onChanged, onBack }: Props) {
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [channel, setChannel] = useState<Channel>('webchat');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [savedReplies, setSavedReplies] = useState<SavedReply[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [calling, setCalling] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api<{ savedReplies: SavedReply[] }>('/saved-replies').then((d) => setSavedReplies(d.savedReplies)).catch(console.error);
  }, []);

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
        if (c.defaultChannel) setChannel(c.defaultChannel);
        onChanged();
      })
      .catch((err) => setError(err.message));
  }, [conversationId]);

  useEffect(() => {
    if (!lastEvent || lastEvent.conversationId !== conversationId) return;
    if (lastEvent.type === 'message-updated') {
      setMessages((list) => list.map((m) => (m.id === lastEvent.message.id ? { ...m, ...lastEvent.message, author_name: m.author_name } : m)));
    } else if (lastEvent.type === 'message') {
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

  // A conversation that started by text has no widget session to deliver chat replies to.

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

  const suggest = async () => {
    setSuggesting(true);
    setError('');
    try {
      const { suggestion } = await api<{ suggestion: string }>(`/conversations/${conversationId}/suggest`, { method: 'POST' });
      setDraft(suggestion);
      textarea.current?.focus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSuggesting(false);
    }
  };

  // Typing "/" at the start of the box opens the saved-reply picker filtered by what follows.
  const onDraftChange = (value: string) => {
    setDraft(value);
    if (value.startsWith('/') && !value.includes('\n')) {
      setPickerOpen(true);
      setPickerQuery(value.slice(1));
    } else if (pickerOpen && pickerQuery !== '' && !value.startsWith('/')) {
      setPickerOpen(false);
    }
  };

  const insertSavedReply = (reply: SavedReply) => {
    const text = fillReply(reply.body, conversation?.contact.name ?? '', business.name);
    setDraft((d) => (d.startsWith('/') || !d.trim() ? text : `${d.trimEnd()} ${text}`));
    setPickerOpen(false);
    setPickerQuery('');
    textarea.current?.focus();
  };

  const filteredReplies = savedReplies.filter((r) =>
    `${r.title} ${r.body}`.toLowerCase().includes(pickerQuery.trim().toLowerCase()),
  );

  const saveName = async () => {
    if (!conversation || renaming === null) return;
    const name = renaming.trim();
    setRenaming(null);
    if (!name || name === conversation.contact.name) return;
    try {
      const { contact } = await api<{ contact: ConversationDetail['contact'] }>(`/contacts/${conversation.contact.id}`, { method: 'PATCH', body: { name } });
      setConversation({ ...conversation, contact });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const requestReview = async () => {
    setError('');
    if (!business.reviewLinkEffective) {
      setError('Connect your Google Business Profile (Integrations), or add your review link on the Reviews page.');
      return;
    }
    if (!confirm(`Send ${conversation?.contact.name} your review link by ${channel === 'webchat' ? 'web chat' : CHANNEL_LABELS[channel]}?`)) return;
    try {
      const { message } = await api<{ message: Message }>(`/conversations/${conversationId}/review-request`, { method: 'POST', body: { channel } });
      setMessages((list) => (list.some((m) => m.id === message.id) ? list : [...list, message]));
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const callBack = async () => {
    setError('');
    setCalling('Starting call…');
    try {
      const { message, ringing } = await api<{ message: Message; ringing: string }>(`/conversations/${conversationId}/call`, { method: 'POST' });
      setMessages((list) => (list.some((m) => m.id === message.id) ? list : [...list, message]));
      setCalling(`Ringing your phone (${ringing}). Answer it to be connected.`);
      setTimeout(() => setCalling(null), 15000);
    } catch (err) {
      setError((err as Error).message);
      setCalling(null);
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

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-4 py-3 md:px-6">
        <button onClick={onBack} className="-ml-1 text-xl text-slate-500 md:hidden" aria-label="Back to conversations">
          ←
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {renaming !== null ? (
              <input
                autoFocus
                value={renaming}
                maxLength={100}
                onChange={(e) => setRenaming(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveName();
                  if (e.key === 'Escape') setRenaming(null);
                }}
                className="rounded border border-blue-400 px-2 py-0.5 font-semibold focus:outline-none"
              />
            ) : (
              <button onClick={() => setRenaming(contact.name)} className="group flex min-w-0 items-center gap-1" title="Rename contact">
                <h2 className="truncate font-semibold">{contact.name}</h2>
                <span className="text-xs text-slate-400 opacity-0 group-hover:opacity-100">✎</span>
              </button>
            )}
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
        {contact.phone && business.smsAvailable && business.smsNumber && (
          <button
            onClick={callBack}
            disabled={calling !== null}
            className="ml-auto shrink-0 rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
            title="Rings your phone, then connects you to the customer. They see your business number."
          >
            📞 Call back
          </button>
        )}
        <button
          onClick={() => setStatus(conversation.status === 'open' ? 'closed' : 'open')}
          className={`${contact.phone && business.smsAvailable && business.smsNumber ? '' : 'ml-auto '}shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50`}
        >
          {conversation.status === 'open' ? 'Close' : 'Reopen'}
        </button>
      </header>
      {calling && <div className="border-b border-green-200 bg-green-50 px-4 py-2 md:px-6 text-sm text-green-800">{calling}</div>}

      <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-4 py-4 md:px-6">
        {messages.map((m) =>
          m.kind === 'call' ? (
            <div key={m.id} className="flex justify-center">
              <div className={`rounded-full px-3 py-1 text-xs ${m.body.startsWith('Missed') ? 'bg-red-50 text-red-700' : 'bg-slate-200 text-slate-600'}`}>
                📞 {m.body} · {new Date(m.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
              </div>
            </div>
          ) : m.kind === 'voicemail' ? (
            <div key={m.id} className="flex justify-start">
              <div className="max-w-[85%] md:max-w-[70%] rounded-2xl rounded-bl-sm border border-amber-200 bg-amber-50 px-4 py-3">
                <div className="mb-2 text-xs font-semibold text-amber-800">🎙️ Voicemail{m.duration ? ` · ${Math.floor(m.duration / 60)}:${String(m.duration % 60).padStart(2, '0')}` : ''}</div>
                <audio controls preload="none" src={`/api/recordings/${m.id}`} className="h-9 w-72 max-w-full" />
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700">{m.body}</p>
                <div className="mt-1 text-[11px] text-slate-400">{new Date(m.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
              </div>
            </div>
          ) : (
          <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
            <div className="max-w-[85%] md:max-w-[70%]">
              <div
                className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-2 text-sm ${
                  m.automated
                    ? 'rounded-br-sm bg-slate-200 text-slate-700'
                    : m.direction === 'out'
                      ? 'rounded-br-sm bg-blue-600 text-white'
                      : 'rounded-bl-sm border border-slate-200 bg-white'
                }`}
              >
                {m.body}
              </div>
              <div className={`mt-1 text-[11px] text-slate-400 ${m.direction === 'out' ? 'text-right' : ''}`}>
                {m.automated ? 'Sent automatically · ' : m.direction === 'out' && m.author_name ? `${m.author_name} · ` : ''}
                {CHANNEL_LABELS[m.channel]} · {new Date(m.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
              </div>
            </div>
          </div>
          ),
        )}
        <div ref={bottom} />
      </div>

      <form onSubmit={send} className="relative border-t border-slate-200 bg-white p-3 md:p-4">
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        {pickerOpen && (
          <div className="absolute bottom-full left-4 right-4 mb-2 max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center gap-2 border-b border-slate-100 p-2">
              <input
                autoFocus={!draft.startsWith('/')}
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setPickerOpen(false);
                  if (e.key === 'Enter' && filteredReplies[0]) {
                    e.preventDefault();
                    insertSavedReply(filteredReplies[0]);
                  }
                }}
                placeholder="Search saved replies"
                className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm focus:outline-none"
              />
              <button type="button" onClick={() => setPickerOpen(false)} className="px-2 text-sm text-slate-400 hover:text-slate-700" aria-label="Close">
                ✕
              </button>
            </div>
            {filteredReplies.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">
                {savedReplies.length === 0 ? 'No saved replies yet. Add some in Settings.' : 'No matches.'}
              </p>
            ) : (
              filteredReplies.map((r) => (
                <button
                  type="button"
                  key={r.id}
                  onClick={() => insertSavedReply(r)}
                  className="block w-full border-b border-slate-50 px-3 py-2 text-left hover:bg-blue-50"
                >
                  <div className="text-sm font-medium">{r.title}</div>
                  <div className="truncate text-xs text-slate-500">{fillReply(r.body, contact.name, business.name)}</div>
                </button>
              ))
            )}
          </div>
        )}
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs [&_button]:whitespace-nowrap">
          <span className="text-slate-500">Reply by</span>
          {conversation.replyChannels.length === 0 && (
            <span className="text-amber-600">No way to reply yet: set up texting in Settings, or connect this customer’s channel under Integrations.</span>
          )}
          {conversation.replyChannels.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChannel(c)}
              className={`rounded-full px-3 py-1 ${channel === c ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}
            >
              {c === 'webchat' ? 'Web chat' : c === 'sms' ? `Text ${contact.phone ?? ''}` : CHANNEL_LABELS[c]}
            </button>
          ))}
          {channel === 'webchat' && !conversation.online && (
            <span className="text-amber-600">They'll see this next time they open your website.</span>
          )}
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => {
                setPickerOpen(!pickerOpen);
                setPickerQuery('');
              }}
              className="rounded-full bg-slate-100 px-3 py-1 text-slate-700 hover:bg-slate-200"
              title="Insert a saved reply (or type / in the box)"
            >
              Saved replies
            </button>
            <button
              type="button"
              onClick={requestReview}
              disabled={conversation.replyChannels.length === 0}
              className="rounded-full bg-amber-100 px-3 py-1 text-amber-800 hover:bg-amber-200 disabled:opacity-40"
              title={business.reviewLinkEffective ? 'Send your Google review link to this customer' : 'Connect Google Business Profile or add a review link first (Reviews page)'}
            >
              ⭐ Ask for review
            </button>
            {business.aiAvailable && (
              <button
                type="button"
                onClick={suggest}
                disabled={suggesting}
                className="rounded-full bg-violet-100 px-3 py-1 text-violet-700 hover:bg-violet-200 disabled:opacity-60"
                title="Let AI draft a reply for you to check before sending"
              >
                {suggesting ? 'Thinking…' : '✨ Suggest reply'}
              </button>
            )}
          </span>
        </div>
        <div className="flex gap-2">
          <textarea
            ref={textarea}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (pickerOpen && draft.startsWith('/')) {
                if (e.key === 'Escape') setPickerOpen(false);
                if (e.key === 'Enter' && filteredReplies[0]) {
                  e.preventDefault();
                  insertSavedReply(filteredReplies[0]);
                }
                if (e.key === 'Enter') return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            maxLength={1600}
            placeholder="Type a reply… (/ for saved replies)"
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
