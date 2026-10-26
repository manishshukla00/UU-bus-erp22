import { Router } from 'express';
import { get, now } from '../db.js';
import { config } from '../config.js';
import { HttpError, intParam } from '../http.js';
import { unsign, sha256 } from '../security.js';
import { DEVICE_COOKIE } from '../middleware/device.js';

/*
 * Student photos taken as a selfie at first verification (for students with no photo on record).
 * Kept in the database (works on serverless hosts with no disk) until an admin removes it; the
 * student's photo_url then points at /api/photos/<id>?v=<time>, so every screen shows it.
 */
const MAX_BYTES = 300_000;
const DATA_URL = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;

/** A JPEG data URL from the phone, checked. Throws 400 on anything else. */
export function parseSelfie(dataUrl) {
  const m = DATA_URL.exec(dataUrl);
  if (!m) throw new HttpError(400, 'The photo must be a JPEG image. Take the selfie again.', { code: 'BAD_PHOTO' });
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length < 2000 || bytes.length > MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new HttpError(400, 'That photo could not be used. Take the selfie again.', { code: 'BAD_PHOTO' });
  }
  return { b64: m[1], mime: 'image/jpeg', size: bytes.length };
}

export const isOwnPhotoUrl = (url, studentId) => typeof url === 'string' && url.startsWith(`/api/photos/${studentId}?`);

/**
 * Batch items that store the selfie and point the student at it, only if they still have no photo
 * (a photo is never replaced this way; an admin removes it first). The UPDATE returns the new URL.
 */
export function savePhotoStmts(studentId, selfie, deviceId) {
  const t = now();
  return [
    ['INSERT INTO student_photos(student_id, mime, data, device_id, created_at) VALUES(?,?,?,?,?) ON CONFLICT(student_id) DO NOTHING',
      studentId, selfie.mime, selfie.b64, deviceId ?? null, t],
    ["UPDATE students SET photo_url = ?, updated_at = ? WHERE id = ? AND photo_url = '' RETURNING photo_url", `/api/photos/${studentId}?v=${t}`, t, studentId],
  ];
}

/**
 * GET /api/photos/:id. Allowed for signed-in staff, and for the student's own phone (the phone
 * bound to that student). The URL changes whenever the photo does, so it can be cached for good.
 */
export const photoRoutes = Router();
photoRoutes.get('/:id', async (req, res) => {
  const id = intParam(req.params.id, 'photo');
  if (!req.user) {
    const dev = unsign(req.cookies?.[DEVICE_COOKIE], config.sessionSecret);
    const cs = req.cookies?.uu_cs;
    const own = dev && (await get(
      `SELECT 1 AS ok FROM devices WHERE id = ? AND student_id = ?
       UNION ALL SELECT 1 FROM checkin_sessions WHERE id = ? AND device_id = ? AND student_id = ? AND expires_at > ?`,
      dev, id, sha256(cs || '-'), dev, id, Date.now(),
    ));
    if (!own) throw new HttpError(403, 'Not allowed');
  }
  const p = await get('SELECT mime, data FROM student_photos WHERE student_id = ?', id);
  if (!p) throw new HttpError(404, 'No photo');
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(p.mime).send(Buffer.from(p.data, 'base64'));
});
