import { useEffect, useState } from 'react';
import { api, type Business } from '../api';

interface Totals {
  conversations: number;
  customerMessages: number;
  calls: number;
  missedCalls: number;
  voicemails: number;
  bookings: number;
  quotes: number;
  callbacks: number;
  forms: number;
}

interface Report {
  range: { from: string; to: string; days: number };
  previous: { from: string; to: string };
  today: string;
  scope: 'business' | 'all';
  totals: Totals;
  previousTotals: Totals;
  bySource: Record<string, number>;
  daily: { date: string; count: number }[];
  response: { measured: number; medianFirstAnswer: number | null; medianStaffReply: number | null; within5min: number; over1h: number; noReply: number };
  assistant: { answered: number; handedOver: number; since: string | null; questions: { body: string; at: string; conversationId: string; businessId: string; businessName: string }[] };
  heatmap: number[][];
  pages: { page: string; count: number }[];
  weeklyReport: boolean;
  emailAvailable: boolean;
}

interface Props {
  business: Business;
  businessCount: number;
  onOpenConversation: (businessId: string, conversationId: string) => void;
}

const PRESETS = [
  { label: 'Today', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
] as const;

const SOURCES: [string, string][] = [
  ['chat', 'Website chat'],
  ['sms', 'Text (SMS)'],
  ['call', 'Phone calls'],
  ['form', 'Website forms'],
  ['email', 'Email'],
  ['facebook', 'Facebook'],
  ['instagram', 'Instagram'],
];

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

function addDays(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function duration(seconds: number | null) {
  if (seconds === null) return '–';
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hr`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

/** "+25%" against the previous period, coloured by whether more is better. */
function Change({ now, before, moreIsGood = true }: { now: number; before: number; moreIsGood?: boolean }) {
  if (now === before) return <span className="text-slate-400">no change</span>;
  if (before === 0) return <span className="text-slate-500">up from 0</span>;
  const pct = Math.round(((now - before) / before) * 100);
  const good = pct > 0 === moreIsGood;
  return (
    <span className={good ? 'text-emerald-700' : 'text-red-700'}>
      {pct > 0 ? '▲' : '▼'} {Math.abs(pct)}%
    </span>
  );
}

function Tile({ label, value, sub, children }: { label: string; value: string | number; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs">{sub}</div>}
      {children}
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-white p-5 shadow-sm">
      <h2 className="font-semibold">{title}</h2>
      {hint && <p className="mb-3 text-sm text-slate-500">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

export default function Reports({ business, businessCount, onOpenConversation }: Props) {
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [preset, setPreset] = useState<number | 'custom'>(7);
  const [scope, setScope] = useState<'business' | 'all'>('business');
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError('');
    const q = new URLSearchParams({ scope, ...(range ?? {}) });
    api<Report>(`/reports?${q}`)
      .then((d) => {
        setData(d);
        if (!range) setRange({ from: d.range.from, to: d.range.to });
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [range?.from, range?.to, scope]);

  const choosePreset = (days: number) => {
    if (!data) return;
    setPreset(days);
    setRange({ from: addDays(data.today, -(days - 1)), to: data.today });
  };

  if (!data) return <div className="flex h-full items-center justify-center text-sm text-slate-400">{error || 'Loading…'}</div>;
  const t = data.totals, p = data.previousTotals;
  const r = data.response;
  const assistantTotal = data.assistant.answered + data.assistant.handedOver;

  return (
    <div className="h-full overflow-y-auto">
      <div className={`mx-auto max-w-4xl space-y-5 px-4 py-6 md:px-6 md:py-8 ${loading ? 'opacity-60' : ''}`}>
        <div>
          <h1 className="text-xl font-semibold">Reports</h1>
          <p className="text-sm text-slate-500">
            {data.scope === 'all' ? 'All your businesses' : business.name} · {data.range.days === 1 ? longDate(data.range.from) : `${shortDate(data.range.from)} – ${shortDate(data.range.to)}`}, compared with the{' '}
            {data.range.days === 1 ? 'day' : `${data.range.days} days`} before
          </p>
        </div>

        {/* Filters: one row */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex w-full rounded-md bg-white p-1 text-sm shadow-sm sm:w-auto">
            {PRESETS.map((x) => (
              <button
                key={x.days}
                onClick={() => choosePreset(x.days)}
                className={`flex-1 whitespace-nowrap rounded px-2 py-1.5 sm:px-3 ${preset === x.days ? 'bg-slate-900 font-medium text-white' : 'text-slate-600'}`}
              >
                {x.label}
              </button>
            ))}
            <button onClick={() => setPreset('custom')} className={`flex-1 whitespace-nowrap rounded px-2 py-1.5 sm:px-3 ${preset === 'custom' ? 'bg-slate-900 font-medium text-white' : 'text-slate-600'}`}>
              Custom
            </button>
          </div>
          {preset === 'custom' && range && (
            <div className="flex items-center gap-1 text-sm">
              <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} className="rounded-md border border-slate-300 px-2 py-1.5" aria-label="From" />
              <span className="text-slate-400">to</span>
              <input type="date" value={range.to} min={range.from} max={data.today} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} className="rounded-md border border-slate-300 px-2 py-1.5" aria-label="To" />
            </div>
          )}
          {businessCount > 1 && (
            <div className="flex rounded-md bg-white p-1 text-sm shadow-sm md:ml-auto">
              {(['business', 'all'] as const).map((s) => (
                <button key={s} onClick={() => setScope(s)} className={`rounded px-3 py-1.5 ${scope === s ? 'bg-slate-900 font-medium text-white' : 'text-slate-600'}`}>
                  {s === 'business' ? 'This business' : 'All businesses'}
                </button>
              ))}
            </div>
          )}
        </div>
        {error && <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Tile label="New conversations" value={t.conversations} sub={<Change now={t.conversations} before={p.conversations} />} />
          <Tile label="Customer messages" value={t.customerMessages} sub={<Change now={t.customerMessages} before={p.customerMessages} />} />
          <Tile
            label="Calls"
            value={t.calls}
            sub={<span className="text-slate-500">{t.missedCalls} missed · {t.voicemails} voicemail{t.voicemails === 1 ? '' : 's'}</span>}
          />
          <Tile label="Bookings" value={t.bookings} sub={<Change now={t.bookings} before={p.bookings} />} />
          <Tile label="Quote requests" value={t.quotes} sub={<Change now={t.quotes} before={p.quotes} />} />
          <Tile label="Call-back requests" value={t.callbacks} sub={t.forms ? <span className="text-slate-500">+ {t.forms} other website form{t.forms === 1 ? '' : 's'}</span> : <Change now={t.callbacks} before={p.callbacks} />} />
        </div>

        {data.daily.length > 1 && <DailyChart daily={data.daily} />}

        <div className="grid gap-5 md:grid-cols-2">
          <Card title="Where they came from" hint="New conversations by how the customer first got in touch.">
            <SourceBars bySource={data.bySource} />
          </Card>

          <Card title="Response time" hint="From the customer’s first message to the first real answer. Missed calls aren’t counted (you usually ring back).">
            {r.measured === 0 ? (
              <p className="text-sm text-slate-400">No customer conversations in this period.</p>
            ) : (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-slate-500">First answer (you or assistant)</dt>
                  <dd className="text-xl font-bold tabular-nums">{duration(r.medianFirstAnswer)}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Your first reply</dt>
                  <dd className="text-xl font-bold tabular-nums">{duration(r.medianStaffReply)}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Answered within 5 min</dt>
                  <dd className="text-xl font-bold tabular-nums">{Math.round((r.within5min / r.measured) * 100)}%</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Waited over an hour</dt>
                  <dd className={`text-xl font-bold tabular-nums ${r.over1h ? 'text-amber-700' : ''}`}>{r.over1h}</dd>
                </div>
                <div className="col-span-2 text-xs text-slate-500">
                  Typical = the middle value. {r.noReply > 0 ? `${r.noReply} of ${r.measured} still have no answer.` : `All ${r.measured} got an answer.`}
                </div>
              </dl>
            )}
          </Card>
        </div>

        <Card
          title="AI assistant"
          hint={data.assistant.since ? 'Questions it answered from your FAQs, and the ones it passed to you. Add the missed ones to your FAQs.' : 'Counting starts when the assistant replies to its first customer.'}
        >
          {assistantTotal === 0 ? (
            <p className="text-sm text-slate-400">No questions for the assistant in this period.</p>
          ) : (
            <>
              <div className="flex items-baseline gap-6 text-sm">
                <div>
                  <span className="text-2xl font-bold tabular-nums">{data.assistant.answered}</span> <span className="text-slate-500">answered</span>
                </div>
                <div>
                  <span className="text-2xl font-bold tabular-nums">{data.assistant.handedOver}</span> <span className="text-slate-500">passed to you</span>
                </div>
                <div className="ml-auto text-slate-500">{Math.round((data.assistant.answered / assistantTotal) * 100)}% answered</div>
              </div>
              <div className="mt-2 flex h-2.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${data.assistant.answered} answered, ${data.assistant.handedOver} passed to you`}>
                {data.assistant.answered > 0 && <div className="rounded-l-full bg-violet-600" style={{ width: `${(data.assistant.answered / assistantTotal) * 100}%` }} />}
                {data.assistant.handedOver > 0 && <div className="rounded-r-full bg-slate-300" style={{ width: `${(data.assistant.handedOver / assistantTotal) * 100}%` }} />}
              </div>
              {data.assistant.questions.length > 0 && (
                <>
                  <h3 className="mb-1 mt-4 text-sm font-medium">Questions it couldn’t answer</h3>
                  <ul className="divide-y divide-slate-100 text-sm">
                    {data.assistant.questions.map((q, i) => (
                      <li key={i}>
                        <button onClick={() => onOpenConversation(q.businessId, q.conversationId)} className="flex w-full items-start gap-3 py-2 text-left hover:bg-slate-50">
                          <span className="flex-1">{q.body}</span>
                          <span className="shrink-0 text-xs text-slate-400">
                            {data.scope === 'all' && `${q.businessName} · `}
                            {new Date(q.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </Card>

        <Heatmap heatmap={data.heatmap} />

        <Card title="Top pages for enquiries" hint="The website page customers were on when they started a chat or sent a form.">
          {data.pages.length === 0 ? (
            <p className="text-sm text-slate-400">No website enquiries in this period.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {data.pages.map((x) => (
                  <tr key={x.page}>
                    <td className="max-w-0 truncate py-1.5 pr-3" title={x.page}>{x.page}</td>
                    <td className="w-12 py-1.5 text-right tabular-nums">{x.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <WeeklyEmail initial={data.weeklyReport} emailAvailable={data.emailAvailable} businessName={business.name} />
      </div>
    </div>
  );
}

/** New conversations per day: one series, so no legend; hover or tap a bar for its value. */
function DailyChart({ daily }: { daily: { date: string; count: number }[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...daily.map((d) => d.count));
  const total = daily.reduce((n, d) => n + d.count, 0);
  const shown = active !== null ? daily[active] : null;
  // A few date labels along the bottom, never crowded.
  const step = Math.ceil(daily.length / 6);
  return (
    <section className="rounded-xl bg-white p-5 shadow-sm">
      <div className="flex items-baseline gap-2">
        <h2 className="font-semibold">New conversations per day</h2>
        <button onClick={() => setTable(!table)} className="ml-auto text-xs text-blue-600 hover:underline">
          {table ? 'Show chart' : 'Show table'}
        </button>
      </div>
      <p className="mb-3 h-5 text-sm text-slate-500">
        {shown ? (
          <>
            <b className="text-slate-900">{shown.count}</b> on {longDate(shown.date)}
          </>
        ) : (
          `${total} in total · busiest day ${Math.max(...daily.map((d) => d.count))}`
        )}
      </p>
      {table ? (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {daily.map((d) => (
                <tr key={d.date}>
                  <td className="py-1">{longDate(d.date)}</td>
                  <td className="py-1 text-right tabular-nums">{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="relative flex h-36 items-end gap-0.5 border-b border-slate-200" onMouseLeave={() => setActive(null)}>
            {daily.map((d, i) => (
              <button
                key={d.date}
                type="button"
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onClick={() => setActive(i)}
                aria-label={`${longDate(d.date)}: ${d.count}`}
                className="group flex h-full flex-1 items-end"
              >
                <span
                  className={`w-full rounded-t ${active === i ? 'bg-blue-800' : 'bg-blue-600'} ${d.count === 0 ? 'opacity-0' : ''}`}
                  style={{ height: `${Math.max((d.count / max) * 100, d.count ? 3 : 0)}%` }}
                />
              </button>
            ))}
          </div>
          <div className="relative mt-1 h-4 text-[11px] text-slate-400">
            {daily.map((d, i) =>
              i % step === 0 ? (
                <span key={d.date} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((i + 0.5) / daily.length) * 100}%` }}>
                  {shortDate(d.date)}
                </span>
              ) : null,
            )}
          </div>
        </>
      )}
    </section>
  );
}

function SourceBars({ bySource }: { bySource: Record<string, number> }) {
  const rows = SOURCES.map(([key, label]) => ({ key, label, n: bySource[key] ?? 0 })).filter((r) => r.n > 0 || ['chat', 'sms', 'call', 'form'].includes(r.key));
  const max = Math.max(1, ...rows.map((r) => r.n));
  const total = rows.reduce((n, r) => n + r.n, 0);
  return (
    <ul className="space-y-2 text-sm">
      {rows.map((r) => (
        <li key={r.key} title={`${r.label}: ${r.n}${total ? ` (${Math.round((r.n / total) * 100)}%)` : ''}`}>
          <div className="flex justify-between">
            <span>{r.label}</span>
            <span className="tabular-nums text-slate-600">
              {r.n}
              {total > 0 && <span className="ml-1 text-xs text-slate-400">{Math.round((r.n / total) * 100)}%</span>}
            </span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-slate-100">
            <div className="h-2 rounded-full bg-blue-600" style={{ width: `${(r.n / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// One hue, light to dark: more messages, darker cell.
const HEAT = ['#f1f5f9', '#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8', '#1e3a8a'];

function Heatmap({ heatmap }: { heatmap: number[][] }) {
  const [active, setActive] = useState<{ day: number; hour: number } | null>(null);
  const max = Math.max(0, ...heatmap.flat());
  const shade = (n: number) => (n === 0 ? HEAT[0] : HEAT[Math.min(HEAT.length - 1, 1 + Math.floor((n / max) * (HEAT.length - 1.01)))]);
  const busiest = heatmap.flatMap((hours, day) => hours.map((n, hour) => ({ n, day, hour }))).sort((a, b) => b.n - a.n)[0];
  const shown = active ? heatmap[active.day][active.hour] : null;
  return (
    <Card title="Busiest times" hint="Customer messages by day and hour, in your business’s time. Darker = busier.">
      <p className="mb-2 h-5 text-sm text-slate-500">
        {active ? (
          <>
            <b className="text-slate-900">{shown}</b> message{shown === 1 ? '' : 's'} on {WEEKDAYS[active.day]}s, {hourLabel(active.hour)}–{hourLabel((active.hour + 1) % 24)}
          </>
        ) : max > 0 ? (
          `Busiest: ${WEEKDAYS[busiest.day]} ${hourLabel(busiest.hour)}–${hourLabel((busiest.hour + 1) % 24)} (${busiest.n})`
        ) : (
          'No customer messages in this period.'
        )}
      </p>
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: '2.25rem repeat(24, minmax(0, 1fr))' }} onMouseLeave={() => setActive(null)}>
        {heatmap.map((hours, day) => (
          <div key={day} className="contents">
            <div className="pr-1 text-[11px] leading-5 text-slate-500">{WEEKDAYS[day]}</div>
            {hours.map((n, hour) => (
              <button
                key={hour}
                type="button"
                onMouseEnter={() => setActive({ day, hour })}
                onFocus={() => setActive({ day, hour })}
                onClick={() => setActive({ day, hour })}
                aria-label={`${WEEKDAYS[day]} ${hourLabel(hour)}: ${n}`}
                className={`h-5 rounded-[3px] ${active?.day === day && active.hour === hour ? 'ring-2 ring-slate-900' : ''}`}
                style={{ background: shade(n) }}
              />
            ))}
          </div>
        ))}
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="text-center text-[10px] text-slate-400">
            {h % 6 === 0 ? hourLabel(h) : ''}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[11px] text-slate-500">
        Quiet
        {HEAT.map((c) => (
          <span key={c} className="h-3 w-3 rounded-[3px]" style={{ background: c }} />
        ))}
        Busy
      </div>
    </Card>
  );
}

function WeeklyEmail({ initial, emailAvailable, businessName }: { initial: boolean; emailAvailable: boolean; businessName: string }) {
  const [on, setOn] = useState(initial);
  const [status, setStatus] = useState('');
  const toggle = async (value: boolean) => {
    setOn(value);
    setStatus('');
    try {
      await api('/reports/settings', { method: 'PATCH', body: { weeklyReport: value } });
      setStatus(value ? 'On: the first one arrives next Monday morning.' : 'Off.');
    } catch (err) {
      setOn(!value);
      setStatus((err as Error).message);
    }
  };
  const test = async () => {
    setStatus('Sending…');
    try {
      await api('/reports/weekly/test', { method: 'POST' });
      setStatus('Sent. Check your inbox.');
    } catch (err) {
      setStatus((err as Error).message);
    }
  };
  return (
    <Card title="Weekly email" hint={`Last week’s numbers for ${businessName}, emailed to everyone on the team every Monday at 8am.`}>
      {!emailAvailable && <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Needs email set up under Integrations → Server keys.</p>}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
          Email me a weekly summary
        </label>
        {emailAvailable && (
          <button onClick={test} className="text-blue-600 hover:underline">
            Send one now
          </button>
        )}
        {status && <span className="text-slate-500">{status}</span>}
      </div>
    </Card>
  );
}
