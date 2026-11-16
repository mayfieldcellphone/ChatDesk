import { useEffect, useState } from 'react';
import { api } from '../api';

// SEO: Google Profile score and insights, Google Search Console, and a website check with a to-do list.

type Status = 'pass' | 'warn' | 'fail' | 'skip';
type Tab = 'profile' | 'search' | 'website';

interface Overview {
  googleAvailable: boolean;
  aiAvailable: boolean;
  pagespeedKey: boolean;
  locations: { id: string; name: string }[];
  website: string;
  searchConsole: { connected: boolean; siteUrl: string | null; error: string | null };
  schemaInject: boolean;
  businessType: string;
  businessTypes: { id: string; label: string }[];
  schema: Record<string, unknown>;
  audits: { id: string; url: string; score: number; created_at: string }[];
}

interface ProfileScore {
  location: string;
  mapsUri: string | null;
  score: number;
  checks: { id: string; label: string; status: Status; detail: string; fix: string; weight: number; page?: 'listings' | 'marketing' | 'reviews'; link?: string }[];
}

type Metric = 'searchViews' | 'mapsViews' | 'calls' | 'websiteClicks' | 'directions';
interface Insights {
  from: string;
  to: string;
  current: Record<Metric, number>;
  previous: Record<Metric, number>;
  daily: ({ date: string } & Record<Metric, number>)[];
  keywords: { keyword: string; count: number | null; under: number | null }[];
  keywordMonths: string;
}

interface GscRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}
interface SearchReport {
  siteUrl: string;
  from: string;
  to: string;
  current: { clicks: number; impressions: number; ctr: number; position: number };
  previous: { clicks: number; impressions: number; ctr: number; position: number };
  daily: { date: string; clicks: number; impressions: number }[];
  queries: GscRow[];
  pages: GscRow[];
  opportunities: GscRow[];
}

interface Audit {
  id: string;
  url: string;
  finalUrl: string;
  checkedAt: string;
  score: number;
  checks: { id: string; label: string; status: Status; detail: string; fix: string }[];
  speed: { performance: number | null; seo: number | null; accessibility: number | null; lcpSeconds: number | null; cls: number | null; error?: string };
  page: { title: string; description: string; h1: string[]; words: number };
  links: string[];
  summary: string;
  todo: { priority: 'high' | 'medium' | 'low'; title: string; why: string; how: string; paste?: string }[];
  suggested: { title: string; description: string } | null;
  aiUsed: boolean;
}

const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';
const btn = 'rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50';
const btnLight = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const num = (n: number) => n.toLocaleString();

function Card({ title, hint, right, children }: { title: string; hint?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl bg-white p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{title}</h2>
          {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Change({ now, before, moreIsGood = true }: { now: number; before: number; moreIsGood?: boolean }) {
  if (now === before) return <span className="text-slate-400">no change</span>;
  if (before === 0) return <span className="text-slate-500">up from 0</span>;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return <span className="text-slate-400">about the same</span>;
  const good = pct > 0 === moreIsGood;
  return (
    <span className={good ? 'text-emerald-700' : 'text-red-700'}>
      {pct > 0 ? '▲' : '▼'} {Math.abs(pct)}% vs before
    </span>
  );
}

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs">{sub}</div>}
    </div>
  );
}

/** A score out of 100 in a ring: green 80+, amber 50+, red below. */
function ScoreRing({ score, size = 88 }: { score: number; size?: number }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const colour = score >= 80 ? '#059669' : score >= 50 ? '#d97706' : '#dc2626';
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`Score ${score} out of 100`} className="flex-none">
      <circle cx="50" cy="50" r={r} fill="none" stroke="#e2e8f0" strokeWidth="10" />
      <circle cx="50" cy="50" r={r} fill="none" stroke={colour} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} transform="rotate(-90 50 50)" />
      <text x="50" y="57" textAnchor="middle" fontSize="24" fontWeight="800" fill="#0f172a">
        {score}
      </text>
    </svg>
  );
}

