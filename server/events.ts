import type { Request, Response } from 'express';

// Server-sent events hub. Channels are "biz:<businessId>" for the inbox and
// "conv:<conversationId>" for a visitor's open chat widget.
const channels = new Map<string, Set<Response>>();

export function subscribe(channel: string, req: Request, res: Response, onClose?: () => void) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  let set = channels.get(channel);
  if (!set) channels.set(channel, (set = new Set()));
  set.add(res);

  // Comment lines keep proxies from closing idle connections.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (set.size === 0) channels.delete(channel);
    onClose?.();
  });
}

export function publish(channel: string, data: unknown) {
  const set = channels.get(channel);
  if (!set) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
}

export function subscriberCount(channel: string) {
  return channels.get(channel)?.size ?? 0;
}

export const isVisitorOnline = (conversationId: string) => subscriberCount(`conv:${conversationId}`) > 0;
