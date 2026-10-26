import { all, get, run, batchChunks, now } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { normUuid, hashPassword, generatePassword, sealPassword, randomId } from '../security.js';
import { mapHeaders, isActiveCell } from './csv.js';

/*
 * Bulk imports used by "Import CSV" and "Import Excel workbook" (the Apps Script workbook layout:
 * Students, Buses and Incharges sheets). Everything is read once, then written as set-based
 * statements in atomic chunks: a few round trips for thousands of rows, even against Turso.
 */

const httpsUrl = (v) => (/^https:\/\/[^\s"'<>]+$/i.test(v) ? v.slice(0, 500) : '');

/**
 * Students from a table: rows[0] is the header row (column names are flexible, see csv.js).
 * Buses and stops that do not exist yet are created. Existing students (same UUID) are updated.
 */
export async function importStudents(rows) {
  if (!Array.isArray(rows) || rows.length < 2) throw new HttpError(400, 'The file needs a header row and at least one student');
  if (rows.length > 20_001) throw new HttpError(413, 'Import at most 20,000 students per file');
  const idx = mapHeaders(rows[0]);
  if (idx.uuid == null && idx.enrollment != null) idx.uuid = idx.enrollment;
  if (idx.uuid == null || idx.name == null) throw new HttpError(400, 'The header row must include "UUID" (or EnrollmentNo) and "Name" columns');
  const cell = (r, k) => (idx[k] == null ? '' : String(r[idx[k]] ?? '').trim());
  const summary = { inserted: 0, updated: 0, skipped: 0, inactive: 0, errors: [], busesCreated: 0, stopsCreated: 0 };

  const [busRows, stopRows, uuidRows] = await Promise.all([
    all('SELECT number FROM buses'),
    all('SELECT b.number, s.name FROM stops s JOIN buses b ON b.id = s.bus_id'),
    all('SELECT uuid FROM students'),
  ]);
  const knownBuses = new Set(busRows.map((b) => b.number.toLowerCase()));
  const knownStops = new Set(stopRows.map((s) => `${s.number.toLowerCase()}|${s.name.toLowerCase()}`));
  const knownUuids = new Set(uuidRows.map((s) => s.uuid.toUpperCase()));
  const ts = now();
  const busStmts = [];
  const stopStmts = [];
  const studentStmts = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const uuid = normUuid(cell(r, 'uuid')).slice(0, 40);
    const name = cell(r, 'name').slice(0, 80);
    if (!uuid || !name) {
      if (r.some((v) => String(v ?? '').trim())) {
        summary.skipped++;
        if (summary.errors.length < 20) summary.errors.push(`Row ${i + 1}: missing UUID or name`);
      }
      continue;
    }
    const busNo = cell(r, 'bus').slice(0, 20);
    const stopName = busNo ? cell(r, 'stop').slice(0, 80) : '';
    if (busNo && !knownBuses.has(busNo.toLowerCase())) {
      knownBuses.add(busNo.toLowerCase());
      busStmts.push(['INSERT OR IGNORE INTO buses(number, name, route, active, created_at) VALUES(?, ?, \'\', 1, ?)', busNo, `Bus ${busNo}`, ts]);
      summary.busesCreated++;
    }
    const sk = `${busNo.toLowerCase()}|${stopName.toLowerCase()}`;
    if (stopName && !knownStops.has(sk)) {
      knownStops.add(sk);
      stopStmts.push([
        `INSERT OR IGNORE INTO stops(bus_id, name, seq)
         SELECT b.id, ?, COALESCE((SELECT MAX(seq) FROM stops WHERE bus_id = b.id), 0) + 1 FROM buses b WHERE b.number = ?`,
        stopName, busNo,
      ]);
      summary.stopsCreated++;
    }
    const active = idx.active == null || isActiveCell(cell(r, 'active'));
    if (!active) summary.inactive++;
    if (knownUuids.has(uuid)) summary.updated++;
    else { knownUuids.add(uuid); summary.inserted++; }
    const enrollment = normUuid(cell(r, 'enrollment')).slice(0, 40);
    studentStmts.push([
      `INSERT INTO students(uuid, enrollment_no, name, photo_url, course, year, specialization, bus_id, stop_id, phone, active, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?,
         (SELECT id FROM buses WHERE number = ?),
         (SELECT s.id FROM stops s JOIN buses b ON b.id = s.bus_id WHERE b.number = ? AND s.name = ? COLLATE NOCASE),
         ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, course = excluded.course,
         enrollment_no = CASE WHEN excluded.enrollment_no <> '' THEN excluded.enrollment_no ELSE students.enrollment_no END,
         photo_url = CASE WHEN excluded.photo_url <> '' THEN excluded.photo_url ELSE students.photo_url END,
         year = CASE WHEN excluded.year <> '' THEN excluded.year ELSE students.year END,
         specialization = CASE WHEN excluded.specialization <> '' THEN excluded.specialization ELSE students.specialization END,
         phone = CASE WHEN excluded.phone <> '' THEN excluded.phone ELSE students.phone END,
         bus_id = excluded.bus_id, stop_id = excluded.stop_id, active = excluded.active, updated_at = excluded.updated_at`,
      uuid, enrollment, name, httpsUrl(cell(r, 'photo')), cell(r, 'course').slice(0, 80), cell(r, 'year').slice(0, 20),
      cell(r, 'specialization').slice(0, 80), busNo, busNo, stopName, cell(r, 'phone').slice(0, 20), active ? 1 : 0, ts, ts,
    ]);
  }
  await batchChunks([...busStmts, ...stopStmts]);
  await batchChunks(studentStmts);
  return summary;
}

/** Buses sheet: BusNo, Route, Active (InchargeID and Notes are handled by the Incharges import). */
export async function importBuses(list) {
  const ts = now();
  const out = { created: 0, updated: 0 };
  const existing = new Set((await all('SELECT number FROM buses')).map((b) => b.number.toLowerCase()));
  const stmts = [];
  for (const b of list) {
    const number = String(b.number ?? '').trim().slice(0, 20);
    if (!number) continue;
    const route = String(b.route ?? '').trim().slice(0, 200);
    const active = isActiveCell(b.active) ? 1 : 0;
    if (existing.has(number.toLowerCase())) {
      out.updated++;
      stmts.push(['UPDATE buses SET route = CASE WHEN ? <> \'\' THEN ? ELSE route END, active = ? WHERE number = ?', route, route, active, number]);
    } else {
      existing.add(number.toLowerCase());
      out.created++;
      stmts.push(['INSERT INTO buses(number, name, route, active, created_at) VALUES(?,?,?,?,?)', number, `Bus ${number}`, route, active, ts]);
    }
  }
  await batchChunks(stmts);
  return out;
}

const IST_OFFSET_MS = 330 * 60_000;
const istDayOf = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istHourOf = (ms) => new Date(ms + IST_OFFSET_MS).getUTCHours();

/**
 * VerificationLogs sheet (history from the Apps Script system): { uuid, bus, status, at } with `at`
 * in epoch ms. Rows are grouped into one ended trip per bus, India-time day and direction (before
 * 1 pm = to college, after = from college). VERIFIED rows become check-ins (flagged "imported"),
 * DUPLICATE rows become duplicate scans. Safe to run again: the same trip is reused and nothing
 * already imported is added twice.
 */
export async function importVerifications(list, actorId) {
  const out = { trips: 0, verified: 0, duplicates: 0, skipped: 0, errors: [] };
  const [students, buses, incharges] = await Promise.all([
    all('SELECT id, uuid, bus_id FROM students'),
    all('SELECT id, number FROM buses'),
    all("SELECT id, bus_id FROM users WHERE role = 'incharge' AND active = 1 ORDER BY id"),
  ]);
  const studentBy = new Map(students.map((s) => [s.uuid.toUpperCase(), s]));
  const busBy = new Map(buses.map((b) => [b.number.toLowerCase(), b]));
  const groups = new Map();
  for (const [i, v] of list.entries()) {
    const at = Number(v.at);
    const st = studentBy.get(normUuid(v.uuid));
    const bus = busBy.get(String(v.bus ?? '').trim().toLowerCase());
    const status = String(v.status ?? '').trim().toUpperCase();
    if (!Number.isFinite(at) || at <= 0 || !st || !bus || !['VERIFIED', 'DUPLICATE'].includes(status)) {
      out.skipped++;
      if (out.errors.length < 20) out.errors.push(`Log row ${i + 2}: ${!st ? `unknown student ${v.uuid}` : !bus ? `unknown bus ${v.bus}` : 'bad time or status'}`);
      continue;
    }
    const direction = istHourOf(at) < 13 ? 'to_college' : 'from_college';
    const key = `${bus.id}|${istDayOf(at)}|${direction}`;
    if (!groups.has(key)) groups.set(key, { bus, direction, note: `imported ${istDayOf(at)} ${direction}`, rows: [] });
    groups.get(key).rows.push({ at, student: st, status });
  }
  for (const g of groups.values()) {
    g.rows.sort((a, b) => a.at - b.at);
    const first = g.rows[0].at;
    const last = g.rows[g.rows.length - 1].at;
    const inchargeId = incharges.find((u) => u.bus_id === g.bus.id)?.id ?? actorId;
    let trip = await get("SELECT id FROM trips WHERE bus_id = ? AND note = ? AND status = 'ended'", g.bus.id, g.note);
    if (!trip) {
      const id = (await run(
        'INSERT INTO trips(bus_id, incharge_id, direction, secret, status, started_at, ended_at, ended_by, note) VALUES(?,?,?,?,?,?,?,?,?)',
        g.bus.id, inchargeId, g.direction, randomId(32), 'ended', first, last, actorId, g.note,
      )).lastInsertRowid;
      trip = { id };
      out.trips++;
    }
    const stmts = [];
    for (const r of g.rows) {
      if (r.status === 'VERIFIED') {
        stmts.push(["INSERT OR IGNORE INTO checkins(trip_id, student_id, device_id, ip, method, flags, created_at) VALUES(?, ?, NULL, NULL, 'qr', 'imported', ?)", trip.id, r.student.id, r.at]);
      } else {
        stmts.push(['INSERT INTO duplicates(trip_id, student_id, device_id, created_at) SELECT ?, ?, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM duplicates WHERE trip_id = ? AND student_id = ? AND created_at = ?)', trip.id, r.student.id, r.at, trip.id, r.student.id, r.at]);
      }
    }
    const results = await batchChunks(stmts);
    g.rows.forEach((r, i) => { if (results[i]?.changes) out[r.status === 'VERIFIED' ? 'verified' : 'duplicates']++; });
    // keep the trip's time span covering everything imported into it
    await run('UPDATE trips SET started_at = MIN(started_at, ?), ended_at = MAX(COALESCE(ended_at, 0), ?) WHERE id = ?', first, last, trip.id);
  }
  return out;
}

/**
 * Incharges sheet: InchargeID, Name, BusNo, Active, Role. Rows with role INCHARGE become bus admin
 * accounts (login = InchargeID). New accounts get a generated password, returned once. Existing
 * accounts keep their password and only get their name, bus and active state updated.
 */
export async function importIncharges(list) {
  const ts = now();
  const [users, buses] = await Promise.all([
    all('SELECT username FROM users'),
    all('SELECT id, number FROM buses'),
  ]);
  const taken = new Set(users.map((u) => u.username.toLowerCase()));
  const busId = new Map(buses.map((b) => [b.number.toLowerCase(), b.id]));
  const stmts = [];
  const created = [];
  let updated = 0;
  for (const row of list) {
    const role = String(row.role ?? 'INCHARGE').trim().toUpperCase();
    if (role && role !== 'INCHARGE') continue; // the workbook's ADMIN row: the console already has its super admin
    const username = String(row.id ?? '').trim().slice(0, 32);
    if (!/^[a-z0-9._-]{3,32}$/i.test(username)) continue;
    const name = String(row.name ?? '').trim().slice(0, 80) || username;
    const bus = busId.get(String(row.bus ?? '').trim().toLowerCase()) ?? null;
    const active = isActiveCell(row.active) ? 1 : 0;
    if (taken.has(username.toLowerCase())) {
      updated++;
      stmts.push(["UPDATE users SET name = ?, bus_id = ?, active = ?, updated_at = ? WHERE username = ? AND role = 'incharge'", name, bus, active, ts, username]);
      continue;
    }
    taken.add(username.toLowerCase());
    const password = generatePassword(12);
    stmts.push([
      'INSERT INTO users(username,name,role,password_hash,password_view,bus_id,active,must_change_password,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,?,?)',
      username, name, 'incharge', hashPassword(password), sealPassword(password, config.sessionSecret), bus, active, ts, ts,
    ]);
    const busNumber = buses.find((b) => b.id === bus)?.number ?? '';
    created.push({ username, name, bus: busNumber, password, portal: busNumber ? `/bus/${encodeURIComponent(busNumber)}` : '/incharge' });
  }
  await batchChunks(stmts);
  return { created, updated };
}
