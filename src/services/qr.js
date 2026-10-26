import QRCode from 'qrcode';
import { config, publicBaseUrl } from '../config.js';
import { hmac, safeEqual, randomId } from '../security.js';
import { get, getSetting, setSetting } from '../db.js';

/*
 * Three QR modes (Admin → Settings):
 *
 *  'trip'     (default) One QR per trip, valid for N hours (default 2) from the trip's start. A photo of
 *             it is useless on any other trip, and after N hours. "New QR code" cancels it and gives
 *             a fresh N hours from now.
 *             token = t<tripId>.<windowStart>.<hmac(tripSecret|serverSecret, trip|tripId|windowStart)>
 *
 *  'day'      One QR per bus per calendar day (India time). It works for whichever trip that bus is
 *             running, so it can be shown all day or printed. "New QR code" invalidates it at once.
 *             token = d<busId>.<istDay>.<hmac(serverSecret, busId|day|busNonce)>
 *
 *  'rotating' A new QR every N seconds, bound to one trip. Screenshots and forwarded links die
 *             within N × (1 + grace) seconds. Strongest protection against remote check-ins.
 *             token = <tripId>.<slot>.<hmac(tripSecret|serverSecret, tripId.slot)>
 */
const SIG_LEN = 27;
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

const MODES = ['trip', 'day', 'rotating'];
export const qrMode = async () => {
  const m = await getSetting('qr_mode', config.qrModeDefault);
  return MODES.includes(m) ? m : config.qrModeDefault;
};
export const setQrMode = (mode) => setSetting('qr_mode', MODES.includes(mode) ? mode : config.qrModeDefault);

// ------------------------------------------------------------------ per trip, N hours
const clampHours = (h) => Math.min(12, Math.max(0.5, Number(h) || config.qrTripHours));
export const qrTripHours = async () => clampHours(await getSetting('qr_trip_hours', String(config.qrTripHours)));
export const setQrTripHours = (h) => setSetting('qr_trip_hours', String(clampHours(h)));
/** When the trip's current QR window began: the trip start, or the last "New QR code". */
const tripWindowStart = async (trip) => Number(await getSetting(`qr_trip_start:${trip.id}`, '0')) || trip.started_at;
const tripSig = (trip, ws) => hmac(trip.secret + '|' + config.sessionSecret, `trip|${trip.id}|${ws}`).slice(0, SIG_LEN);

/** { token, validUntil } of the trip's QR. `trip` needs id, secret and started_at. */
export async function tripTokenFor(trip) {
  const ws = await tripWindowStart(trip);
  return { token: `t${trip.id}.${ws}.${tripSig(trip, ws)}`, validUntil: ws + (await qrTripHours()) * 3_600_000 };
}

/** "New QR code" on a trip: the old QR stops working; the new one is valid N hours from now. */
export const regenerateTripQr = (tripId) => setSetting(`qr_trip_start:${tripId}`, String(Date.now()));

// ------------------------------------------------------------------ rotating (per trip)
const slotOf = (ms) => Math.floor(ms / 1000 / config.qrRotateSec);
const sigFor = (trip, payload) => hmac(trip.secret + '|' + config.sessionSecret, payload).slice(0, SIG_LEN);

export function tokenFor(trip, ms = Date.now()) {
  const payload = `${trip.id}.${slotOf(ms)}`;
  return `${payload}.${sigFor(trip, payload)}`;
}

export function secondsLeftInSlot(ms = Date.now()) {
  const s = config.qrRotateSec;
  return s - Math.floor((ms / 1000) % s);
}

// ------------------------------------------------------------------ whole day (per bus)
export const istDay = (ms = Date.now()) => Math.floor((ms + IST_OFFSET_MS) / DAY_MS);
/** Epoch ms when the current India-time day ends (the day QR stops working). */
export const endOfIstDay = (ms = Date.now()) => (istDay(ms) + 1) * DAY_MS - IST_OFFSET_MS;
const busNonce = (busId) => getSetting(`qr_nonce:${busId}`, '0');
const daySig = (busId, day, nonce) => hmac(config.sessionSecret, `day|${busId}|${day}|${nonce}`).slice(0, SIG_LEN);

export async function dayTokenFor(busId, ms = Date.now()) {
  const day = istDay(ms);
  return `d${busId}.${day}.${daySig(busId, day, await busNonce(busId))}`;
}

