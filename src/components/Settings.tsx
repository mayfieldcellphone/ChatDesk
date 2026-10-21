import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import WebsiteImport from './WebsiteImport';
import PushControls from './PushControls';
import { api, DAYS, type Business, type Day, type SavedReply, type WeeklyHours } from '../api';

interface Props {
  business: Business;
  notifyEmail: boolean;
  userPhone: string | null;
  onSaved: (business: Business) => void;
  onNotifyEmailChange: (value: boolean) => void;
  onUserPhoneChange: (value: string | null) => void;
}

const DAY_NAMES: Record<Day, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';
const label = 'mb-1 block text-sm font-medium text-slate-700';
const primary = 'rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60';

type Status = { ok: boolean; text: string } | null;

function Card({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl bg-white p-6 shadow-sm">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function StatusText({ status }: { status: Status }) {
  return status ? <span className={`text-sm ${status.ok ? 'text-green-600' : 'text-red-600'}`}>{status.text}</span> : null;
}

/** Saves part of the business settings and reports the result next to the section's Save button. */
function useBusinessSave(onSaved: (b: Business) => void) {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const save = async (fields: Record<string, unknown>) => {
    setBusy(true);
    setStatus(null);
    try {
      const { business } = await api<{ business: Business }>('/business', { method: 'PATCH', body: fields });
      onSaved(business);
      setStatus({ ok: true, text: 'Saved' });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return { save, status, busy };
}

export default function Settings(props: Props & { autoImport?: boolean }) {
  // Sections keep their own form state, so remount them after an import changes the saved values.
  const [version, setVersion] = useState(0);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-6 md:px-6 md:py-8">
        <h1 className="text-xl font-semibold">Settings</h1>
        <WebsiteImport
          business={props.business}
          autoStart={Boolean(props.autoImport)}
          onApplied={(business) => {
            props.onSaved(business);
            setVersion((v) => v + 1);
          }}
        />
        <div key={version} className="space-y-6">
          <InstallSection business={props.business} />
          <WidgetSection {...props} />
          <WidgetLookSection {...props} />
          <HoursSection {...props} />
          <PhoneSection {...props} />
          <SavedRepliesSection />
          <AiSection {...props} />
          <NotificationsSection {...props} />
        </div>
      </div>
    </div>
  );
}

function InstallSection({ business }: { business: Business }) {
  const [copied, setCopied] = useState(false);
  const snippet = `<script src="${location.origin}/widget.js" data-key="${business.widgetKey}" async></script>`;
  const copy = async () => {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Card title="Install the chat widget" description={<>Paste this just before <code>&lt;/body&gt;</code> on every page of your website.</>}>
      <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{snippet}</pre>
      <div className="flex gap-3 text-sm">
        <button onClick={copy} className="rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white">
          {copied ? 'Copied!' : 'Copy code'}
        </button>
        <a href={`/demo.html?key=${encodeURIComponent(business.widgetKey)}`} target="_blank" rel="noreferrer" className="px-3 py-1.5 text-blue-600 hover:underline">
          Preview on a test page →
        </a>
      </div>
    </Card>
  );
}

function WidgetSection({ business, onSaved }: Props) {
  const [form, setForm] = useState({ name: business.name, greeting: business.greeting, color: business.color, smsNumber: business.smsNumber ?? '' });
  const { save, status, busy } = useBusinessSave(onSaved);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save(form);
  };
  return (
    <form onSubmit={submit}>
      <Card title="Widget & business">
        <div>
          <label className={label} htmlFor="name">Business name</label>
          <input id="name" className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </div>
        <div>
          <label className={label} htmlFor="greeting">Greeting</label>
          <textarea id="greeting" rows={2} maxLength={300} className={input} value={form.greeting} onChange={(e) => setForm({ ...form, greeting: e.target.value })} required />
        </div>
        <div>
          <label className={label} htmlFor="color">Brand colour</label>
          <div className="flex items-center gap-3">
            <input id="color" type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="h-9 w-14 cursor-pointer rounded border border-slate-300" />
            <span className="font-mono text-sm text-slate-500">{form.color}</span>
          </div>
        </div>
        <div>
          <label className={label} htmlFor="sms">Twilio SMS number</label>
          <input id="sms" className={input} placeholder="+61400123456" value={form.smsNumber} onChange={(e) => setForm({ ...form, smsNumber: e.target.value })} />
          <p className="mt-1 text-xs text-slate-500">
            {business.smsAvailable
              ? 'Lets you reply by text, and puts customers’ texts to this number in your inbox. In Twilio, set the number’s incoming-message webhook to '
              : 'Texting is off: the server has no Twilio credentials. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, then point the number’s incoming-message webhook at '}
            <code>{location.origin}/api/sms/inbound</code>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button disabled={busy} className={primary}>Save</button>
          <StatusText status={status} />
        </div>
      </Card>
    </form>
  );
}

/** Where the chat button sits, and the menu visitors see before they start. */
function WidgetLookSection({ business, onSaved }: Props) {
  const [form, setForm] = useState({
    widgetPosition: business.widgetPosition,
    widgetOffsetX: business.widgetOffsetX,
    widgetOffsetY: business.widgetOffsetY,
    widgetQuote: business.widgetQuote,
    widgetCallback: business.widgetCallback,
    widgetCallNumber: business.widgetCallNumber ?? '',
  });
  const { save, status, busy } = useBusinessSave(onSaved);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save(form);
  };
  const side = form.widgetPosition;
  return (
    <form onSubmit={submit}>
      <Card title="Chat button & menu" description="Move the button if it sits on top of another one (e.g. Birdeye), and choose what visitors can ask for.">
        <div className="flex flex-col gap-5 sm:flex-row">
          <div className="flex-1 space-y-3">
            <div>
              <span className={label}>Position</span>
              <div className="flex gap-2">
                {(['left', 'right'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setForm({ ...form, widgetPosition: p })}
                    className={`rounded-md border px-3 py-1.5 text-sm capitalize ${side === p ? 'border-blue-600 bg-blue-50 font-semibold text-blue-700' : 'border-slate-300'}`}
                  >
                    Bottom {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="offx">From the side (px)</label>
                <input id="offx" type="number" min={0} max={400} className={input} value={form.widgetOffsetX} onChange={(e) => setForm({ ...form, widgetOffsetX: Number(e.target.value) })} />
              </div>
              <div>
                <label className={label} htmlFor="offy">From the bottom (px)</label>
                <input id="offy" type="number" min={0} max={400} className={input} value={form.widgetOffsetY} onChange={(e) => setForm({ ...form, widgetOffsetY: Number(e.target.value) })} />
              </div>
            </div>
            <p className="text-xs text-slate-500">Tip: to sit above another chat button on the same side, set “From the bottom” to about 100.</p>
          </div>
          {/* Small preview of a page with the button where it will appear. */}
          <div className="relative h-36 w-full shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 sm:w-44" aria-hidden>
            <div className="m-3 h-2 w-20 rounded bg-slate-200" />
            <div className="mx-3 h-2 w-28 rounded bg-slate-200" />
            <div
              className="absolute h-6 w-6 rounded-full shadow"
              style={{ background: business.color, bottom: 4 + form.widgetOffsetY / 5, [side]: 4 + form.widgetOffsetX / 5 }}
            />
          </div>
        </div>

        <div className="space-y-2 border-t border-slate-100 pt-4">
          <span className={label}>Menu options (Chat is always on)</span>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.widgetQuote} onChange={(e) => setForm({ ...form, widgetQuote: e.target.checked })} />
            📋 Get a quote <span className="text-slate-400">(device + what needs fixing)</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.widgetCallback} onChange={(e) => setForm({ ...form, widgetCallback: e.target.checked })} />
            📞 Request a call back <span className="text-slate-400">(best time to call)</span>
          </label>
          <div>
            <label className={label} htmlFor="callnum">☎️ “Call us now” number (leave empty to hide)</label>
            <input id="callnum" className={input} placeholder="e.g. 02 4968 1234" value={form.widgetCallNumber} onChange={(e) => setForm({ ...form, widgetCallNumber: e.target.value })} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button disabled={busy} className={primary}>Save</button>
          <StatusText status={status} />
          <a href={`/demo.html?key=${encodeURIComponent(business.widgetKey)}`} target="_blank" rel="noreferrer" className="ml-auto text-sm text-blue-600 hover:underline">
            Preview →
          </a>
        </div>
      </Card>
    </form>
  );
}

function HoursSection({ business, onSaved }: Props) {
  const [enabled, setEnabled] = useState(business.hoursEnabled);
  const [timezone, setTimezone] = useState(business.timezone);
  const [hours, setHours] = useState<WeeklyHours>(business.hours);
  const [awayMessage, setAwayMessage] = useState(business.awayMessage);
  const { save, status, busy } = useBusinessSave(onSaved);
  const timezones = Intl.supportedValuesOf?.('timeZone') ?? [];

  const setDay = (day: Day, value: WeeklyHours[Day]) => setHours({ ...hours, [day]: value });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save({ hoursEnabled: enabled, timezone, hours, awayMessage });
  };

  return (
    <form onSubmit={submit}>
      <Card
        title="Office hours & away message"
        description="Outside these hours, customers get your away message automatically (once per conversation every 12 hours), and the widget shows that you're away."
      >
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4" />
          Use office hours
          {business.hoursEnabled && (
            <span className={`ml-2 rounded-full px-2 text-xs ${business.openNow ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'}`}>
              {business.openNow ? 'Open now' : 'Closed now'}
            </span>
          )}
        </label>
        <fieldset disabled={!enabled} className="space-y-4 disabled:opacity-50">
          <div>
            <label className={label} htmlFor="tz">Timezone</label>
            <input id="tz" list="timezones" className={input} value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            <datalist id="timezones">
              {timezones.map((tz) => <option key={tz} value={tz} />)}
            </datalist>
          </div>
          <div className="space-y-2">
            {DAYS.map((day) => {
              const value = hours[day];
              return (
                <div key={day} className="flex items-center gap-3 text-sm">
                  <label className="flex w-32 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={value !== null}
                      onChange={(e) => setDay(day, e.target.checked ? { open: '09:00', close: '17:00' } : null)}
                      className="h-4 w-4"
                    />
                    {DAY_NAMES[day]}
                  </label>
                  {value ? (
                    <>
                      <input type="time" value={value.open} onChange={(e) => setDay(day, { ...value, open: e.target.value })} className="rounded border border-slate-300 px-2 py-1" required />
                      <span className="text-slate-400">to</span>
                      <input type="time" value={value.close} onChange={(e) => setDay(day, { ...value, close: e.target.value })} className="rounded border border-slate-300 px-2 py-1" required />
                    </>
                  ) : (
                    <span className="text-slate-400">Closed</span>
                  )}
                </div>
              );
            })}
          </div>
          <div>
            <label className={label} htmlFor="away">Away message</label>
            <textarea id="away" rows={3} maxLength={500} className={input} value={awayMessage} onChange={(e) => setAwayMessage(e.target.value)} required />
          </div>
        </fieldset>
        <div className="flex items-center gap-3">
          <button disabled={busy} className={primary}>Save</button>
          <StatusText status={status} />
        </div>
      </Card>
    </form>
  );
}

