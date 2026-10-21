import type { Request, Response } from 'express';

// Server-sent events hub. Channels are "biz:<businessId>" for the inbox (one connection can follow
// every business the user runs) and "conv:<conversationId>" for a visitor's open chat widget.
const channels = new Map<string, Set<Response>>();

export function subscribe(channelOrChannels: string | string[], req: Request, res: Response, onClose?: () => void) {
  const names = ([] as string[]).concat(channelOrChannels);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  for (const name of names) {
    let set = channels.get(name);
    if (!set) channels.set(name, (set = new Set()));
    set.add(res);
  }

  // Comment lines keep proxies from closing idle connections.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    for (const name of names) {
      const set = channels.get(name);
      set?.delete(res);
      if (set?.size === 0) channels.delete(name);
    }
    onClose?.();
  });
}

export function publish(channel: string, data: unknown) {
  const set = channels.get(channel);
  if (!set) return;
  // Say which business an inbox event belongs to, since one connection may follow several.
  const body = channel.startsWith('biz:') && data && typeof data === 'object' ? { ...data, businessId: channel.slice(4) } : data;
  const payload = `data: ${JSON.stringify(body)}\n\n`;
  for (const res of set) res.write(payload);
}

export function subscriberCount(channel: string) {
  return channels.get(channel)?.size ?? 0;
}

export const isVisitorOnline = (conversationId: string) => subscriberCount(`conv:${conversationId}`) > 0;
