import readExcelFile from 'read-excel-file/browser';

/*
 * Reads the Apps Script workbook layout in the browser (nothing is uploaded until "Import"):
 *   Students:  UUID, Name, PhotoURL, Route, BusNo, Course, EnrollmentNo, Active
 *   Buses:     BusNo, Route, InchargeID, Active, Notes
 *   Incharges: InchargeID, Name, BusNo, Salt, PINHash, Active, Role   (PIN hashes are never sent)
 */
const text = (v) => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v).trim());
const key = (v) => text(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const findSheet = (sheets, name) => sheets.find((s) => key(s.sheet) === key(name));
const rowsOf = (sheet) => (sheet?.data || []).map((r) => r.map(text)).filter((r) => r.some(Boolean));

/** Rows as objects keyed by the normalised header (e.g. "busno", "inchargeid"). */
function objects(rows) {
  if (rows.length < 2) return [];
  const head = rows[0].map(key);
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** Students table (header row first) from the "Students" sheet, or the first sheet of a plain file. */
export async function readStudentsFile(file) {
  const sheets = await readExcelFile(file);
  return rowsOf(findSheet(sheets, 'Students') || sheets[0]);
}

export async function readWorkbook(file) {
  const sheets = await readExcelFile(file);
  const students = rowsOf(findSheet(sheets, 'Students'));
  const buses = objects(rowsOf(findSheet(sheets, 'Buses')))
    .map((b) => ({ number: b.busno || b.bus || b.number, route: b.route || '', active: b.active ?? '' }))
    .filter((b) => b.number);
  const incharges = objects(rowsOf(findSheet(sheets, 'Incharges')))
    .map((u) => ({ id: u.inchargeid || u.loginid || u.id || u.username, name: u.name || '', bus: u.busno || u.bus || '', active: u.active ?? '', role: u.role || 'INCHARGE' }))
    .filter((u) => u.id);
  if (!students.length && !buses.length && !incharges.length) {
    throw new Error('No Students, Buses or Incharges sheet found. Use the United University bus database workbook layout.');
  }
  return { students, buses, incharges, sheetNames: sheets.map((s) => s.sheet) };
}
