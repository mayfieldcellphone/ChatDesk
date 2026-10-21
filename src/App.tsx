import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Me } from './api';
import Login from './components/Login';
import Inbox from './components/Inbox';
import Settings from './components/Settings';
import Reviews from './components/Reviews';
import Integrations from './components/Integrations';

const VIEWS = ['inbox', 'reviews', 'integrations', 'settings'] as const;
type View = (typeof VIEWS)[number];

/**
 * Reads the address once, then tidies it: ?view=, a sign-in result from Integrations, and
 * ?business=&conversation= from a notification.
 */
function initialRoute() {
  const params = new URLSearchParams(location.search);
  const view = VIEWS.find((v) => v === params.get('view')) ?? 'inbox';
  const connected = params.get('connected');
  const error = params.get('error');
  if (params.toString()) history.replaceState(null, '', '/');
  return {
    view,
    notice: connected ? { ok: true, text: `Connected: ${connected}` } : error ? { ok: false, text: error } : null,
    businessId: params.get('business'),
    conversationId: params.get('conversation'),
  };
}
const route = initialRoute();

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>(route.view);
  const [autoImport, setAutoImport] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  const loadMe = () =>
    api<Me>('/me')
      .then(setMe)
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
        setMe(null);
      })
      .finally(() => setLoading(false));

  const switchBusiness = async (businessId: string) => {
    await api('/auth/switch', { method: 'POST', body: { businessId } });
    await loadMe();
  };

  useEffect(() => {
    (async () => {
      // A notification for another business opens that business first.
      if (route.businessId) await api('/auth/switch', { method: 'POST', body: { businessId: route.businessId } }).catch(() => {});
      await loadMe();
    })();
  }, []);

  // Keep the sidebar's unread counts fresh without reloading on every event.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshCounts = () => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => api<Me>('/me').then(setMe).catch(() => {}), 800);
  };

  if (loading) return <div className="flex h-full items-center justify-center text-slate-500">Loading…</div>;
  if (!me)
    return (
      <Login
        onSignedIn={(isNewAccount) => {
          // New accounts land on Settings, which reads their website straight away if they gave one.
          if (isNewAccount) {
            setView('settings');
            setAutoImport(true);
          }
          loadMe();
        }}
      />
    );

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    setMe(null);
  };
  const go = (v: View) => {
    setView(v);
    setMenuOpen(false);
  };
  const totalUnread = me.businesses.reduce((n, b) => n + b.unread, 0);

  const sidebar = (
    <nav className="flex h-full w-64 shrink-0 flex-col bg-slate-900 text-slate-300">
      <div className="px-5 pb-3 pt-5 text-lg font-bold text-white">ChatDesk</div>
      <div className="mx-2 mb-3 space-y-0.5 rounded-lg bg-slate-800/60 p-1.5">
        {me.businesses.map((b) => (
          <button
            key={b.id}
            onClick={() => {
              if (b.id !== me.business.id) switchBusiness(b.id);
              setMenuOpen(false);
            }}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ${b.id === me.business.id ? 'bg-slate-700 text-white' : 'hover:bg-slate-800'}`}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: b.color }} />
            <span className="truncate">{b.name}</span>
            {b.unread > 0 && <span className="ml-auto rounded-full bg-blue-600 px-1.5 text-[10px] font-bold text-white">{b.unread}</span>}
          </button>
        ))}
        <button onClick={() => setAdding(true)} className="w-full rounded-md px-2.5 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-800 hover:text-white">
          + Add a business
        </button>
      </div>
      {VIEWS.map((v) => (
        <button
          key={v}
          onClick={() => go(v)}
          className={`mx-2 rounded-md px-3 py-2 text-left text-sm font-medium capitalize ${view === v ? 'bg-slate-700 text-white' : 'hover:bg-slate-800'}`}
        >
          {v}
        </button>
      ))}
      <div className="mt-auto border-t border-slate-800 px-5 py-4 text-xs">
        <div className="truncate text-slate-200">{me.user.name}</div>
        <div className="truncate text-slate-500">{me.user.email}</div>
        <button onClick={logout} className="mt-2 text-slate-400 hover:text-white">
          Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full flex-col md:flex-row">
      <div className="hidden md:block">{sidebar}</div>

      {/* Phone: top bar and slide-out menu */}
      <header className="flex items-center gap-3 bg-slate-900 px-4 py-3 text-white md:hidden">
        <button onClick={() => setMenuOpen(true)} aria-label="Menu" className="relative text-xl leading-none">
          ☰
          {totalUnread > 0 && <span className="absolute -right-2 -top-1 h-2.5 w-2.5 rounded-full bg-blue-500" />}
        </button>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: me.business.color }} />
        <span className="truncate font-semibold">{me.business.name}</span>
        <span className="ml-auto text-sm capitalize text-slate-400">{view}</span>
      </header>
      {menuOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="h-full">{sidebar}</div>
          <button aria-label="Close menu" className="flex-1 bg-black/40" onClick={() => setMenuOpen(false)} />
        </div>
      )}

      <main className="min-h-0 min-w-0 flex-1">
        {view === 'inbox' ? (
          <Inbox
            business={me.business}
            businesses={me.businesses}
            initialConversationId={route.conversationId}
            onSwitchBusiness={switchBusiness}
            onActivity={refreshCounts}
            onOpenSettings={() => setView('settings')}
          />
        ) : view === 'reviews' ? (
          <Reviews key={me.business.id} business={me.business} onSaved={(business) => setMe({ ...me, business })} onOpenIntegrations={() => setView('integrations')} />
        ) : view === 'integrations' ? (
          <Integrations key={me.business.id} notice={route.notice} onOpenSettings={() => setView('settings')} />
        ) : (
          <Settings
            key={me.business.id}
            autoImport={autoImport && !me.business.websiteImportedAt}
            business={me.business}
            notifyEmail={me.user.notifyEmail}
            userPhone={me.user.phone}
            onSaved={(business) => setMe({ ...me, business })}
            onNotifyEmailChange={(notifyEmail) => setMe({ ...me, user: { ...me.user, notifyEmail } })}
            onUserPhoneChange={(phone) => setMe({ ...me, user: { ...me.user, phone } })}
          />
        )}
      </main>

      {adding && (
        <AddBusiness
          onClose={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false);
            setMenuOpen(false);
            await loadMe();
            // Straight to Settings, which reads the new site's website if one was given.
            setView('settings');
            setAutoImport(true);
          }}
        />
      )}
    </div>
  );
}

function AddBusiness({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/businesses', { method: 'POST', body: { name, website } });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-4 rounded-xl bg-white p-6 shadow-xl">
        <div>
          <h2 className="text-lg font-semibold">Add a business</h2>
          <p className="text-sm text-slate-500">Each business gets its own chat widget, phone number, settings and connected accounts. You manage them all from this login.</p>
        </div>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <input autoFocus className={input} placeholder="Business name, e.g. RepairRange" value={name} onChange={(e) => setName(e.target.value)} required />
        <input className={input} placeholder="Website (optional), e.g. repairrange.io" value={website} onChange={(e) => setWebsite(e.target.value)} />
        <div className="flex gap-3">
          <button disabled={busy} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            Add business
          </button>
          <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:underline">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
