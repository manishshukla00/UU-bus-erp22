import readExcelFile from 'read-excel-file/browser';

/*
 * Reads the Apps Script workbook layout in the browser (nothing is uploaded until "Import"):
 *   Students:         UUID, Name, PhotoURL, Route, BusNo, Course, EnrollmentNo, Active
 *   Buses:            BusNo, Route, InchargeID, Active, Notes
 *   Incharges:        InchargeID, Name, BusNo, Salt, PINHash, Active, Role   (PIN hashes are never sent)
 *   VerificationLogs: Timestamp, Date, UUID, Name, BusNo, InchargeID, Status, Route, Course
 */
const text = (v) => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v).trim());
const key = (v) => text(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const findSheet = (sheets, name) => sheets.find((s) => key(s.sheet) === key(name));
const rowsOf = (sheet) => (sheet?.data || []).map((r) => r.map(text)).filter((r) => r.some(Boolean));

/** Rows as objects keyed by the normalised header (e.g. "busno", "inchargeid"). Cells keep their type. */
function objects(sheet) {
  const rows = (sheet?.data || []).filter((r) => r.some((v) => text(v)));
  if (rows.length < 2) return [];
  const head = rows[0].map(key);
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** Students table (header row first) from the "Students" sheet, or the first sheet of a plain file. */
export async function readStudentsFile(file) {
  const sheets = await readExcelFile(file);
  return rowsOf(findSheet(sheets, 'Students') || sheets[0]);
}

/*
 * Log timestamps are stored without a timezone (Google Sheets writes them in the spreadsheet's
 * own zone). The Date column is the India-time day the script recorded, so pick the zone that
 * puts every timestamp on that day, preferring the one with the most times in bus hours.
 */
export const TIMEZONES = [
  ['America/Los_Angeles', 'US Pacific (Google Sheets default)'],
  ['UTC', 'UTC'],
  ['Asia/Kolkata', 'India (IST)'],
  ['America/New_York', 'US Eastern'],
  ['Europe/London', 'UK'],
];
function tzOffsetMin(tz, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms) / 60000);
}
/** A wall-clock time read from the sheet (as if UTC) to a real instant in zone `tz`. */
export const toInstant = (naiveMs, tz) => naiveMs - tzOffsetMin(tz, naiveMs) * 60000;
const IST = 330 * 60000;
const istDay = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const istHour = (ms) => new Date(ms + IST).getUTCHours();

function detectZone(logs) {
  let best = { tz: 'Asia/Kolkata', score: -1 };
  for (const [tz] of TIMEZONES) {
    let ok = true;
    let score = 0;
    for (const l of logs) {
      const at = toInstant(l.naive, tz);
      if (l.day && istDay(at) !== l.day) { ok = false; break; }
      if (istHour(at) >= 5 && istHour(at) < 22) score++;
    }
    if (ok && score > best.score) best = { tz, score };
  }
  return best.tz;
}

function readLogs(sheet) {
  return objects(sheet).map((r) => {
    const ts = r.timestamp instanceof Date ? r.timestamp : null;
    const day = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : /^\d{4}-\d{2}-\d{2}/.test(text(r.date)) ? text(r.date).slice(0, 10) : '';
    return { naive: ts ? ts.getTime() : NaN, day, uuid: text(r.uuid), bus: text(r.busno || r.bus), status: text(r.status).toUpperCase(), name: text(r.name) };
  }).filter((l) => Number.isFinite(l.naive) && l.uuid && ['VERIFIED', 'DUPLICATE'].includes(l.status));
}

export async function readWorkbook(file) {
  const sheets = await readExcelFile(file);
  const students = rowsOf(findSheet(sheets, 'Students'));
  const buses = objects(findSheet(sheets, 'Buses'))
    .map((b) => ({ number: text(b.busno || b.bus || b.number), route: text(b.route), active: text(b.active) }))
    .filter((b) => b.number);
  const incharges = objects(findSheet(sheets, 'Incharges'))
    .map((u) => ({ id: text(u.inchargeid || u.loginid || u.id || u.username), name: text(u.name), bus: text(u.busno || u.bus), active: text(u.active), role: text(u.role) || 'INCHARGE' }))
    .filter((u) => u.id);
  const logs = readLogs(findSheet(sheets, 'VerificationLogs'));
  if (!students.length && !buses.length && !incharges.length) {
    throw new Error('No Students, Buses or Incharges sheet found. Use the United University bus database workbook layout.');
  }
  return { students, buses, incharges, logs, zone: logs.length ? detectZone(logs) : 'Asia/Kolkata', sheetNames: sheets.map((s) => s.sheet) };
}
