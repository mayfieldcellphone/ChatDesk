import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Business } from '../api';
import { isMobileNumber, parseContactsFile, type ImportRow, type ParsedFile } from '../contactImport';
import Promotions from './Promotions';

interface Campaign {
  id: string;
  name: string;
  channel: 'sms' | 'email';
  subject: string | null;
  body: string;
  status: 'sending' | 'paused' | 'done' | 'cancelled';
  createdAt: string;
  finishedAt: string | null;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
  replies: number;
  optOuts: number;
  lastError: string | null;
}

interface CampaignsData {
  campaigns: Campaign[];
  smsAvailable: boolean;
  emailAvailable: boolean;
  reviewLink: string | null;
  sendingHours: { from: string; until: string; now: string; open: boolean };
}

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: string | null;
  lastContactAt: string | null;
  optedOut: boolean;
}

interface CustomersData {
  contacts: Customer[];
  total: number;
  counts: { total: number; unsubscribed: number; mobiles: number; emails: number };
  sources: { source: string; count: number }[];
}

const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';
const sourceLabel = (s: string) => (s === 'chatbird' ? 'ChatBird (chats, texts, calls)' : s);
const fmt = (n: number) => n.toLocaleString();

export default function Marketing({ business }: { business: Business }) {
  const [tab, setTab] = useState<'posts' | 'campaigns' | 'customers'>('posts');
  const [sources, setSources] = useState<{ source: string; count: number }[]>([]);
  const loadSources = () => api<CustomersData>('/marketing/contacts?status=subscribed').then((d) => setSources(d.sources)).catch(() => {});
  useEffect(() => {
    loadSources();
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 md:px-6 md:py-8">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-xl font-semibold">Marketing</h1>
            <p className="text-sm text-slate-500">Posts for Google, Facebook and Instagram, and texts and emails to your customers.</p>
          </div>
          <div className="flex w-full rounded-md bg-white p-1 text-sm shadow-sm sm:ml-auto sm:w-auto">
            {([['posts', 'Social posts'], ['campaigns', 'Texts & emails'], ['customers', 'Customers']] as const).map(([t, label]) => (
              <button key={t} onClick={() => setTab(t)} className={`flex-1 whitespace-nowrap rounded px-3 py-1.5 ${tab === t ? 'bg-slate-900 font-medium text-white' : 'text-slate-600'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {tab === 'posts' ? (
          <Promotions />
        ) : tab === 'campaigns' ? (
          <Campaigns business={business} sources={sources} onOpenCustomers={() => setTab('customers')} />
        ) : (
          <Customers onChanged={loadSources} />
        )}
      </div>
    </div>
  );
}

// ---------- Campaigns ----------

const TEMPLATES = [
  {
    key: 'review',
    label: '⭐ Review request',
    name: 'Review request',
    subject: 'How did we do, {name}?',
    body: 'Hi {name}, thanks for choosing {business}! If you were happy with your repair, would you mind leaving us a quick Google review? It really helps a small local business: {link}',
  },
  {
    key: 'offer',
    label: '🏷️ Special offer',
    name: 'Special offer',
    subject: 'A little thank-you from {business}',
    body: 'Hi {name}, {business} here. This month only: 15% off battery replacements for past customers. Just mention this text when you drop in.',
  },
  {
    key: 'news',
    label: '📣 News',
    name: 'Announcement',
    subject: 'News from {business}',
    body: 'Hi {name}, quick note from {business}: we now repair iPads, laptops and game consoles too, most while you wait. Message us here for a quote.',
  },
  { key: 'blank', label: 'Blank', name: '', subject: '', body: '' },
];

function Campaigns({ business, sources, onOpenCustomers }: { business: Business; sources: { source: string; count: number }[]; onOpenCustomers: () => void }) {
  const [data, setData] = useState<CampaignsData | null>(null);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState('');

  const load = () =>
    api<CampaignsData>('/marketing/campaigns')
      .then((d) => {
        setData(d);
        if (d.campaigns.length === 0) setComposing(true);
      })
      .catch((err) => setError(err.message));
  useEffect(() => {
    load();
  }, []);
  // Live progress while something is sending.
  useEffect(() => {
    if (!data?.campaigns.some((c) => c.status === 'sending')) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [data]);

  if (!data) return <p className="text-sm text-slate-400">{error || 'Loading…'}</p>;
  const totalCustomers = sources.reduce((n, s) => n + s.count, 0);

  return (
    <div className="space-y-5">
      {error && <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
      {totalCustomers < 5 && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          You have {totalCustomers} customer{totalCustomers === 1 ? '' : 's'} so far.{' '}
          <button onClick={onOpenCustomers} className="font-semibold underline">
            Import your customers
          </button>{' '}
          from your phone, Birdeye or RepairBill to reach them all.
        </div>
      )}
      {composing ? (
        <Composer
          business={business}
          data={data}
          sources={sources}
          onCancel={data.campaigns.length ? () => setComposing(false) : undefined}
          onSent={() => {
            setComposing(false);
            load();
          }}
        />
      ) : (
        <button onClick={() => setComposing(true)} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
          + New campaign
        </button>
      )}
      {data.campaigns.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold">Your campaigns</h2>
          {data.campaigns.map((c) => (
            <CampaignCard key={c.id} campaign={c} hours={data.sendingHours} onChanged={load} />
          ))}
        </section>
      )}
    </div>
  );
}

function Composer({
  business,
  data,
  sources,
  onCancel,
  onSent,
}: {
  business: Business;
  data: CampaignsData;
  sources: { source: string; count: number }[];
  onCancel?: () => void;
  onSent: () => void;
}) {
  const [channel, setChannel] = useState<'sms' | 'email'>(data.smsAvailable || !data.emailAvailable ? 'sms' : 'email');
  const [name, setName] = useState(TEMPLATES[0].name);
  const [subject, setSubject] = useState(TEMPLATES[0].subject);
  const [body, setBody] = useState(TEMPLATES[0].body);
  const [source, setSource] = useState('');
  const [months, setMonths] = useState('');
  const [preview, setPreview] = useState<{ recipients: number; preview: string; segments: number } | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const audience = { source: source || null, lastContactMonths: months ? Number(months) : null };
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ recipients: number; preview: string; segments: number }>('/marketing/campaigns/preview', { method: 'POST', body: { channel, body, audience } })
        .then(setPreview)
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [channel, body, source, months]);

  const useTemplate = (key: string) => {
    const t = TEMPLATES.find((x) => x.key === key)!;
    setName(t.name);
    setSubject(t.subject);
    setBody(t.body);
  };

  const draft = { name, channel, subject, body, audience };
  const test = async () => {
    setStatus(null);
    setBusy(true);
    try {
      const r = await api<{ to: string }>('/marketing/campaigns/test', { method: 'POST', body: draft });
      setStatus({ ok: true, text: `Test sent to ${r.to}.` });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!preview) return;
    const texts = channel === 'sms' ? ` (about ${fmt(preview.recipients * preview.segments)} texts on your Twilio bill)` : '';
    if (!window.confirm(`Send "${name || 'this campaign'}" to ${fmt(preview.recipients)} customers${texts}?\n\nIt sends between ${data.sendingHours.from} and ${data.sendingHours.until}, about one a second, and you can pause it any time.`)) return;
    setStatus(null);
    setBusy(true);
    try {
      await api('/marketing/campaigns', { method: 'POST', body: { ...draft, expectedRecipients: preview.recipients } });
      onSent();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
      setBusy(false);
    }
  };

  const usesLink = /\{link\}/i.test(body);
  const noChannel = channel === 'sms' ? !data.smsAvailable : !data.emailAvailable;

  return (
    <section className="space-y-4 rounded-xl bg-white p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold">New campaign</h2>
        {onCancel && (
          <button onClick={onCancel} className="ml-auto text-sm text-slate-500 hover:underline">
            Cancel
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {TEMPLATES.map((t) => (
          <button key={t.key} onClick={() => useTemplate(t.key)} className="rounded-full border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Campaign name (only you see this)</span>
          <input className={input} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. October battery offer" />
        </label>
        <div className="text-sm">
          <span className="mb-1 block font-medium">Send as</span>
          <div className="flex rounded-md border border-slate-300 p-0.5">
            {(['sms', 'email'] as const).map((c) => (
              <button key={c} onClick={() => setChannel(c)} className={`flex-1 rounded px-3 py-1.5 ${channel === c ? 'bg-slate-900 text-white' : 'text-slate-600'}`}>
                {c === 'sms' ? 'Text (SMS)' : 'Email'}
              </button>
            ))}
          </div>
        </div>
      </div>
      {noChannel && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {channel === 'sms' ? 'Texting isn’t set up yet: add your Twilio number in Settings.' : 'Email isn’t set up yet: add it under Integrations → Server keys.'}
        </p>
      )}

      {channel === 'email' && (
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Subject</span>
          <input className={input} value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)} />
        </label>
      )}
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Message</span>
        <textarea className={`${input} min-h-28`} value={body} maxLength={channel === 'sms' ? 800 : 5000} onChange={(e) => setBody(e.target.value)} />
        <span className="mt-1 block text-xs text-slate-500">
          {'{name}'} = first name (or “there”), {'{business}'} = {business.name}, {'{link}'} = your Google review link.
          {channel === 'sms' && preview && preview.segments > 0 && (
            <b className={preview.segments > 2 ? 'text-amber-700' : ''}>
              {' '}
              Counts as {preview.segments} text{preview.segments === 1 ? '' : 's'} per customer.
            </b>
          )}
        </span>
      </label>
      {usesLink && !data.reviewLink && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Add your Google review link on the Reviews page to use {'{link}'}.</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Who</span>
          <select className={input} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">All customers</option>
            {sources.map((s) => (
              <option key={s.source} value={s.source}>
                {sourceLabel(s.source)} ({fmt(s.count)})
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Last in touch</span>
          <select className={input} value={months} onChange={(e) => setMonths(e.target.value)}>
            <option value="">Any time</option>
            <option value="3">Within 3 months</option>
            <option value="6">Within 6 months</option>
            <option value="12">Within a year</option>
            <option value="24">Within 2 years</option>
            <option value="36">Within 3 years</option>
          </select>
        </label>
      </div>

      {preview && preview.preview && (
        <div>
          <div className="mb-1 text-sm font-medium">What {preview.recipients ? 'they’ll' : 'customers would'} get</div>
          <div className={`whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm ${channel === 'sms' ? 'max-w-sm rounded-bl-sm bg-slate-100' : 'border border-slate-200'}`}>
            {channel === 'email' && <div className="mb-2 font-semibold">{subject.replace(/\{business\}/gi, business.name).replace(/\{name\}/gi, 'Sam')}</div>}
            {preview.preview}
            {channel === 'email' && <div className="mt-3 text-xs text-slate-400">— {business.name} · Unsubscribe link added automatically</div>}
          </div>
          {channel === 'sms' && <p className="mt-1 text-xs text-slate-500">Your business name and “Reply STOP to opt out” are added if your message doesn’t include them. Australian law requires both.</p>}
        </div>
      )}

      {status && <p className={`rounded-md px-3 py-2 text-sm ${status.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{status.text}</p>}
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
        <button
          onClick={send}
          disabled={busy || noChannel || !preview?.recipients || !body.trim() || (usesLink && !data.reviewLink)}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Send to {fmt(preview?.recipients ?? 0)} customer{preview?.recipients === 1 ? '' : 's'}
        </button>
        <button onClick={test} disabled={busy || noChannel || !body.trim()} className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50">
          Send me a test
        </button>
        <span className="text-xs text-slate-500">Skips anyone who unsubscribed or got a campaign in the last 3 days.</span>
      </div>
    </section>
  );
}

const STATUS_STYLE: Record<Campaign['status'], string> = {
  sending: 'bg-blue-100 text-blue-800',
  paused: 'bg-amber-100 text-amber-800',
  done: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-slate-100 text-slate-600',
};

function CampaignCard({ campaign: c, hours, onChanged }: { campaign: Campaign; hours: CampaignsData['sendingHours']; onChanged: () => void }) {
  const [error, setError] = useState('');
  const act = async (action: 'pause' | 'resume' | 'cancel') => {
    if (action === 'cancel' && !window.confirm(`Stop "${c.name}"? The ${fmt(c.pending)} customers not reached yet won’t get it.`)) return;
    try {
      await api(`/marketing/campaigns/${c.id}/${action}`, { method: 'POST' });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const done = c.sent + c.failed + c.skipped;
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.name}</span>
        <span className="text-xs text-slate-500">{c.channel === 'sms' ? 'Text' : 'Email'} · {new Date(c.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[c.status]}`}>{c.status === 'sending' && !hours.open ? 'waiting for 9am' : c.status}</span>
        <div className="ml-auto flex gap-3 text-sm">
          {c.status === 'sending' && (
            <button onClick={() => act('pause')} className="text-slate-600 hover:underline">
              Pause
            </button>
          )}
          {c.status === 'paused' && (
            <button onClick={() => act('resume')} className="text-blue-600 hover:underline">
              Resume
            </button>
          )}
          {(c.status === 'sending' || c.status === 'paused') && (
            <button onClick={() => act('cancel')} className="text-red-600 hover:underline">
              Stop
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 line-clamp-2 text-sm text-slate-500">{c.body}</p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${done} of ${c.total} processed`}>
        <div className="h-2 rounded-full bg-blue-600" style={{ width: `${c.total ? (done / c.total) * 100 : 0}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <span>
          <b className="tabular-nums">{fmt(c.sent)}</b> <span className="text-slate-500">of {fmt(c.total)} sent</span>
        </span>
        <span>
          <b className="tabular-nums">{fmt(c.replies)}</b> <span className="text-slate-500">replied</span>
        </span>
        <span>
          <b className="tabular-nums">{fmt(c.optOuts)}</b> <span className="text-slate-500">unsubscribed</span>
        </span>
        {c.failed > 0 && (
          <span className="text-red-700">
            <b className="tabular-nums">{fmt(c.failed)}</b> failed
          </span>
        )}
        {c.skipped > 0 && <span className="text-slate-500">{fmt(c.skipped)} skipped</span>}
      </div>
      {c.lastError && <p className="mt-2 text-xs text-red-700">Last error: {c.lastError}</p>}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}

// ---------- Customers ----------

function Customers({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<CustomersData | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  const load = (offset = 0) => {
    const params = new URLSearchParams({ q, status, source, offset: String(offset) });
    return api<CustomersData>(`/marketing/contacts?${params}`)
      .then((d) => setData((prev) => (offset && prev ? { ...d, contacts: [...prev.contacts, ...d.contacts] } : d)))
      .catch((err) => setError(err.message));
  };
  useEffect(() => {
    const t = setTimeout(() => load(), 250);
    return () => clearTimeout(t);
  }, [q, status, source]);

  const toggle = async (c: Customer) => {
    try {
      await api(`/marketing/contacts/${c.id}`, { method: 'PATCH', body: { optedOut: !c.optedOut } });
      setData((d) => d && { ...d, contacts: d.contacts.map((x) => (x.id === c.id ? { ...x, optedOut: !c.optedOut } : x)) });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const removeList = async (name: string) => {
    if (!window.confirm(`Remove the customers imported as "${name}"? Anyone who has a conversation in ChatBird is kept.`)) return;
    try {
      const r = await api<{ deleted: number }>(`/marketing/contacts?source=${encodeURIComponent(name)}`, { method: 'DELETE' });
      window.alert(`Removed ${fmt(r.deleted)} customers.`);
      setSource('');
      load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!data) return <p className="text-sm text-slate-400">{error || 'Loading…'}</p>;
  const k = data.counts;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['Customers', k.total],
          ['Mobiles (can text)', k.mobiles],
          ['With email', k.emails],
          ['Unsubscribed', k.unsubscribed],
        ].map(([label, n]) => (
          <div key={label} className="rounded-xl bg-white p-4 shadow-sm">
            <div className="text-xs font-medium text-slate-500">{label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{fmt(n as number)}</div>
          </div>
        ))}
      </div>

      {importing ? (
        <Importer
          onClose={() => setImporting(false)}
          onImported={() => {
            load();
            onChanged();
          }}
        />
      ) : (
        <button onClick={() => setImporting(true)} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
          Import customers
        </button>
      )}

      <section className="rounded-xl bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <input className={`${input} min-w-0 flex-1 basis-48`} placeholder="Search name, number or email" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className={`${input} w-auto`} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="all">Everyone</option>
            <option value="subscribed">Subscribed</option>
            <option value="unsubscribed">Unsubscribed</option>
          </select>
          <select className={`${input} w-auto max-w-full`} value={source} onChange={(e) => setSource(e.target.value)} aria-label="List">
            <option value="">All lists</option>
            {data.sources.map((s) => (
              <option key={s.source} value={s.source}>
                {sourceLabel(s.source)} ({fmt(s.count)})
              </option>
            ))}
          </select>
        </div>
        {source && source !== 'chatbird' && (
          <button onClick={() => removeList(source)} className="mt-2 text-xs text-red-600 hover:underline">
            Remove this imported list
          </button>
        )}
        {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {data.contacts.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{c.name}</div>
                <div className="truncate text-xs text-slate-500">
                  {[c.phone, c.email].filter(Boolean).join(' · ')}
                  {c.source && ` · ${c.source}`}
                  {c.lastContactAt && ` · last in touch ${new Date(c.lastContactAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`}
                </div>
              </div>
              <button
                onClick={() => toggle(c)}
                className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${c.optedOut ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-700'}`}
                title={c.optedOut ? 'Unsubscribed: gets no marketing. Click to resubscribe (only if they asked).' : 'Gets marketing. Click to unsubscribe them.'}
              >
                {c.optedOut ? 'Unsubscribed' : 'Subscribed'}
              </button>
            </li>
          ))}
          {data.contacts.length === 0 && <li className="py-6 text-center text-slate-400">No customers match.</li>}
        </ul>
        {data.contacts.length < data.total && (
          <button onClick={() => load(data.contacts.length)} className="mt-2 text-sm text-blue-600 hover:underline">
            Show more ({fmt(data.total - data.contacts.length)} left)
          </button>
        )}
      </section>
    </div>
  );
}

const YEARS = [
  ['', 'Any time'],
  ['1', 'Within 1 year'],
  ['2', 'Within 2 years'],
  ['3', 'Within 3 years'],
  ['5', 'Within 5 years'],
];

function Importer({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [fileName, setFileName] = useState('');
  const [paste, setPaste] = useState('');
  const [listName, setListName] = useState('');
  const [skipSaved, setSkipSaved] = useState(true);
  const [mobilesOnly, setMobilesOnly] = useState(true);
  const [years, setYears] = useState('3');
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ added: number; updated: number } | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const read = (text: string, name: string) => {
    setError('');
    setResult(null);
    const p = parseContactsFile(text);
    if (p.rows.length === 0) return setError('No phone numbers or emails found in that file.');
    setParsed(p);
    setFileName(name);
    setListName(p.kind === 'sms-backup' ? 'Phone messages' : /birdeye/i.test(name) ? 'Birdeye' : /repair ?bill/i.test(name) ? 'RepairBill' : name.replace(/\.[a-z]+$/i, '').slice(0, 40) || 'Imported');
  };

  const chosen: ImportRow[] = useMemo(() => {
    if (!parsed) return [];
    const since = years ? Date.now() - Number(years) * 365 * 86_400_000 : 0;
    return parsed.rows.filter(
      (r) =>
        !(skipSaved && r.saved) &&
        (r.email || !mobilesOnly || (r.phone && isMobileNumber(r.phone))) &&
        (!since || !r.lastContactAt || Date.parse(r.lastContactAt) >= since),
    );
  }, [parsed, skipSaved, mobilesOnly, years]);
  const savedCount = parsed?.rows.filter((r) => r.saved).length ?? 0;
  const hasDates = parsed?.rows.some((r) => r.lastContactAt) ?? false;

  const run = async () => {
    setError('');
    let added = 0, updated = 0;
    try {
      for (let i = 0; i < chosen.length; i += 1000) {
        setProgress(`Importing ${fmt(Math.min(i + 1000, chosen.length))} of ${fmt(chosen.length)}…`);
        const batch = chosen.slice(i, i + 1000).map(({ phone, email, name, lastContactAt }) => ({ phone, email, name, lastContactAt }));
        const r = await api<{ added: number; updated: number }>('/marketing/contacts/import', { method: 'POST', body: { source: listName, rows: batch } });
        added += r.added;
        updated += r.updated;
      }
      setResult({ added, updated });
      setParsed(null);
      setPaste('');
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  };

  return (
    <section className="space-y-4 rounded-xl bg-white p-5 shadow-sm">
      <div className="flex items-center">
        <h2 className="font-semibold">Import customers</h2>
        <button onClick={onClose} className="ml-auto text-sm text-slate-500 hover:underline">
          Close
        </button>
      </div>
      {result && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Done: {fmt(result.added)} new customers added{result.updated ? `, ${fmt(result.updated)} existing ones updated` : ''}.
        </p>
      )}

      {!parsed ? (
        <>
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div className="rounded-lg bg-slate-50 p-3">
              <b>Android phone</b>
              <p className="mt-1 text-slate-600">
                Install <i>SMS Backup &amp; Restore</i>, back up <b>messages</b> (MMS off is fine), and upload the <code>.xml</code> file here.
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <b>iPhone</b>
              <p className="mt-1 text-slate-600">
                On a computer, use <i>iMazing</i> (or similar) → Messages → <b>Export to CSV</b>, and upload the <code>.csv</code> here.
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <b>Birdeye / RepairBill / spreadsheet</b>
              <p className="mt-1 text-slate-600">Export the contacts or customers as CSV. Columns for name, phone, email and date are found automatically.</p>
            </div>
          </div>
          <p className="text-xs text-slate-500">
            Your file is read on this computer: only names, numbers, emails and last-contact dates are sent to ChatBird, never the messages. Only import people who
            have been your customers.
          </p>
          <div className="flex flex-wrap gap-3">
            <button onClick={() => fileRef.current?.click()} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
              Choose file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xml,.csv,.tsv,.txt,text/csv,text/xml"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) read(await f.text(), f.name);
                e.target.value = '';
              }}
            />
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-blue-600">Or paste numbers / a spreadsheet</summary>
            <textarea className={`${input} mt-2 min-h-24`} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'0412 345 678\n0498 765 432\nsam@example.com'} />
            <button onClick={() => read(paste, 'Pasted')} disabled={!paste.trim()} className="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50">
              Read
            </button>
          </details>
        </>
      ) : (
        <>
          <p className="text-sm">
            <b>{fileName}</b>: found {fmt(parsed.rows.length)} {parsed.kind === 'sms-backup' ? 'numbers in your messages' : 'customers'}
            {parsed.ignored ? ` (ignored ${fmt(parsed.ignored)} ${parsed.kind === 'sms-backup' ? 'group chats and short codes' : 'rows without a number or email'})` : ''}.
          </p>
          <div className="space-y-2 text-sm">
            {savedCount > 0 && (
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={skipSaved} onChange={(e) => setSkipSaved(e.target.checked)} />
                <span>
                  Skip the {fmt(savedCount)} number{savedCount === 1 ? '' : 's'} saved with a name in your phone <span className="text-slate-500">(friends, family, suppliers)</span>
                </span>
              </label>
            )}
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={mobilesOnly} onChange={(e) => setMobilesOnly(e.target.checked)} />
              <span>Only mobile numbers (landlines can’t get texts)</span>
            </label>
            {hasDates && (
              <label className="flex items-center gap-2">
                <span>Last in touch</span>
                <select className={`${input} w-auto`} value={years} onChange={(e) => setYears(e.target.value)}>
                  {YEARS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block max-w-xs">
              <span className="mb-1 block">Name this list</span>
              <input className={input} value={listName} maxLength={40} onChange={(e) => setListName(e.target.value)} />
            </label>
          </div>
          {chosen.length > 0 && (
            <div className="rounded-lg border border-slate-200 text-sm">
              <div className="border-b border-slate-100 px-3 py-2 text-xs font-medium text-slate-500">First few</div>
              {chosen.slice(0, 5).map((r, i) => (
                <div key={i} className="flex gap-3 px-3 py-1.5">
                  <span className="w-40 truncate">{r.name || <span className="text-slate-400">no name</span>}</span>
                  <span className="truncate text-slate-600">{r.phone || r.email}</span>
                  {r.lastContactAt && <span className="ml-auto shrink-0 text-xs text-slate-400">{new Date(r.lastContactAt).toLocaleDateString()}</span>}
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={run} disabled={!chosen.length || !!progress || !listName.trim()} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              Import {fmt(chosen.length)} customers
            </button>
            <button onClick={() => setParsed(null)} className="text-sm text-slate-500 hover:underline">
              Choose another file
            </button>
            {progress && <span className="text-sm text-slate-500">{progress}</span>}
          </div>
        </>
      )}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}
