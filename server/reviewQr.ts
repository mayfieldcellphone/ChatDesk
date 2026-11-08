import { Router } from 'express';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { all, get, newId, now, run, type Business, type Connection, type Review } from './db';
import { requireAuth } from './auth';
import { locationReviewLink, reviewLink } from './google';
import { publicUrl } from './twilio';
import { rateLimit } from './rateLimit';

/**
 * In-store review QR codes. A printed code opens ChatBird's short link (/q/…), which counts the scan
 * and goes straight on to Google's "write a review" page for that location. Reviews then arrive in
 * ChatBird as usual; one that comes in soon after a scan of that location is marked "via QR code".
 */
const QR_WINDOW_MS = 3 * 60 * 60 * 1000;

export const qrUrl = (code: string) => `${publicUrl()}/q/${code}`;

function target(businessId: string, connectionId: string | null) {
  const connection = connectionId ? get<Connection>('SELECT * FROM connections WHERE id = ? AND business_id = ?', connectionId, businessId) : undefined;
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  return (connection && locationReviewLink(connection)) || reviewLink(business);
}

/** Called by the review sync with newly arrived reviews: marks those that followed a scan. */
export function markQrReviews(connectionId: string, reviews: Review[]) {
  for (const r of reviews) {
    const from = new Date(Date.parse(r.review_created_at) - QR_WINDOW_MS).toISOString();
    const scan = get<{ label: string }>(
      `SELECT q.label FROM review_qr_scans s JOIN review_qr_codes q ON q.id = s.qr_id
        WHERE q.connection_id = ? AND s.scanned_at BETWEEN ? AND ? ORDER BY s.scanned_at DESC LIMIT 1`,
      connectionId, from, r.review_created_at,
    );
    if (scan) run('UPDATE reviews SET via_qr = ? WHERE id = ?', scan.label, r.id);
  }
}

// ---------- Public: the printed code's link ----------

export const qrRedirectRouter = Router();
qrRedirectRouter.get('/:code', rateLimit('qr-scan', 120, 60 * 1000), (req, res) => {
  const qr = get<{ id: string; business_id: string; connection_id: string | null }>('SELECT id, business_id, connection_id FROM review_qr_codes WHERE code = ?', req.params.code);
  const link = qr && target(qr.business_id, qr.connection_id);
  if (!qr || !link) return res.status(404).type('text').send('This review code isn’t active any more.');
  run('INSERT INTO review_qr_scans (id, qr_id, scanned_at) VALUES (?, ?, ?)', newId(), qr.id, now());
  res.set('Cache-Control', 'no-store').redirect(302, link);
});

// ---------- Owner: Reviews → QR codes ----------

export const reviewQrRouter = Router();
reviewQrRouter.use(requireAuth);

interface QrRow {
  id: string;
  code: string;
  label: string;
  connection_id: string | null;
  created_at: string;
}

reviewQrRouter.get('/', (req, res) => {
  const { businessId } = req.session!;
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const codes = all<QrRow>('SELECT * FROM review_qr_codes WHERE business_id = ? ORDER BY created_at', businessId).map((q) => {
    const stats = get<{ total: number; month: number; last: string | null }>(
      'SELECT COUNT(*) AS total, COALESCE(SUM(scanned_at > ?), 0) AS month, MAX(scanned_at) AS last FROM review_qr_scans WHERE qr_id = ?',
      monthAgo, q.id,
    )!;
    const reviews = get<{ n: number }>('SELECT COUNT(*) AS n FROM reviews WHERE business_id = ? AND connection_id IS ? AND via_qr = ?', businessId, q.connection_id, q.label)!.n;
    return { id: q.id, label: q.label, connectionId: q.connection_id, url: qrUrl(q.code), scans: stats.total, scansThisMonth: stats.month, lastScan: stats.last, reviews, working: Boolean(target(businessId, q.connection_id)) };
  });
  const locations = all<Connection>("SELECT * FROM connections WHERE business_id = ? AND provider = 'google' ORDER BY created_at", businessId).map((c) => ({ id: c.id, name: c.name }));
  res.json({ codes, locations });
});

