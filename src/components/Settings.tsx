import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import WebsiteImport from './WebsiteImport';
import { ColorChoices, TagPill } from './Tags';
import PushControls from './PushControls';
import { api, DAYS, TAG_COLORS, type Business, type Day, type Faq, type SavedReply, type Tag, type WeeklyHours } from '../api';

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
          <WebsiteFormsSection business={props.business} onSaved={props.onSaved} />
          <BookingReplySection {...props} />
          <WidgetSection {...props} />
          <WidgetLookSection {...props} />
          <HoursSection {...props} />
          <PhoneSection {...props} />
          <SavedRepliesSection />
          <TagsSection />
          <AiSection {...props} />
          <AssistantSection {...props} />
          <FaqSection />
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

/** The private address a website's own server can post its booking/quote forms to. */
function WebsiteFormsSection({ business, onSaved }: Pick<Props, 'business' | 'onSaved'>) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(business.leadsUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const regenerate = async () => {
    if (!confirm('Make a new address? The current one stops working, so update your website with the new one.')) return;
    const { business: updated } = await api<{ business: Business }>('/business/lead-token', { method: 'POST' });
    onSaved(updated);
  };
  return (
    <Card
      title="Website forms (bookings & quotes)"
      description="If your website has its own booking or quote forms, its server can send each one here, and it lands in the inbox like a chat. Keep this address private."
    >
      <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{business.leadsUrl}</pre>
      <div className="flex gap-3 text-sm">
        <button onClick={copy} className="rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white">
          {copied ? 'Copied!' : 'Copy address'}
        </button>
        <button onClick={regenerate} className="px-3 py-1.5 text-slate-500 hover:underline">
          Make a new address
        </button>
      </div>
      <p className="text-xs text-slate-500">
        The website POSTs JSON such as <code>{'{"type":"booking","data":{"customerName":"…","phone":"…","date":"…"}}'}</code>. Types: booking, quote, corporate.
      </p>
    </Card>
  );
}

/** Sample booking for the preview of the automatic reply. */
const SAMPLE_BOOKING = { name: 'Sarah', device: 'Apple iPhone 13', service: 'Screen Replacement', when: '2026-10-23 at 10:00 AM' };

/** Automatic confirmation sent to customers who book through the website's booking form. */
function BookingReplySection({ business, onSaved }: Props) {
  const [form, setForm] = useState({ bookingReplyEnabled: business.bookingReplyEnabled, bookingReplyText: business.bookingReplyText });
  const { save, status, busy } = useBusinessSave(onSaved);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save(form);
  };
  const values: Record<string, string> = { ...SAMPLE_BOOKING, business: business.name, phone: business.widgetCallNumber ?? '' };
  const preview = form.bookingReplyText.replace(/\{(name|business|device|service|when|phone)\}/gi, (_, k: string) => values[k.toLowerCase()]);
  return (
    <form onSubmit={submit}>
      <Card
        title="Automatic booking reply"
        description="When someone books on your website, send them a confirmation straight away: by email if they gave one, otherwise by text. It shows in the conversation as “Sent automatically”."
      >
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.bookingReplyEnabled} onChange={(e) => setForm({ ...form, bookingReplyEnabled: e.target.checked })} className="h-4 w-4" />
          Send customers an automatic reply when they book
        </label>
        <div>
          <label className={label} htmlFor="bookingReply">Message</label>
          <textarea id="bookingReply" rows={3} maxLength={600} className={input} value={form.bookingReplyText} onChange={(e) => setForm({ ...form, bookingReplyText: e.target.value })} required />
          <p className="mt-1 text-xs text-slate-500">
            Fills in: <code>{'{name}'}</code> first name, <code>{'{device}'}</code>, <code>{'{service}'}</code>, <code>{'{when}'}</code> booked time, <code>{'{business}'}</code>,{' '}
            <code>{'{phone}'}</code> your “Call us now” number.
          </p>
        </div>
        <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
          <div className="mb-1 text-xs font-medium text-slate-500">Preview</div>
          {preview}
        </div>
        {!business.emailAvailable && !business.smsNumber && (
          <p className="text-xs text-amber-700">Needs email (SMTP) settings or a Twilio number before anything can be sent.</p>
        )}
        <div className="flex items-center gap-3">
          <button disabled={busy} className={primary}>Save</button>
          <StatusText status={status} />
        </div>
      </Card>
    </form>
  );
}

