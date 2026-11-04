import { Router } from 'express';
import express from 'express';
import { db, newId, now, type Message } from './db';
import { requireAuth } from './auth';
import { publicUrl } from './twilio';

/**
 * Pictures in conversations. Ones the team sends are public by an unguessable link (Twilio and Meta
 * fetch them from there); ones customers send are private, shown only to the signed-in team.
 */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export function saveMedia(businessId: string, mime: string, data: Buffer, isPrivate: boolean) {
  const id = newId();
  db.prepare('INSERT INTO media (id, business_id, mime, data, created_at, private) VALUES (?, ?, ?, ?, ?, ?)').run(id, businessId, mime, data, now(), isPrivate ? 1 : 0);
  return id;
}

export const publicMediaUrl = (id: string) => `${publicUrl()}/media/${id}.jpg`;

/** Where a message's picture can be seen: the public link for ours, the signed-in route for the customer's. */
export function messageMedia(m: Pick<Message, 'media_id'>, forTeam: boolean) {
  if (!m.media_id) return null;
  const row = db.prepare('SELECT private FROM media WHERE id = ?').get(m.media_id) as { private: number } | undefined;
  if (!row) return null;
  if (row.private) return forTeam ? `/api/media/${m.media_id}` : null;
  return forTeam ? `/api/media/${m.media_id}` : publicMediaUrl(m.media_id);
}

export const conversationMediaRouter = Router();
conversationMediaRouter.use(requireAuth);

/** A photo the team is about to send (already turned into a JPEG by the browser). */
conversationMediaRouter.post('/', express.raw({ type: ['image/jpeg'], limit: MAX_PHOTO_BYTES }), (req, res) => {
  const data = req.body as Buffer;
  if (!Buffer.isBuffer(data) || data.length < 100 || data[0] !== 0xff || data[1] !== 0xd8) return res.status(400).json({ error: 'Choose a photo (JPEG)' });
  res.status(201).json({ id: saveMedia(req.session!.businessId, 'image/jpeg', data, false) });
});

conversationMediaRouter.get('/:id', (req, res) => {
  const row = db.prepare('SELECT mime, data FROM media WHERE id = ? AND business_id = ?').get(req.params.id, req.session!.businessId) as { mime: string; data: Uint8Array } | undefined;
  if (!row) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=86400').type(row.mime).send(Buffer.from(row.data));
});
