import { useState, type FormEvent } from 'react';
import { api, type Business } from '../api';

interface Props {
  business: Business;
  onSaved: (business: Business) => void;
}

export default function Settings({ business, onSaved }: Props) {
  const [form, setForm] = useState({
    name: business.name,
    greeting: business.greeting,
    color: business.color,
    smsNumber: business.smsNumber ?? '',
  });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const snippet = `<script src="${location.origin}/widget.js" data-key="${business.widgetKey}" async></script>`;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    try {
      const { business: updated } = await api<{ business: Business }>('/business', { method: 'PATCH', body: form });
      onSaved(updated);
      setMessage({ ok: true, text: 'Saved' });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';
  const label = 'mb-1 block text-sm font-medium text-slate-700';

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
        <h1 className="text-xl font-semibold">Settings</h1>

        <section className="rounded-xl bg-white p-6 shadow-sm">
          <h2 className="font-semibold">Install the chat widget</h2>
          <p className="mt-1 text-sm text-slate-500">
            Paste this just before <code>&lt;/body&gt;</code> on every page of your website.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{snippet}</pre>
          <div className="mt-3 flex gap-3 text-sm">
            <button onClick={copy} className="rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white">
              {copied ? 'Copied!' : 'Copy code'}
            </button>
            <a href={`/demo.html?key=${encodeURIComponent(business.widgetKey)}`} target="_blank" rel="noreferrer" className="px-3 py-1.5 text-blue-600 hover:underline">
              Preview on a test page →
            </a>
          </div>
        </section>

        <form onSubmit={save} className="space-y-4 rounded-xl bg-white p-6 shadow-sm">
          <h2 className="font-semibold">Widget & business</h2>
          <div>
            <label className={label} htmlFor="name">Business name</label>
            <input id="name" className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div>
            <label className={label} htmlFor="greeting">Greeting</label>
            <textarea
              id="greeting"
              rows={2}
              maxLength={300}
              className={input}
              value={form.greeting}
              onChange={(e) => setForm({ ...form, greeting: e.target.value })}
              required
            />
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
            <input
              id="sms"
              className={input}
              placeholder="+61400123456"
              value={form.smsNumber}
              onChange={(e) => setForm({ ...form, smsNumber: e.target.value })}
            />
            <p className="mt-1 text-xs text-slate-500">
              {business.smsAvailable
                ? 'Lets you reply by text, and puts customers’ texts to this number in your inbox. In Twilio, set the number’s incoming-message webhook to '
                : 'Texting is off: the server has no Twilio credentials. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, then point the number’s incoming-message webhook at '}
              <code>{location.origin}/api/sms/inbound</code>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Save</button>
            {message && <span className={`text-sm ${message.ok ? 'text-green-600' : 'text-red-600'}`}>{message.text}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
