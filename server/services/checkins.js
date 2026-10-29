/*
 * Verifying students: by QR scan (the student's own phone) or marked manually by the incharge.
 *
 * Rules that stop someone verifying for a friend:
 *   - the student must be registered on this bus
 *   - one verification per student per trip (a repeat scan is counted as a "duplicate")
 *   - one student per phone per trip
 *   - a phone belongs to the first student who verifies with it
 *   - at most N phones per student in 30 days (then an admin resets them)
 */
import { get, run, batch, now } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { normUuid } from '../security.js';
import { broadcast, tripScope } from './events.js';
import { tripCounts } from './trips.js';
import { savePhotoStmts } from './photos.js';

// a student with their route (stop) and bus
const STUDENT_SQL = `SELECT s.*, st.name AS stop_name, b.number AS bus_number, b.name AS bus_name
  FROM students s LEFT JOIN stops st ON st.id = s.stop_id LEFT JOIN buses b ON b.id = s.bus_id`;

// the live counts of a trip (shown on the bus portal)
const COUNTS_SQL = `SELECT (SELECT COUNT(*) FROM checkins WHERE trip_id = ?) AS boarded,
  (SELECT COUNT(*) FROM checkins WHERE trip_id = ? AND flags <> '') AS flagged,
  (SELECT COUNT(*) FROM students WHERE bus_id = ? AND active = 1) AS expected,
  (SELECT COUNT(*) FROM duplicates WHERE trip_id = ?) AS duplicates`;
const countsQuery = (trip) => [COUNTS_SQL, trip.id, trip.id, trip.bus_id, trip.id];

// the error messages students and staff see
const notFound = (trip, attemptsLeft) => new HttpError(404,
  `Student not found for Bus ${trip.bus_number}. Check your UUID or enrollment number.${attemptsLeft > 0 ? ` ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.` : ''}`,
  { code: 'NO_MATCH', attemptsLeft });
const phoneUsed = () => new HttpError(403, 'This phone was already used to board this trip. One phone, one student.', { code: 'DEVICE_USED' });
const phoneBound = () => new HttpError(403, 'This phone is linked to a different student. Use your own phone, or ask the incharge to mark you manually.', { code: 'DEVICE_BOUND' });
const tripEnded = () => new HttpError(410, 'This trip has ended. Ask the bus incharge.', { code: 'TRIP_ENDED' });

/** Active student by UUID or enrollment number (a UUID match wins). */
export async function studentByIdentifier(identifier) {
  const id = normUuid(identifier);
  if (!id) return null;
  return (await get(`${STUDENT_SQL} WHERE s.uuid = ? AND s.active = 1`, id))
    || get(`${STUDENT_SQL} WHERE s.enrollment_no = ? COLLATE NOCASE AND s.active = 1 ORDER BY s.id LIMIT 1`, id);
}

/** What the verified card on the student's phone shows. */
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

/**
 * A student typed their UUID or enrollment number after scanning the bus QR.
 * Returns one of:
 *   { student, needsPhoto: true }          no photo on record yet: take a selfie first
 *   { student, already: true, at }         already verified on this trip (counted as a duplicate)
 *   { student, already: false, at, flags } verified now
 * Database trips: 1) count the attempt + read everything the rules need, 2) save, 3) live update.
 */
