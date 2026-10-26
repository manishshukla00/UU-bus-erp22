/* Dates and labels, always shown in India time (the college's clock), whatever the device says. */

const TZ = 'Asia/Kolkata';
const time = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
const timeSec = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
const date = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
const isoDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export const fmtTime = (ms) => (ms ? time.format(ms) : '');
export const fmtTimeSec = (ms) => (ms ? timeSec.format(ms) : '');
export const fmtDate = (ms) => (ms ? date.format(ms) : '');
export const fmtDateTime = (ms) => (ms ? `${fmtDate(ms)}, ${fmtTime(ms)}` : '');
/** Today's date in India as YYYY-MM-DD. */
export const todayIso = () => isoDay.format(Date.now());

export function fmtRel(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(ms);
}

export const directionLabel = (d) => (d === 'to_college' ? 'To college' : d === 'from_college' ? 'From college' : d || '');
export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export const FLAG_INFO = {
  new_device: ['pill-warn', 'New phone', 'Verified from a phone not used before'],
  wrong_bus: ['pill-warn', 'Other bus', 'Student is assigned to a different bus'],
  manual: ['', 'Manual', 'Marked by staff, not by QR scan'],
  imported: ['pill-muted', 'Imported', 'Verified in the previous (Apps Script) system and imported from the workbook'],
};