function PhoneSection({ business, userPhone, onSaved, onUserPhoneChange }: Props) {
  const [form, setForm] = useState({
    forwardNumber: business.forwardNumber ?? '',
    ringSeconds: business.ringSeconds,
    voicemailGreeting: business.voicemailGreeting,
    missedCallTextEnabled: business.missedCallTextEnabled,
    missedCallText: business.missedCallText,
  });
  const [myPhone, setMyPhone] = useState(userPhone ?? '');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const ready = business.smsAvailable && business.smsNumber;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const { business: updated } = await api<{ business: Business }>('/business', { method: 'PATCH', body: form });
      await api('/me', { method: 'PATCH', body: { phone: myPhone } });
      onSaved(updated);
      onUserPhoneChange(myPhone || null);
      setStatus({ ok: true, text: 'Saved' });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <Card
        title="Phone calls & voicemail"
        description={
          ready
            ? <>Calls to {business.smsNumber} ring your shop first (during office hours), then go to voicemail. Voicemails appear in the inbox with a transcript. In Twilio, set the number’s <b>A call comes in</b> webhook to <code>{location.origin}/api/voice/incoming</code> and <b>Call status changes</b> to <code>{location.origin}/api/voice/status</code>.</>
            : 'Needs Twilio: set up texting first (see docs/TWILIO_SETUP.md). The same number handles calls.'
        }
      >
        <div>
          <label className={label} htmlFor="fwd">Ring this phone first (optional)</label>
          <input id="fwd" className={input} placeholder="Your shop or mobile number" value={form.forwardNumber} onChange={(e) => setForm({ ...form, forwardNumber: e.target.value })} />
          <p className="mt-1 text-xs text-slate-500">
            Leave empty to send every call straight to voicemail. Don’t enter a number that already forwards its missed calls to your Twilio number, or calls will loop.
          </p>
        </div>
        <div>
          <label className={label} htmlFor="ring">Ring for (seconds) before voicemail</label>
          <input id="ring" type="number" min={5} max={60} className={`${input} w-28`} value={form.ringSeconds} onChange={(e) => setForm({ ...form, ringSeconds: Number(e.target.value) })} />
        </div>
        <div>
          <label className={label} htmlFor="vm">Voicemail greeting (read out to callers)</label>
          <textarea id="vm" rows={3} maxLength={500} className={input} value={form.voicemailGreeting} onChange={(e) => setForm({ ...form, voicemailGreeting: e.target.value })} required />
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.missedCallTextEnabled} onChange={(e) => setForm({ ...form, missedCallTextEnabled: e.target.checked })} className="h-4 w-4" />
            Text callers automatically when you miss their call
          </label>
          <textarea rows={2} maxLength={320} disabled={!form.missedCallTextEnabled} className={`${input} disabled:opacity-50`} value={form.missedCallText} onChange={(e) => setForm({ ...form, missedCallText: e.target.value })} required />
        </div>
        <div>
          <label className={label} htmlFor="myphone">Your mobile, for “Call back”</label>
          <input id="myphone" className={input} placeholder="+61400123456" value={myPhone} onChange={(e) => setMyPhone(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">
            When you click 📞 Call back, we ring this phone and connect you to the customer, who sees your business number. Only you see this setting.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button disabled={busy} className={primary}>Save</button>
          <StatusText status={status} />
        </div>
      </Card>
    </form>
  );
}

