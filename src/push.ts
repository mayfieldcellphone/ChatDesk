import { useEffect, useState } from 'react';
import { api } from './api';

export type PushState = 'loading' | 'unsupported' | 'needs-install' | 'off' | 'on' | 'blocked';

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

function keyBytes(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** The service worker registration, or null if it isn't available within a few seconds. */
async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
}

/** Push notifications for this device: current state, and turning them on/off. */
export function usePush() {
  const [state, setState] = useState<PushState>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      // iPhones only allow push for web apps added to the Home Screen.
      if (isIos() && !isInstalled()) return setState('needs-install');
      if (!('PushManager' in window) || !('Notification' in window)) return setState('unsupported');
      const reg = await registration();
      if (!reg) return setState('unsupported');
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? 'on' : Notification.permission === 'denied' ? 'blocked' : 'off');
    })().catch(() => setState('unsupported'));
  }, []);

  const enable = async () => {
    setError('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setState('blocked');
      const reg = await registration();
      if (!reg) throw new Error('Notifications aren’t available in this browser.');
      const { publicKey } = await api<{ publicKey: string }>('/push/key');
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
      await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      setState('on');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const disable = async () => {
    const sub = await (await registration())?.pushManager.getSubscription();
    if (sub) {
      await api('/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
    setState('off');
  };

  const test = () => api('/push/test', { method: 'POST' });

  return { state, error, enable, disable, test, ios: isIos() };
}
