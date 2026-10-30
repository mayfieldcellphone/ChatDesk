import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';

type Mode = 'off' | 'draft' | 'positive' | 'all';

interface Data {
  mode: Mode;
  since: string | null;
  notes: string;
  aiAvailable: boolean;
  locations: string[];
}

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'You reply yourself (the ✨ Suggest AI reply button still works).' },
  { value: 'draft', label: 'AI drafts, I approve', hint: 'Every new review gets a reply written for you to approve or edit on the Reviews page.' },
  { value: 'positive', label: 'Auto-reply to 4–5 stars', hint: 'Happy reviews are answered straight away; 1–3 stars get a draft for you to approve. Recommended.' },
  { value: 'all', label: 'Auto-reply to every review', hint: 'All new reviews are answered straight away, including unhappy ones.' },
];

const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';

/** Settings card: how new Google reviews are answered. */
export default function ReviewRepliesSection() {
  const [data, setData] = useState<Data | null>(null);
  const [mode, setMode] = useState<Mode>('off');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api<Data>('/reviews/auto-reply')
      .then((d) => {
        setData(d);
        setMode(d.mode);
        setNotes(d.notes);
      })
      .catch((err) => setLoadError((err as Error).message));
  }, []);
  if (!data) {
    return loadError ? (
      <section className="rounded-xl bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Review replies</h2>
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">Couldn’t load this setting: {loadError}</p>
      </section>
    ) : null;
  }

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setStatus(null);
    try {
      const r = await api<{ since: string | null }>('/reviews/auto-reply', { method: 'PATCH', body: { mode, notes } });
      setData({ ...data, mode, notes, since: r.since });
      setStatus({ ok: true, text: 'Saved' });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };

  return (
    <form onSubmit={save}>
      <section className="rounded-xl bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Review replies</h2>
        <p className="mt-1 text-sm text-slate-500">
          Answer new Google reviews with AI, in the name of the location they were left for{data.locations.length > 1 ? ` (${data.locations.join(', ')})` : ''}. Only reviews that arrive after
          you switch this on are answered. Existing reviews and replies are never changed.
        </p>
        <div className="mt-4 space-y-4">
          {!data.aiAvailable && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Needs ANTHROPIC_API_KEY under Integrations → Server keys.</p>}
          {data.locations.length === 0 && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Connect Google Business Profile under Integrations first.</p>}
          <fieldset className="space-y-2">
            <legend className="mb-1 block text-sm font-medium text-slate-700">New reviews</legend>
            {MODES.map((m) => (
              <label key={m.value} className="flex cursor-pointer items-start gap-2 text-sm">
                <input type="radio" name="reviewReplyMode" className="mt-0.5" checked={mode === m.value} onChange={() => setMode(m.value)} />
                <span>
                  <span className="font-medium">{m.label}</span> <span className="text-slate-500">· {m.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="rrnotes">
              How replies should sound (optional)
            </label>
            <textarea
              id="rrnotes"
              className={`${input} min-h-20`}
              maxLength={1500}
              placeholder="e.g. Sign off with “– Khalil and the team”. For unhappy customers, ask them to call us on 02 4049 1735."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {data.mode !== 'off' && data.since && (
            <p className="text-xs text-slate-500">On since {new Date(data.since).toLocaleString()}. At most 20 automatic replies a day; any more wait as drafts.</p>
          )}
          <div className="flex items-center gap-3">
            <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Save</button>
            {status && <span className={`text-sm ${status.ok ? 'text-emerald-700' : 'text-red-700'}`}>{status.text}</span>}
          </div>
        </div>
      </section>
    </form>
  );
}