function SavedRepliesSection() {
  const [replies, setReplies] = useState<SavedReply[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; title: string; body: string } | null>(null);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    api<{ savedReplies: SavedReply[] }>('/saved-replies').then((d) => setReplies(d.savedReplies)).catch(console.error);
  }, []);

  const sortByTitle = (list: SavedReply[]) => [...list].sort((a, b) => a.title.localeCompare(b.title));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setStatus(null);
    try {
      const body = { title: editing.title, body: editing.body };
      if (editing.id) {
        const { savedReply } = await api<{ savedReply: SavedReply }>(`/saved-replies/${editing.id}`, { method: 'PUT', body });
        setReplies(sortByTitle(replies.map((r) => (r.id === savedReply.id ? savedReply : r))));
      } else {
        const { savedReply } = await api<{ savedReply: SavedReply }>('/saved-replies', { method: 'POST', body });
        setReplies(sortByTitle([...replies, savedReply]));
      }
      setEditing(null);
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };

  const remove = async (reply: SavedReply) => {
    if (!confirm(`Delete the saved reply "${reply.title}"?`)) return;
    await api(`/saved-replies/${reply.id}`, { method: 'DELETE' });
    setReplies(replies.filter((r) => r.id !== reply.id));
  };

  return (
    <Card
      title="Saved replies"
      description={<>Answers you send often. Insert them from the reply box, or type <code>/</code>. Use <code>{'{name}'}</code> for the customer's first name and <code>{'{business}'}</code> for your business name.</>}
    >
      {replies.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {replies.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{r.title}</div>
                <div className="truncate text-xs text-slate-500">{r.body}</div>
              </div>
              <button onClick={() => setEditing({ id: r.id, title: r.title, body: r.body })} className="text-sm text-blue-600 hover:underline">Edit</button>
              <button onClick={() => remove(r)} className="text-sm text-red-600 hover:underline">Delete</button>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <form onSubmit={submit} className="space-y-3 rounded-md bg-slate-50 p-4">
          <input className={input} placeholder="Title, e.g. iPhone screen price" value={editing.title} maxLength={80} onChange={(e) => setEditing({ ...editing, title: e.target.value })} required autoFocus />
          <textarea className={input} rows={3} maxLength={1600} placeholder="Hi {name}, an iPhone 14 screen is $249 and takes about an hour." value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} required />
          <div className="flex items-center gap-3">
            <button className={primary}>{editing.id ? 'Save changes' : 'Add reply'}</button>
            <button type="button" onClick={() => setEditing(null)} className="text-sm text-slate-500 hover:underline">Cancel</button>
            <StatusText status={status} />
          </div>
        </form>
      ) : (
        <button onClick={() => setEditing({ id: null, title: '', body: '' })} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
          + Add saved reply
        </button>
      )}
    </Card>
  );
}