export async function verifyStudent({ session, trip, identifier, deviceId, ip, ua, maxLookups, photoRequired = false, selfie = null }) {
  const id = normUuid(identifier);
  const t = now();

  // ---- 1. count this attempt and read everything the rules need, in one go
  // "pick" finds the student this ID means (UUID first, then enrollment number)
  const pick = '(SELECT id FROM students WHERE (uuid = ? OR enrollment_no = ? COLLATE NOCASE) AND active = 1 ORDER BY (uuid = ?) DESC, id LIMIT 1)';
  const sinceMonth = t - config.deviceWindowDays * 86_400_000;
  const [attempt, [student], [already], [phone], [phoneOnTrip], [phoneCount]] = (await batch([
    ['UPDATE checkin_sessions SET lookups = lookups + 1 WHERE id = ? AND lookups < ? RETURNING lookups', session.id, maxLookups],
    [`${STUDENT_SQL} WHERE s.id = ${pick}`, id, id, id],
    [`SELECT created_at FROM checkins WHERE trip_id = ? AND student_id = ${pick}`, trip.id, id, id, id],
    ['SELECT student_id FROM devices WHERE id = ?', deviceId],
    ['SELECT student_id FROM checkins WHERE trip_id = ? AND device_id = ?', trip.id, deviceId],
    [`SELECT COUNT(*) AS c FROM devices WHERE student_id = ${pick} AND last_seen > ?`, id, id, id, sinceMonth],
  ])).map((r) => r.rows);

  // ---- 2. check the rules
  if (!attempt.length) throw new HttpError(429, 'Too many wrong attempts. Scan the QR again and check your ID with the incharge.', { code: 'LOOKUPS_EXHAUSTED' });
  if (!student || student.bus_id !== trip.bus_id) throw notFound(trip, maxLookups - attempt[0].lookups);

  if (already) {
    // repeat scan: show the card again and count it as a duplicate
    const [, , { rows: [counts] }] = await batch([
      ['UPDATE checkin_sessions SET student_id = ? WHERE id = ?', student.id, session.id],
      ['INSERT INTO duplicates(trip_id, student_id, device_id, created_at) VALUES(?, ?, ?, ?)', trip.id, student.id, deviceId ?? null, t],
      countsQuery(trip),
    ]);
    await broadcast('duplicate', { trip_id: trip.id, bus_id: trip.bus_id, uuid: student.uuid, name: student.name, created_at: t, counts }, tripScope(trip));
    return { student, already: true, at: already.created_at, flags: [] };
  }
  if (phoneOnTrip) throw phoneUsed();
  if (phone?.student_id && phone.student_id !== student.id) throw phoneBound();

  const flags = [];
  if (!phone?.student_id) {
    // a phone this student has not used before
    if (phoneCount.c >= config.maxDevicesPerStudent) {
      throw new HttpError(403, `You already used ${phoneCount.c} different phones recently. Ask the admin to reset your devices.`, { code: 'TOO_MANY_DEVICES' });
    }
    if (phoneCount.c > 0) flags.push('new_device');
  }

  // no photo on record and no selfie sent yet: ask for one (nothing is saved until it arrives)
  if (photoRequired && !student.photo_url && !selfie) {
    await run('UPDATE checkin_sessions SET student_id = ? WHERE id = ?', student.id, session.id);
    return { student, needsPhoto: true };
  }

  // ---- 3. save everything together (all or nothing)
  const photoQueries = selfie && !student.photo_url ? savePhotoStmts(student.id, selfie, deviceId) : [];
  let results;
  try {
    results = await batch([
      ...photoQueries,
      // the phone belongs to this student (the first owner is kept)
      [`INSERT INTO devices(id, student_id, ua, bound_at, first_seen, last_seen) VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET student_id = COALESCE(devices.student_id, excluded.student_id),
          bound_at = COALESCE(devices.bound_at, excluded.bound_at), last_seen = excluded.last_seen, ua = excluded.ua`,
      deviceId, student.id, ua, t, t, t],
      // the verification, only if the trip is still running and this is the student's phone
      [`INSERT INTO checkins(trip_id, student_id, device_id, ip, method, flags, created_at)
        SELECT ?, ?, ?, ?, 'qr', ?, ?
         WHERE (SELECT status FROM trips WHERE id = ?) = 'active'
           AND (SELECT student_id FROM devices WHERE id = ?) = ?
        RETURNING id`,
      trip.id, student.id, deviceId, ip, flags.join(','), t, trip.id, deviceId, student.id],
      ['UPDATE checkin_sessions SET student_id = ?, consumed_at = ? WHERE id = ?', student.id, t, session.id],
      countsQuery(trip),
    ]);
  } catch (e) {
    // two phones at the same moment: the database's unique rules stop the second one
    if (/UNIQUE/i.test(e?.message || '')) throw /device_id/i.test(e.message) ? phoneUsed() : new HttpError(409, 'You have already boarded this trip.', { code: 'ALREADY' });
    throw e;
  }
  if (photoQueries.length) {
    student.photo_url = results[1].rows[0]?.photo_url || student.photo_url;
    results = results.slice(photoQueries.length);
  }
  const checkinId = results[1].rows[0]?.id;
  if (!checkinId) {
    // something changed a moment ago: the trip ended, or the phone was taken by someone else
    const t2 = await get('SELECT status FROM trips WHERE id = ?', trip.id);
    throw t2?.status !== 'active' ? tripEnded() : phoneBound();
  }

  // ---- 4. tell the bus portal and the dashboards
  const checkin = {
    id: checkinId, trip_id: trip.id, created_at: t, method: 'qr', flags: flags.join(','), note: '',
    student_id: student.id, uuid: student.uuid, enrollment_no: student.enrollment_no, name: student.name, photo_url: student.photo_url,
    course: student.course, year: student.year, specialization: student.specialization, stop: student.stop_name, marked_by_name: null,
    bus_number: trip.bus_number, direction: trip.direction,
  };
  const eventTrip = { id: trip.id, bus_id: trip.bus_id, incharge_id: trip.incharge_id, direction: trip.direction, bus_number: trip.bus_number };
  await broadcast('checkin', { checkin, trip: eventTrip, counts: results[3].rows[0] }, tripScope(eventTrip));
  return { student, already: false, at: t, flags };
}

/** The incharge marks a student (phone dead, etc). Always flagged "manual" with the incharge's name. */
export async function manualCheckin({ trip, student, byUser, note = '' }) {
  const t = now();
  if (student.bus_id !== trip.bus_id) throw new HttpError(403, `Invalid. You are not registered on Bus ${trip.bus_number}.`, { code: 'NOT_ON_BUS' });
  let r;
  try {
    r = await run(
      `INSERT INTO checkins(trip_id, student_id, device_id, ip, method, flags, marked_by, note, created_at)
       SELECT ?, ?, NULL, NULL, 'manual', 'manual', ?, ?, ? WHERE (SELECT status FROM trips WHERE id = ?) = 'active'`,
      trip.id, student.id, byUser.id, note.slice(0, 200), t, trip.id,
    );
  } catch (e) {
    if (/UNIQUE/i.test(e?.message || '')) throw new HttpError(409, `${student.name} already boarded this trip`);
    throw e;
  }
  if (!r.changes) throw new HttpError(410, 'Trip is not running');

  // tell the bus portal and the dashboards
  const checkin = {
    id: r.lastInsertRowid, trip_id: trip.id, created_at: t, method: 'manual', flags: 'manual', note,
    student_id: student.id, uuid: student.uuid, enrollment_no: student.enrollment_no, name: student.name, photo_url: student.photo_url,
    course: student.course, year: student.year, specialization: student.specialization, stop: student.stop_name, marked_by_name: byUser.name,
    bus_number: trip.bus_number, direction: trip.direction,
  };
  const eventTrip = { id: trip.id, bus_id: trip.bus_id, incharge_id: trip.incharge_id, direction: trip.direction, bus_number: trip.bus_number };
  await broadcast('checkin', { checkin, trip: eventTrip, counts: await tripCounts(trip.id, trip.bus_id) }, tripScope(eventTrip));
  return { id: r.lastInsertRowid, flags: ['manual'], at: t };
}
