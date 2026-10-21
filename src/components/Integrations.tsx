import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, timeAgo, type Business } from '../api';
import ServerKeys from './ServerKeys';

interface Connection {
  id: string;
  provider: 'google' | 'facebook' | 'instagram';
  name: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface Status {
  publicUrlSet: boolean;
  google: { available: boolean; redirectUri: string };
  meta: { available: boolean; redirectUri: string; webhookUrl: string };
  twilio: { available: boolean; number: string | null };
  connections: Connection[];
}

interface Props {
  /** Result passed back in the URL after a provider's sign-in. */
  notice: { ok: boolean; text: string } | null;
  onOpenSettings: () => void;
  business: Business;
  onSaved: (business: Business) => void;
}

function Card({ icon, title, description, children }: { icon: string; title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-xl bg-white p-6 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-2xl">{icon}</div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 className="font-semibold">{title}</h2>
            <p className="text-sm text-slate-500">{description}</p>
          </div>
          {children}
        </div>
      </div>
    </section>
  );
}

function SetupNote({ children }: { children: ReactNode }) {
  return <div className="rounded-md bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">{children}</div>;
}

export default function Integrations({ notice, onOpenSettings, isAdmin, business, onSaved }: Props & { isAdmin: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api<Status>('/integrations').then(setStatus).catch((err) => setError(err.message));
  useEffect(() => {
    load();
  }, []);

  const disconnect = async (c: Connection) => {
    const also = c.provider === 'google' ? '' : ' Its linked Facebook Page / Instagram account will be disconnected together.';
    if (!confirm(`Disconnect ${c.name}? Existing conversations stay in ChatBird.${also}`)) return;
    setBusy(c.id);
    await api(`/integrations/${c.id}`, { method: 'DELETE' }).catch((err) => setError(err.message));
    setBusy(null);
    load();
  };

  const sync = async (c: Connection) => {
    setBusy(c.id);
    setError('');
    try {
      const { added } = await api<{ added: number }>(`/integrations/${c.id}/sync`, { method: 'POST' });
      if (added) setError('');
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(null);
    load();
  };

  if (!status) return <div className="flex h-full items-center justify-center text-sm text-slate-400">{error || 'Loading…'}</div>;

  const list = (provider: Connection['provider']) => status.connections.filter((c) => c.provider === provider);
  const connectButton = (provider: 'google' | 'meta', label: string, available: boolean) => (
    <a
      href={available ? `/api/integrations/${provider}/start` : undefined}
      aria-disabled={!available}
      className={`inline-block rounded-md px-4 py-2 text-sm font-semibold text-white ${available ? 'bg-blue-600 hover:bg-blue-700' : 'cursor-not-allowed bg-slate-300'}`}
    >
      {label}
    </a>
  );
  const rows = (items: Connection[], canSync = false) =>
    items.length > 0 && (
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
        {items.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            <span className="font-medium">{c.name}</span>
            {canSync && <span className="text-xs text-slate-400">{!c.lastSyncedAt ? 'syncing…' : timeAgo(c.lastSyncedAt) === 'now' ? 'synced just now' : `synced ${timeAgo(c.lastSyncedAt)} ago`}</span>}
            {c.lastError && <span className="w-full text-xs text-red-600">⚠ {c.lastError}</span>}
            <span className="ml-auto flex gap-3">
              {canSync && (
                <button onClick={() => sync(c)} disabled={busy === c.id} className="text-blue-600 hover:underline disabled:opacity-50">
                  Sync now
                </button>
              )}
              <button onClick={() => disconnect(c)} disabled={busy === c.id} className="text-red-600 hover:underline disabled:opacity-50">
                Disconnect
              </button>
            </span>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-6 md:px-6 md:py-8">
        <div>
          <h1 className="text-xl font-semibold">Integrations</h1>
          <p className="text-sm text-slate-500">Connect your accounts so messages and reviews come into ChatBird.</p>
          {isAdmin && (
            <a href="#server-keys" className="text-sm text-blue-600 hover:underline">
              Enter API keys (Server keys) ↓
            </a>
          )}
        </div>
        {notice && (
          <p className={`rounded-md px-4 py-3 text-sm ${notice.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>{notice.text}</p>
        )}
        {error && <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}

        <Card icon="🔎" title="Google Business Profile" description="See your Google reviews, reply to them from ChatBird, get alerts for new ones, and send customers your review link.">
          {rows(list('google'), true)}
          {connectButton('google', list('google').length ? 'Connect another Google account' : 'Connect Google', status.google.available)}
          {!status.google.available && (
            <SetupNote>
              Needs a one-time setup in Google Cloud: create OAuth credentials, enable the Business Profile APIs and request API access, then set
              <code> GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> on the server. Use this redirect URI:{' '}
              <code className="break-all">{status.google.redirectUri}</code>. Step by step: <code>docs/INTEGRATIONS.md</code>.
            </SetupNote>
          )}
          <p className="text-xs text-slate-500">Google ended chat messaging on Business Profiles in 2024, so Google brings reviews, not messages.</p>
        </Card>

        <Card icon="💬" title="Facebook Messenger & Instagram" description="Messages to your Facebook Page and Instagram business account land in the inbox, and you reply from ChatBird.">
          {rows([...list('facebook'), ...list('instagram')])}
          {connectButton('meta', list('facebook').length ? 'Add or update Pages' : 'Connect Facebook & Instagram', status.meta.available)}
          {!status.meta.available && (
            <SetupNote>
              Needs a Meta developer app: set <code>META_APP_ID</code>, <code>META_APP_SECRET</code> and <code>META_VERIFY_TOKEN</code> on the server, add the
              redirect URI <code className="break-all">{status.meta.redirectUri}</code>, and point the Messenger and Instagram webhooks at{' '}
              <code className="break-all">{status.meta.webhookUrl}</code>. Step by step: <code>docs/INTEGRATIONS.md</code>.
            </SetupNote>
          )}
          <p className="text-xs text-slate-500">
            Instagram needs a professional (business or creator) account linked to your Facebook Page. Meta only allows replies within 24 hours of the customer’s
            last message.
          </p>
        </Card>

        <Card icon="📱" title="Texting & calls (Twilio)" description="SMS, calls, voicemail and missed-call texts.">
          {status.twilio.available && status.twilio.number ? (
            <p className="text-sm"><span className="mr-2 inline-block h-2 w-2 rounded-full bg-green-500" />Connected: {status.twilio.number}</p>
          ) : (
            <SetupNote>
              {status.twilio.available ? 'Twilio is set up on the server; add your number ' : 'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the server, then add your number '}
              in <button onClick={onOpenSettings} className="underline">Settings</button>. Guide: <code>docs/TWILIO_SETUP.md</code>.
            </SetupNote>
          )}
        </Card>

        <Card icon="🌐" title="Website chat" description="The chat bubble on your website. Always on.">
          <button onClick={onOpenSettings} className="text-sm text-blue-600 hover:underline">Get the install code in Settings →</button>
        </Card>

        <RepairBillCard business={business} onSaved={onSaved} />

        {isAdmin && <div id="server-keys"><ServerKeys onChanged={load} /></div>}

        {!status.publicUrlSet && <SetupNote>PUBLIC_URL isn’t set on the server, so connections can’t finish signing in.</SetupNote>}
      </div>
    </div>
  );
}

/** Forwards website chats, quote and call-back requests to a RepairBill dashboard, so a site needs one widget. */
function RepairBillCard({ business, onSaved }: { business: Business; onSaved: (b: Business) => void }) {
  const [url, setUrl] = useState(business.repairbillUrl ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const connected = Boolean(business.repairbillUrl && business.repairbillKeyHint);

  const run = async (action: () => Promise<{ business: Business }>, done: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await action();
      onSaved(res.business);
      setKey('');
      setStatus({ ok: true, text: done });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
    setBusy(false);
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    run(() => api('/business', { method: 'PATCH', body: { repairbillUrl: url, repairbillKey: key } }), 'Saved');
  };
  const test = () => run(() => api('/business/repairbill/test', { method: 'POST' }), 'Test sent. Check the RepairBill inbox.');
  const disconnect = () => {
    setUrl('');
    run(() => api('/business', { method: 'PATCH', body: { repairbillUrl: '' } }), 'Disconnected');
  };

  return (
    <Card
      icon="🧾"
      title="RepairBill"
      description="Send website chats, quote requests and call-back requests from this business’s chat widget to your RepairBill dashboard too, so your site needs only one chat button."
    >
      {connected && (
        <p className="text-sm">
          <span className={`mr-2 inline-block h-2 w-2 rounded-full ${business.repairbillLastError ? 'bg-red-500' : 'bg-green-500'}`} />
          Sending to {business.repairbillUrl}
          {business.repairbillLastSentAt && <span className="text-slate-400"> · last sent {timeAgo(business.repairbillLastSentAt)} ago</span>}
        </p>
      )}
      {business.repairbillLastError && <p className="text-xs text-red-600">⚠ {business.repairbillLastError}</p>}
      <form onSubmit={save} className="space-y-3">
        <input className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder="RepairBill address, e.g. https://repairbill.shop" value={url} onChange={(e) => setUrl(e.target.value)} />
        <input
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          placeholder={business.repairbillKeyHint ? `Widget API key (saved: ${business.repairbillKeyHint})` : 'Widget API key from RepairBill → Settings'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
        />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button disabled={busy} className="rounded-md bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-60">Save</button>
          {connected && (
            <>
              <button type="button" onClick={test} disabled={busy} className="text-blue-600 hover:underline disabled:opacity-50">Send a test</button>
              <button type="button" onClick={disconnect} disabled={busy} className="text-red-600 hover:underline disabled:opacity-50">Disconnect</button>
            </>
          )}
          {status && <span className={status.ok ? 'text-green-600' : 'text-red-600'}>{status.text}</span>}
        </div>
      </form>
      <p className="text-xs text-slate-500">
        Once this works, remove the RepairBill chat script from your website and keep only the ChatBird one. Each new conversation is sent once (not every message); you reply in ChatBird.
      </p>
    </Card>
  );
}
