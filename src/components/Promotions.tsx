import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface ChannelInfo {
  id: string;
  provider: 'google' | 'facebook' | 'instagram';
  name: string;
  available: boolean;
  lastError: string | null;
}

interface Post {
  id: string;
  caption: string;
  imageUrl: string;
  offer: { title: string; start: string; end: string; terms?: string } | null;
  scheduledAt: string | null;
  status: 'scheduled' | 'posting' | 'done' | 'partial' | 'failed' | 'cancelled';
  createdAt: string;
  results: Record<string, { ok: boolean; url?: string; error?: string; name: string; provider: string }>;
}

interface Data {
  channels: ChannelInfo[];
  posts: Post[];
  aiAvailable: boolean;
  business: { name: string; phone: string | null; color: string; website: string | null };
}

const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';
const PROVIDER: Record<ChannelInfo['provider'], string> = { google: 'Google', facebook: 'Facebook', instagram: 'Instagram' };
const SIZE = 1080;

type Style = 'bold' | 'burst' | 'photo';
const STYLES: { value: Style; label: string }[] = [
  { value: 'bold', label: 'Bold' },
  { value: 'burst', label: 'Starburst' },
  { value: 'photo', label: 'Photo' },
];

interface Poster {
  style: Style;
  headline: string;
  big: string;
  details: string;
  footer: string;
  color: string;
}

/** Breaks text into lines that fit, shrinking the font until it fits in maxLines. Returns the font size used. */
function fitLines(ctx: CanvasRenderingContext2D, text: string, weight: number, start: number, min: number, maxWidth: number, maxLines: number) {
  for (let size = start; size >= min; size -= 4) {
    ctx.font = `${weight} ${size}px "Plus Jakarta Sans", system-ui, sans-serif`;
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
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxWidth)) return { size, lines };
  }
  ctx.font = `${weight} ${min}px "Plus Jakarta Sans", system-ui, sans-serif`;
  return { size: min, lines: [text] };
}

function drawLines(ctx: CanvasRenderingContext2D, lines: string[], x: number, y: number, size: number, gap = 1.12) {
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * size * gap));
  return lines.length * size * gap;
}

function starburst(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number, inner: number, points: number) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = (Math.PI * i) / points - Math.PI / 2;
    ctx[i ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  ctx.closePath();
  ctx.fill();
}

