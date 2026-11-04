import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { drawPoster, ICONS, input, loadImage, MIX_COLOURS, PostCard, PROVIDER, STYLES, toJpeg, type Data, type Icon, type Plan, type Poster, type Style } from './Promotions';

/** Repairs an auto post can be about. Phone repairs rotate through the chosen brands. */
const TOPICS: { id: string; label: string; icon: Icon; phone?: boolean }[] = [
  { id: 'screen', label: 'Screen replacement', icon: 'screen', phone: true },
  { id: 'battery', label: 'Battery replacement', icon: 'battery', phone: true },
  { id: 'back', label: 'Back glass replacement', icon: 'back', phone: true },
  { id: 'port', label: 'Charging port repair', icon: 'port', phone: true },
  { id: 'camera', label: 'Camera repair', icon: 'camera', phone: true },
  { id: 'water', label: 'Water damage repair', icon: 'water', phone: true },
  { id: 'playstation', label: 'PlayStation repair', icon: 'console' },
  { id: 'consoles', label: 'Xbox & Nintendo Switch repair', icon: 'console' },
  { id: 'macbook', label: 'MacBook repair', icon: 'laptop' },
  { id: 'laptop', label: 'Laptop repair', icon: 'laptop' },
  { id: 'ipad', label: 'iPad & tablet repair', icon: 'tablet' },
];
const BRANDS = ['iPhone', 'Samsung Galaxy', 'Oppo', 'Google Pixel', 'Motorola', 'Xiaomi'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LENGTHS = [
  { weeks: 1, label: '1 week' },
  { weeks: 2, label: '2 weeks' },
  { weeks: 4, label: '1 month' },
  { weeks: 8, label: '2 months' },
  { weeks: 13, label: '3 months' },
];
const MAX_POSTS = 60;
const BATCH = 10;

interface Draft {
  key: number;
  when: Date;
  topic: string;
  device: string;
  poster: Poster;
  photo: number | null;
  caption: string;
  preview: string;
}

const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function shuffle<T>(list: T[]) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Endless rotation through a list in a shuffled order, never giving the same item twice in a row. */
function rotation<T>(list: T[]) {
  let order: T[] = [];
  let last: T | undefined;
  return () => {
    if (order.length === 0) {
      order = shuffle(list);
      if (order.length > 1 && order[0] === last) order.push(order.shift()!);
    }
    last = order.shift()!;
    return last;
  };
}

/** Every posting time from the start date, on the chosen days, for the chosen number of weeks. */
function postingTimes(start: string, weeks: number, days: number[], time: string) {
  const [h, m] = time.split(':').map(Number);
  const first = new Date(`${start}T00:00:00`);
  const out: Date[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i, h, m);
    if (days.includes(d.getDay()) && d.getTime() > Date.now() + 5 * 60_000) out.push(d);
  }
  return out;
}

function render(draft: Draft, photos: HTMLImageElement[], size: 'preview' | 'full') {
  const canvas = document.createElement('canvas');
  drawPoster(canvas, draft.poster, draft.photo === null ? null : photos[draft.photo] ?? null);
  if (size === 'full') return canvas;
  const small = document.createElement('canvas');
  small.width = small.height = 360;
  small.getContext('2d')!.drawImage(canvas, 0, 0, 360, 360);
  return small;
}

