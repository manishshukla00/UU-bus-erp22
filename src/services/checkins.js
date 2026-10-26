import { get, run, batch, now } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { normUuid } from '../security.js';
import { broadcast, tripScope } from './events.js';
import { tripCounts } from './trips.js';
import { savePhotoStmts } from './photos.js';

const STUDENT_SQL = `SELECT s.*, st.name AS stop_name, b.number AS bus_number, b.name AS bus_name
  FROM students s LEFT JOIN stops st ON st.id = s.stop_id LEFT JOIN buses b ON b.id = s.bus_id`;

export const studentById = (id) => get(`${STUDENT_SQL} WHERE s.id = ?`, id);

/**
 * Active student by UUID or enrollment number (what a student types after scanning, or staff type
 * for a manual check-in). A UUID match wins over an enrollment-number match.
 */
export async function studentByIdentifier(identifier) {
  const id = normUuid(identifier);
  if (!id) return null;
  return (await get(`${STUDENT_SQL} WHERE s.uuid = ? AND s.active = 1`, id))
    || get(`${STUDENT_SQL} WHERE s.enrollment_no = ? COLLATE NOCASE AND s.active = 1 ORDER BY s.id LIMIT 1`, id);
}

/** What a student is allowed to see about themselves on the check-in screen. */
export function publicStudent(s, trip) {
  return {
    id: s.id,
    uuid: s.uuid,
    enrollment_no: s.enrollment_no || '',
    name: s.name,
    photo_url: s.photo_url || '',
    course: s.course,
    year: s.year,
    specialization: s.specialization,
    stop: s.stop_name || '',
    bus: s.bus_number ? { number: s.bus_number, name: s.bus_name } : null,
    ownBus: trip ? s.bus_id === trip.bus_id : null,
  };
}

const COUNTS_SQL = `SELECT (SELECT COUNT(*) FROM checkins WHERE trip_id = ?) AS boarded,
  (SELECT COUNT(*) FROM checkins WHERE trip_id = ? AND flags <> '') AS flagged,
  (SELECT COUNT(*) FROM students WHERE bus_id = ? AND active = 1) AS expected,
  (SELECT COUNT(*) FROM duplicates WHERE trip_id = ?) AS duplicates`;
const countsStmt = (trip) => [COUNTS_SQL, trip.id, trip.id, trip.bus_id, trip.id];
const notFound = (trip, left) => new HttpError(404,
  `Student not found for Bus ${trip.bus_number}. Check your UUID or enrollment number.${left > 0 ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : ''}`,
  { code: 'NO_MATCH', attemptsLeft: left });

/**
 * The student typed their UUID or enrollment number on a live check-in session. Same rules as
 * confirmCheckin, arranged for a far-away database: one round trip counts the attempt and reads
 * everything the rules need, one atomic round trip writes, one publishes the live event.
 * Returns { student, already, at, flags }, or { student, needsPhoto: true } when a selfie is required
 * first (the boarding is not recorded until it arrives).
 */