/** Draws the poster at 1080×1080. */
function drawPoster(canvas: HTMLCanvasElement, p: Poster, photo: HTMLImageElement | null) {
  const ctx = canvas.getContext('2d')!;
  canvas.width = SIZE;
  canvas.height = SIZE;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const pad = 80;
  const width = SIZE - pad * 2;

  if (p.style === 'photo' && photo) {
    const scale = Math.max(SIZE / photo.width, SIZE / photo.height);
    ctx.drawImage(photo, (SIZE - photo.width * scale) / 2, (SIZE - photo.height * scale) / 2, photo.width * scale, photo.height * scale);
    ctx.fillStyle = 'rgba(15,30,54,0.62)';
    ctx.fillRect(0, SIZE * 0.52, SIZE, SIZE * 0.48);
  } else {
    ctx.fillStyle = p.style === 'burst' ? '#0F1E36' : p.color;
    ctx.fillRect(0, 0, SIZE, SIZE);
  }

  if (p.style === 'bold') {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '700 36px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.fillText(p.footer.split('·')[0].trim().toUpperCase(), SIZE / 2, 70);
    // Shrink everything together until the three blocks fit above the bottom strip.
    let big = fitLines(ctx, p.big, 800, 230, 60, width, 2), head = big, det = big;
    for (let scale = 1; scale >= 0.5; scale -= 0.05) {
      big = fitLines(ctx, p.big, 800, Math.round(230 * scale), 60, width, 2);
      head = fitLines(ctx, p.headline, 800, Math.round(84 * scale), 36, width, 3);
      det = fitLines(ctx, p.details, 600, Math.round(46 * scale), 24, width, 3);
      const total = big.lines.length * big.size + head.lines.length * head.size * 1.12 + det.lines.length * det.size * 1.25 + 60;
      if (150 + total <= SIZE - 150) break;
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `800 ${big.size}px "Plus Jakarta Sans", system-ui, sans-serif`;
    let y = 150 + drawLines(ctx, big.lines, SIZE / 2, 150, big.size, 1.0);
    ctx.font = `800 ${head.size}px "Plus Jakarta Sans", system-ui, sans-serif`;
    y += 30 + drawLines(ctx, head.lines, SIZE / 2, y + 30, head.size);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = `600 ${det.size}px "Plus Jakarta Sans", system-ui, sans-serif`;
    drawLines(ctx, det.lines, SIZE / 2, y + 30, det.size, 1.25);
  } else if (p.style === 'burst') {
    ctx.fillStyle = '#F2A33A';
    starburst(ctx, SIZE / 2, 330, 270, 225, 24);
    ctx.fillStyle = '#0F1E36';
    const big = fitLines(ctx, p.big, 800, 150, 60, 380, 2);
    const bigH = big.lines.length * big.size;
    drawLines(ctx, big.lines, SIZE / 2, 330 - bigH / 2, big.size, 1.0);
    ctx.fillStyle = '#FFFFFF';
    const head = fitLines(ctx, p.headline, 800, 76, 40, width, 2);
    const y = 640 + drawLines(ctx, head.lines, SIZE / 2, 640, head.size);
    ctx.fillStyle = '#C9D2DE';
    const det = fitLines(ctx, p.details, 600, 42, 26, width, 2);
    drawLines(ctx, det.lines, SIZE / 2, y + 22, det.size, 1.25);
  } else {
    // Photo: offer badge top right, text on the darkened lower half.
    ctx.fillStyle = '#F2A33A';
    ctx.beginPath();
    ctx.arc(SIZE - 210, 210, 150, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0F1E36';
    const big = fitLines(ctx, p.big, 800, 88, 36, 205, 3);
    const bigH = big.lines.length * big.size;
    drawLines(ctx, big.lines, SIZE - 210, 210 - bigH / 2, big.size, 1.0);
    ctx.fillStyle = '#FFFFFF';
    const head = fitLines(ctx, p.headline, 800, 78, 40, width, 2);
    const y = 600 + drawLines(ctx, head.lines, SIZE / 2, 600, head.size);
    ctx.fillStyle = '#E8EDF3';
    const det = fitLines(ctx, p.details, 600, 42, 26, width, 2);
    drawLines(ctx, det.lines, SIZE / 2, y + 20, det.size, 1.25);
  }

  // Footer strip: business and phone.
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, SIZE - 120, SIZE, 120);
  ctx.fillStyle = p.style === 'burst' ? '#0F1E36' : p.color;
  const foot = fitLines(ctx, p.footer, 800, 44, 26, width, 1);
  ctx.textBaseline = 'middle';
  ctx.fillText(foot.lines[0], SIZE / 2, SIZE - 60);
}

const toJpeg = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the image'))), 'image/jpeg', 0.92));

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file isn’t an image we can read'));
    img.src = URL.createObjectURL(file);
  });
}

/** Re-encodes the owner's own design as a JPEG (Instagram only accepts JPEG), at most 1440px on its long side. */
function ownImageCanvas(img: HTMLImageElement) {
  const scale = Math.min(1, 1440 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export default function Promotions() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const load = () => api<Data>('/posts').then(setData).catch((err) => setError(err.message));
  useEffect(() => {
    load();
  }, []);
  if (!data) return <p className="text-sm text-slate-400">{error || 'Loading…'}</p>;
  return (
    <div className="space-y-5">
      <Composer data={data} onPosted={load} />
      {data.posts.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold">Your posts</h2>
          {data.posts.map((p) => (
            <PostCard key={p.id} post={p} onChanged={load} />
          ))}
        </section>
      )}
    </div>
  );
}