function WidgetSection({ business, onSaved }: Props) {
  const [form, setForm] = useState({ name: business.name, greeting: business.greeting, color: business.color, smsNumber: business.smsNumber ?? '', replyEmail: business.replyEmail ?? '' });
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
        <div>
          <label className={label} htmlFor="replyEmail">Customer email replies go to</label>
          <input id="replyEmail" type="email" className={input} placeholder={business.replyEmailEffective ?? 'you@yourbusiness.com.au'} value={form.replyEmail} onChange={(e) => setForm({ ...form, replyEmail: e.target.value })} />
          <p className="mt-1 text-xs text-slate-500">
            When you reply to a customer by email, their answer goes to this address. Leave empty to use your login email.
            {!business.emailAvailable && ' Email replies need the email (SMTP) settings under Integrations → Server keys.'}
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
    widgetButtons: business.widgetButtons,
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
          <label className="flex items-start gap-2 pt-1 text-sm">
            <input type="checkbox" className="mt-0.5" checked={form.widgetButtons} onChange={(e) => setForm({ ...form, widgetButtons: e.target.checked })} />
            <span>
              Show quick buttons above the chat icon <span className="text-slate-400">(“Chat with us”, “Get a quote”, “Request a call back”, so visitors see the choices before they click)</span>
            </span>
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

/** Create, rename, recolour and delete the business's internal tags. */
function TagsSection() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; name: string; color: string } | null>(null);
  const [status, setStatus] = useState<Status>(null);

  const load = () => api<{ tags: Tag[] }>('/tags').then((d) => setTags(d.tags)).catch((err) => setStatus({ ok: false, text: err.message }));
  useEffect(() => {
    load();
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setStatus(null);
    try {
      const body = { name: editing.name, color: editing.color };
      if (editing.id) await api(`/tags/${editing.id}`, { method: 'PATCH', body });
      else await api('/tags', { method: 'POST', body });
      setEditing(null);
      setStatus({ ok: true, text: 'Saved' });
      load();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };

  const remove = async (tag: Tag) => {
    const where = tag.uses ? ` It will be removed from ${tag.uses} conversation${tag.uses === 1 ? '' : 's'}.` : '';
    if (!confirm(`Delete the tag “${tag.name}”?${where}`)) return;
    setStatus(null);
    try {
      await api(`/tags/${tag.id}`, { method: 'DELETE' });
      if (editing?.id === tag.id) setEditing(null);
      setStatus({ ok: true, text: 'Deleted' });
      load();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };

  const form = editing && (
    <form onSubmit={save} className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <input
        autoFocus
        maxLength={30}
        className={input}
        placeholder="Tag name"
        value={editing.name}
        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
        required
      />
      <ColorChoices value={editing.color} onChange={(color) => setEditing({ ...editing, color })} />
      <div className="flex flex-wrap items-center gap-3">
        {editing.name.trim() && <TagPill tag={{ id: 'preview', name: editing.name.trim(), color: editing.color }} />}
        <button className={primary}>{editing.id ? 'Save tag' : 'Create tag'}</button>
        <button type="button" onClick={() => setEditing(null)} className="text-sm text-slate-500 hover:underline">
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <Card title="Tags" description="Colour-coded labels for your team, e.g. “Waiting on parts”. Customers never see them. Add them to a conversation with “+ Tag”.">
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
        {tags.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">No tags yet.</li>}
        {tags.map((t) =>
          editing?.id === t.id ? (
            <li key={t.id} className="p-2">{form}</li>
          ) : (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <TagPill tag={t} />
              <span className="text-xs text-slate-400">{t.uses ? `${t.uses} conversation${t.uses === 1 ? '' : 's'}` : 'not used yet'}</span>
              <span className="ml-auto flex gap-3">
                <button onClick={() => setEditing({ id: t.id, name: t.name, color: t.color })} className="text-blue-600 hover:underline">
                  Edit
                </button>
                <button onClick={() => remove(t)} className="text-red-600 hover:underline">
                  Delete
                </button>
              </span>
            </li>
          ),
        )}
      </ul>
      {editing?.id === null ? form : (
        <div className="flex items-center gap-3">
          <button onClick={() => setEditing({ id: null, name: '', color: TAG_COLORS[0] })} className="text-sm font-medium text-blue-600 hover:underline">
            + New tag
          </button>
          <StatusText status={status} />
        </div>
      )}
    </Card>
  );
}

const ASSISTANT_MODES: { value: Business['assistantMode']; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Only you reply.' },
  { value: 'always', label: 'Always, straight away', hint: 'Customers get an answer within seconds, day or night. Recommended.' },
  { value: 'after_hours', label: 'Only outside opening hours', hint: 'You reply while the shop is open. Needs office hours turned on.' },
  { value: 'no_reply', label: 'Only if nobody replies within 2 minutes', hint: 'A safety net when you’re busy.' },
];

/** When the AI assistant answers customers on its own, and what it says when it can't. */
function AssistantSection({ business, onSaved }: Props) {
  const [form, setForm] = useState({ assistantMode: business.assistantMode, assistantHandoff: business.assistantHandoff });
  const { save, status, busy } = useBusinessSave(onSaved);
  const [question, setQuestion] = useState('');
  const [trial, setTrial] = useState<{ action: string; reply: string } | null>(null);
  const [trialError, setTrialError] = useState('');
  const [trying, setTrying] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save(form);
  };
  const tryIt = async () => {
    setTrying(true);
    setTrial(null);
    setTrialError('');
    try {
      setTrial(await api<{ action: string; reply: string }>('/assistant/test', { method: 'POST', body: { question } }));
    } catch (err) {
      setTrialError((err as Error).message);
    }
    setTrying(false);
  };
  return (
    <form onSubmit={submit}>
      <Card
        title="AI assistant"
        description="Answers customers in web chat and texts on its own, using only your FAQs and AI notes. If the answer isn’t there, it sends your holding message and tags the conversation “Needs reply”. You can step in any time: after you reply, it leaves that conversation to you until 30 minutes after your last message."
      >
        {!business.aiAvailable && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">No Anthropic key yet, so every question gets the holding message below. Add ANTHROPIC_API_KEY under Integrations → Server keys for real answers.</p>}
        <div className="space-y-2">
          {ASSISTANT_MODES.map((m) => (
            <label key={m.value} className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="radio" name="assistantMode" className="mt-0.5" checked={form.assistantMode === m.value} onChange={() => setForm({ ...form, assistantMode: m.value })} />
              <span>
                <span className="font-medium">{m.label}</span> <span className="text-slate-500">{m.hint}</span>
              </span>
            </label>
          ))}
          {form.assistantMode === 'after_hours' && !business.hoursEnabled && (
            <p className="text-xs text-amber-700">Office hours are off, so ChatBird treats you as always open and the assistant won’t answer. Turn them on under Office hours.</p>
          )}
        </div>
        <div>
          <label className={label} htmlFor="handoff">Holding message (when it can’t answer)</label>
          <textarea id="handoff" rows={2} maxLength={500} className={input} value={form.assistantHandoff} onChange={(e) => setForm({ ...form, assistantHandoff: e.target.value })} required />
          <p className="mt-1 text-xs text-slate-500">Sent each time it can’t answer a question (never twice in a row), day or night.</p>
        </div>
        <div className="flex items-center gap-3">
          <button disabled={busy} className={primary}>Save</button>
          <StatusText status={status} />
        </div>
        <div className="space-y-2 border-t border-slate-100 pt-4">
          <span className={label}>Try it (nothing is sent)</span>
          <div className="flex gap-2">
            <input className={input} placeholder="e.g. Do you fix Samsung back glass?" value={question} onChange={(e) => setQuestion(e.target.value)} />
            <button type="button" onClick={tryIt} disabled={trying || !question.trim()} className="shrink-0 rounded-md border border-slate-300 px-3 text-sm hover:bg-slate-50 disabled:opacity-50">
              {trying ? 'Thinking…' : 'Ask'}
            </button>
          </div>
          {trialError && <p className="text-sm text-red-600">{trialError}</p>}
          {trial && (
            <div className={`rounded-md p-3 text-sm ${trial.action === 'answer' ? 'bg-violet-50 text-violet-900' : 'bg-amber-50 text-amber-900'}`}>
              <div className="mb-1 text-xs font-medium">{trial.action === 'answer' ? '🤖 Would answer:' : 'Not in your FAQs, so it would send the holding message and tag “Needs reply”:'}</div>
              {trial.reply}
            </div>
          )}
        </div>
      </Card>
    </form>
  );
}

/** The questions and answers the assistant uses: add, edit, delete, import from a spreadsheet. */
function FaqSection() {
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<{ id: string | null; question: string; answer: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [paste, setPaste] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [showAll, setShowAll] = useState(false);
  const [onlyGaps, setOnlyGaps] = useState(false);

  const load = () => api<{ faqs: Faq[] }>('/faqs').then((d) => setFaqs(d.faqs)).catch((err) => setStatus({ ok: false, text: err.message }));
  useEffect(() => {
    load();
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    try {
      const body = { question: editing.question, answer: editing.answer };
      if (editing.id) await api(`/faqs/${editing.id}`, { method: 'PATCH', body });
      else await api('/faqs', { method: 'POST', body });
      setEditing(null);
      setStatus({ ok: true, text: 'Saved' });
      load();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };
  const remove = async (f: Faq) => {
    if (!confirm(`Delete “${f.question}”?`)) return;
    await api(`/faqs/${f.id}`, { method: 'DELETE' });
    load();
  };
  const importText = async (text: string) => {
    try {
      const r = await api<{ added: number; skipped: number }>('/faqs/import', { method: 'POST', body: { text } });
      setStatus({ ok: true, text: `Added ${r.added} FAQ${r.added === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped} (duplicates or empty)` : ''}` });
      setImporting(false);
      setPaste('');
      load();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = faqs.filter((f) => (!onlyGaps || f.needsEditing) && (!q || `${f.question} ${f.answer}`.toLowerCase().includes(q)));
  const needEdit = faqs.filter((f) => f.needsEditing).length;
  const form = editing && (
    <form onSubmit={save} className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <input className={input} placeholder="Question" maxLength={300} value={editing.question} onChange={(e) => setEditing({ ...editing, question: e.target.value })} required autoFocus />
      <textarea className={input} rows={3} placeholder="Answer" maxLength={2000} value={editing.answer} onChange={(e) => setEditing({ ...editing, answer: e.target.value })} required />
      <div className="flex gap-3">
        <button className={primary}>{editing.id ? 'Save' : 'Add FAQ'}</button>
        <button type="button" onClick={() => setEditing(null)} className="text-sm text-slate-500 hover:underline">Cancel</button>
      </div>
    </form>
  );

  return (
    <Card title={`FAQs (${faqs.length})`} description="What the assistant answers from. Keep answers factual: prices, hours, warranty, what you repair.">
      {needEdit > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {needEdit} FAQ{needEdit === 1 ? ' still has a' : 's still have'} template gap{needEdit === 1 ? '' : 's'} like “[Business hours]”. The assistant skips {needEdit === 1 ? 'it' : 'them'} until you fill {needEdit === 1 ? 'it' : 'them'} in.{' '}
          <button className="underline" onClick={() => setOnlyGaps(!onlyGaps)}>{onlyGaps ? 'Show all' : 'Show them'}</button>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <input className={`${input} max-w-xs`} placeholder="Search FAQs" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={() => setEditing({ id: null, question: '', answer: '' })} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">+ Add FAQ</button>
        <button onClick={() => setImporting(!importing)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">Import</button>
      </div>
      {importing && (
        <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="text-slate-600">Choose a CSV file with Question and Answer columns, or copy the two columns from Excel and paste them below.</p>
          <input
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) importText(await file.text());
            }}
          />
          <textarea className={input} rows={4} placeholder="Paste from Excel here" value={paste} onChange={(e) => setPaste(e.target.value)} />
          <button disabled={!paste.trim()} onClick={() => importText(paste)} className={primary}>Import pasted FAQs</button>
        </div>
      )}
      {editing?.id === null && form}
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
        {shown.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">{faqs.length ? 'No FAQs match.' : 'No FAQs yet.'}</li>}
        {(showAll || q || onlyGaps ? shown : shown.slice(0, 10)).map((f) =>
          editing?.id === f.id ? (
            <li key={f.id} className="p-2">{form}</li>
          ) : (
            <li key={f.id} className="px-3 py-2 text-sm">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{f.question}</div>
                  <div className="mt-0.5 line-clamp-2 text-slate-500">{f.answer}</div>
                  {f.needsEditing && <div className="mt-0.5 text-xs text-amber-700">Has a template gap; edit before the assistant uses it</div>}
                </div>
                <span className="flex shrink-0 gap-3">
                  <button onClick={() => setEditing({ id: f.id, question: f.question, answer: f.answer })} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => remove(f)} className="text-red-600 hover:underline">Delete</button>
                </span>
              </div>
            </li>
          ),
        )}
      </ul>
      {!q && !onlyGaps && shown.length > 10 && (
        <button onClick={() => setShowAll(!showAll)} className="text-sm text-blue-600 hover:underline">
          {showAll ? 'Show fewer' : `Show all ${shown.length}`}
        </button>
      )}
      <StatusText status={status} />
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
