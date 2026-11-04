import { useEffect, useState } from 'react';
import { api, DAYS, type Day, type WeeklyHours } from '../api';

interface SpecialDay {
  date: string;
  closed: boolean;
  open?: string;
  close?: string;
  label?: string;
}

interface Site {
  id: string;
  name: string;
  url: string;
  tip: string;
  doneAt: string | null;
  outOfDate: boolean;
}

interface Profile {
  id: string;
  isMain: boolean;
  googleConnectionId: string | null;
  facebookConnectionId: string | null;
  name: string;
  address: string;
  phone: string;
  website: string;
  description: string;
  hours: WeeklyHours | null;
  specialHours: SpecialDay[];
  checklist: Site[];
  publishedAt: string | null;
  publishResults: Record<string, { ok: boolean; error?: string; at: string }>;
  unpublishedChanges: boolean;
  updatedAt: string;
}

interface Data {
  profiles: Profile[];
  googleLocations: { id: string; name: string; used: boolean }[];
  facebookPages: { id: string; name: string }[];
  widgetKey: string;
}

const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';
const DAY_NAMES: Record<Day, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const TARGETS: Record<string, string> = { google: 'Google (Search & Maps)', facebook: 'Facebook Page', chatbird: 'ChatBird, your website & AI receptionist' };

/** The next date (YYYY-MM-DD) for a month and day, from today. */
function next(month: number, day: number) {
  const today = new Date();
  const year = today.getMonth() + 1 > month || (today.getMonth() + 1 === month && today.getDate() > day) ? today.getFullYear() + 1 : today.getFullYear();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const QUICK_HOLIDAYS = [
  { label: 'Christmas Day', date: () => next(12, 25) },
  { label: 'Boxing Day', date: () => next(12, 26) },
  { label: 'New Year’s Day', date: () => next(1, 1) },
  { label: 'Australia Day', date: () => next(1, 26) },
  { label: 'Anzac Day', date: () => next(4, 25) },
];

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl bg-white p-6 shadow-sm">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export default function Listings({ onOpenIntegrations }: { onOpenIntegrations: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<Data>('/listings')
      .then((d) => {
        setData(d);
        setSelected((s) => (s && d.profiles.some((p) => p.id === s) ? s : d.profiles[0]?.id ?? null));
      })
      .catch((err) => setError((err as Error).message));
  useEffect(() => {
    load();
  }, []);

  const add = async (googleConnectionId: string) => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ profile: Profile; warning: string }>('/listings', { method: 'POST', body: { googleConnectionId } });
      if (r.warning) setError(r.warning);
      setAdding('');
      await load();
      setSelected(r.profile.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="p-8 text-sm text-slate-400">{error || 'Loading…'}</div>;
  const free = data.googleLocations.filter((l) => !l.used);
  const profile = data.profiles.find((p) => p.id === selected);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 p-4 md:p-8">
        <div>
          <h1 className="text-xl font-semibold">Listings</h1>
          <p className="mt-1 text-sm text-slate-500">
            Your details in one place. Update them here and they go to Google, your Facebook Page, your website and ChatBird’s AI receptionist; other sites get a checklist.
          </p>
        </div>
        {error && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{error}</p>}

        {data.googleLocations.length === 0 ? (
          <Card title="Connect Google first" hint="Listings start from your Google Business Profile.">
            <button onClick={onOpenIntegrations} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              Go to Integrations
            </button>
          </Card>
        ) : data.profiles.length === 0 ? (
          <Card title="Set up your listing" hint="Choose your Google location. ChatBird copies its current details from Google; nothing on Google changes until you press Update everywhere.">
            <div className="flex flex-wrap gap-2">
              <select className={`${input} w-auto`} value={adding || free[0]?.id} onChange={(e) => setAdding(e.target.value)}>
                {free.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <button disabled={busy} onClick={() => add(adding || free[0].id)} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {busy ? 'Reading Google…' : 'Set up'}
              </button>
            </div>
          </Card>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {data.profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelected(p.id)}
                  className={`rounded-full px-4 py-1.5 text-sm ${p.id === selected ? 'bg-slate-900 font-medium text-white' : 'bg-white text-slate-600 shadow-sm'}`}
                >
                  {p.name}
                  {p.unpublishedChanges && <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-amber-400" title="Changes not sent yet" />}
                </button>
              ))}
              {free.length > 0 && (
                <span className="flex items-center gap-1">
                  <select className="rounded-full border border-dashed border-slate-400 bg-transparent px-3 py-1.5 text-sm text-slate-600" value="" onChange={(e) => e.target.value && add(e.target.value)} disabled={busy}>
                    <option value="">+ Add location</option>
                    {free.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </span>
              )}
            </div>
            {profile && <ProfileEditor key={profile.id} profile={profile} facebookPages={data.facebookPages} widgetKey={data.widgetKey} onChanged={load} />}
          </>
        )}
      </div>
    </div>
  );
}

