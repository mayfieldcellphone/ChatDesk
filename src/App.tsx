import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import Login from './components/Login';
import Inbox from './components/Inbox';
import Settings from './components/Settings';

type View = 'inbox' | 'settings';

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('inbox');

  const loadMe = () =>
    api<Me>('/me')
      .then(setMe)
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
        setMe(null);
      })
      .finally(() => setLoading(false));

  useEffect(() => {
    loadMe();
  }, []);

  if (loading) return <div className="flex h-full items-center justify-center text-slate-500">Loading…</div>;
  if (!me) return <Login onSignedIn={loadMe} />;

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    setMe(null);
  };

  return (
    <div className="flex h-full">
      <nav className="flex w-56 shrink-0 flex-col bg-slate-900 text-slate-300">
        <div className="px-5 py-5">
          <div className="text-lg font-bold text-white">ChatDesk</div>
          <div className="truncate text-xs text-slate-400">{me.business.name}</div>
        </div>
        {(['inbox', 'settings'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`mx-2 rounded-md px-3 py-2 text-left text-sm font-medium capitalize ${
              view === v ? 'bg-slate-700 text-white' : 'hover:bg-slate-800'
            }`}
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
      <main className="min-w-0 flex-1">
        {view === 'inbox' ? (
          <Inbox business={me.business} onOpenSettings={() => setView('settings')} />
        ) : (
          <Settings business={me.business} onSaved={(business) => setMe({ ...me, business })} />
        )}
      </main>
    </div>
  );
}