function AiSection({ business, onSaved }: Props) {
  const [notes, setNotes] = useState(business.aiNotes);
  const { save, status, busy } = useBusinessSave(onSaved);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save({ aiNotes: notes });
      }}
    >
      <Card
        title="AI-suggested replies"
        description={
          business.aiAvailable
            ? 'The ✨ Suggest reply button drafts an answer for you to check and edit before sending. It uses this information and your saved replies, and won’t make up prices or policies that aren’t here.'
            : 'Off: add ANTHROPIC_API_KEY to the server’s environment to turn on the ✨ Suggest reply button. You can fill this in now.'
        }
      >
        <div>
          <label className={label} htmlFor="ai-notes">What should the AI know about your business?</label>
          <textarea
            id="ai-notes"
            rows={8}
            maxLength={5000}
            className={input}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={'Services and prices, e.g.\n- iPhone 14 screen: $249, about 1 hour\n- Battery replacement: from $89\n- Free diagnosis, 90-day warranty on all repairs\nAddress, parking, booking policy…'}
          />
        </div>
        <div className="flex items-center gap-3">
          <button disabled={busy} className={primary}>Save</button>
          <StatusText status={status} />
        </div>
      </Card>
    </form>
  );
}

function NotificationsSection({ business, notifyEmail, onNotifyEmailChange }: Props) {
  const [status, setStatus] = useState<Status>(null);
  const toggle = async (value: boolean) => {
    setStatus(null);
    try {
      await api('/me', { method: 'PATCH', body: { notifyEmail: value } });
      onNotifyEmailChange(value);
      setStatus({ ok: true, text: 'Saved' });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <Card
      title="Notifications"
      description="Turn on notifications on each phone and computer you use. While the inbox is open you also get a sound. Email covers the times nobody has it open."
    >
      <PushControls />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={notifyEmail} disabled={!business.emailAvailable} onChange={(e) => toggle(e.target.checked)} className="h-4 w-4" />
        Email me when a customer messages and nobody has the inbox open
        <StatusText status={status} />
      </label>
      {!business.emailAvailable && (
        <p className="text-xs text-slate-500">Email is off: the server needs SMTP settings (SMTP_HOST, SMTP_FROM and usually SMTP_USER / SMTP_PASS).</p>
      )}
    </Card>
  );
}
