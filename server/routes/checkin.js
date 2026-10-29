/*
 * /api/checkin/... : the student's phone (no login).
 *   POST /session  after scanning the QR: opens a short private session on this phone
 *   GET  /session  what the page should show after a reload
 *   POST /verify   UUID or enrollment number (+ a selfie the first time) -> verified card
 */
import { Router } from 'express';
import { z } from 'zod';
import { get, read, run, now } from '../db.js';
import { config } from '../config.js';
import { HttpError, validate, setCookie, clearCookie, clientIp, userAgent } from '../http.js';
import { randomId, sha256 } from '../security.js';
import { deviceIdentity } from '../middleware/device.js';
import { scanLimiter, lookupLimiter } from '../middleware/rateLimit.js';
import { verifyToken } from '../services/qr.js';
import { publicStudent, verifyStudent } from '../services/checkins.js';
import { parseSelfie } from '../services/photos.js';

const router = Router();
const CS_COOKIE = 'uu_cs';
const MAX_LOOKUPS = 6;

router.use(deviceIdentity);

const publicTrip = (t) => ({ id: t.id, bus_number: t.bus_number, bus_name: t.bus_name, bus_route: t.bus_route, direction: t.direction, started_at: t.started_at, status: t.status });

/**
 * The caller's check-in session (cookie) with its trip and bus, in one query. Null unless it is
 * alive and on this device.
 */
async function loadCheckinSession(req, res) {
  const raw = req.cookies[CS_COOKIE];
  if (!raw || raw.length > 120) return null;
  const s = await get(
    `SELECT cs.*, t.bus_id, t.incharge_id, t.direction, t.started_at, t.status AS trip_status,
            b.number AS bus_number, b.name AS bus_name, b.route AS bus_route
       FROM checkin_sessions cs JOIN trips t ON t.id = cs.trip_id JOIN buses b ON b.id = t.bus_id WHERE cs.id = ?`,
    sha256(raw),
  );
  if (!s || s.expires_at < now() || s.device_id !== req.deviceId) { clearCookie(res, CS_COOKIE); return null; }
  return s;
}
const tripOfSession = (s) => ({
  id: s.trip_id, bus_id: s.bus_id, incharge_id: s.incharge_id, direction: s.direction, started_at: s.started_at,
  status: s.trip_status, bus_number: s.bus_number, bus_name: s.bus_name, bus_route: s.bus_route,
});

/** Step 1: the phone scanned the bus QR. Exchange the token for a short private session. */
router.post('/session', scanLimiter, async (req, res) => {
  const { token, bus } = validate(z.object({ token: z.string().min(5).max(120), bus: z.string().trim().max(20).optional() }), req.body);
  const [checked, existing] = await Promise.all([verifyToken(token), loadCheckinSession(req, res)]);
  if (checked.error === 'NO_TRIP') {
    throw new HttpError(409, `No trip is running on Bus ${checked.bus.number} right now. Ask the incharge to start the trip, then scan again.`, { code: 'NO_TRIP', bus: checked.bus.number });
  }
  if (checked.error) throw new HttpError(410, 'This QR code is no longer valid. Scan the QR on the bus again.', { code: 'QR_EXPIRED' });
  const trip = checked.trip;
  if (bus && trip.bus_number.toLowerCase() !== bus.toLowerCase()) {
    throw new HttpError(410, 'This QR code belongs to a different bus. Scan the QR on this bus.', { code: 'QR_EXPIRED' });
  }
  const t = now();
  // re-use a still-valid session for the same trip on this device (student re-scanned or reloaded)
  let raw = req.cookies[CS_COOKIE];
  let expiresAt = existing?.expires_at;
  if (!existing || existing.trip_id !== trip.id || existing.consumed_at) {
    raw = randomId(32);
    expiresAt = t + config.checkinTtlMs;
    await run(
      'INSERT INTO checkin_sessions(id,trip_id,device_id,ip,ua,lookups,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)',
      sha256(raw), trip.id, req.deviceId, clientIp(req), userAgent(req), t, expiresAt,
    );
  }
  setCookie(res, CS_COOKIE, raw, { maxAgeMs: Math.max(1000, expiresAt - t), sameSite: 'Lax' });
  res.json({ trip: publicTrip(trip), expiresAt, device: req.deviceToken, student: null });
});

