import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';

interface Settings {
  mode: 'off' | 'always' | 'after_hours' | 'no_answer';
  greeting: string;
  voice: string;
  handoffNumber: string | null;
  urgentNumber: string | null;
  notes: string;
  pricingMode: 'off' | 'from' | 'exact';
  pricingRules: string;
  priceMaxAgeDays: number;
}

interface Price {
  id: string;
  model: string;
  service: string;
  price: string;
  updatedAt: string;
  expired: boolean;
}

interface Data {
  settings: Settings;
  smsNumber: string | null;
  forwardNumber: string | null;
  hoursEnabled: boolean;
  voices: { id: string; label: string }[];
  aiAvailable: boolean;
  prices: Price[];
}

const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';
const label = 'mb-1 block text-sm font-medium text-slate-700';
const primary = 'rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60';

const MODES: { value: Settings['mode']; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Calls ring your mobile, then go to voicemail, as now.' },
  { value: 'no_answer', label: 'When nobody answers', hint: 'Rings your mobile first; the receptionist picks up if you don’t, and answers outside opening hours. Recommended.' },
  { value: 'after_hours', label: 'Only outside opening hours', hint: 'You take calls while the shop is open. Needs office hours turned on.' },
  { value: 'always', label: 'Every call', hint: 'The receptionist answers straight away and puts callers through to you when needed.' },
];

const PRICING: { value: Settings['pricingMode']; label: string; hint: string }[] = [
  { value: 'off', label: 'Never give prices', hint: 'Offers to text a quote instead.' },
  { value: 'from', label: '“From” prices', hint: 'Says “from $X” using your price list only, as an estimate.' },
  { value: 'exact', label: 'Exact prices', hint: 'Quotes your price list exactly, only for the models and repairs listed.' },
];