/** "New QR code": every earlier QR of this bus (screens, prints, forwards) stops working. */
export const regenerateDayQr = (busId) => setSetting(`qr_nonce:${busId}`, randomId(9));

// ------------------------------------------------------------------ shared
/** Public address phones open. Pass the request so serverless deployments can fall back to their own origin. */
export const baseUrl = async (req) => publicBaseUrl(await getSetting('base_url'), req);

/** Each bus gets its own link: /checkin/<bus number>?t=<token>. */
export const checkinUrl = async (token, busNumber, req) =>
  `${await baseUrl(req)}/checkin${busNumber ? `/${encodeURIComponent(busNumber)}` : ''}?t=${encodeURIComponent(token)}`;

export function qrSvg(url) {
  return QRCode.toString(url, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#0b1220ff', light: '#ffffff00' },
  });
}

/**
 * Check a scanned token.
 * Returns { trip } (the running trip, with secret) or { error: 'QR_EXPIRED' | 'NO_TRIP', bus }.
 * Rotating tokens are accepted in both modes (they are strictly stronger); day tokens only in day mode.
 */
export async function verifyToken(token, ms = Date.now()) {
  if (typeof token !== 'string' || token.length > 120) return { error: 'QR_EXPIRED' };
  const parts = token.split('.');
  if (parts.length !== 3) return { error: 'QR_EXPIRED' };

  if (parts[0].startsWith('t')) {
    const tripId = Number(parts[0].slice(1));
    const ws = Number(parts[1]);
    if (!Number.isInteger(tripId) || tripId <= 0 || !Number.isInteger(ws) || ws <= 0) return { error: 'QR_EXPIRED' };
    if ((await qrMode()) !== 'trip') return { error: 'QR_EXPIRED' };
    const trip = await get(
      `SELECT t.*, b.number AS bus_number, b.name AS bus_name, b.route AS bus_route
         FROM trips t JOIN buses b ON b.id = t.bus_id WHERE t.id = ? AND t.status = 'active'`,
      tripId,
    );
    if (!trip || !safeEqual(parts[2], tripSig(trip, ws))) return { error: 'QR_EXPIRED' };
    // only the trip's current QR, and only within its N hours
    if (ws !== (await tripWindowStart(trip)) || ms >= ws + (await qrTripHours()) * 3_600_000) return { error: 'QR_EXPIRED' };
    return { trip };
  }

  if (parts[0].startsWith('d')) {
    const busId = Number(parts[0].slice(1));
    const day = Number(parts[1]);
    if (!Number.isInteger(busId) || busId <= 0 || day !== istDay(ms)) return { error: 'QR_EXPIRED' };
    if ((await qrMode()) !== 'day') return { error: 'QR_EXPIRED' };
    if (!safeEqual(parts[2], daySig(busId, day, await busNonce(busId)))) return { error: 'QR_EXPIRED' };
    // the bus and its running trip (with the bus details the phone shows) in one query
    const row = await get(
      `SELECT b.id AS b_id, b.number AS bus_number, b.name AS bus_name, b.route AS bus_route, t.*
         FROM buses b LEFT JOIN trips t ON t.bus_id = b.id AND t.status = 'active' WHERE b.id = ? AND b.active = 1`,
      busId,
    );
    if (!row) return { error: 'QR_EXPIRED' };
    return row.id ? { trip: row } : { error: 'NO_TRIP', bus: { id: row.b_id, number: row.bus_number } };
  }

  const tripId = Number(parts[0]);
  const slot = Number(parts[1]);
  if (!Number.isInteger(tripId) || tripId <= 0 || !Number.isInteger(slot)) return { error: 'QR_EXPIRED' };
  const cur = slotOf(ms);
  if (slot > cur || slot < cur - config.qrGraceSlots) return { error: 'QR_EXPIRED' };
  const trip = await get(
    `SELECT t.*, b.number AS bus_number, b.name AS bus_name, b.route AS bus_route
       FROM trips t JOIN buses b ON b.id = t.bus_id WHERE t.id = ? AND t.status = 'active'`,
    tripId,
  );
  if (!trip || !safeEqual(parts[2], sigFor(trip, `${tripId}.${slot}`))) return { error: 'QR_EXPIRED' };
  return { trip };
}
