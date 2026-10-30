import { useEffect, useState, type FormEvent } from 'react';
import { api, timeAgo, type Business } from '../api';

interface Review {
  id: string;
  location: string;
  authorName: string;
  authorPhoto: string | null;
  rating: number;
  comment: string | null;
  reply: string | null;
  createdAt: string;
  seen: boolean;
  aiDraft: string | null;
  autoReplied: boolean;
  replyError: string | null;
}

interface LocationInfo {
  id: string;
  name: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface ReviewsData {
  reviews: Review[];
  locations: LocationInfo[];
  summary: { count: number; average: number | null; unreplied: number; unseen: number };
  reviewLink: string | null;
  aiAvailable: boolean;
  reconnectRequired?: boolean;
}

interface Props {
  business: Business;
  onSaved: (business: Business) => void;
  onOpenIntegrations: () => void;
}

const Stars = ({ n }: { n: number }) => (
  <span className="text-amber-500" aria-label={`${n} out of 5 stars`}>
    {'★'.repeat(n)}
    <span className="text-slate-300">{'★'.repeat(5 - n)}</span>
  </span>
);

export default function Reviews({ business, onSaved, onOpenIntegrations }: Props) {
  const [data, setData] = useState<ReviewsData | null>(null);
  const [filter, setFilter] = useState<'all' | 'unreplied' | 'replied' | 'low'>('all');
  const [selectedLocation, setSelectedLocation] = useState<string>('all');
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState('');

  const load = () => {
    const locParam = selectedLocation !== 'all' ? `&location=${encodeURIComponent(selectedLocation)}` : '';
    return api<ReviewsData>(`/reviews?filter=${filter}${locParam}`)
      .then((d) => {
        setData(d);
        if (d.summary.unseen > 0) api('/reviews/seen', { method: 'POST' }).catch(() => {});
      })
      .catch((err) => setError(err.message));
  };

  useEffect(() => {
    load();
  }, [filter, selectedLocation]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncNotice('');
    setError('');
    try {
      const res = await api<{ ok: boolean; added: number; synced: number }>('/reviews/sync', { method: 'POST' });
      setSyncNotice(res.added > 0 ? `Synced ${res.synced} location(s): ${res.added} new review(s) found.` : 'Synced. Reviews are up to date.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setSyncing(false);
  };

  if (!data) return <div className="flex h-full items-center justify-center text-sm text-slate-400">{error || 'Loading…'}</div>;
  const { summary } = data;
  const locations = data.locations ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-6 md:py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Reviews</h1>
            <p className="text-sm text-slate-500">Google Business Profile customer reviews, synced every 15 minutes.</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
            >
              {syncing ? '🔄 Syncing…' : '🔄 Sync now'}
            </button>
            {summary.count > 0 && (
              <div className="flex gap-4 text-sm border-l border-slate-200 pl-4">
                <div>
                  <div className="text-lg font-bold leading-tight">{summary.average?.toFixed(1) ?? '–'}</div>
                  <div className="text-xs text-slate-500">average</div>
                </div>
                <div>
                  <div className="text-lg font-bold leading-tight">{summary.count}</div>
                  <div className="text-xs text-slate-500">total</div>
                </div>
                <div>
                  <div className={`text-lg font-bold leading-tight ${summary.unreplied ? 'text-amber-600' : ''}`}>{summary.unreplied}</div>
                  <div className="text-xs text-slate-500">unreplied</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {data.reconnectRequired && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 shadow-sm">
            <div>
              <strong>⚠️ Google connection needs attention:</strong> Your Google authorization was revoked or expired. Reconnect Google to keep reviews synced and reply to customers.
            </div>
            <a
              href="/api/google/connect"
              className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-amber-700"
            >
              Reconnect Google
            </a>
          </div>
        )}

        {syncNotice && <p className="rounded-md bg-emerald-50 px-4 py-2 text-xs font-medium text-emerald-800">✓ {syncNotice}</p>}
        {error && <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}

        {/* Location selector filter if multiple locations exist */}
        {locations.length > 1 && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1 text-sm">
            <span className="text-xs font-medium text-slate-500">Location:</span>
            <button
              onClick={() => setSelectedLocation('all')}
              className={`rounded-full px-3 py-1 text-xs font-medium ${selectedLocation === 'all' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              All locations
            </button>
            {locations.map((loc) => (
              <button
                key={loc.id}
                onClick={() => setSelectedLocation(loc.name)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${selectedLocation === loc.name ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                {loc.name}
              </button>
            ))}
          </div>
        )}

        {summary.count === 0 ? (
          <div className="rounded-xl bg-white p-8 text-center shadow-sm">
            <p className="text-slate-600">No reviews found yet.</p>
            <p className="mt-1 text-xs text-slate-400">Make sure Google Business Profile is connected with active locations.</p>
            <div className="mt-4 flex justify-center gap-3">
              <a href="/api/google/connect" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
                Connect Google Business Profile
              </a>
              <button onClick={onOpenIntegrations} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                Manage Integrations
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex rounded-md bg-white p-1 text-sm shadow-sm">
              {([['all', 'All'], ['unreplied', 'Needs a reply'], ['replied', 'Replied'], ['low', '1–3 stars']] as const).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  className={`flex-1 rounded px-3 py-1.5 ${filter === value ? 'bg-slate-900 font-medium text-white' : 'text-slate-600'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <ul className="space-y-4">
              {data.reviews.map((r) => (
                <ReviewCard key={r.id} review={r} aiAvailable={data.aiAvailable} onChanged={load} />
              ))}
              {data.reviews.length === 0 && <li className="text-center text-sm text-slate-500 py-6">No reviews matching the selected filter.</li>}
            </ul>
          </>
        )}

        <ReviewRequestSettings business={business} effectiveLink={data.reviewLink} onSaved={onSaved} />
      </div>
    </div>
  );
}

function ReviewCard({ review, aiAvailable, onChanged }: { review: Review; aiAvailable: boolean; onChanged: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const suggest = async () => {
    setBusy(true);
    setError('');
    try {
      const { suggestion } = await api<{ suggestion: string }>(`/reviews/${review.id}/suggest`, { method: 'POST' });
      setDraft(suggestion);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const post = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft?.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api(`/reviews/${review.id}/reply`, { method: 'PUT', body: { comment: draft } });
      setDraft(null);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const approve = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/reviews/${review.id}/reply`, { method: 'PUT', body: { comment: review.aiDraft } });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const discard = async () => {
    await api(`/reviews/${review.id}/draft`, { method: 'DELETE' }).catch((err) => setError(err.message));
    onChanged();
  };

  const remove = async () => {
    if (!confirm('Delete your reply from Google?')) return;
    setBusy(true);
    await api(`/reviews/${review.id}/reply`, { method: 'DELETE' }).catch((err) => setError(err.message));
    setBusy(false);
    onChanged();
  };

  return (
    <li className={`rounded-xl bg-white p-5 shadow-sm ${!review.seen ? 'ring-2 ring-blue-200' : ''}`}>
      <div className="flex items-center gap-3">
        {review.authorPhoto ? (
          <img src={review.authorPhoto} alt="" className="h-9 w-9 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-600">{review.authorName[0]}</div>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{review.authorName}</span>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{review.location}</span>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            <Stars n={review.rating} /> · {timeAgo(review.createdAt)}
          </div>
        </div>
        {!review.seen && <span className="ml-auto rounded-full bg-blue-100 px-2 text-xs text-blue-700">New</span>}
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{review.comment || <span className="italic text-slate-400">Rating only, no comment.</span>}</p>

      {review.reply && draft === null && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm border border-slate-100">
          <div className="mb-1 text-xs font-semibold text-slate-500">{review.autoReplied ? 'Replied automatically by ChatBird AI' : 'Your reply on Google'}</div>
          <p className="whitespace-pre-wrap text-slate-700">{review.reply}</p>
          <div className="mt-2 flex gap-3 text-xs">
            <button onClick={() => setDraft(review.reply)} className="text-blue-600 hover:underline">Edit reply</button>
            <button onClick={remove} disabled={busy} className="text-red-600 hover:underline">Delete reply</button>
          </div>
        </div>
      )}

      {!review.reply && review.aiDraft && draft === null && (
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
          <div className="mb-1 text-xs font-semibold text-blue-800">AI reply ready to approve (not posted yet)</div>
          <p className="whitespace-pre-wrap text-slate-800">{review.aiDraft}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <button onClick={approve} disabled={busy} className="rounded-md bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              {busy ? 'Posting…' : 'Approve & post'}
            </button>
            <button onClick={() => setDraft(review.aiDraft)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-semibold hover:bg-slate-50">
              Edit first
            </button>
            <button onClick={discard} className="text-slate-500 hover:underline">
              Discard
            </button>
          </div>
        </div>
      )}
      {review.replyError && !review.reply && <p className="mt-2 text-xs text-amber-700">Automatic reply didn’t go through: {review.replyError}</p>}

      {draft !== null ? (
        <form onSubmit={post} className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold text-slate-700">Compose Reply (Editable)</span>
            <span>Only posted when you click Send</span>
          </div>
          <textarea
            autoFocus
            rows={4}
            maxLength={4000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            placeholder="Write a public reply…"
          />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button disabled={busy || !draft.trim()} className="rounded-md bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              {busy ? 'Sending…' : 'Send reply'}
            </button>
            {aiAvailable && (
              <button type="button" onClick={suggest} disabled={busy} className="rounded-md bg-violet-100 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-200 disabled:opacity-50">
                {busy ? 'Drafting…' : '✨ Re-draft with AI'}
              </button>
            )}
            <button type="button" onClick={() => setDraft(null)} className="text-slate-500 hover:underline text-xs">Cancel</button>
            <span className="text-xs text-slate-400 ml-auto">Replies appear publicly on Google Maps.</span>
          </div>
        </form>
      ) : (
        !review.reply && !review.aiDraft && (
          <div className="mt-3 flex gap-2 text-sm">
            <button onClick={() => setDraft('')} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">
              Reply
            </button>
            {aiAvailable && (
              <button onClick={suggest} disabled={busy} className="rounded-md bg-violet-100 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-200 disabled:opacity-50">
                {busy ? 'Thinking…' : '✨ Suggest AI reply'}
              </button>
            )}
          </div>
        )
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </li>
  );
}

function ReviewRequestSettings({ business, effectiveLink, onSaved }: { business: Business; effectiveLink: string | null; onSaved: (b: Business) => void }) {
  const [link, setLink] = useState(business.reviewLink ?? '');
  const [text, setText] = useState(business.reviewRequestText);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setStatus(null);
    try {
      const { business: updated } = await api<{ business: Business }>('/business', { method: 'PATCH', body: { reviewLink: link, reviewRequestText: text } });
      onSaved(updated);
      setStatus({ ok: true, text: 'Saved' });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };

  const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';
  return (
    <form onSubmit={save} className="space-y-4 rounded-xl bg-white p-6 shadow-sm">
      <div>
        <h2 className="font-semibold">Asking for reviews</h2>
        <p className="mt-1 text-sm text-slate-500">
          The ⭐ Ask for review button in a conversation sends this message. Use <code>{'{name}'}</code>, <code>{'{business}'}</code> and <code>{'{link}'}</code>.
        </p>
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="rl">Review link</label>
        <input id="rl" className={input} value={link} onChange={(e) => setLink(e.target.value)} placeholder={effectiveLink ?? 'https://g.page/r/…/review'} />
        <p className="mt-1 text-xs text-slate-500">
          {effectiveLink && !link ? `Using the link from Google Business Profile: ${effectiveLink}` : 'Leave empty to use the link from your connected Google Business Profile.'}
        </p>
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="rt">Message</label>
        <textarea id="rt" rows={3} maxLength={500} className={input} value={text} onChange={(e) => setText(e.target.value)} required />
      </div>
      <div className="flex items-center gap-3">
        <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Save</button>
        {status && <span className={`text-sm ${status.ok ? 'text-green-600' : 'text-red-600'}`}>{status.text}</span>}
      </div>
    </form>
  );
}