/** Reload-safe: what is the state of my current check-in session? */
router.get('/session', async (req, res) => {
  const s = await loadCheckinSession(req, res);
  if (!s) return res.json({ active: false, device: req.deviceToken });
  const trip = tripOfSession(s);
  if (trip.status !== 'active') return res.json({ active: false, device: req.deviceToken, reason: 'TRIP_ENDED' });
  let student = null;
  let boardedAt = null;
  if (s.student_id && s.consumed_at) {
    const [[st], [c]] = await read([
      [`SELECT s.*, st.name AS stop_name, b.number AS bus_number, b.name AS bus_name
          FROM students s LEFT JOIN stops st ON st.id = s.stop_id LEFT JOIN buses b ON b.id = s.bus_id WHERE s.id = ?`, s.student_id],
      ['SELECT created_at FROM checkins WHERE trip_id = ? AND student_id = ?', trip.id, s.student_id],
    ]);
    student = st ? publicStudent(st, trip) : null;
    boardedAt = c?.created_at ?? null;
  }
  res.json({ active: true, trip: publicTrip(trip), expiresAt: s.expires_at, device: req.deviceToken, student, boardedAt, consumed: !!s.consumed_at });
});

/**
 * Step 2: the student types their UUID or enrollment number and is verified in one step, with every
 * anti-proxy rule (one phone per student, one check-in per trip, own bus only).
 * A student with no photo on record is asked for a selfie first ({ needsPhoto: true }); the same
 * call with `photo` saves it for good and records the boarding.
 * Someone already verified on this trip gets their card back marked "already verified", and the
 * repeat scan is counted as a duplicate.
 */
router.post('/verify', lookupLimiter, async (req, res) => {
  const s = await loadCheckinSession(req, res);
  if (!s) throw new HttpError(410, 'Your check-in window has expired. Scan the QR again.', { code: 'SESSION_EXPIRED' });
  const trip = tripOfSession(s);
  if (trip.status !== 'active') throw new HttpError(410, 'This trip has ended. Ask the bus incharge.', { code: 'TRIP_ENDED' });
  if (s.consumed_at && s.student_id) {
    const [[student], [c]] = await read([
      [`SELECT s.*, st.name AS stop_name, b.number AS bus_number, b.name AS bus_name
          FROM students s LEFT JOIN stops st ON st.id = s.stop_id LEFT JOIN buses b ON b.id = s.bus_id WHERE s.id = ?`, s.student_id],
      ['SELECT created_at FROM checkins WHERE trip_id = ? AND student_id = ?', trip.id, s.student_id],
    ]);
    return res.json({ ok: true, already: true, boardedAt: c?.created_at ?? s.consumed_at, student: publicStudent(student, trip), trip: publicTrip(trip) });
  }
  const { id, photo } = validate(z.object({ id: z.string().trim().min(2).max(40), photo: z.string().max(400_000).optional() }), req.body);
  const selfie = photo ? parseSelfie(photo) : null;
  const r = await verifyStudent({
    session: s, trip, identifier: id, deviceId: req.deviceId, ip: clientIp(req), ua: userAgent(req),
    maxLookups: MAX_LOOKUPS, photoRequired: true, selfie,
  });
  if (r.needsPhoto) return res.json({ ok: true, needsPhoto: true, student: { name: r.student.name, uuid: r.student.uuid }, trip: publicTrip(trip) });
  res.json({ ok: true, already: r.already, boardedAt: r.at, flags: r.flags, student: publicStudent(r.student, trip), trip: publicTrip(trip) });
});

export default router;