const STATUS_ICON: Record<Status, { mark: string; cls: string; label: string }> = {
  pass: { mark: '✓', cls: 'bg-emerald-100 text-emerald-700', label: 'Done' },
  warn: { mark: '!', cls: 'bg-amber-100 text-amber-700', label: 'Could be better' },
  fail: { mark: '✕', cls: 'bg-red-100 text-red-700', label: 'Needs fixing' },
  skip: { mark: '–', cls: 'bg-slate-100 text-slate-500', label: 'Not checked' },
};
function StatusDot({ status }: { status: Status }) {
  const s = STATUS_ICON[status];
  return (
    <span title={s.label} aria-label={s.label} className={`mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold ${s.cls}`}>
      {s.mark}
    </span>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={btnLight}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}

function Range({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <div className="flex rounded-md bg-slate-100 p-0.5 text-xs">
      {[7, 28, 90].map((d) => (
        <button key={d} onClick={() => onChange(d)} className={`rounded px-2.5 py-1 ${days === d ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'}`}>
          {d} days
        </button>
      ))}
    </div>
  );
}

/** Small daily bar chart with a hover readout. */
function Bars({ data, label }: { data: { date: string; value: number }[]; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const shown = active !== null ? data[active] : null;
  if (!data.length) return null;
  return (
    <div>
      <p className="mb-2 h-5 text-xs text-slate-500">
        {shown ? (
          <>
            <b className="text-slate-900">{num(shown.value)}</b> {label} on {shortDate(shown.date)}
          </>
        ) : (
          `${label} per day, ${shortDate(data[0].date)} – ${shortDate(data[data.length - 1].date)}`
        )}
      </p>
      <div className="flex h-24 items-end gap-px border-b border-slate-200" onMouseLeave={() => setActive(null)}>
        {data.map((d, i) => (
          <button key={d.date} type="button" className="flex h-full flex-1 items-end" onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onClick={() => setActive(i)} aria-label={`${shortDate(d.date)}: ${d.value}`}>
            <span className={`w-full rounded-t ${active === i ? 'bg-blue-800' : 'bg-blue-500'}`} style={{ height: `${Math.max((d.value / max) * 100, d.value ? 3 : 0)}%` }} />
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Seo({ onNavigate }: { onNavigate: (view: 'listings' | 'marketing' | 'reviews' | 'integrations') => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const t = localStorage.getItem('chatbird-seo-tab');
      return t === 'search' || t === 'website' ? t : 'profile';
    } catch {
      return 'profile';
    }
  });
  const [location, setLocation] = useState('');

  const load = () =>
    api<Overview>('/seo')
      .then((d) => {
        setData(d);
        setLocation((l) => l || d.locations[0]?.id || '');
      })
      .catch((err) => setError(err.message));
  useEffect(() => {
    load();
  }, []);
  const choose = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem('chatbird-seo-tab', t);
    } catch {
      /* storage blocked */
    }
  };

  if (!data) return <div className="flex h-full items-center justify-center text-sm text-slate-400">{error || 'Loading…'}</div>;
  const TABS: [Tab, string][] = [
    ['profile', 'Google Profile'],
    ['search', 'Search Console'],
    ['website', 'Website check'],
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 md:px-6 md:py-8">
        <div>
          <h1 className="text-xl font-semibold">SEO</h1>
          <p className="text-sm text-slate-500">How you show up on Google and Maps, what people search to find you, and what to fix on your website.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex w-full rounded-md bg-white p-1 text-sm shadow-sm sm:w-auto">
            {TABS.map(([t, label]) => (
              <button key={t} onClick={() => choose(t)} className={`flex-1 whitespace-nowrap rounded px-2 py-1.5 sm:px-3 ${tab === t ? 'bg-slate-900 font-medium text-white' : 'text-slate-600'}`}>
                {label}
              </button>
            ))}
          </div>
          {tab === 'profile' && data.locations.length > 1 && (
            <select value={location} onChange={(e) => setLocation(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" aria-label="Location">
              {data.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {tab === 'profile' &&
          (data.locations.length === 0 ? (
            <Card title="Connect Google Business Profile" hint="Your Google Profile score and insights come from your Business Profile.">
              <button className={btn} onClick={() => onNavigate('integrations')}>
                Go to Integrations
              </button>
            </Card>
          ) : (
            <ProfileTab key={location} location={location} onNavigate={onNavigate} />
          ))}
        {tab === 'search' && <SearchTab data={data} onChanged={load} />}
        {tab === 'website' && <WebsiteTab data={data} onChanged={load} />}
      </div>
    </div>
  );
}

// ---------- Google Profile ----------

function ProfileTab({ location, onNavigate }: { location: string; onNavigate: (view: 'listings' | 'marketing' | 'reviews') => void }) {
  const [score, setScore] = useState<ProfileScore | null>(null);
  const [scoreError, setScoreError] = useState('');
  const [days, setDays] = useState(28);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [insightsError, setInsightsError] = useState('');
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    api<ProfileScore>(`/seo/profile-score?location=${encodeURIComponent(location)}`).then(setScore).catch((err) => setScoreError(err.message));
  }, [location]);
  useEffect(() => {
    setInsightsError('');
    api<Insights>(`/seo/insights?location=${encodeURIComponent(location)}&days=${days}`).then(setInsights).catch((err) => setInsightsError(err.message));
  }, [location, days]);

  const todo = score?.checks.filter((c) => c.status === 'fail' || c.status === 'warn').sort((a, b) => (a.status === b.status ? b.weight - a.weight : a.status === 'fail' ? -1 : 1)) ?? [];
  const done = score?.checks.filter((c) => c.status === 'pass') ?? [];
  const PAGE_NAMES = { listings: 'Listings', marketing: 'Marketing', reviews: 'Reviews' };

  return (
    <>
      <Card title="Google Profile score" hint="The things Google looks at when choosing which businesses to show in Maps and the local results.">
        {scoreError ? (
          <p className="text-sm text-red-700">{scoreError}</p>
        ) : !score ? (
          <p className="text-sm text-slate-400">Checking your profile…</p>
        ) : (
          <>
            <div className="flex items-center gap-4">
              <ScoreRing score={score.score} />
              <div className="text-sm">
                <div className="font-semibold">{score.location}</div>
                <div className="text-slate-500">
                  {todo.length === 0 ? 'Everything we check is in good shape.' : `${todo.length} thing${todo.length === 1 ? '' : 's'} to improve, most important first.`}
                </div>
                {score.mapsUri && (
                  <a href={score.mapsUri} target="_blank" rel="noopener" className="text-blue-600 hover:underline">
                    See it on Google Maps ↗
                  </a>
                )}
              </div>
            </div>
            <ul className="divide-y divide-slate-100">
              {[...todo, ...(showDone ? done : [])].map((c) => (
                <li key={c.id} className="flex gap-3 py-3">
                  <StatusDot status={c.status} />
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="font-medium">
                      {c.label} <span className="font-normal text-slate-500">· {c.detail}</span>
                    </div>
                    {c.status !== 'pass' && <p className="mt-0.5 text-slate-600">{c.fix}</p>}
                    {c.status !== 'pass' && (c.page || c.link) && (
                      <div className="mt-2">
                        {c.page ? (
                          <button className={btnLight} onClick={() => onNavigate(c.page!)}>
                            Fix in {PAGE_NAMES[c.page]}
                          </button>
                        ) : (
                          <a className={btnLight} href={c.link} target="_blank" rel="noopener">
                            Open Google Business Profile ↗
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {done.length > 0 && (
              <button className="text-sm text-blue-600 hover:underline" onClick={() => setShowDone(!showDone)}>
                {showDone ? 'Hide what’s done' : `Show ${done.length} thing${done.length === 1 ? '' : 's'} already done`}
              </button>
            )}
          </>
        )}
      </Card>

      <Card
        title="Profile insights"
        hint={insights ? `${shortDate(insights.from)} – ${shortDate(insights.to)}, compared with the ${days} days before. Google’s numbers arrive a few days late.` : 'People who found you on Google and what they did.'}
        right={<Range days={days} onChange={setDays} />}
      >
        {insightsError ? (
          <p className="text-sm text-red-700">{insightsError}</p>
        ) : !insights ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {(
                [
                  ['searchViews', 'Views on Google Search'],
                  ['mapsViews', 'Views on Google Maps'],
                  ['calls', 'Calls'],
                  ['websiteClicks', 'Website clicks'],
                  ['directions', 'Direction requests'],
                ] as [Metric, string][]
              ).map(([m, label]) => (
                <Tile key={m} label={label} value={num(insights.current[m])} sub={<Change now={insights.current[m]} before={insights.previous[m]} />} />
              ))}
            </div>
            <Bars label="profile views" data={insights.daily.map((d) => ({ date: d.date, value: d.searchViews + d.mapsViews }))} />
            <div>
              <h3 className="text-sm font-semibold">What people searched to find you</h3>
              <p className="mb-2 text-xs text-slate-500">{insights.keywordMonths}. Google shows small numbers as “under 15”.</p>
              {insights.keywords.length === 0 ? (
                <p className="text-sm text-slate-400">No search terms yet.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-slate-100">
                      {insights.keywords.map((k) => (
                        <tr key={k.keyword}>
                          <td className="py-1.5">{k.keyword}</td>
                          <td className="py-1.5 text-right tabular-nums text-slate-600">{k.count !== null ? num(k.count) : k.under !== null ? `under ${k.under}` : '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </Card>
    </>
  );
}

// ---------- Search Console ----------

function GscTable({ rows, first }: { rows: GscRow[]; first: string }) {
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white text-left text-xs text-slate-500">
          <tr>
            <th className="py-1.5 font-medium">{first}</th>
            <th className="py-1.5 text-right font-medium">Clicks</th>
            <th className="py-1.5 text-right font-medium">Seen</th>
            <th className="py-1.5 text-right font-medium">Position</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="max-w-0 truncate py-1.5 pr-2" title={r.key}>
                {first === 'Page' ? r.key.replace(/^https?:\/\/(www\.)?/, '') : r.key}
              </td>
              <td className="py-1.5 text-right tabular-nums">{num(r.clicks)}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-600">{num(r.impressions)}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-600">{r.position.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SearchTab({ data, onChanged }: { data: Overview; onChanged: () => void }) {
  const gsc = data.searchConsole;
  const [sites, setSites] = useState<{ siteUrl: string }[] | null>(null);
  const [report, setReport] = useState<SearchReport | null>(null);
  const [days, setDays] = useState(28);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!gsc.connected) return;
    if (!gsc.siteUrl) {
      api<{ sites: { siteUrl: string }[] }>('/seo/search-console/sites').then((d) => setSites(d.sites)).catch((err) => setError(err.message));
      return;
    }
    setError('');
    api<SearchReport>(`/seo/search-console?days=${days}`).then(setReport).catch((err) => setError(err.message));
  }, [gsc.connected, gsc.siteUrl, days]);

  const chooseSite = async (siteUrl: string) => {
    try {
      await api('/seo/search-console/site', { method: 'PUT', body: { siteUrl } });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const disconnect = async () => {
    if (!confirm('Disconnect Google Search Console from ChatBird?')) return;
    await api('/seo/search-console', { method: 'DELETE' });
    setReport(null);
    onChanged();
  };

  if (!gsc.connected) {
    return (
      <Card
        title="Google Search Console"
        hint="See the searches that bring people to your website, how often you appear, and where you rank. It’s free from Google; ChatBird only reads it."
      >
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
          <li>
            Your website needs to be in Search Console. If it isn’t yet, add it at{' '}
            <a className="text-blue-600 hover:underline" href="https://search.google.com/search-console" target="_blank" rel="noopener">
              search.google.com/search-console
            </a>{' '}
            (Google shows how to verify it; a “Domain” property is best).
          </li>
          <li>Press Connect and sign in with the Google account that can see it.</li>
        </ol>
        {data.googleAvailable ? (
          <a className={`${btn} inline-block`} href="/api/seo/search-console/connect">
            Connect Search Console
          </a>
        ) : (
          <p className="text-sm text-amber-700">Google isn’t set up on the server yet (Integrations → Server keys).</p>
        )}
        <SetupNote />
      </Card>
    );
  }

  if (!gsc.siteUrl) {
    return (
      <Card title="Choose your website" hint="Which Search Console property is your business website?">
        {error && <p className="text-sm text-red-700">{error}</p>}
        {!sites ? (
          !error && <p className="text-sm text-slate-400">Loading…</p>
        ) : sites.length === 0 ? (
          <p className="text-sm text-slate-600">This Google account has no websites in Search Console. Add your website there first, then come back.</p>
        ) : (
          <div className="space-y-2">
            {sites.map((s) => (
              <button key={s.siteUrl} className={`${btnLight} block w-full text-left`} onClick={() => chooseSite(s.siteUrl)}>
                {s.siteUrl.replace(/^sc-domain:/, 'Domain: ')}
              </button>
            ))}
          </div>
        )}
        <button className="text-sm text-slate-500 hover:underline" onClick={disconnect}>
          Disconnect
        </button>
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Google Search"
        hint={report ? `${gsc.siteUrl.replace(/^sc-domain:/, '')} · ${shortDate(report.from)} – ${shortDate(report.to)}, compared with the ${days} days before` : gsc.siteUrl}
        right={<Range days={days} onChange={setDays} />}
      >
        {error ? (
          <div className="space-y-2 text-sm">
            <p className="text-red-700">{error}</p>
            {/reconnect|revoked|expired/i.test(error) && (
              <a className={`${btn} inline-block`} href="/api/seo/search-console/connect">
                Reconnect Search Console
              </a>
            )}
            <SetupNote />
          </div>
        ) : !report ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="Clicks to your website" value={num(report.current.clicks)} sub={<Change now={report.current.clicks} before={report.previous.clicks} />} />
              <Tile label="Times you appeared" value={num(report.current.impressions)} sub={<Change now={report.current.impressions} before={report.previous.impressions} />} />
              <Tile label="Click rate" value={`${(report.current.ctr * 100).toFixed(1)}%`} sub={<span className="text-slate-500">of people who saw you</span>} />
              <Tile
                label="Average position"
                value={report.current.position ? report.current.position.toFixed(1) : '–'}
                sub={report.previous.position ? <Change now={report.current.position} before={report.previous.position} moreIsGood={false} /> : undefined}
              />
            </div>
            <Bars label="clicks" data={report.daily.map((d) => ({ date: d.date, value: d.clicks }))} />
          </>
        )}
      </Card>

      {report && report.opportunities.length > 0 && (
        <Card
          title="Close to the top"
          hint="Searches where you show up on page 1–2 but not in the top 3. Mention these words in your page titles, headings and service text, or write a page about them: a small move up brings many more clicks."
        >
          <GscTable rows={report.opportunities} first="Search" />
        </Card>
      )}
      {report && (
        <Card title="Top searches" hint="What people typed into Google before they saw or clicked your website.">
          {report.queries.length ? <GscTable rows={report.queries} first="Search" /> : <p className="text-sm text-slate-400">No searches in this period yet.</p>}
        </Card>
      )}
      {report && report.pages.length > 0 && (
        <Card title="Top pages">
          <GscTable rows={report.pages} first="Page" />
        </Card>
      )}
      <button className="text-sm text-slate-500 hover:underline" onClick={disconnect}>
        Disconnect Search Console
      </button>
    </>
  );
}

function SetupNote() {
  return (
    <details className="text-xs text-slate-500">
      <summary className="cursor-pointer">Setting up ChatBird for the first time? (owner only)</summary>
      <p className="mt-1">
        In Google Cloud (the same project as Business Profile): APIs &amp; Services → Library → turn on <b>Google Search Console API</b> and{' '}
        <b>Business Profile Performance API</b>. Then OAuth consent screen → Data access → add the scope <code>webmasters.readonly</code>.
      </p>
    </details>
  );
}

// ---------- Website check ----------

const PRIORITY: Record<string, string> = { high: 'bg-red-100 text-red-800', medium: 'bg-amber-100 text-amber-800', low: 'bg-slate-100 text-slate-700' };

function WebsiteTab({ data, onChanged }: { data: Overview; onChanged: () => void }) {
  const [url, setUrl] = useState(data.website);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [showChecks, setShowChecks] = useState(false);

  useEffect(() => {
    // Show the latest check when the tab opens.
    if (data.audits[0]) api<Audit>(`/seo/audits/${data.audits[0].id}`).then(setAudit).catch(() => {});
  }, []);

  const run = async (target = url) => {
    setRunning(true);
    setError('');
    setUrl(target);
    try {
      setAudit(await api<Audit>('/seo/audit', { method: 'POST', body: { url: target } }));
      setShowChecks(false);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const previous = audit ? data.audits.find((a) => a.url === audit.finalUrl && a.id !== audit.id && a.created_at < audit.checkedAt) : undefined;

  return (
    <>
      <Card title="Check a page" hint="ChatBird reads the page like Google does, runs Google’s speed test for phones, and gives you a to-do list. Takes up to a minute.">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourwebsite.com.au" aria-label="Page address" />
          <button className={`${btn} whitespace-nowrap`} disabled={running || !url.trim()}>
            {running ? 'Checking…' : 'Check page'}
          </button>
        </form>
        {running && <p className="text-sm text-slate-500">Reading the page and running the speed test. This can take up to a minute…</p>}
        {error && <p className="text-sm text-red-700">{error}</p>}
        {audit && audit.links.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-500">Check another page:</span>
            <select
              className="max-w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              value=""
              disabled={running}
              onChange={(e) => e.target.value && run(e.target.value)}
              aria-label="Another page"
            >
              <option value="">Choose a page…</option>
              {audit.links.map((l) => (
                <option key={l} value={l}>
                  {l.replace(/^https?:\/\/(www\.)?[^/]+/, '') || '/'}
                </option>
              ))}
            </select>
          </div>
        )}
      </Card>

      {audit && (
        <>
          <Card title="Result" hint={`${audit.finalUrl} · checked ${when(audit.checkedAt)}`}>
            <div className="flex items-center gap-4">
              <ScoreRing score={audit.score} />
              <div className="space-y-1 text-sm">
                <p>{audit.summary}</p>
                {previous && (
                  <p className="text-slate-500">
                    Last time: {previous.score}/100 ({when(previous.created_at)})
                  </p>
                )}
                <p className="text-slate-500">
                  Phone speed:{' '}
                  {audit.speed.performance !== null
                    ? `${audit.speed.performance}/100${audit.speed.lcpSeconds !== null ? `, main content shows after ${audit.speed.lcpSeconds}s` : ''}`
                    : audit.speed.error ?? 'not measured'}
                </p>
              </div>
            </div>
          </Card>

          {audit.suggested && (audit.suggested.title || audit.suggested.description) && (
            <Card title="Suggested Google listing for this page" hint="How the page could appear in Google results. Paste these into your website’s SEO title and description fields.">
              <div className="rounded-lg border border-slate-200 p-3">
                <div className="truncate text-xs text-slate-500">{audit.finalUrl.replace(/^https?:\/\//, '')}</div>
                <div className="text-lg leading-snug text-[#1a0dab]">{audit.suggested.title}</div>
                <div className="text-sm text-slate-600">{audit.suggested.description}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <CopyButton text={audit.suggested.title} label="Copy title" />
                <CopyButton text={audit.suggested.description} label="Copy description" />
              </div>
            </Card>
          )}

          <Card title="To do" hint={audit.aiUsed ? 'Most valuable first, written for this page.' : 'Most valuable first.'}>
            {audit.todo.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing urgent on this page.</p>
            ) : (
              <ol className="space-y-4">
                {audit.todo.map((t, i) => (
                  <li key={i} className="space-y-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold uppercase ${PRIORITY[t.priority]}`}>{t.priority}</span>
                      <span className="font-semibold">{t.title}</span>
                    </div>
                    <p className="text-slate-500">{t.why}</p>
                    <p className="whitespace-pre-line text-slate-700">{t.how}</p>
                    {t.paste && (
                      <div className="space-y-1">
                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-xs text-slate-800">{t.paste}</pre>
                        <CopyButton text={t.paste} />
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card
            title="All checks"
            right={
              <button className="text-sm text-blue-600 hover:underline" onClick={() => setShowChecks(!showChecks)}>
                {showChecks ? 'Hide' : `Show ${audit.checks.length}`}
              </button>
            }
          >
            {showChecks && (
              <ul className="divide-y divide-slate-100">
                {audit.checks.map((c) => (
                  <li key={c.id} className="flex gap-3 py-2.5 text-sm">
                    <StatusDot status={c.status} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{c.label}</div>
                      <div className="break-words text-slate-500">{c.detail}</div>
                      {(c.status === 'fail' || c.status === 'warn') && <div className="mt-0.5 text-slate-700">{c.fix}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <SchemaCard data={data} onChanged={onChanged} />

      {data.audits.length > 0 && (
        <Card title="Earlier checks">
          <ul className="divide-y divide-slate-100 text-sm">
            {data.audits.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2">
                <span className={`w-10 text-right font-bold tabular-nums ${a.score >= 80 ? 'text-emerald-700' : a.score >= 50 ? 'text-amber-700' : 'text-red-700'}`}>{a.score}</span>
                <button className="min-w-0 flex-1 truncate text-left text-blue-600 hover:underline" onClick={() => api<Audit>(`/seo/audits/${a.id}`).then(setAudit)}>
                  {a.url.replace(/^https?:\/\/(www\.)?/, '')}
                </button>
                <span className="text-xs text-slate-500">{when(a.created_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function SchemaCard({ data, onChanged }: { data: Overview; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const save = async (body: { schemaInject?: boolean; businessType?: string }) => {
    setSaving(true);
    try {
      await api('/seo/settings', { method: 'PUT', body });
      onChanged();
    } finally {
      setSaving(false);
    }
  };
  const code = `<script type="application/ld+json">\n${JSON.stringify(data.schema, null, 2)}\n</script>`;
  return (
    <Card
      title="Business details for Google"
      hint="A hidden block on your website that tells Google your business type, address, phone and opening hours, so it can match your site to your Google listing. Built from Listings and updated when they change."
    >
      <label className="block text-sm">
        <span className="font-medium">Type of business</span>
        <select className={`${input} mt-1`} value={data.businessType} disabled={saving} onChange={(e) => save({ businessType: e.target.value })}>
          {data.businessTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1 h-4 w-4" checked={data.schemaInject} disabled={saving} onChange={(e) => save({ schemaInject: e.target.checked })} />
        <span>
          <span className="font-medium">Add business details to my website automatically</span>
          <span className="block text-slate-500">Through the ChatBird chat widget on your site. Skipped on pages that already have their own.</span>
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button className={btnLight} onClick={() => setShowCode(!showCode)}>
          {showCode ? 'Hide code' : 'Show code'}
        </button>
        <CopyButton text={code} label="Copy code to paste into the page head" />
        <a className={btnLight} href="https://search.google.com/test/rich-results" target="_blank" rel="noopener">
          Test with Google ↗
        </a>
      </div>
      {showCode && <pre className="max-h-72 overflow-auto rounded-md bg-slate-50 p-3 text-xs text-slate-800">{code}</pre>}
    </Card>
  );
}