export async function verifyStudent({ session, trip, identifier, deviceId, ip, ua, maxLookups, photoRequired = false, selfie = null }) {
  const id = normUuid(identifier);
  const ts = now();
  const since = ts - config.deviceWindowDays * 86_400_000;
  // the student this identifier means (a UUID match wins over an enrollment-number match)
  const pick = '(SELECT id FROM students WHERE (uuid = ? OR enrollment_no = ? COLLATE NOCASE) AND active = 1 ORDER BY (uuid = ?) DESC, id LIMIT 1)';
  const [used, [student], [existing], [dev], [devUsed], [others]] = (await batch([
    ['UPDATE checkin_sessions SET lookups = lookups + 1 WHERE id = ? AND lookups < ? RETURNING lookups', session.id, maxLookups],
    [`${STUDENT_SQL} WHERE s.id = ${pick}`, id, id, id],
    [`SELECT created_at FROM checkins WHERE trip_id = ? AND student_id = ${pick}`, trip.id, id, id, id],
    ['SELECT student_id FROM devices WHERE id = ?', deviceId],
    ['SELECT student_id FROM checkins WHERE trip_id = ? AND device_id = ?', trip.id, deviceId],
    [`SELECT COUNT(*) AS c FROM devices WHERE student_id = ${pick} AND last_seen > ?`, id, id, id, since],
  ])).map((r) => r.rows);
  if (!used.length) throw new HttpError(429, 'Too many wrong attempts. Scan the QR again and check your ID with the incharge.', { code: 'LOOKUPS_EXHAUSTED' });
  // only students registered on THIS bus can board it; anyone else is simply "not found"
  if (!student || student.bus_id !== trip.bus_id) throw notFound(trip, maxLookups - used[0].lookups);

  if (existing) {
    // a repeat scan: show the card again and count it as a duplicate
    const [, , { rows: [counts] }] = await batch([
      ['UPDATE checkin_sessions SET student_id = ? WHERE id = ?', student.id, session.id],
      ['INSERT INTO duplicates(trip_id, student_id, device_id, created_at) VALUES(?,?,?,?)', trip.id, student.id, deviceId ?? null, ts],
      countsStmt(trip),
    ]);
    await broadcast('duplicate', { trip_id: trip.id, bus_id: trip.bus_id, uuid: student.uuid, name: student.name, created_at: ts, counts }, tripScope(trip));
    return { student, already: true, at: existing.created_at, flags: [] };
  }
  if (devUsed) throw new HttpError(403, 'This phone was already used to board this trip. One phone, one student.', { code: 'DEVICE_USED' });
  if (dev?.student_id && dev.student_id !== student.id) throw deviceBound();
  const flags = [];
  if (!dev?.student_id) {
    if (others.c >= config.maxDevicesPerStudent) {
      throw new HttpError(403, `You already used ${others.c} different phones recently. Ask the admin to reset your devices.`, { code: 'TOO_MANY_DEVICES' });
    }
    if (others.c > 0) flags.push('new_device');
  }
  // no photo on record: ask for a selfie before anything is written (the session remembers the student)
  if (photoRequired && !student.photo_url && !selfie) {
    await run('UPDATE checkin_sessions SET student_id = ? WHERE id = ?', student.id, session.id);
    return { student, needsPhoto: true };
  }

  // a selfie for a student with no photo is stored in the same atomic write as the boarding
  const photoWrites = selfie && !student.photo_url ? savePhotoStmts(student.id, selfie, deviceId) : [];
  let results;
  try {
    results = await batch([
      ...photoWrites,
      [`INSERT INTO devices(id, student_id, ua, bound_at, first_seen, last_seen) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET student_id = COALESCE(devices.student_id, excluded.student_id),
          bound_at = COALESCE(devices.bound_at, excluded.bound_at), last_seen = excluded.last_seen, ua = excluded.ua`,
      deviceId, student.id, ua, ts, ts, ts],
      // board only if the trip is still running and this phone belongs to this student
      [`INSERT INTO checkins(trip_id, student_id, device_id, ip, method, flags, created_at)
        SELECT ?, ?, ?, ?, 'qr', ?, ?
         WHERE (SELECT status FROM trips WHERE id = ?) = 'active'
           AND (SELECT student_id FROM devices WHERE id = ?) = ?
           AND (SELECT bus_id FROM students WHERE id = ?) = (SELECT bus_id FROM trips WHERE id = ?)
        RETURNING id`,
      trip.id, student.id, deviceId, ip, flags.join(','), ts, trip.id, deviceId, student.id, student.id, trip.id],
      ['UPDATE checkin_sessions SET student_id = ?, consumed_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM checkins WHERE trip_id = ? AND student_id = ?)', student.id, ts, session.id, trip.id, student.id],
      countsStmt(trip),
    ]);
  } catch (e) { rethrowUnique(e); }
  if (photoWrites.length) {
    const url = results[1].rows[0]?.photo_url;
    results = results.slice(2);
    if (url) student.photo_url = url;
  }
  const checkinId = results[1].rows[0]?.id;
  if (!checkinId) {
    // a rule changed between our reads and the write; tell the student which one
    const [t2, d2] = await Promise.all([get('SELECT status FROM trips WHERE id = ?', trip.id), get('SELECT student_id FROM devices WHERE id = ?', deviceId)]);
    if (t2?.status !== 'active') throw new HttpError(410, 'This trip has ended. Ask the bus incharge.', { code: 'TRIP_ENDED' });
    if (d2?.student_id !== student.id) throw deviceBound();
    throw new HttpError(409, 'Could not record the boarding. Scan the QR again.', { code: 'RETRY' });
  }
  // the live event is built from what we already have: no reload of the check-in
  const checkin = {
    id: checkinId, trip_id: trip.id, created_at: ts, method: 'qr', flags: flags.join(','), note: '',
    student_id: student.id, uuid: student.uuid, enrollment_no: student.enrollment_no, name: student.name, photo_url: student.photo_url,
    course: student.course, year: student.year, specialization: student.specialization, stop: student.stop_name, marked_by_name: null,
    bus_number: trip.bus_number, direction: trip.direction,
  };
  const eventTrip = { id: trip.id, bus_id: trip.bus_id, incharge_id: trip.incharge_id, direction: trip.direction, bus_number: trip.bus_number };
  await broadcast('checkin', { checkin, trip: eventTrip, counts: results[3].rows[0] }, tripScope(eventTrip));
  return { student, already: false, at: ts, flags };
}