export default function AutoPosts({ data, onChanged }: { data: Data; onChanged: () => void }) {
  const b = data.business;
  const [brief, setBrief] = useState('');
  const [topics, setTopics] = useState<string[]>(['screen', 'battery', 'back', 'port', 'playstation', 'macbook', 'laptop']);
  const [brands, setBrands] = useState<string[]>(['iPhone', 'Samsung Galaxy', 'Oppo']);
  const [days, setDays] = useState<number[]>([2, 4, 6]);
  const [time, setTime] = useState('10:00');
  const [weeks, setWeeks] = useState(4);
  const [start, setStart] = useState(() => isoDate(new Date(Date.now() + 86_400_000)));
  const [offer, setOffer] = useState('');
  const [offerUntil, setOfferUntil] = useState('');
  const [chosen, setChosen] = useState<string[]>(data.channels.filter((c) => c.available).map((c) => c.id));
  const [photos, setPhotos] = useState<HTMLImageElement[]>([]);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const keyRef = useRef(0);

  const times = postingTimes(start, weeks, days, time).slice(0, MAX_POSTS);
  const allTimes = postingTimes(start, weeks, days, time).length;
  const toggle = <T,>(list: T[], v: T, set: (l: T[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const create = async () => {
    setStatus(null);
    if (topics.length === 0) return setStatus({ ok: false, text: 'Choose at least one repair to promote' });
    if (topics.some((t) => TOPICS.find((x) => x.id === t)?.phone) && brands.length === 0) return setStatus({ ok: false, text: 'Choose at least one phone brand' });
    if (times.length === 0) return setStatus({ ok: false, text: 'Choose at least one day to post on' });
    await document.fonts.ready;
    // Which repair and device each post is about, and a fresh look for each.
    const nextTopic = rotation(topics);
    const nextBrand = rotation(brands);
    const styles = STYLES.map((s) => s.value).filter((s) => s !== 'photo' || photos.length > 0) as Style[];
    const nextStyle = rotation(styles);
    const nextColour = rotation(MIX_COLOURS);
    const nextPhoto = rotation(photos.map((_, i) => i));
    const slots = times.map((when) => {
      const id = nextTopic();
      const topic = TOPICS.find((t) => t.id === id)!;
      const withOffer = offer.trim() && (!offerUntil || isoDate(when) <= offerUntil) ? offer.trim() : '';
      return { when, topic, device: topic.phone ? nextBrand() : '', offer: withOffer };
    });
    const made: Draft[] = [];
    try {
      for (let i = 0; i < slots.length; i += BATCH) {
        setBusy(`Writing posts ${i + 1}–${Math.min(i + BATCH, slots.length)} of ${slots.length}…`);
        const batch = slots.slice(i, i + BATCH);
        const r = await api<{ posts: { big: string; headline: string; details: string; caption: string }[] }>('/posts/plan/copy', {
          method: 'POST',
          body: { brief, slots: batch.map((s) => ({ topic: s.topic.label, device: s.device, offer: s.offer })) },
        });
        batch.forEach((s, j) => {
          const words = r.posts[j];
          const style = nextStyle();
          const draft: Draft = {
            key: keyRef.current++,
            when: s.when,
            topic: s.topic.label,
            device: s.device,
            photo: style === 'photo' ? nextPhoto() : null,
            caption: words.caption,
            preview: '',
            poster: {
              style,
              icon: s.topic.icon,
              big: words.big,
              headline: words.headline,
              details: words.details,
              footer: [b.name, b.phone].filter(Boolean).join(' · '),
              color: nextColour(),
            },
          };
          draft.preview = render(draft, photos, 'preview').toDataURL('image/jpeg', 0.8);
          made.push(draft);
        });
        setDrafts([...made]);
      }
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy('');
    }
  };

  const update = (key: number, change: (d: Draft) => Draft) =>
    setDrafts((list) =>
      list!.map((d) => {
        if (d.key !== key) return d;
        const next = change(d);
        return { ...next, preview: render(next, photos, 'preview').toDataURL('image/jpeg', 0.8) };
      }),
    );

  const newDesign = (d: Draft) => {
    const styles = STYLES.map((s) => s.value).filter((s) => s !== d.poster.style && (s !== 'photo' || photos.length > 0)) as Style[];
    const colours = MIX_COLOURS.filter((c) => c !== d.poster.color);
    const style = styles[Math.floor(Math.random() * styles.length)];
    update(d.key, (x) => ({
      ...x,
      photo: style === 'photo' ? Math.floor(Math.random() * photos.length) : null,
      poster: { ...x.poster, style, color: colours[Math.floor(Math.random() * colours.length)] },
    }));
  };

  const scheduleAll = async () => {
    if (!drafts?.length) return;
    if (chosen.length === 0) return setStatus({ ok: false, text: 'Choose where to post' });
    setStatus(null);
    let done = 0;
    try {
      const names = [...new Set(drafts.map((d) => d.topic))];
      const plan = await api<{ id: string }>('/posts/plans', {
        method: 'POST',
        body: {
          name: `${drafts.length} posts from ${drafts[0].when.toLocaleDateString()} · ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`,
          settings: { brief, topics, brands, days, time, weeks, start, offer, offerUntil, channels: chosen },
        },
      });
      for (const d of drafts) {
        setBusy(`Scheduling ${done + 1} of ${drafts.length}…`);
        const blob = await toJpeg(render(d, photos, 'full'));
        const up = await fetch('/api/posts/media', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
        const media = await up.json();
        if (!up.ok) throw new Error(media.error || 'An image didn’t upload');
        await api('/posts', { method: 'POST', body: { caption: d.caption, mediaId: media.id, channels: chosen, scheduledAt: d.when.toISOString(), planId: plan.id } });
        done++;
      }
      setDrafts(null);
      setStatus({ ok: true, text: `All ${done} posts are scheduled. They’ll go out on their own; see them under “Your auto posts” below.` });
    } catch (err) {
      setStatus({ ok: false, text: `${done ? `${done} posts were scheduled, then: ` : ''}${(err as Error).message}` });
    } finally {
      setBusy('');
      onChanged();
    }
  };

  const chip = (on: boolean) => `flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${on ? 'border-blue-600 bg-blue-50 font-medium text-blue-800' : 'border-slate-300 text-slate-600'}`;

  return (
    <div className="space-y-5">
      <section className="space-y-5 rounded-xl bg-white p-5 shadow-sm">
        <div>
          <h2 className="font-semibold">Auto posts</h2>
          <p className="text-sm text-slate-500">
            Set it up once: ChatBird writes and designs every post, each with a different layout, colour and wording, and posts them on your chosen days. You check them all before anything is scheduled.
          </p>
        </div>
        {!data.aiAvailable && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Needs ANTHROPIC_API_KEY under Integrations → Server keys.</p>}

        <label className="block text-sm">
          <span className="mb-1 block font-medium">Your instructions for every post</span>
          <textarea
            className={`${input} min-h-20`}
            maxLength={1000}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="e.g. Friendly and local. Walk-ins welcome, free diagnosis, genuine-quality parts. Mention we’re on Maitland Rd, Mayfield."
          />
          <span className="mt-1 block text-xs text-slate-500">The AI only uses what you write here and your business notes. It never makes up prices, times or warranties.</span>
        </label>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Repairs to promote (they take turns)</legend>
          <div className="flex flex-wrap gap-2">
            {TOPICS.map((t) => (
              <label key={t.id} className={chip(topics.includes(t.id))}>
                <input type="checkbox" className="sr-only" checked={topics.includes(t.id)} onChange={() => toggle(topics, t.id, setTopics)} />
                <svg viewBox="0 0 100 100" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={8} strokeLinecap="round" strokeLinejoin="round">
                  <path d={ICONS[t.icon as keyof typeof ICONS].d} />
                </svg>
                {t.label}
              </label>
            ))}
          </div>
        </fieldset>

        {topics.some((t) => TOPICS.find((x) => x.id === t)?.phone) && (
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Phone brands for phone repairs (they take turns)</legend>
            <div className="flex flex-wrap gap-2">
              {BRANDS.map((brand) => (
                <label key={brand} className={chip(brands.includes(brand))}>
                  <input type="checkbox" className="sr-only" checked={brands.includes(brand)} onChange={() => toggle(brands, brand, setBrands)} />
                  {brand}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Post on</legend>
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <label key={d} className={`${chip(days.includes(d))} px-2.5`}>
                  <input type="checkbox" className="sr-only" checked={days.includes(d)} onChange={() => toggle(days, d, setDays)} />
                  {DAY_NAMES[d]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-3 gap-2 text-sm">
            <label>
              <span className="mb-1 block font-medium">At</span>
              <input type="time" className={input} value={time} onChange={(e) => setTime(e.target.value || '10:00')} />
            </label>
            <label>
              <span className="mb-1 block font-medium">Starting</span>
              <input type="date" className={input} value={start} min={isoDate(new Date())} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label>
              <span className="mb-1 block font-medium">For</span>
              <select className={input} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
                {LENGTHS.map((l) => (
                  <option key={l.weeks} value={l.weeks}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="grid gap-3 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-3">
          <label className="sm:col-span-2">
            <span className="mb-1 block font-medium">Offer to include (optional)</span>
            <input className={input} maxLength={120} value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="e.g. 10% off for Mayfield locals" />
          </label>
          <label>
            <span className="mb-1 block font-medium">Offer ends (optional)</span>
            <input type="date" className={input} value={offerUntil} min={start} onChange={(e) => setOfferUntil(e.target.value)} />
          </label>
          <span className="text-xs text-slate-500 sm:col-span-3">Posts after the end date leave the offer out.</span>
        </div>

        <div className="text-sm">
          <span className="mb-1 block font-medium">Your photos (optional)</span>
          <div className="flex flex-wrap items-center gap-2">
            {photos.map((p, i) => (
              <span key={i} className="relative">
                <img src={p.src} alt="" className="h-14 w-14 rounded-md object-cover" />
                <button type="button" onClick={() => setPhotos(photos.filter((_, j) => j !== i))} className="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full bg-slate-900 text-xs text-white" aria-label="Remove photo">
                  ×
                </button>
              </span>
            ))}
            <label className="cursor-pointer rounded-md border border-dashed border-slate-400 px-3 py-2 text-slate-600 hover:bg-slate-50">
              + Add shop photos
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={async (e) => {
                  const files = [...(e.target.files ?? [])].slice(0, 12);
                  const loaded = await Promise.all(files.map((f) => loadImage(f).catch(() => null)));
                  setPhotos((p) => [...p, ...(loaded.filter(Boolean) as HTMLImageElement[])].slice(0, 12));
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <span className="mt-1 block text-xs text-slate-500">Photos you took (repairs, the shop, the team) are mixed into some posts. Without photos, posts use the 7 poster layouts.</span>
        </div>

        <fieldset className="text-sm">
          <legend className="mb-1 font-medium">Post to</legend>
          {data.channels.length === 0 && <p className="text-slate-500">Connect Google and Facebook/Instagram under Integrations first.</p>}
          <div className="flex flex-wrap gap-2">
            {data.channels.map((c) => (
              <label key={c.id} className={`${chip(chosen.includes(c.id))} ${c.available ? '' : 'opacity-50'}`}>
                <input type="checkbox" className="sr-only" disabled={!c.available} checked={chosen.includes(c.id)} onChange={() => toggle(chosen, c.id, setChosen)} />
                {PROVIDER[c.provider]} <span className="font-normal text-slate-500">{c.name}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4 text-sm">
          <span className="text-slate-600">
            {times.length === 0
              ? 'No posting days chosen yet.'
              : `${times.length} posts, ${days.length} a week, from ${times[0].toLocaleDateString()} to ${times.at(-1)!.toLocaleDateString()}.`}
            {allTimes > MAX_POSTS && ` (At most ${MAX_POSTS} at a time; make another plan for later.)`}
          </span>
          <button
            type="button"
            onClick={create}
            disabled={!!busy || !data.aiAvailable || times.length === 0}
            className="ml-auto rounded-md bg-blue-600 px-5 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {drafts ? '✨ Start again' : '✨ Create my posts'}
          </button>
        </div>
        {busy && <p className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">{busy}</p>}
        {status && <p className={`rounded-md px-3 py-2 text-sm ${status.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{status.text}</p>}
      </section>

      {drafts && drafts.length > 0 && (
        <section className="space-y-3 rounded-xl bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h2 className="font-semibold">Check your {drafts.length} posts</h2>
              <p className="text-sm text-slate-500">Change any words, get a new design, or remove a post. Nothing is scheduled until you press the button.</p>
            </div>
            <button
              type="button"
              onClick={scheduleAll}
              disabled={!!busy || chosen.length === 0}
              className="ml-auto rounded-md bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Schedule all {drafts.length} posts
            </button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {drafts.map((d) => (
              <DraftCard key={d.key} draft={d} onChange={(c) => update(d.key, c)} onNewDesign={() => newDesign(d)} onRemove={() => setDrafts(drafts.filter((x) => x.key !== d.key))} />
            ))}
          </div>
        </section>
      )}

      {data.plans.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold">Your auto posts</h2>
          {data.plans.map((p) => (
            <PlanCard key={p.id} plan={p} onChanged={onChanged} />
          ))}
        </section>
      )}
    </div>
  );
}

function DraftCard({ draft, onChange, onNewDesign, onRemove }: { draft: Draft; onChange: (c: (d: Draft) => Draft) => void; onNewDesign: () => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const small = 'w-full rounded border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none';
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-slate-800">{draft.when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
        <span className="text-slate-500">{draft.when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
        <span className="ml-auto truncate text-slate-500">
          {draft.topic}
          {draft.device ? ` · ${draft.device}` : ''}
        </span>
      </div>
      <img src={draft.preview} alt="" className="w-full rounded-md" />
      <div className="flex gap-3 text-xs">
        <button type="button" onClick={onNewDesign} className="font-medium text-blue-600 hover:underline">
          🎲 New design
        </button>
        <button type="button" onClick={() => setEditing(!editing)} className="font-medium text-blue-600 hover:underline">
          {editing ? 'Done' : 'Edit poster words'}
        </button>
        <button type="button" onClick={onRemove} className="ml-auto text-red-600 hover:underline">
          Remove
        </button>
      </div>
      {editing && (
        <div className="space-y-1.5">
          <input className={small} maxLength={30} aria-label="Big text" value={draft.poster.big} onChange={(e) => onChange((d) => ({ ...d, poster: { ...d.poster, big: e.target.value } }))} />
          <input className={small} maxLength={60} aria-label="Headline" value={draft.poster.headline} onChange={(e) => onChange((d) => ({ ...d, poster: { ...d.poster, headline: e.target.value } }))} />
          <input className={small} maxLength={90} aria-label="Details" value={draft.poster.details} onChange={(e) => onChange((d) => ({ ...d, poster: { ...d.poster, details: e.target.value } }))} />
        </div>
      )}
      <textarea className={`${small} min-h-24`} maxLength={2000} aria-label="Post text" value={draft.caption} onChange={(e) => onChange((d) => ({ ...d, caption: e.target.value }))} />
    </div>
  );
}

function PlanCard({ plan, onChanged }: { plan: Plan; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const next = plan.upcoming[0]?.scheduledAt;
  const stop = async () => {
    if (!confirm(`Cancel the ${plan.upcoming.length} posts in this plan that haven’t gone out yet? Posts already published stay up.`)) return;
    await api(`/posts/plans/${plan.id}/stop`, { method: 'POST' }).catch(() => {});
    onChanged();
  };
  useEffect(() => {
    if (plan.upcoming.length === 0) setOpen(false);
  }, [plan.upcoming.length]);
  return (
    <div className="rounded-xl bg-white p-4 text-sm shadow-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium">{plan.name}</span>
        <span className="text-slate-500">
          {plan.posted} posted · {plan.upcoming.length} to come{plan.failed ? ` · ${plan.failed} failed` : ''}
          {next ? ` · next ${new Date(next).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
        </span>
        {plan.upcoming.length > 0 && (
          <span className="ml-auto flex gap-3">
            <button onClick={() => setOpen(!open)} className="text-blue-600 hover:underline">
              {open ? 'Hide' : 'See upcoming'}
            </button>
            <button onClick={stop} className="text-red-600 hover:underline">
              Stop plan
            </button>
          </span>
        )}
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          {plan.upcoming.map((p) => (
            <PostCard key={p.id} post={p} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

