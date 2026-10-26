import { all, get, read, batch, now } from '../db.js';
import { randomId } from '../security.js';
import { HttpError } from '../http.js';
import { broadcast, tripScope } from './events.js';

const TRIP_COLS = `t.id, t.bus_id, t.incharge_id, t.direction, t.status, t.started_at, t.ended_at, t.note,
  b.number AS bus_number, b.name AS bus_name, b.route AS bus_route, u.name AS incharge_name`;
const TRIP_FROM = 'FROM trips t JOIN buses b ON b.id = t.bus_id JOIN users u ON u.id = t.incharge_id';
const COUNT_COLS = `(SELECT COUNT(*) FROM checkins c WHERE c.trip_id = t.id) AS boarded,
       (SELECT COUNT(*) FROM checkins c WHERE c.trip_id = t.id AND c.flags <> '') AS flagged,
       (SELECT COUNT(*) FROM students s WHERE s.bus_id = t.bus_id AND s.active = 1) AS expected`;
// a trip with its live counts, in one query
const TRIP_WITH_COUNTS = `SELECT ${TRIP_COLS}, ${COUNT_COLS}, (SELECT COUNT(*) FROM duplicates d WHERE d.trip_id = t.id) AS duplicates ${TRIP_FROM}`;
const splitCounts = (row) => {
  if (!row) return null;
  const { boarded, flagged, expected, duplicates, ...trip } = row;
  return { ...trip, counts: { boarded, flagged, expected, duplicates } };
};

export const getTrip = (id) => get(`SELECT ${TRIP_COLS} ${TRIP_FROM} WHERE t.id = ?`, id);
export const getTripRaw = (id) => get('SELECT * FROM trips WHERE id = ?', id);
/** Trip and its counts in one round trip: { ...trip, counts }. */
export const getTripWithCounts = async (id) => splitCounts(await get(`${TRIP_WITH_COUNTS} WHERE t.id = ?`, id));

export async function tripCounts(tripId, busId) {
  const r = await get(
    `SELECT (SELECT COUNT(*) FROM checkins WHERE trip_id = ?) AS boarded,
            (SELECT COUNT(*) FROM checkins WHERE trip_id = ? AND flags <> '') AS flagged,
            (SELECT COUNT(*) FROM students WHERE bus_id = ? AND active = 1) AS expected,
            (SELECT COUNT(*) FROM duplicates WHERE trip_id = ?) AS duplicates`,
    tripId, tripId, busId, tripId,
  );
  return { boarded: r.boarded, flagged: r.flagged, expected: r.expected, duplicates: r.duplicates };
}

export const withCounts = async (trip) => ({ ...trip, counts: await tripCounts(trip.id, trip.bus_id) });

/** The trip, its counts, who verified and who has not yet: one database round trip. */
export async function tripSummary(id, { lists = true } = {}) {
  if (!lists) {
    const t = await getTripWithCounts(id);
    return t ? { trip: t, counts: t.counts } : null;
  }
  const [[row], checkins, notBoarded] = await read([
    [`${TRIP_WITH_COUNTS} WHERE t.id = ?`, id],
    [`SELECT c.id, c.created_at, c.method, c.flags, c.note, c.ip,
              s.id AS student_id, s.uuid, s.enrollment_no, s.name, s.photo_url, s.course, s.year, s.specialization, s.bus_id AS student_bus_id,
              st.name AS stop, m.name AS marked_by_name
         FROM checkins c
         JOIN students s ON s.id = c.student_id
         LEFT JOIN stops st ON st.id = s.stop_id
         LEFT JOIN users m ON m.id = c.marked_by
        WHERE c.trip_id = ?
        ORDER BY c.created_at DESC`, id],
    [`SELECT s.id, s.uuid, s.enrollment_no, s.name, s.photo_url, s.course, s.year, st.name AS stop
         FROM students s LEFT JOIN stops st ON st.id = s.stop_id
        WHERE s.bus_id = (SELECT bus_id FROM trips WHERE id = ?) AND s.active = 1
          AND s.id NOT IN (SELECT student_id FROM checkins WHERE trip_id = ?)
        ORDER BY COALESCE(st.seq, 999), s.name COLLATE NOCASE`, id, id],
  ]);
  const trip = splitCounts(row);
  if (!trip) return null;
  const { counts } = trip;
  delete trip.counts;
  return { trip, counts, checkins, notBoarded };
}

export function listTrips({ start, end, busId, status, limit = 100 }) {
  const where = ['t.started_at >= ?', 't.started_at < ?'];
  const params = [start, end];
  if (busId) { where.push('t.bus_id = ?'); params.push(busId); }
  if (status) { where.push('t.status = ?'); params.push(status); }
  params.push(limit);
  return all(`SELECT ${TRIP_COLS}, ${COUNT_COLS} ${TRIP_FROM} WHERE ${where.join(' AND ')} ORDER BY t.started_at DESC LIMIT ?`, ...params);
}

export const activeTrips = () => all(`SELECT ${TRIP_COLS}, ${COUNT_COLS} ${TRIP_FROM} WHERE t.status = 'active' ORDER BY t.started_at DESC`);

/** Start a trip: one atomic write (bus active, nothing running) that returns the trip with its counts. */
export async function startTrip({ busId, inchargeId, direction }) {
  let results;
  try {
    results = await batch([
      [`INSERT INTO trips(bus_id,incharge_id,direction,secret,status,started_at)
        SELECT ?,?,?,?,'active',? WHERE EXISTS (SELECT 1 FROM buses WHERE id = ? AND active = 1)
          AND NOT EXISTS (SELECT 1 FROM trips WHERE bus_id = ? AND status = 'active') RETURNING id`,
      busId, inchargeId, direction, randomId(32), now(), busId, busId],
      [`${TRIP_WITH_COUNTS} WHERE t.bus_id = ? AND t.status = 'active'`, busId],
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'This bus already has a running trip');
    throw e;
  }
  const trip = splitCounts(results[1].rows[0]);
  if (!results[0].rows.length) {
    if (trip) throw new HttpError(409, `Bus ${trip.bus_number} already has a running trip`, { tripId: trip.id });
    throw new HttpError(404, 'Bus not found or inactive');
  }
  await broadcast('trip', { type: 'started', trip }, tripScope(trip));
  return trip;
}

/** End a trip: one atomic write (the trip and its open check-in sessions) that returns it with its counts. */
export async function endTrip(id, byUserId) {
  const t = now();
  const results = await batch([
    ["UPDATE trips SET status = 'ended', ended_at = ?, ended_by = ? WHERE id = ? AND status = 'active'", t, byUserId, id],
    ['UPDATE checkin_sessions SET expires_at = ? WHERE trip_id = ? AND consumed_at IS NULL AND changes() > 0', t, id],
    [`${TRIP_WITH_COUNTS} WHERE t.id = ?`, id],
  ]);
  if (!results[0].changes) throw new HttpError(409, 'Trip is not running');
  const trip = splitCounts(results[2].rows[0]);
  await broadcast('trip', { type: 'ended', trip }, tripScope(trip));
  return trip;
}

/**
 * Can this user see this trip? Operations admins see every trip; their write attempts are refused
 * earlier by the read-only guard on the routes.
 */
export const canAccessTrip = (user, trip) =>
  user.role === 'admin' || user.role === 'operator' || trip.incharge_id === user.id || (user.bus_id != null && user.bus_id === trip.bus_id);
