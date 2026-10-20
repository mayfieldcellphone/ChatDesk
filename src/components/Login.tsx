import { useState, type FormEvent } from 'react';
import { api } from '../api';

export default function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ businessName: '', name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/auth/${mode}`, { method: 'POST', body: form });
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';

  return (
    <div className="flex h-full items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl bg-white p-8 shadow">
        <div>
          <h1 className="text-2xl font-bold">ChatDesk</h1>
          <p className="text-sm text-slate-500">
            {mode === 'login' ? 'Sign in to your inbox' : 'Create an account for your business'}
          </p>
        </div>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {mode === 'signup' && (
          <>
            <input className={input} placeholder="Business name" value={form.businessName} onChange={set('businessName')} required />
            <input className={input} placeholder="Your name" value={form.name} onChange={set('name')} autoComplete="name" required />
          </>
        )}
        <input className={input} type="email" placeholder="Email" value={form.email} onChange={set('email')} autoComplete="email" required />
        <input
          className={input}
          type="password"
          placeholder="Password"
          value={form.password}
          onChange={set('password')}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          minLength={mode === 'signup' ? 8 : undefined}
          required
        />
        <button disabled={busy} className="w-full rounded-md bg-blue-600 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'signup' : 'login');
            setError('');
          }}
          className="w-full text-sm text-blue-600 hover:underline"
        >
          {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
