import { useEffect, useState } from 'react';
import { api } from '../api';

interface KeyStatus {
  name: string;
  group: string;
  secret: boolean;
  source: 'server' | 'saved' | null;
  preview: string | null;
}

const HELP: Record<string, string> = {
  META_APP_ID: 'Meta app → App settings → Basic → App ID',
  META_APP_SECRET: 'Meta app → App settings → Basic → App secret (Show)',
  META_LOGIN_CONFIG_ID: 'Only for Facebook Login for Business: Configurations → Configuration ID',
  META_VERIFY_TOKEN: 'Any random text; enter the same in the Meta webhook settings',
  GOOGLE_CLIENT_ID: 'Google Cloud → Credentials → OAuth client ID',
  GOOGLE_CLIENT_SECRET: 'Google Cloud → Credentials → Client secret',
  TWILIO_ACCOUNT_SID: 'Twilio Console home → Account Info (starts with AC)',
  TWILIO_AUTH_TOKEN: 'Twilio Console home → Account Info → Auth Token',
  ANTHROPIC_API_KEY: 'console.anthropic.com → API Keys (starts with sk-ant-)',
  SMTP_HOST: 'Your email provider’s SMTP server, e.g. smtp.gmail.com',
  SMTP_PORT: 'Usually 587',
  SMTP_USER: 'Your email login',
  SMTP_PASS: 'Email password or app password',
  SMTP_FROM: 'e.g. ChatDesk <alerts@yourshop.com.au>',
};

/** Owner-only panel for entering integration keys without the hosting dashboard. */
export default function ServerKeys({ onChanged }: { onChanged: () => void }) {
  const [keys, setKeys] = useState<KeyStatus[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    api<{ keys: KeyStatus[] }>('/integrations/keys').then((d) => setKeys(d.keys)).catch((err) => setError(err.message));
  }, []);

  const save = async (name: string, value: string | null) => {
    setError('');
    setSaved('');
    try {
      const d = await api<{ keys: KeyStatus[] }>(`/integrations/keys/${name}`, { method: 'PUT', body: { value } });
      setKeys(d.keys);
      setDrafts((x) => ({ ...x, [name]: '' }));
      setSaved(value ? `${name} saved` : `${name} removed`);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!keys) return error ? <p className="text-sm text-red-600">{error}</p> : null;
  const groups = [...new Set(keys.map((k) => k.group))];

  return (
    <section className="space-y-4 rounded-xl bg-white p-6 shadow-sm">
      <div>
        <h2 className="font-semibold">🔑 Server keys</h2>
        <p className="mt-1 text-sm text-slate-500">
          Only you (the ChatDesk owner) see this. Keys are stored encrypted and work for all your businesses. Secrets are never shown again after saving.
        </p>
      </div>
      {saved && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">✓ {saved}</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {groups.map((group) => (
        <div key={group} className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-700">{group}</h3>
          {keys
            .filter((k) => k.group === group)
            .map((k) => (
              <div key={k.name} className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-xs font-semibold">{k.name}</code>
                  {k.source === 'server' && <span className="rounded bg-slate-100 px-1.5 text-xs text-slate-600">set in Railway</span>}
                  {k.source === 'saved' && <span className="rounded bg-green-100 px-1.5 text-xs text-green-700">saved</span>}
                  {!k.source && <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-700">not set</span>}
                  {k.preview && <span className="truncate font-mono text-xs text-slate-500">{k.preview}</span>}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{HELP[k.name]}</div>
                {k.source !== 'server' && (
                  <form
                    className="mt-2 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (drafts[k.name]?.trim()) save(k.name, drafts[k.name].trim());
                    }}
                  >
                    <input
                      type={k.secret ? 'password' : 'text'}
                      autoComplete="off"
                      value={drafts[k.name] ?? ''}
                      onChange={(e) => setDrafts((x) => ({ ...x, [k.name]: e.target.value }))}
                      placeholder={k.source ? 'Enter a new value to replace it' : 'Paste here'}
                      className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs focus:border-blue-500 focus:outline-none"
                    />
                    <button disabled={!drafts[k.name]?.trim()} className="rounded-md bg-blue-600 px-3 text-xs font-semibold text-white disabled:opacity-40">
                      Save
                    </button>
                    {k.source === 'saved' && (
                      <button type="button" onClick={() => confirm(`Remove ${k.name}?`) && save(k.name, null)} className="text-xs text-red-600 hover:underline">
                        Remove
                      </button>
                    )}
                  </form>
                )}
              </div>
            ))}
        </div>
      ))}
    </section>
  );
}
