import { useEffect, useState, type FormEvent } from 'react';
import { api, DAYS, type Business, type WeeklyHours } from '../api';

interface Proposal {
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  timezone: string | null;
  hours: WeeklyHours | null;
  brandColor: string | null;
  greeting: string | null;
  awayMessage: string | null;
  voicemailGreeting: string | null;
  missedCallText: string | null;
  aiNotes: string | null;
  reviewLink: string | null;
  savedReplies: { title: string; body: string }[];
  socials: { facebook: string | null; instagram: string | null };
}

interface Props {
  business: Business;
  /** Read the saved website straight away (right after sign-up). */
  autoStart: boolean;
  onApplied: (business: Business) => void;
}

type FieldKey = 'name' | 'brandColor' | 'hours' | 'greeting' | 'awayMessage' | 'voicemailGreeting' | 'missedCallText' | 'aiNotes' | 'reviewLink';

const DAY_SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' } as const;
const fmt = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
};
export function describeHours(hours: WeeklyHours) {
  return DAYS.map((d) => `${DAY_SHORT[d]} ${hours[d] ? `${fmt(hours[d]!.open)}–${fmt(hours[d]!.close)}` : 'closed'}`).join(' · ');
}

export default function WebsiteImport({ business, autoStart, onApplied }: Props) {
  const [url, setUrl] = useState(business.websiteUrl ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ proposal: Proposal; pages: string[]; usedAi: boolean } | null>(null);
  const [chosen, setChosen] = useState<Set<FieldKey>>(new Set());
  const [replies, setReplies] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState(false);

  const read = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setError('');
    setResult(null);
    setDone(false);
    try {
      const data = await api<{ proposal: Proposal; pages: string[]; usedAi: boolean }>('/business/website', { method: 'POST', body: { url } });
      setResult(data);
      // Pre-tick everything that was found and differs from what's set now.
      const p = data.proposal;
      const differs: Record<FieldKey, boolean> = {
        name: !!p.name && p.name !== business.name,
        brandColor: !!p.brandColor && p.brandColor.toLowerCase() !== business.color.toLowerCase(),
        hours: !!p.hours,
        greeting: !!p.greeting && p.greeting !== business.greeting,
        awayMessage: !!p.awayMessage && p.awayMessage !== business.awayMessage,
        voicemailGreeting: !!p.voicemailGreeting && p.voicemailGreeting !== business.voicemailGreeting,
        missedCallText: !!p.missedCallText && p.missedCallText !== business.missedCallText,
        aiNotes: !!p.aiNotes && p.aiNotes !== business.aiNotes,
        reviewLink: !!p.reviewLink && p.reviewLink !== business.reviewLink,
      };
      setChosen(new Set((Object.keys(differs) as FieldKey[]).filter((k) => differs[k])));
      setReplies(new Set(p.savedReplies.map((_, i) => i)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (autoStart && business.websiteUrl) read();
  }, []);

  const toggle = (k: FieldKey) => setChosen((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));

  const apply = async () => {
    if (!result) return;
    const p = result.proposal;
    const body: Record<string, unknown> = { websiteImported: true };
    if (chosen.has('name')) body.name = p.name;
    if (chosen.has('brandColor')) body.color = p.brandColor;
    if (chosen.has('hours') && p.hours) {
      body.hoursEnabled = true;
      body.hours = p.hours;
      if (p.timezone) body.timezone = p.timezone;
    }
    for (const k of ['greeting', 'awayMessage', 'voicemailGreeting', 'missedCallText', 'aiNotes', 'reviewLink'] as const) {
      if (chosen.has(k)) body[k] = p[k];
    }
    setApplying(true);
    setError('');
    try {
      const { business: updated } = await api<{ business: Business }>('/business', { method: 'PATCH', body });
      for (const i of replies) await api('/saved-replies', { method: 'POST', body: p.savedReplies[i] });
      setDone(true);
      setResult(null);
      onApplied(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const row = (key: FieldKey, label: string, value: string | null, current?: string) =>
    value && (
      <label key={key} className="flex gap-3 border-b border-slate-100 py-3 last:border-0">
        <input type="checkbox" checked={chosen.has(key)} onChange={() => toggle(key)} className="mt-1 h-4 w-4 shrink-0" />
        <div className="min-w-0 text-sm">
          <div className="font-medium text-slate-700">{label}</div>
          <div className="whitespace-pre-wrap break-words text-slate-900">{value}</div>
          {current && current !== value && <div className="mt-1 text-xs text-slate-400">Now: {current.length > 140 ? `${current.slice(0, 140)}…` : current}</div>}
        </div>
      </label>
    );

  const p = result?.proposal;
  return (
    <section className="space-y-4 rounded-xl border-2 border-blue-100 bg-white p-6 shadow-sm">
      <div>
        <h2 className="font-semibold">Set up from your website</h2>
        <p className="mt-1 text-sm text-slate-500">
          ChatBird reads your website and fills in your details, hours, messages and answers, so everything matches what customers see there. You check it before
          anything changes.
        </p>
      </div>
      <form onSubmit={read} className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="yourbusiness.com.au"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        <button disabled={loading || !url.trim()} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
          {loading ? 'Reading your website…' : result || done ? 'Read again' : 'Fill in for me'}
        </button>
      </form>
      {loading && <p className="text-sm text-slate-500">This takes up to a minute: ChatBird reads your home, contact, services and prices pages.</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {done && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">Done! Your settings below are updated. Change anything you like.</p>}

      {p && result && (
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            Read {result.pages.length} page{result.pages.length === 1 ? '' : 's'}.{' '}
            {result.usedAi ? 'Messages were drafted by AI from your site, so read them through.' : 'Add ANTHROPIC_API_KEY on the server to also draft your messages, notes and saved replies.'}
          </p>
          {(p.phone || p.email || p.address || p.socials.facebook || p.socials.instagram) && (
            <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-600">
              <div className="mb-1 font-semibold">Found on your site</div>
              {p.phone && <div>Phone: {p.phone}</div>}
              {p.email && <div>Email: {p.email}</div>}
              {p.address && <div>Address: {p.address}</div>}
              {p.socials.facebook && <div>Facebook: {p.socials.facebook}</div>}
              {p.socials.instagram && <div>Instagram: {p.socials.instagram}</div>}
            </div>
          )}
          <div>
            {row('name', 'Business name', p.name, business.name)}
            {p.brandColor && (
              <label className="flex items-center gap-3 border-b border-slate-100 py-3">
                <input type="checkbox" checked={chosen.has('brandColor')} onChange={() => toggle('brandColor')} className="h-4 w-4" />
                <div className="text-sm">
                  <div className="font-medium text-slate-700">Brand colour</div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-5 w-5 rounded border border-slate-200" style={{ background: p.brandColor }} /> {p.brandColor}
                  </div>
                </div>
              </label>
            )}
            {row('hours', `Opening hours${p.timezone ? ` (${p.timezone})` : ''}`, p.hours ? describeHours(p.hours) : null, business.hoursEnabled ? describeHours(business.hours) : 'not set')}
            {row('greeting', 'Chat greeting', p.greeting, business.greeting)}
            {row('awayMessage', 'Away message', p.awayMessage, business.awayMessage)}
            {row('voicemailGreeting', 'Voicemail greeting', p.voicemailGreeting, business.voicemailGreeting)}
            {row('missedCallText', 'Missed-call text', p.missedCallText, business.missedCallText)}
            {row('aiNotes', 'Business info for AI replies', p.aiNotes, business.aiNotes || 'empty')}
            {row('reviewLink', 'Google review link', p.reviewLink, business.reviewLink ?? undefined)}
          </div>
          {p.savedReplies.length > 0 && (
            <div>
              <div className="mb-1 text-sm font-medium text-slate-700">Saved replies to add</div>
              {p.savedReplies.map((r, i) => (
                <label key={i} className="flex gap-3 border-b border-slate-100 py-2 text-sm last:border-0">
                  <input
                    type="checkbox"
                    checked={replies.has(i)}
                    onChange={() => setReplies((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])))}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <span>
                    <b>{r.title}</b>: {r.body}
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={apply}
              disabled={applying || (chosen.size === 0 && replies.size === 0)}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-60"
            >
              {applying ? 'Applying…' : `Apply ${chosen.size + replies.size} change${chosen.size + replies.size === 1 ? '' : 's'}`}
            </button>
            <button onClick={() => setResult(null)} className="text-sm text-slate-500 hover:underline">Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
