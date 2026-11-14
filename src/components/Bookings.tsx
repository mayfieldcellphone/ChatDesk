import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';

export interface Appointment {
  id: string;
  conversationId: string;
  startsAt: string | null;
  whenText: string;
  device: string;
  service: string;
  status: 'booked' | 'confirmed' | 'arrived' | 'no_show' | 'cancelled';
  source: string;
  remindedDayBefore: boolean;
  remindedSoon: boolean;
  noShowTexted: boolean;
  createdAt: string;
  contactName?: string;
  contactPhone?: string | null;
}

interface Settings {
  reminders: boolean;
  dayBeforeText: string;
  soonText: string;
  noShowAuto: boolean;
  noShowText: string;
}

const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';
const STATUS: Record<Appointment['status'], [string, string]> = {
  booked: ['Booked', 'bg-blue-100 text-blue-800'],
  confirmed: ['Confirmed ✓', 'bg-emerald-100 text-emerald-800'],
  arrived: ['Arrived', 'bg-slate-200 text-slate-700'],
  no_show: ['No-show', 'bg-red-100 text-red-700'],
  cancelled: ['Cancelled', 'bg-slate-100 text-slate-500'],
};

export const when = (a: Appointment) =>
  a.startsAt
    ? new Date(a.startsAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : a.whenText
      ? `“${a.whenText}” (time not set)`
      : 'Time not set';

const localParts = (iso: string | null) => {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
};

/** Status, reminder state and the buttons to change it: used on the Bookings page and in a conversation. */
export function BookingCard({ appointment, onChanged, showContact, onOpen }: { appointment: Appointment; onChanged: (a: Appointment | null) => void; showContact?: boolean; onOpen?: () => void }) {
  const [editing, setEditing] = useState(!appointment.startsAt && ['booked', 'confirmed'].includes(appointment.status));
  const [form, setForm] = useState({ ...localParts(appointment.startsAt), device: appointment.device });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = appointment.status === 'booked' || appointment.status === 'confirmed';
  const past = appointment.startsAt ? Date.parse(appointment.startsAt) < Date.now() : false;

  const update = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ appointment: Appointment }>(`/bookings/${appointment.id}`, { method: 'PATCH', body });
      onChanged({ ...appointment, ...r.appointment });
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const noShow = async () => {
    const text = confirm('Mark as a no-show and text them a friendly “want to rebook?” message?\n\nOK = mark and text · Cancel = choose again');
    if (!text && !confirm('Mark as a no-show without texting them?')) return;
    setBusy(true);
    try {
      const r = await api<{ appointment: Appointment }>(`/bookings/${appointment.id}/no-show`, { method: 'POST', body: { text } });
      onChanged({ ...appointment, ...r.appointment });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const [label, colour] = STATUS[appointment.status];
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">📅 {when(appointment)}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colour}`}>{label}</span>
        {showContact && (
          <button onClick={onOpen} className="font-medium text-blue-600 hover:underline">
            {appointment.contactName}
          </button>
        )}
        {(appointment.device || appointment.service) && <span className="text-slate-600">· {[appointment.device, appointment.service].filter(Boolean).join(', ')}</span>}
      </div>
      {active && appointment.startsAt && (
        <div className="text-xs text-slate-500">
          {[
            appointment.remindedDayBefore
              ? '✓ Reminded the day before'
              : new Date(appointment.startsAt).toDateString() !== new Date().toDateString() && 'Reminder goes the evening before',
            appointment.remindedSoon ? '✓ reminded 2 hours before' : Date.parse(appointment.startsAt) > Date.now() && 'another 2 hours before',
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      {editing ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            update({ date: form.date, time: form.time, device: form.device });
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="rounded border border-slate-300 px-2 py-1" />
          <input type="time" required value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} className="rounded border border-slate-300 px-2 py-1" />
          <input value={form.device} onChange={(e) => setForm({ ...form, device: e.target.value })} placeholder="Device" className="w-36 rounded border border-slate-300 px-2 py-1" />
          <button disabled={busy} className="rounded-md bg-blue-600 px-3 py-1 font-semibold text-white disabled:opacity-50">
            Save time
          </button>
          {appointment.startsAt && (
            <button type="button" onClick={() => setEditing(false)} className="text-slate-500 hover:underline">
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {active && (
            <>
              {past && (
                <button disabled={busy} onClick={() => update({ status: 'arrived' })} className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white">
                  ✓ Arrived
                </button>
              )}
              {!past && appointment.status === 'booked' && (
                <button disabled={busy} onClick={() => update({ status: 'confirmed' })} className="rounded-md border border-emerald-300 px-3 py-1 text-xs text-emerald-800">
                  Mark confirmed
                </button>
              )}
              {past && (
                <button disabled={busy} onClick={noShow} className="rounded-md border border-red-300 px-3 py-1 text-xs text-red-700">
                  No-show…
                </button>
              )}
              <button onClick={() => setEditing(true)} className="rounded-md border border-slate-300 px-3 py-1 text-xs">
                Change time
              </button>
              <button disabled={busy} onClick={() => confirm('Cancel this booking? No more reminders will be sent.') && update({ status: 'cancelled' })} className="px-1 text-xs text-slate-500 hover:underline">
                Cancel booking
              </button>
            </>
          )}
          {!active && appointment.status !== 'cancelled' && (
            <button disabled={busy} onClick={() => update({ status: 'booked' })} className="px-1 text-xs text-slate-500 hover:underline">
              Undo
            </button>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** Adds a booking to a conversation (e.g. agreed on the phone). */
export function NewBooking({ conversationId, onAdded, onCancel }: { conversationId: string; onAdded: (a: Appointment) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ date: '', time: '', device: '' });
  const [error, setError] = useState('');
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const r = await api<{ appointment: Appointment }>('/bookings', { method: 'POST', body: { conversationId, ...form } });
          onAdded(r.appointment);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <span className="font-medium">📅 New booking</span>
      <input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="rounded border border-slate-300 px-2 py-1" />
      <input type="time" required value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} className="rounded border border-slate-300 px-2 py-1" />
      <input value={form.device} onChange={(e) => setForm({ ...form, device: e.target.value })} placeholder="Device, e.g. iPhone 13" className="w-44 rounded border border-slate-300 px-2 py-1" />
      <button className="rounded-md bg-blue-600 px-3 py-1 font-semibold text-white">Save</button>
      <button type="button" onClick={onCancel} className="text-slate-500 hover:underline">
        Cancel
      </button>
      {error && <span className="text-red-600">{error}</span>}
    </form>
  );
}

export default function Bookings({ onOpenConversation }: { onOpenConversation: (conversationId: string) => void }) {
  const [data, setData] = useState<{ appointments: Appointment[]; settings: Settings; stats: { arrived: number; no_show: number; confirmed: number; total: number } } | null>(null);
  const [error, setError] = useState('');
  const load = () => api<NonNullable<typeof data>>('/bookings').then(setData).catch((err) => setError((err as Error).message));
  useEffect(() => {
    load();
  }, []);
  if (!data) return <div className="p-8 text-sm text-slate-400">{error || 'Loading…'}</div>;

  const nowMs = Date.now();
  const startOfTomorrow = new Date();
  startOfTomorrow.setHours(24, 0, 0, 0);
  const active = (a: Appointment) => a.status === 'booked' || a.status === 'confirmed';
  const groups: [string, string, Appointment[]][] = [
    ['Did they come?', 'Past bookings still waiting for Arrived or No-show.', data.appointments.filter((a) => active(a) && a.startsAt && Date.parse(a.startsAt) < nowMs)],
    ['Needs a time', 'Bookings without a set date and time get no reminders. Set one to turn reminders on.', data.appointments.filter((a) => active(a) && !a.startsAt)],
    ['Today', '', data.appointments.filter((a) => active(a) && a.startsAt && Date.parse(a.startsAt) >= nowMs && Date.parse(a.startsAt) < startOfTomorrow.getTime())],
    ['Coming up', '', data.appointments.filter((a) => active(a) && a.startsAt && Date.parse(a.startsAt) >= startOfTomorrow.getTime())],
    ['Recent outcomes', '', data.appointments.filter((a) => !active(a)).slice(-20).reverse()],
  ];
  const s = data.stats;
  const decided = s.arrived + s.no_show;
  const change = (a: Appointment | null) => a && setData({ ...data, appointments: data.appointments.map((x) => (x.id === a.id ? { ...x, ...a } : x)) });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 p-4 md:p-8">
        <div>
          <h1 className="text-xl font-semibold">Bookings</h1>
          <p className="mt-1 text-sm text-slate-500">
            Bookings from your website, the AI receptionist and ones you add in a conversation. Customers get a reminder the evening before and 2 hours before, and can reply C to
            confirm or R to change it.
          </p>
        </div>
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Bookings (last 30 days)', s.total],
            ['Confirmed by reply', s.confirmed],
            ['Arrived', s.arrived],
            ['No-show rate', decided ? `${Math.round((s.no_show / decided) * 100)}%` : '–'],
          ].map(([l, v]) => (
            <div key={l as string} className="rounded-xl bg-white p-4 shadow-sm">
              <div className="text-2xl font-bold tabular-nums">{v}</div>
              <div className="text-xs text-slate-500">{l}</div>
            </div>
          ))}
        </section>
        {groups.map(([title, hint, list]) =>
          list.length === 0 ? null : (
            <section key={title} className="space-y-3 rounded-xl bg-white p-5 shadow-sm">
              <div>
                <h2 className="font-semibold">
                  {title} <span className="font-normal text-slate-400">({list.length})</span>
                </h2>
                {hint && <p className="text-sm text-slate-500">{hint}</p>}
              </div>
              <ul className="divide-y divide-slate-100">
                {list.map((a) => (
                  <li key={a.id} className="py-3">
                    <BookingCard appointment={a} showContact onOpen={() => onOpenConversation(a.conversationId)} onChanged={change} />
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}
        {data.appointments.length === 0 && <p className="rounded-xl bg-white p-6 text-sm text-slate-500 shadow-sm">No bookings yet. They appear here from your website, the AI receptionist, or 📅 Booking in a conversation.</p>}
        <ReminderSettings initial={data.settings} />
      </div>
    </div>
  );
}

function ReminderSettings({ initial }: { initial: Settings }) {
  const [form, setForm] = useState(initial);
  const [status, setStatus] = useState('');
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const r = await api<{ settings: Settings }>('/bookings/settings/texts', { method: 'PATCH', body: form });
          setForm(r.settings);
          setStatus('Saved');
        } catch (err) {
          setStatus((err as Error).message);
        }
      }}
      className="space-y-4 rounded-xl bg-white p-6 shadow-sm"
    >
      <div>
        <h2 className="font-semibold">Reminder texts</h2>
        <p className="mt-1 text-sm text-slate-500">
          Use {'{name}'}, {'{device}'}, {'{day}'}, {'{time}'}, {'{business}'}, {'{address}'}, {'{phone}'}. Sent between 8am and 8pm, never to anyone who replied STOP.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={form.reminders} onChange={(e) => setForm({ ...form, reminders: e.target.checked })} /> Send reminders
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">The evening before (from 5pm)</span>
        <textarea className={`${input} min-h-16`} maxLength={320} value={form.dayBeforeText} onChange={(e) => setForm({ ...form, dayBeforeText: e.target.value })} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">2 hours before</span>
        <textarea className={`${input} min-h-16`} maxLength={320} value={form.soonText} onChange={(e) => setForm({ ...form, soonText: e.target.value })} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">“Sorry we missed you” (sent when you mark a no-show)</span>
        <textarea className={`${input} min-h-16`} maxLength={320} value={form.noShowText} onChange={(e) => setForm({ ...form, noShowText: e.target.value })} />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={form.noShowAuto} onChange={(e) => setForm({ ...form, noShowAuto: e.target.checked })} />
        <span>
          <span className="font-medium">Send it automatically</span> <span className="text-slate-500">· if nobody marks them Arrived within 90 minutes. Only turn on if you always mark arrivals.</span>
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Save</button>
        {status && <span className="text-sm text-slate-600">{status}</span>}
      </div>
    </form>
  );
}
