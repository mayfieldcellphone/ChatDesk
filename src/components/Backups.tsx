import { useEffect, useState } from 'react';
import { api } from '../api';

interface Backup {
  name: string;
  bytes: number;
  createdAt: string;
}

const size = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Owner-only: the daily database backups, a manual one, and downloads. */
export default function Backups() {
  const [data, setData] = useState<{ backups: Backup[]; keep: number; emailConfigured: boolean; owners: string[] } | null>(null);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api<NonNullable<typeof data>>('/backups').then(setData).catch((err) => setStatus({ ok: false, text: err.message }));
  useEffect(() => {
    load();
  }, []);

  const act = async (what: 'run' | 'email') => {
    setBusy(what);
    setStatus(null);
    try {
      if (what === 'run') {
        const r = await api<{ backup: Backup }>('/backups', { method: 'POST' });
        setStatus({ ok: true, text: `Backup made: ${r.backup.name} (${size(r.backup.bytes)})` });
      } else {
        const r = await api<{ to: string[] }>('/backups/email', { method: 'POST' });
        setStatus({ ok: true, text: `Emailed to ${r.to.join(', ')}` });
      }
      load();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="space-y-4 rounded-xl bg-white p-6 shadow-sm">
      <div>
        <h2 className="font-semibold">Backups</h2>
        <p className="mt-1 text-sm text-slate-500">
          Everything (messages, contacts, reviews, settings) is backed up every night after 3am and kept on the server for {data?.keep ?? 14} days. Every Monday a copy is emailed to{' '}
          {data?.owners.join(', ') || 'you'} so one is always off the server. Download one now and then and keep it in Google Drive too.
        </p>
      </div>
      {data && !data.emailConfigured && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Set up email (SMTP, above) so the weekly copy can be emailed to you.</p>}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => act('run')} disabled={!!busy} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {busy === 'run' ? 'Backing up…' : 'Back up now'}
        </button>
        <button onClick={() => act('email')} disabled={!!busy || !data?.backups.length} className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50">
          {busy === 'email' ? 'Sending…' : 'Email me the latest'}
        </button>
      </div>
      {status && <p className={`text-sm ${status.ok ? 'text-emerald-700' : 'text-red-700'}`}>{status.text}</p>}
      {data && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
          {data.backups.length === 0 && <li className="px-3 py-2 text-slate-500">No backups yet. The first runs tonight, or press Back up now.</li>}
          {data.backups.map((b) => (
            <li key={b.name} className="flex items-center gap-3 px-3 py-2">
              <span className="font-medium">{new Date(b.createdAt).toLocaleString()}</span>
              <span className="text-slate-500">{size(b.bytes)}</span>
              <a href={`/api/backups/${b.name}`} className="ml-auto text-blue-600 hover:underline" download>
                Download
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