function Card({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

export default function ReceptionistSection() {
  const [data, setData] = useState<Data | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<Data>('/receptionist')
      .then((d) => {
        setData(d);
        setForm((f) => f ?? d.settings);
      })
      .catch((err) => setStatus({ ok: false, text: err.message }));
  useEffect(() => {
    load();
  }, []);

  if (!data || !form) {
    return status && !status.ok ? (
      <Card title="AI phone receptionist">
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">Couldn’t load this setting: {status.text}</p>
      </Card>
    ) : null;
  }

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const r = await api<{ settings: Settings }>('/receptionist/settings', { method: 'PATCH', body: form });
      setForm(r.settings);
      setStatus({ ok: true, text: 'Saved' });
      load();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const warnings = [
    !data.aiAvailable && 'Needs ANTHROPIC_API_KEY under Integrations → Server keys.',
    !data.smsNumber && 'Add your Twilio number in Settings → Phone calls & voicemail first.',
    form.mode === 'after_hours' && !data.hoursEnabled && 'Turn on office hours, or the receptionist never answers in this mode.',
    form.mode === 'no_answer' && !data.forwardNumber && 'No mobile to ring first (Phone calls & voicemail), so the receptionist will answer every call.',
    form.mode !== 'off' && !form.handoffNumber && 'Add a transfer number so callers who ask for a person can be put through.',
  ].filter(Boolean) as string[];

  return (
    <>
      <form onSubmit={save}>
        <Card
          title="AI phone receptionist"
          description="Answers calls in a natural Australian voice using your FAQs, notes and opening hours. Takes bookings and messages, puts callers through to you, and falls back to voicemail if anything goes wrong. Every call appears in your inbox with a transcript."
        >
          {warnings.map((w) => (
            <p key={w} className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {w}
            </p>
          ))}
          <fieldset className="space-y-2">
            <legend className={label}>When it answers</legend>
            {MODES.map((m) => (
              <label key={m.value} className="flex cursor-pointer items-start gap-2 text-sm">
                <input type="radio" name="receptionistMode" className="mt-0.5" checked={form.mode === m.value} onChange={() => setForm({ ...form, mode: m.value })} />
                <span>
                  <span className="font-medium">{m.label}</span> <span className="text-slate-500">· {m.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className={label} htmlFor="rgreet">Greeting</label>
              <input id="rgreet" className={input} value={form.greeting} maxLength={300} onChange={(e) => setForm({ ...form, greeting: e.target.value })} />
              <p className="mt-1 text-xs text-slate-500">{'{business}'} is replaced by your business name. Keep “virtual assistant” in it so callers know.</p>
            </div>
            <div>
              <label className={label} htmlFor="rvoice">Voice</label>
              <select id="rvoice" className={input} value={form.voice} onChange={(e) => setForm({ ...form, voice: e.target.value })}>
                {data.voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="rhand">Put callers through to (your mobile)</label>
              <input id="rhand" className={input} placeholder="e.g. 0431 618 100" value={form.handoffNumber ?? ''} onChange={(e) => setForm({ ...form, handoffNumber: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="rurg">Urgent after-hours repairs (optional)</label>
              <input id="rurg" className={input} placeholder="Leave empty to take a message instead" value={form.urgentNumber ?? ''} onChange={(e) => setForm({ ...form, urgentNumber: e.target.value })} />
            </div>
          </div>
          <div>
            <label className={label} htmlFor="rnotes">Extra instructions (optional)</label>
            <textarea id="rnotes" className={`${input} min-h-20`} maxLength={3000} placeholder="e.g. Most screen repairs take 30–45 minutes. We don’t repair game consoles." value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <p className="mt-1 text-xs text-slate-500">It also uses your business information and FAQs from the AI assistant above, so update answers there once for chat, text and phone.</p>
          </div>

          <fieldset className="space-y-2 border-t border-slate-100 pt-4">
            <legend className={label}>Prices on the phone</legend>
            {PRICING.map((p) => (
              <label key={p.value} className="flex cursor-pointer items-start gap-2 text-sm">
                <input type="radio" name="pricingMode" className="mt-0.5" checked={form.pricingMode === p.value} onChange={() => setForm({ ...form, pricingMode: p.value })} />
                <span>
                  <span className="font-medium">{p.label}</span> <span className="text-slate-500">· {p.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {form.pricingMode !== 'off' && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className={label} htmlFor="rrules">Pricing rules it must follow</label>
                <textarea id="rrules" className={`${input} min-h-20`} maxLength={2000} value={form.pricingRules} onChange={(e) => setForm({ ...form, pricingRules: e.target.value })} />
              </div>
              <div>
                <label className={label} htmlFor="rage">Stop using a price after (days)</label>
                <input id="rage" type="number" min={1} max={365} className={input} value={form.priceMaxAgeDays} onChange={(e) => setForm({ ...form, priceMaxAgeDays: Number(e.target.value) })} />
                <p className="mt-1 text-xs text-slate-500">Prices not checked within this time aren’t quoted, so old prices never slip out.</p>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3">
            <button disabled={busy} className={primary}>
              Save
            </button>
            {status && <span className={`text-sm ${status.ok ? 'text-emerald-700' : 'text-red-700'}`}>{status.text}</span>}
          </div>
        </Card>
      </form>
      {form.pricingMode !== 'off' && <PriceList prices={data.prices} maxAge={form.priceMaxAgeDays} onChanged={load} />}
      <TryIt available={data.aiAvailable} />
    </>
  );
}

function PriceList({ prices, maxAge, onChanged }: { prices: Price[]; maxAge: number; onChanged: () => void }) {
  const [row, setRow] = useState({ model: '', service: '', price: '' });
  const [paste, setPaste] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const expired = prices.filter((p) => p.expired).length;

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    setNote('');
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    act(async () => {
      await api('/receptionist/prices', { method: 'POST', body: row });
      setRow({ model: '', service: '', price: '' });
    });
  };

  return (
    <Card title="Price list" description={`The only prices the receptionist may give. Prices older than ${maxAge} days are skipped until you confirm them.`}>
      {expired > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {expired} price{expired === 1 ? ' is' : 's are'} out of date and won’t be quoted.
          <button type="button" onClick={() => act(() => api('/receptionist/prices/confirm', { method: 'POST' }))} className="font-semibold underline">
            All still correct
          </button>
        </div>
      )}
      <form onSubmit={add} className="grid gap-2 sm:grid-cols-[1fr_1fr_8rem_auto]">
        <input className={input} placeholder="Model, e.g. iPhone 13" aria-label="Model" value={row.model} onChange={(e) => setRow({ ...row, model: e.target.value })} />
        <input className={input} placeholder="Repair, e.g. Screen" aria-label="Repair" value={row.service} onChange={(e) => setRow({ ...row, service: e.target.value })} />
        <input className={input} placeholder="$189" aria-label="Price" value={row.price} onChange={(e) => setRow({ ...row, price: e.target.value })} />
        <button className={primary}>Add</button>
      </form>
      {prices.length > 0 && (
        <div className="max-h-80 overflow-auto rounded-md border border-slate-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Repair</th>
                <th className="px-3 py-2 font-medium">Price</th>
                <th className="px-3 py-2 font-medium">Checked</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {prices.map((p) => (
                <tr key={p.id} className={p.expired ? 'text-slate-400' : ''}>
                  <td className="px-3 py-1.5">{p.model}</td>
                  <td className="px-3 py-1.5">{p.service}</td>
                  <td className="px-3 py-1.5 tabular-nums">{p.price}</td>
                  <td className="px-3 py-1.5 text-xs">{p.expired ? 'Out of date' : new Date(p.updatedAt).toLocaleDateString()}</td>
                  <td className="px-3 py-1.5 text-right">
                    <button type="button" onClick={() => act(() => api(`/receptionist/prices/${p.id}`, { method: 'DELETE' }))} className="text-xs text-red-600 hover:underline">
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-blue-600">Paste many at once</summary>
        <textarea className={`${input} mt-2 min-h-24`} placeholder={'iPhone 13, Screen, $189\niPhone 13, Battery, $99\nGalaxy S22, Screen, $249'} value={paste} onChange={(e) => setPaste(e.target.value)} />
        <p className="mt-1 text-xs text-slate-500">One per line: model, repair, price. Copying three columns from a spreadsheet works too. The same model and repair updates the price.</p>
        <button
          type="button"
          disabled={!paste.trim()}
          onClick={() =>
            act(async () => {
              const r = await api<{ added: number; updated: number }>('/receptionist/prices/import', { method: 'POST', body: { text: paste } });
              setPaste('');
              setNote(`${r.added} added, ${r.updated} updated.`);
            })
          }
          className="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Add these
        </button>
      </details>
      {note && <p className="text-sm text-emerald-700">{note}</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </Card>
  );
}

function TryIt({ available }: { available: boolean }) {
  const [turns, setTurns] = useState<{ role: 'caller' | 'receptionist'; text: string; actions?: string[] }[]>([]);
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!line.trim()) return;
    const next = [...turns, { role: 'caller' as const, text: line.trim() }];
    setTurns(next);
    setLine('');
    setBusy(true);
    setError('');
    try {
      const r = await api<{ reply: string; actions: string[]; ends: string | null }>('/receptionist/test', {
        method: 'POST',
        body: { turns: next.map((t) => ({ role: t.role, text: t.text })) },
      });
      const actions = [...r.actions, ...(r.ends === 'hangup' ? ['Hangs up'] : [])];
      setTurns([...next, { role: 'receptionist', text: r.reply || '(says nothing)', actions }]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Try the receptionist" description="Type what a caller would say. You’ll see its reply and anything it would do. Nothing is saved or sent.">
      <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm">
        {turns.length === 0 && <p className="text-slate-400">e.g. “How much is an iPhone 13 screen?” or “Can I book in for Saturday morning?”</p>}
        {turns.map((t, i) => (
          <div key={i} className={t.role === 'caller' ? 'text-right' : ''}>
            <span className={`inline-block max-w-[85%] rounded-2xl px-3 py-2 ${t.role === 'caller' ? 'bg-blue-600 text-white' : 'border border-slate-200 bg-white'}`}>{t.text}</span>
            {t.actions?.map((a) => (
              <div key={a} className="mt-1 text-xs font-medium text-blue-700">
                Would do: {a}
              </div>
            ))}
          </div>
        ))}
        {busy && <p className="text-slate-400">…</p>}
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <form onSubmit={send} className="flex gap-2">
        <input className={input} placeholder="What the caller says" aria-label="What the caller says" value={line} onChange={(e) => setLine(e.target.value)} disabled={!available} />
        <button disabled={busy || !available} className={primary}>
          Say
        </button>
        {turns.length > 0 && (
          <button type="button" onClick={() => setTurns([])} className="text-sm text-slate-500 hover:underline">
            Start over
          </button>
        )}
      </form>
    </Card>
  );
}