reviewQrRouter.post('/', (req, res) => {
  const { businessId } = req.session!;
  const label = String(req.body.label ?? '').trim().slice(0, 40) || 'Counter';
  const connectionId = req.body.connectionId ? get<{ id: string }>("SELECT id FROM connections WHERE id = ? AND business_id = ? AND provider = 'google'", String(req.body.connectionId), businessId)?.id ?? null : null;
  if (!target(businessId, connectionId)) return res.status(400).json({ error: 'Connect Google Business Profile or add your review link on this page first.' });
  if (get('SELECT 1 FROM review_qr_codes WHERE business_id = ? AND label = ? COLLATE NOCASE AND connection_id IS ?', businessId, label, connectionId)) {
    return res.status(400).json({ error: 'There’s already a code with that name' });
  }
  const id = newId();
  run('INSERT INTO review_qr_codes (id, business_id, code, label, connection_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, businessId, crypto.randomBytes(5).toString('base64url'), label, connectionId, now());
  res.status(201).json({ id });
});

reviewQrRouter.delete('/:id', (req, res) => {
  const result = run('DELETE FROM review_qr_codes WHERE id = ? AND business_id = ?', req.params.id, req.session!.businessId);
  res.status(result.changes ? 200 : 404).json({ ok: Boolean(result.changes) });
});

const loadCode = (id: string, businessId: string) => get<QrRow>('SELECT * FROM review_qr_codes WHERE id = ? AND business_id = ?', id, businessId);

/** The code as SVG (sharp at any print size), or PNG for apps that want a picture. */
reviewQrRouter.get('/:id/qr.:ext(svg|png)', async (req, res) => {
  const q = loadCode(req.params.id, req.session!.businessId);
  if (!q) return res.sendStatus(404);
  const options = { errorCorrectionLevel: 'M' as const, margin: 2, color: { dark: '#0F1E36', light: '#FFFFFF' } };
  const name = `review-qr-${q.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  if (req.params.ext === 'svg') {
    res.type('image/svg+xml').set('Content-Disposition', `inline; filename="${name}.svg"`).send(await QRCode.toString(qrUrl(q.code), { ...options, type: 'svg' }));
  } else {
    res.type('image/png').set('Content-Disposition', `attachment; filename="${name}.png"`).send(await QRCode.toBuffer(qrUrl(q.code), { ...options, width: 1200 }));
  }
});

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A printable counter card: big code, stars, a short ask, the business name. Two to an A4 page. */
reviewQrRouter.get('/:id/print', async (req, res) => {
  const { businessId } = req.session!;
  const q = loadCode(req.params.id, businessId);
  if (!q) return res.sendStatus(404);
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', businessId)!;
  const location = q.connection_id ? get<Connection>('SELECT name FROM connections WHERE id = ?', q.connection_id) : undefined;
  const svg = await QRCode.toString(qrUrl(q.code), { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#0F1E36', light: '#FFFFFF' } });
  const name = escape(location?.name ?? business.name);
  const colour = /^#[0-9a-f]{6}$/i.test(business.color) ? business.color : '#087565';
  const card = `
    <div class="card">
      <div class="stars">★★★★★</div>
      <h1>Happy with your repair?</h1>
      <p class="ask">Scan to leave us a quick Google review. It really helps a small local business.</p>
      <div class="qr">${svg}</div>
      <p class="how">Open your phone camera and point it at the code</p>
      <div class="name">${name}</div>
    </div>`;
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Review QR · ${escape(q.label)}</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Plus Jakarta Sans", system-ui, sans-serif; color: #0F1E36; background: #f1f5f9; }
  .bar { padding: 12px 16px; background: #0F1E36; color: #fff; display: flex; gap: 12px; align-items: center; font-size: 14px; }
  .bar button { background: ${colour}; color: #fff; border: 0; border-radius: 6px; padding: 8px 16px; font: inherit; font-weight: 700; cursor: pointer; }
  .sheet { display: flex; flex-wrap: wrap; gap: 10mm; justify-content: center; padding: 10mm; }
  .card { width: 90mm; height: 130mm; background: #fff; border: 2px solid ${colour}; border-radius: 6mm; padding: 8mm 7mm; text-align: center; display: flex; flex-direction: column; align-items: center; }
  .stars { color: #F5A623; font-size: 26pt; letter-spacing: 2pt; line-height: 1; }
  h1 { font-size: 17pt; margin: 3mm 0 2mm; }
  .ask { font-size: 10pt; color: #475569; margin: 0 0 4mm; line-height: 1.4; }
  .qr { width: 58mm; height: 58mm; }
  .qr svg { width: 100%; height: 100%; }
  .how { font-size: 8.5pt; color: #64748b; margin: 2mm 0 0; }
  .name { margin-top: auto; background: ${colour}; color: #fff; font-weight: 800; font-size: 12pt; padding: 2.5mm 5mm; border-radius: 3mm; width: 100%; }
  @media print { body { background: #fff; } .bar { display: none; } .sheet { padding: 0; } }
</style></head><body>
<div class="bar"><button onclick="print()">Print</button><span>Two cards per A4 page. Cut them out, or print on card and fold into a stand.</span></div>
<div class="sheet">${card}${card}</div>
</body></html>`);
});