function Composer({ data, onPosted }: { data: Data; onPosted: () => void }) {
  const b = data.business;
  const [idea, setIdea] = useState('');
  const [source, setSource] = useState<'poster' | 'own'>('poster');
  const [poster, setPoster] = useState<Poster>({
    style: 'bold',
    headline: 'iPhone 14 screen repair',
    big: '25% OFF',
    details: 'This weekend only · walk in, done while you wait',
    footer: [b.name, b.phone].filter(Boolean).join(' · '),
    color: b.color || '#087565',
  });
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [own, setOwn] = useState<HTMLImageElement | null>(null);
  const [caption, setCaption] = useState('');
  const [isOffer, setIsOffer] = useState(true);
  const [offer, setOffer] = useState({ title: '25% off iPhone 14 screen repair', start: today(), end: plusDays(2), terms: '' });
  const [chosen, setChosen] = useState<string[]>(data.channels.filter((c) => c.available).map((c) => c.id));
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Redraw the preview whenever anything changes (after the brand font has loaded).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    document.fonts.ready.then(() => {
      if (source === 'poster') drawPoster(canvas, poster, photo);
      else if (own) {
        const c = ownImageCanvas(own);
        canvas.width = c.width;
        canvas.height = c.height;
        canvas.getContext('2d')!.drawImage(c, 0, 0);
      } else {
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#F1F5F9';
        ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.fillStyle = '#64748B';
        ctx.font = '600 40px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Upload your design', SIZE / 2, SIZE / 2);
      }
    });
  }, [poster, photo, own, source]);

  const ratio = source === 'own' && own ? own.width / own.height : 1;
  const instagramChosen = data.channels.some((c) => c.provider === 'instagram' && chosen.includes(c.id));
  const badRatio = instagramChosen && (ratio < 0.8 || ratio > 1.91);

  /** One click: the brief becomes the poster text, the post text and the offer. */
  const fillAll = async () => {
    if (!idea.trim()) return setStatus({ ok: false, text: 'Say what the post is about first' });
    setBusy('fill');
    setStatus(null);
    try {
      const r = await api<{ big: string; headline: string; details: string; caption: string; offer: typeof offer | null }>('/posts/draft', { method: 'POST', body: { idea } });
      setPoster((p) => ({ ...p, big: r.big || p.big, headline: r.headline || p.headline, details: r.details }));
      setCaption(r.caption);
      setIsOffer(!!r.offer);
      if (r.offer) setOffer(r.offer);
      setSource('poster');
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy('');
    }
  };

  const writeCaption = async () => {
    setBusy('caption');
    setStatus(null);
    try {
      const brief = [idea, source === 'poster' ? `${poster.big} ${poster.headline}. ${poster.details}` : '', isOffer ? `Offer runs ${offer.start} to ${offer.end}.` : ''].filter(Boolean).join('\n');
      const r = await api<{ caption: string }>('/posts/caption', { method: 'POST', body: { idea: brief } });
      setCaption(r.caption);
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy('');
    }
  };

  const publish = async () => {
    setStatus(null);
    if (source === 'own' && !own) return setStatus({ ok: false, text: 'Upload your design first' });
    if (when === 'later' && !at) return setStatus({ ok: false, text: 'Choose when to post' });
    setBusy('post');
    try {
      const blob = await toJpeg(canvasRef.current!);
      const up = await fetch('/api/posts/media', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      const media = await up.json();
      if (!up.ok) throw new Error(media.error || 'The image didn’t upload');
      await api('/posts', {
        method: 'POST',
        body: {
          caption,
          mediaId: media.id,
          channels: chosen,
          offer: isOffer ? offer : null,
          scheduledAt: when === 'later' ? new Date(at).toISOString() : null,
        },
      });
      setStatus({ ok: true, text: when === 'later' ? 'Scheduled.' : 'Posted. See the results below.' });
      onPosted();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="space-y-4 rounded-xl bg-white p-5 shadow-sm">
      <div>
        <h2 className="font-semibold">New post</h2>
        <p className="text-sm text-slate-500">One post to Google, Facebook and Instagram at once.</p>
      </div>
      <div className="text-sm">
        <label htmlFor="post-idea" className="mb-1 block font-medium">What’s it about?</label>
        <div className="flex gap-2">
          <input
            id="post-idea"
            className={input}
            value={idea}
            maxLength={300}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && data.aiAvailable && (e.preventDefault(), fillAll())}
            placeholder="e.g. iPhone back glass replacement 25% off, iPhone X to iPhone 15, this weekend"
          />
          {data.aiAvailable && (
            <button type="button" onClick={fillAll} disabled={!!busy} className="shrink-0 rounded-md bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              {busy === 'fill' ? 'Making it…' : '✨ Make my post'}
            </button>
          )}
        </div>
        <span className="mt-1 block text-xs text-slate-500">
          {data.aiAvailable ? 'Fills in the poster, the post text and the offer dates. You can change anything after.' : 'Add ANTHROPIC_API_KEY under Integrations → Server keys to have this filled in for you.'}
        </span>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-3">
          <div className="flex rounded-md border border-slate-300 p-0.5 text-sm">
            <button type="button" onClick={() => setSource('poster')} className={`flex-1 rounded px-3 py-1.5 ${source === 'poster' ? 'bg-slate-900 text-white' : 'text-slate-600'}`}>
              Make a poster
            </button>
            <button type="button" onClick={() => setSource('own')} className={`flex-1 rounded px-3 py-1.5 ${source === 'own' ? 'bg-slate-900 text-white' : 'text-slate-600'}`}>
              Use my own design
            </button>
          </div>
          {source === 'poster' ? (
            <>
              <div className="flex gap-2">
                {STYLES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setPoster({ ...poster, style: s.value })}
                    className={`flex-1 rounded-md border px-2 py-1.5 text-sm ${poster.style === s.value ? 'border-blue-600 bg-blue-50 font-semibold text-blue-700' : 'border-slate-300'}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Big text</span>
                <input className={input} value={poster.big} maxLength={30} onChange={(e) => setPoster({ ...poster, big: e.target.value })} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Headline</span>
                <input className={input} value={poster.headline} maxLength={60} onChange={(e) => setPoster({ ...poster, headline: e.target.value })} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Details</span>
                <input className={input} value={poster.details} maxLength={90} onChange={(e) => setPoster({ ...poster, details: e.target.value })} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Bottom line</span>
                <input className={input} value={poster.footer} maxLength={60} onChange={(e) => setPoster({ ...poster, footer: e.target.value })} />
              </label>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                {poster.style !== 'burst' && (
                  <label className="flex items-center gap-2">
                    Colour <input type="color" value={poster.color} onChange={(e) => setPoster({ ...poster, color: e.target.value })} className="h-8 w-10 rounded border border-slate-300" />
                  </label>
                )}
                {poster.style === 'photo' && (
                  <label className="cursor-pointer text-blue-600 hover:underline">
                    {photo ? 'Change photo' : 'Add a photo'}
                    <input type="file" accept="image/*" className="hidden" onChange={async (e) => e.target.files?.[0] && setPhoto(await loadImage(e.target.files[0]))} />
                  </label>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-2 text-sm">
              <p className="text-slate-600">Design it in PosterMyWall or Canva, download it as an image (square works everywhere), then upload it here.</p>
              <label className="inline-block cursor-pointer rounded-md bg-slate-900 px-4 py-2 font-semibold text-white">
                {own ? 'Choose another image' : 'Upload image'}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      setOwn(await loadImage(f));
                    } catch (err) {
                      setStatus({ ok: false, text: (err as Error).message });
                    }
                  }}
                />
              </label>
            </div>
          )}
        </div>
        <div>
          <canvas ref={canvasRef} className="w-full rounded-lg border border-slate-200" aria-label="Post image preview" />
          {badRatio && <p className="mt-1 text-xs text-amber-700">Instagram needs an image between portrait 4:5 and landscape 1.91:1. Use a square design for Instagram.</p>}
        </div>
      </div>

      <label className="block text-sm">
        <span className="mb-1 flex items-center gap-3 font-medium">
          Post text
          {data.aiAvailable && (
            <button type="button" onClick={writeCaption} disabled={!!busy} className="rounded-md bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50">
              {busy === 'caption' ? 'Writing…' : '✨ Write it for me'}
            </button>
          )}
        </span>
        <textarea className={`${input} min-h-28`} value={caption} maxLength={2000} onChange={(e) => setCaption(e.target.value)} placeholder="What the post says" />
      </label>

      <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm">
        <label className="flex items-center gap-2 font-medium">
          <input type="checkbox" checked={isOffer} onChange={(e) => setIsOffer(e.target.checked)} />
          It’s an offer with dates (shows as an Offer on Google)
        </label>
        {isOffer && (
          <div className="grid gap-2 sm:grid-cols-4">
            <input className={`${input} sm:col-span-2`} aria-label="Offer title" maxLength={58} value={offer.title} onChange={(e) => setOffer({ ...offer, title: e.target.value })} />
            <input type="date" className={input} aria-label="Starts" value={offer.start} onChange={(e) => setOffer({ ...offer, start: e.target.value })} />
            <input type="date" className={input} aria-label="Ends" value={offer.end} min={offer.start} onChange={(e) => setOffer({ ...offer, end: e.target.value })} />
            <input className={`${input} sm:col-span-4`} aria-label="Terms" placeholder="Terms (optional), e.g. Not with any other offer" value={offer.terms} onChange={(e) => setOffer({ ...offer, terms: e.target.value })} />
          </div>
        )}
      </div>

      <fieldset className="text-sm">
        <legend className="mb-1 font-medium">Post to</legend>
        {data.channels.length === 0 && <p className="text-slate-500">Connect Google and Facebook/Instagram under Integrations first.</p>}
        <div className="flex flex-wrap gap-2">
          {data.channels.map((c) => (
            <label key={c.id} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${chosen.includes(c.id) ? 'border-blue-600 bg-blue-50' : 'border-slate-300'} ${c.available ? '' : 'opacity-50'}`}>
              <input
                type="checkbox"
                disabled={!c.available}
                checked={chosen.includes(c.id)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))}
              />
              <span className="font-medium">{PROVIDER[c.provider]}</span> <span className="text-slate-500">{c.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} /> Post now
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} /> Schedule
        </label>
        {when === 'later' && <input type="datetime-local" className={`${input} w-auto`} aria-label="When" value={at} onChange={(e) => setAt(e.target.value)} />}
        <button
          onClick={publish}
          disabled={!!busy || !caption.trim() || chosen.length === 0}
          className="ml-auto rounded-md bg-blue-600 px-5 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy === 'post' ? 'Posting…' : when === 'later' ? 'Schedule post' : 'Post now'}
        </button>
      </div>
      {status && <p className={`rounded-md px-3 py-2 text-sm ${status.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{status.text}</p>}
    </section>
  );
}

const STATUS: Record<Post['status'], string> = {
  scheduled: 'bg-amber-100 text-amber-800',
  posting: 'bg-blue-100 text-blue-800',
  done: 'bg-emerald-100 text-emerald-800',
  partial: 'bg-amber-100 text-amber-800',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-600',
};

function PostCard({ post, onChanged }: { post: Post; onChanged: () => void }) {
  const cancel = async () => {
    await api(`/posts/${post.id}/cancel`, { method: 'POST' }).catch(() => {});
    onChanged();
  };
  return (
    <div className="flex gap-4 rounded-xl bg-white p-4 shadow-sm">
      <img src={post.imageUrl} alt="" className="h-24 w-24 shrink-0 rounded-lg object-cover" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[post.status]}`}>
            {post.status === 'scheduled' && post.scheduledAt ? `Scheduled ${new Date(post.scheduledAt).toLocaleString()}` : post.status === 'partial' ? 'Partly posted' : post.status}
          </span>
          {post.offer && <span className="text-xs text-slate-500">Offer {post.offer.start} – {post.offer.end}</span>}
          {post.status === 'scheduled' && (
            <button onClick={cancel} className="ml-auto text-xs text-red-600 hover:underline">
              Cancel
            </button>
          )}
        </div>
        <p className="mt-1 line-clamp-2 text-slate-700">{post.caption}</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {Object.entries(post.results).map(([id, r]) =>
            r.ok ? (
              <a key={id} href={r.url} target="_blank" rel="noreferrer" className="font-medium">
                ✓ {PROVIDER[r.provider as ChannelInfo['provider']]} · {r.name}
              </a>
            ) : (
              <span key={id} className="text-red-700" title={r.error}>
                ✗ {PROVIDER[r.provider as ChannelInfo['provider']]} · {r.name}: {r.error}
              </span>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