/** A repeat scan of someone already verified on this trip: kept for the daily duplicates count. */
export async function recordDuplicate({ trip, student, deviceId }) {
  const ts = now();
  await run('INSERT INTO duplicates(trip_id, student_id, device_id, created_at) VALUES(?,?,?,?)', trip.id, student.id, deviceId ?? null, ts);
  await broadcast('duplicate', { trip_id: trip.id, bus_id: trip.bus_id, uuid: student.uuid, name: student.name, created_at: ts, counts: await tripCounts(trip.id, trip.bus_id) }, tripScope(trip));
}

/**
 * Atomic QR check-in with every anti-proxy rule:
 *  - trip must still be running
 *  - one check-in per student per trip
 *  - one phone per trip (a phone cannot board two students)
 *  - a phone is bound to the first student who uses it; another student on that phone is refused
 *  - a student may use at most N phones in 30 days (then admin must reset)
 *  - boarding another bus is allowed but flagged
 * Reads first, then ONE atomic write batch. The batch re-checks the critical rules in SQL (trip still
 * running, phone owned by this student) and unique indexes stop double boarding, so two phones racing
 * each other can never both win, and the database write lock is held for milliseconds.
 */
export async function confirmCheckin({ sessionId, trip, student, deviceId, ip, ua }) {
  const ts = now();
  const [live, existing, devUsed, dev] = await Promise.all([
    get('SELECT status FROM trips WHERE id = ?', trip.id),
    get('SELECT created_at FROM checkins WHERE trip_id = ? AND student_id = ?', trip.id, student.id),
    get('SELECT student_id FROM checkins WHERE trip_id = ? AND device_id = ?', trip.id, deviceId),
    get('SELECT student_id FROM devices WHERE id = ?', deviceId),
  ]);
  if (!live || live.status !== 'active') throw new HttpError(410, 'This trip has ended. Ask the bus incharge.', { code: 'TRIP_ENDED' });
  if (existing) throw new HttpError(409, 'You have already boarded this trip.', { code: 'ALREADY', at: existing.created_at });
  if (devUsed) throw new HttpError(403, 'This phone was already used to board this trip. One phone, one student.', { code: 'DEVICE_USED' });
  if (dev?.student_id && dev.student_id !== student.id) throw deviceBound();
  if (student.bus_id !== trip.bus_id) throw notOnBus(trip);

  const flags = [];
  if (!dev?.student_id) {
    const since = ts - config.deviceWindowDays * 86_400_000;
    const others = (await get('SELECT COUNT(*) AS c FROM devices WHERE student_id = ? AND last_seen > ?', student.id, since)).c;
    if (others >= config.maxDevicesPerStudent) {
      throw new HttpError(403, `You already used ${others} different phones recently. Ask the admin to reset your devices.`, { code: 'TOO_MANY_DEVICES' });
    }
    if (others > 0) flags.push('new_device');
  }

  let results;
  try {
    results = await batch([
      // bind the phone to this student unless someone already owns it (COALESCE keeps the first owner)
      [`INSERT INTO devices(id, student_id, ua, bound_at, first_seen, last_seen) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET student_id = COALESCE(devices.student_id, excluded.student_id),
          bound_at = COALESCE(devices.bound_at, excluded.bound_at), last_seen = excluded.last_seen, ua = excluded.ua`,
      deviceId, student.id, ua, ts, ts, ts],
      // board only if the trip is still running and this phone belongs to this student
      [`INSERT INTO checkins(trip_id, student_id, device_id, ip, method, flags, created_at)
        SELECT ?, ?, ?, ?, 'qr', ?, ?
         WHERE (SELECT status FROM trips WHERE id = ?) = 'active'
           AND (SELECT student_id FROM devices WHERE id = ?) = ?
           AND (SELECT bus_id FROM students WHERE id = ?) = (SELECT bus_id FROM trips WHERE id = ?)`,
      trip.id, student.id, deviceId, ip, flags.join(','), ts, trip.id, deviceId, student.id, student.id, trip.id],
      ['UPDATE checkin_sessions SET consumed_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM checkins WHERE trip_id = ? AND student_id = ?)', ts, sessionId, trip.id, student.id],
    ]);
  } catch (e) { rethrowUnique(e); }
  if (!results[1].changes) {
    // a rule changed between our reads and the write; tell the student which one
    const [t2, d2] = await Promise.all([get('SELECT status FROM trips WHERE id = ?', trip.id), get('SELECT student_id FROM devices WHERE id = ?', deviceId)]);
    if (t2?.status !== 'active') throw new HttpError(410, 'This trip has ended. Ask the bus incharge.', { code: 'TRIP_ENDED' });
    if (d2?.student_id !== student.id) throw deviceBound();
    const s2 = await get('SELECT bus_id FROM students WHERE id = ?', student.id);
    if (s2?.bus_id !== trip.bus_id) throw notOnBus(trip);
    throw new HttpError(409, 'Could not record the boarding. Scan the QR again.', { code: 'RETRY' });
  }
  const result = { id: results[1].lastInsertRowid, flags, at: ts };
  await emitCheckin(result.id);
  return result;
}