function ProfileEditor({ profile, facebookPages, widgetKey, onChanged }: { profile: Profile; facebookPages: Data['facebookPages']; widgetKey: string; onChanged: () => void }) {
  const [form, setForm] = useState(profile);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState('');
  const dirty =
    form.phone !== profile.phone ||
    form.website !== profile.website ||
    form.description !== profile.description ||
    form.facebookConnectionId !== profile.facebookConnectionId ||
    JSON.stringify(form.hours) !== JSON.stringify(profile.hours) ||
    JSON.stringify(form.specialHours) !== JSON.stringify(profile.specialHours);

  const save = async () => {
    const r = await api<{ profile: Profile }>(`/listings/${profile.id}`, {
      method: 'PATCH',
      body: { phone: form.phone, website: form.website, description: form.description, hours: form.hours, specialHours: form.specialHours, facebookConnectionId: form.facebookConnectionId },
    });
    setForm(r.profile);
    return r.profile;
  };

  const act = async (what: 'save' | 'publish' | 'refresh') => {
    setBusy(what);
    setStatus(null);
    try {
      if (what === 'refresh') {
        if (dirty && !confirm('Replace your unsaved changes with what’s on Google now?')) return;
        const r = await api<{ profile: Profile }>(`/listings/${profile.id}/refresh`, { method: 'POST' });
        setForm(r.profile);
        setStatus({ ok: true, text: 'Loaded the latest details from Google.' });
      } else {
        await save();
        if (what === 'publish') {
          const r = await api<{ profile: Profile; results: Profile['publishResults'] }>(`/listings/${profile.id}/publish`, { method: 'POST' });
          setForm(r.profile);
          const failed = Object.entries(r.results).filter(([, x]) => !x.ok);
          setStatus(failed.length ? { ok: false, text: `Some places didn’t update: ${failed.map(([k]) => TARGETS[k] ?? k).join(', ')}. See below.` } : { ok: true, text: 'Updated everywhere.' });
        } else setStatus({ ok: true, text: 'Saved. Press Update everywhere to send it out.' });
      }
      onChanged();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy('');
    }
  };

  const setDay = (day: Day, value: WeeklyHours[Day]) => setForm({ ...form, hours: { ...(form.hours ?? { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }), [day]: value } });
  const setSpecial = (i: number, s: SpecialDay) => setForm({ ...form, specialHours: form.specialHours.map((x, j) => (j === i ? s : x)) });
  const addSpecial = (s: SpecialDay) => setForm({ ...form, specialHours: [...form.specialHours.filter((x) => x.date !== s.date), s].sort((a, b) => a.date.localeCompare(b.date)) });

  const details = [form.name, form.address, form.phone, form.website, form.description].filter(Boolean).join('\n');
  const hoursText = form.hours ? DAYS.map((d) => `${DAY_NAMES[d]}: ${form.hours![d] ? `${form.hours![d]!.open}–${form.hours![d]!.close}` : 'Closed'}`).join('\n') : '';
  const copy = async (what: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(what);
    setTimeout(() => setCopied(''), 2000);
  };
  const snippet = `<script src="${location.origin}/hours.js" data-key="${widgetKey}"${profile.isMain ? '' : ` data-location="${profile.id}"`} async></script>`;

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-center gap-3 rounded-xl bg-white p-4 shadow-sm">
        <div className="text-sm">
          {profile.unpublishedChanges || dirty ? (
            <span className="font-medium text-amber-700">● Changes not sent out yet</span>
          ) : (
            <span className="text-emerald-700">✓ Up to date{profile.publishedAt ? ` · sent ${new Date(profile.publishedAt).toLocaleString()}` : ''}</span>
          )}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {profile.googleConnectionId && (
            <button onClick={() => act('refresh')} disabled={!!busy} className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50">
              {busy === 'refresh' ? 'Loading…' : 'Load from Google'}
            </button>
          )}
          <button onClick={() => act('save')} disabled={!!busy || !dirty} className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50">
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => act('publish')} disabled={!!busy} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {busy === 'publish' ? 'Updating…' : 'Update everywhere'}
          </button>
        </div>
        {status && <p className={`w-full rounded-md px-3 py-2 text-sm ${status.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{status.text}</p>}
        {Object.keys(form.publishResults).length > 0 && (
          <ul className="w-full space-y-1 text-sm">
            {Object.entries(form.publishResults).map(([k, r]) => (
              <li key={k} className={r.ok ? 'text-slate-600' : 'text-red-700'}>
                {r.ok ? '✓' : '✗'} {TARGETS[k] ?? k}
                {r.error ? `: ${r.error}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card title="Business details" hint={profile.isMain ? 'Main location: also sets ChatBird’s own hours, address, phone and website.' : undefined}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">Business name</span>
            <p className="rounded-md bg-slate-50 px-3 py-2 text-sm">{form.name}</p>
          </div>
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">Address</span>
            <p className="rounded-md bg-slate-50 px-3 py-2 text-sm">{form.address || '—'}</p>
          </div>
          <p className="text-xs text-slate-500 sm:col-span-2">
            Change the name or address in Google Business Profile itself (Google re-checks those and can pause a listing while it does), then press Load from Google.
          </p>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-700">Phone</span>
            <input className={input} value={form.phone} maxLength={30} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="02 4049 1735" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-700">Website</span>
            <input className={input} value={form.website} maxLength={300} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 flex font-medium text-slate-700">
              Description <span className="ml-auto font-normal text-slate-400">{form.description.length}/750</span>
            </span>
            <textarea className={`${input} min-h-24`} maxLength={750} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          {facebookPages.length > 0 && (
            <label className="text-sm">
              <span className="mb-1 block font-medium text-slate-700">Facebook Page to update</span>
              <select className={input} value={form.facebookConnectionId ?? ''} onChange={(e) => setForm({ ...form, facebookConnectionId: e.target.value || null })}>
                <option value="">None</option>
                {facebookPages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </Card>

      <Card title="Opening hours">
        <div className="space-y-2">
          {DAYS.map((day) => {
            const value = form.hours?.[day] ?? null;
            return (
              <div key={day} className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex w-36 items-center gap-2">
                  <input type="checkbox" checked={value !== null} onChange={(e) => setDay(day, e.target.checked ? { open: '09:00', close: '17:00' } : null)} />
                  {DAY_NAMES[day]}
                </label>
                {value ? (
                  <span className="flex items-center gap-2">
                    <input type="time" value={value.open} onChange={(e) => setDay(day, { ...value, open: e.target.value })} className="rounded border border-slate-300 px-2 py-1" />
                    to
                    <input type="time" value={value.close} onChange={(e) => setDay(day, { ...value, close: e.target.value })} className="rounded border border-slate-300 px-2 py-1" />
                  </span>
                ) : (
                  <span className="text-slate-400">Closed</span>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Holiday hours" hint="Days you’re closed or open different hours. They go to Google and your website, and the AI receptionist and away message follow them.">
        {form.specialHours.length === 0 && <p className="text-sm text-slate-400">None set.</p>}
        <div className="space-y-2">
          {form.specialHours.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <input type="date" value={s.date} onChange={(e) => setSpecial(i, { ...s, date: e.target.value })} className="rounded border border-slate-300 px-2 py-1" />
              <select value={s.closed ? 'closed' : 'open'} onChange={(e) => setSpecial(i, e.target.value === 'closed' ? { date: s.date, label: s.label, closed: true } : { ...s, closed: false, open: s.open ?? '10:00', close: s.close ?? '14:00' })} className="rounded border border-slate-300 px-2 py-1">
                <option value="closed">Closed</option>
                <option value="open">Open</option>
              </select>
              {!s.closed && (
                <>
                  <input type="time" value={s.open} onChange={(e) => setSpecial(i, { ...s, open: e.target.value })} className="rounded border border-slate-300 px-2 py-1" />
                  to
                  <input type="time" value={s.close} onChange={(e) => setSpecial(i, { ...s, close: e.target.value })} className="rounded border border-slate-300 px-2 py-1" />
                </>
              )}
              <input value={s.label ?? ''} maxLength={60} onChange={(e) => setSpecial(i, { ...s, label: e.target.value })} placeholder="e.g. Christmas Day" className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1" />
              <button onClick={() => setForm({ ...form, specialHours: form.specialHours.filter((_, j) => j !== i) })} className="text-red-600 hover:underline">
                Remove
              </button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button onClick={() => addSpecial({ date: new Date().toISOString().slice(0, 10), closed: true })} className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-50">
            + Add a day
          </button>
          <span className="text-slate-400">Quick add:</span>
          {QUICK_HOLIDAYS.map((h) => (
            <button key={h.label} onClick={() => addSpecial({ date: h.date(), closed: true, label: h.label })} className="rounded-full bg-slate-100 px-3 py-1 text-slate-700 hover:bg-slate-200">
              {h.label}
            </button>
          ))}
        </div>
      </Card>

      <Card title="Other listing sites" hint="These sites don’t let other apps change your details, so update them yourself: copy your details, open the site, then tick it. ChatBird tells you when your details change.">
        <div className="flex flex-wrap gap-2 text-sm">
          <button onClick={() => copy('details', details)} className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-50">
            {copied === 'details' ? 'Copied!' : '📋 Copy details'}
          </button>
          {hoursText && (
            <button onClick={() => copy('hours', hoursText)} className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-50">
              {copied === 'hours' ? 'Copied!' : '🕘 Copy hours'}
            </button>
          )}
        </div>
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
          {form.checklist.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <a href={s.url} target="_blank" rel="noreferrer" className="font-medium text-blue-600 hover:underline">
                  {s.name} ↗
                </a>
                <div className="text-xs text-slate-500">{s.tip}</div>
              </div>
              {s.outOfDate && <span className="text-xs font-medium text-amber-700">Details changed since</span>}
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={!!s.doneAt && !s.outOfDate}
                  onChange={async (e) => {
                    const r = await api<{ profile: Profile }>(`/listings/${profile.id}/checklist`, { method: 'POST', body: { site: s.id, done: e.target.checked } });
                    setForm({ ...form, checklist: r.profile.checklist });
                  }}
                />
                {s.doneAt && !s.outOfDate ? `Updated ${new Date(s.doneAt).toLocaleDateString()}` : 'Mark updated'}
              </label>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Opening hours on your website" hint="Shows today’s open/closed status, your hours, holiday hours, address and phone, and tells Google the same details. It updates by itself when you press Update everywhere.">
        <code className="block break-all rounded-md bg-slate-900 p-3 text-xs text-slate-100">{snippet}</code>
        <button onClick={() => copy('snippet', snippet)} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
          {copied === 'snippet' ? 'Copied!' : 'Copy code'}
        </button>
      </Card>
    </div>
  );
}
