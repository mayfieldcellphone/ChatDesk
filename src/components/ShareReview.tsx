import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { MIX_COLOURS, PROVIDER, SIZE, toJpeg, type Data } from './Promotions';

interface ShareableReview {
  id: string;
  authorName: string;
  rating: number;
  comment: string | null;
  location: string;
}

type Look = 'light' | 'dark' | 'colour';
const LOOKS: Look[] = ['light', 'dark', 'colour'];
const font = (weight: number, size: number) => `${weight} ${size}px "Plus Jakarta Sans", system-ui, sans-serif`;
const STAR = 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z';

/** "Sarah Nguyen" → "Sarah N." (the name is public on Google, but a shared post needn't carry it in full). */
export const shortName = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest[rest.length - 1][0].toUpperCase()}.` : first;
};

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/** Draws the review as a square picture: stars, the quote (shrunk to fit), who said it, and the business. */
export function drawReviewCard(canvas: HTMLCanvasElement, r: ShareableReview, look: Look, colour: string, business: { name: string; phone: string | null }) {
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const bg = look === 'light' ? '#FFFFFF' : look === 'dark' ? '#0F1E36' : colour;
  const ink = look === 'light' ? '#0F1E36' : '#FFFFFF';
  const soft = look === 'light' ? '#475569' : 'rgba(255,255,255,0.8)';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SIZE, SIZE);
  if (look === 'light') {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, SIZE, 24);
  }
  // Big quote mark
  ctx.fillStyle = look === 'light' ? colour : 'rgba(255,255,255,0.18)';
  ctx.font = font(800, 320);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('“', 60, 20);
  // Stars
  const starSize = 64;
  const starsWidth = 5 * starSize + 4 * 12;
  for (let i = 0; i < 5; i++) {
    ctx.save();
    ctx.translate((SIZE - starsWidth) / 2 + i * (starSize + 12), 150);
    ctx.scale(starSize / 24, starSize / 24);
    ctx.fillStyle = i < r.rating ? '#F5A623' : look === 'light' ? '#D9DEE5' : 'rgba(255,255,255,0.25)';
    ctx.fill(new Path2D(STAR));
    ctx.restore();
  }
  // The quote, as large as fits
  const words = (r.comment ?? '').split(/\n\n\(Original\)\n|\(Translated by Google\)/)[0].trim();
  const quote = words.length > 320 ? `${words.slice(0, 317).replace(/\s+\S*$/, '')}…` : words;
  ctx.textAlign = 'center';
  ctx.fillStyle = ink;
  let size = 64;
  let lines: string[] = [];
  for (; size >= 30; size -= 2) {
    ctx.font = font(700, size);
    lines = wrap(ctx, quote, SIZE - 180);
    if (lines.length * size * 1.3 <= 520) break;
  }
  const top = 260 + (520 - lines.length * size * 1.3) / 2;
  lines.forEach((l, i) => ctx.fillText(l, SIZE / 2, top + i * size * 1.3));
  // Who said it
  ctx.fillStyle = soft;
  ctx.font = font(600, 38);
  ctx.fillText(`— ${shortName(r.authorName)}, Google review`, SIZE / 2, 820);
  // Footer
  ctx.fillStyle = look === 'light' ? colour : 'rgba(255,255,255,0.12)';
  ctx.fillRect(0, SIZE - 130, SIZE, 130);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = font(800, 42);
  ctx.textBaseline = 'middle';
  ctx.fillText([business.name, business.phone].filter(Boolean).join(' · '), SIZE / 2, SIZE - 65);
}

/** 📣 Share: a picture of the review plus a thank-you caption, posted to Google, Facebook and Instagram. */
export default function ShareReview({ review, onClose, onShared }: { review: ShareableReview; onClose: () => void; onShared: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [look, setLook] = useState<Look>('light');
  const [colour, setColour] = useState('#087565');
  const [caption, setCaption] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    api<Data>('/posts')
      .then((d) => {
        setData(d);
        setColour(d.business.color || '#087565');
        setChosen(d.channels.filter((c) => c.available && c.provider !== 'google').map((c) => c.id));
        const first = shortName(review.authorName).split(' ')[0];
        const contact = [d.business.phone && `📞 ${d.business.phone}`, d.business.website].filter(Boolean).join(' · ');
        setCaption(`${'⭐'.repeat(review.rating)} Thank you, ${first}! Reviews like this make our day.\n\nNeed a repair? Pop in or get in touch.${contact ? `\n${contact}` : ''}\n\n#customerlove #reviews #phonerepair`);
      })
      .catch((err) => setError((err as Error).message));
  }, [review]);

  useEffect(() => {
    if (!data || !canvasRef.current) return;
    document.fonts.ready.then(() => drawReviewCard(canvasRef.current!, review, look, colour, data.business));
  }, [data, look, colour, review]);

  const newDesign = () => {
    const looks = LOOKS.filter((l) => l !== look);
    setLook(looks[Math.floor(Math.random() * looks.length)]);
    const colours = MIX_COLOURS.filter((c) => c !== colour);
    setColour(colours[Math.floor(Math.random() * colours.length)]);
  };

  const share = async () => {
    setBusy(true);
    setError('');
    try {
      const blob = await toJpeg(canvasRef.current!);
      const up = await fetch('/api/posts/media', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      const media = await up.json();
      if (!up.ok) throw new Error(media.error || 'The picture didn’t upload');
      const r = await api<{ post: { status: string; results: Record<string, { ok: boolean; error?: string; provider: string }> } }>('/posts', {
        method: 'POST',
        body: { caption, mediaId: media.id, channels: chosen, reviewId: review.id },
      });
      const failed = Object.values(r.post.results).filter((x) => !x.ok);
      if (failed.length === Object.keys(r.post.results).length) throw new Error(failed[0]?.error || 'It didn’t post');
      onShared();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div className="max-h-full w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center">
          <h2 className="font-semibold">Share this review</h2>
          <button onClick={onClose} className="ml-auto px-2 text-xl text-slate-400 hover:text-slate-700" aria-label="Close">
            ×
          </button>
        </div>
        {!data ? (
          <p className="text-sm text-slate-500">{error || 'Loading…'}</p>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-2">
              <canvas ref={canvasRef} className="w-full rounded-lg border border-slate-200" aria-label="Review picture" />
              <button type="button" onClick={newDesign} className="text-sm font-medium text-blue-600 hover:underline">
                🎲 New design
              </button>
            </div>
            <div className="space-y-4 text-sm">
              <label className="block">
                <span className="mb-1 block font-medium">Post text</span>
                <textarea className="min-h-40 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" maxLength={2000} value={caption} onChange={(e) => setCaption(e.target.value)} />
              </label>
              <fieldset>
                <legend className="mb-1 font-medium">Post to</legend>
                {data.channels.length === 0 && <p className="text-slate-500">Connect Facebook/Instagram under Integrations first.</p>}
                <div className="flex flex-wrap gap-2">
                  {data.channels.map((c) => (
                    <label key={c.id} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${chosen.includes(c.id) ? 'border-blue-600 bg-blue-50' : 'border-slate-300'} ${c.available ? '' : 'opacity-50'}`}>
                      <input type="checkbox" disabled={!c.available} checked={chosen.includes(c.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))} />
                      <span className="font-medium">{PROVIDER[c.provider]}</span> <span className="text-slate-500">{c.name}</span>
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-slate-500">The review is already on Google, so Google isn’t ticked; tick it to post it there too.</p>
              </fieldset>
              {error && <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>}
              <button onClick={share} disabled={busy || chosen.length === 0 || !caption.trim()} className="w-full rounded-md bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {busy ? 'Posting…' : 'Post now'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