const notOnBus = (trip) =>
  new HttpError(403, `Invalid. You are not registered on Bus ${trip.bus_number}.`, { code: 'NOT_ON_BUS' });

const deviceBound = () =>
  new HttpError(403, 'This phone is linked to a different student. Use your own phone, or ask the incharge to mark you manually.', { code: 'DEVICE_BOUND' });

/** Staff-marked boarding (phone dead, etc). Always flagged 'manual' and audited by the caller. */
export async function manualCheckin({ trip, student, byUser, note = '' }) {
  const ts = now();
  const existing = await get('SELECT created_at FROM checkins WHERE trip_id = ? AND student_id = ?', trip.id, student.id);
  if (existing) throw new HttpError(409, `${student.name} already boarded this trip`, { at: existing.created_at });
  if (student.bus_id !== trip.bus_id) throw notOnBus(trip);
  const flags = ['manual'];
  let r;
  try {
    r = await run(
      `INSERT INTO checkins(trip_id, student_id, device_id, ip, method, flags, marked_by, note, created_at)
       SELECT ?, ?, NULL, NULL, 'manual', ?, ?, ?, ? WHERE (SELECT status FROM trips WHERE id = ?) = 'active'`,
      trip.id, student.id, flags.join(','), byUser.id, note.slice(0, 200), ts, trip.id,
    );
  } catch (e) {
    if (/UNIQUE/i.test(e?.message || '')) throw new HttpError(409, `${student.name} already boarded this trip`, { at: ts });
    throw e;
  }
  if (!r.changes) throw new HttpError(410, 'Trip is not running');
  const result = { id: r.lastInsertRowid, flags, at: ts };
  await emitCheckin(result.id);
  return result;
}

/** Two phones racing the same student/device hit a UNIQUE index; report it like the normal check. */
function rethrowUnique(e) {
  if (/UNIQUE/i.test(e?.message || '')) {
    if (/device_id/i.test(e.message)) throw new HttpError(403, 'This phone was already used to board this trip. One phone, one student.', { code: 'DEVICE_USED' });
    throw new HttpError(409, 'You have already boarded this trip.', { code: 'ALREADY', at: Date.now() });
  }
  throw e;
}

export function loadCheckin(id) {
  return get(
    `SELECT c.id, c.trip_id, c.created_at, c.method, c.flags, c.note,
            s.id AS student_id, s.uuid, s.enrollment_no, s.name, s.photo_url, s.course, s.year, s.specialization, st.name AS stop,
            t.bus_id, t.incharge_id, t.direction, b.number AS bus_number, m.name AS marked_by_name
       FROM checkins c
       JOIN students s ON s.id = c.student_id
       JOIN trips t ON t.id = c.trip_id
       JOIN buses b ON b.id = t.bus_id
       LEFT JOIN stops st ON st.id = s.stop_id
       LEFT JOIN users m ON m.id = c.marked_by
      WHERE c.id = ?`,
    id,
  );
}

export async function emitCheckin(id) {
  const c = await loadCheckin(id);
  if (!c) return;
  const trip = { id: c.trip_id, bus_id: c.bus_id, incharge_id: c.incharge_id, direction: c.direction, bus_number: c.bus_number };
  const checkin = {
    id: c.id, trip_id: c.trip_id, created_at: c.created_at, method: c.method, flags: c.flags, note: c.note,
    student_id: c.student_id, uuid: c.uuid, enrollment_no: c.enrollment_no, name: c.name, photo_url: c.photo_url,
    course: c.course, year: c.year, specialization: c.specialization, stop: c.stop, marked_by_name: c.marked_by_name,
    bus_number: c.bus_number, direction: c.direction,
  };
  await broadcast('checkin', { checkin, trip, counts: await tripCounts(c.trip_id, c.bus_id) }, tripScope(trip));
}
