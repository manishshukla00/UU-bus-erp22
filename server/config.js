/*
 * All settings in one place. Values come from environment variables (or a .env file);
 * every one of them is optional on your own computer. See .env.example.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * The project folder (the one with package.json). Normally found from this file's own location;
 * on Netlify the code is bundled into one file where that location is not available, so fall back
 * to the function's folder or the current folder.
 */
function findRoot() {
  if (import.meta?.url) return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const candidates = [process.env.LAMBDA_TASK_ROOT, process.cwd()].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'package.json'))) || candidates[0] || '.';
}
const ROOT = findRoot();

// read .env if there is one
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env: defaults are fine */ }
const env = process.env;

// Where are we running? Netlify sets HOSTING_PLATFORM=netlify (netlify/functions/server.js).
// "serverless" = no disk that survives and no background timers, so data must live in Turso.
const PLATFORM = env.HOSTING_PLATFORM || (env.NETLIFY ? 'netlify' : 'server');
const SERVERLESS = PLATFORM !== 'server' || env.SERVERLESS === '1';

const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data');
if (!SERVERLESS) fs.mkdirSync(DATA_DIR, { recursive: true });

// problems that stop the app from working (shown on a "finish the setup" page instead of crashing)
const problems = [];

// Turso database (online). Without it, a local SQLite file in data/ is used.
const DB_URL = (env.TURSO_DATABASE_URL || '').trim();
const DB_TOKEN = (env.TURSO_AUTH_TOKEN || '').trim();
if (SERVERLESS && !DB_URL) problems.push('TURSO_DATABASE_URL is not set. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Netlify, then redeploy.');

/**
 * Secret key that signs sessions, phones and QR codes. From SESSION_SECRET, or (on your own
 * computer/server) generated once and kept in data/secret.key. Changing it signs everyone out.
 */
function sessionSecret() {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) return env.SESSION_SECRET;
  if (SERVERLESS) {
    problems.push('SESSION_SECRET is missing or shorter than 32 characters. Add a long random value in Netlify, then redeploy.');
    return 'unconfigured-' + crypto.randomBytes(24).toString('base64url');
  }
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 64) return saved;
  } catch { /* not created yet */ }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** This computer's Wi-Fi address, so phones on the same Wi-Fi can open the QR link. */
export function lanIp() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || /virtual|vmware|vethernet|docker|wsl|hyper-v|bluetooth/i.test(name)) continue;
      // prefer typical home/college network addresses
      found.push({ address: i.address, score: /^192\.168\./.test(i.address) ? 2 : /^10\./.test(i.address) ? 1 : 0 });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return found[0]?.address || '127.0.0.1';
}

const number = (value, fallback, min, max) => Math.min(max, Math.max(min, Number(value) || fallback));
const BASE_URL = (env.BASE_URL || '').trim().replace(/\/+$/, '');

export const config = Object.freeze({
  root: ROOT,
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'bus-erp.sqlite'),
  dbUrl: DB_URL,
  dbAuthToken: DB_TOKEN,
  platform: PLATFORM,
  serverless: SERVERLESS,
  port: Number(env.PORT) || 3000,
  host: env.HOST || '0.0.0.0',
  baseUrl: BASE_URL,
  isProd: env.NODE_ENV === 'production' || SERVERLESS,
  // behind nginx/Caddy/Netlify the real visitor IP comes from the proxy
  trustProxy: env.TRUST_PROXY ? (env.TRUST_PROXY === 'true' ? true : Number(env.TRUST_PROXY) || env.TRUST_PROXY) : SERVERLESS,
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : SERVERLESS || BASE_URL.startsWith('https://'),
  sessionSecret: sessionSecret(),
  sessionTtlMs: number(env.SESSION_HOURS, 12, 1, 168) * 3_600_000,

  // live updates: 'sse' = instant push (one server), 'poll' = screens ask every few seconds (Netlify)
  liveMode: env.LIVE_MODE === 'poll' || env.LIVE_MODE === 'sse' ? env.LIVE_MODE : SERVERLESS ? 'poll' : 'sse',
  pollMs: number(env.POLL_SECONDS, 2.5, 1.5, 30) * 1000,
  // login/scan limits: kept in the database on Netlify so every server instance counts together
  rateLimitStore: env.RATE_LIMIT_STORE === 'db' || env.RATE_LIMIT_STORE === 'memory' ? env.RATE_LIMIT_STORE : SERVERLESS ? 'db' : 'memory',

  // QR codes: 'trip' (one per trip, valid qrTripHours), 'day' (one per bus per day) or 'rotating'
  qrModeDefault: ['trip', 'day', 'rotating'].includes(env.QR_MODE) ? env.QR_MODE : 'trip',
  qrTripHours: number(env.QR_TRIP_HOURS, 2, 0.5, 12),
  qrRotateSec: number(env.QR_ROTATE_SECONDS, 20, 10, 300),
  qrGraceSlots: Math.max(0, Number(env.QR_GRACE_SLOTS ?? 1)),
  // a running trip ends by itself after this many hours (and always at midnight, India time)
  tripMaxHours: number(env.TRIP_MAX_HOURS, 4, 1, 24),

  // students
  checkinTtlMs: number(env.CHECKIN_MINUTES, 5, 1, 30) * 60_000, // time to finish after scanning
  maxDevicesPerStudent: number(env.MAX_DEVICES_PER_STUDENT, 2, 1, 10), // phones per student in 30 days
  deviceWindowDays: 30,

  problems: Object.freeze(problems),
});

/** Where first-run passwords are saved (separate file names for a Turso database). */
export const credentialsFile = (name) => path.join(DATA_DIR, DB_URL ? `turso-${name}` : name);

/**
 * The address phones open from the QR code.
 * Order: Admin → Settings value, then BASE_URL, then (online) the site's own address, then the Wi-Fi address.
 */
export function publicBaseUrl(settingValue, req) {
  const trim = (v) => String(v || '').trim().replace(/\/+$/, '');
  if (trim(settingValue)) return trim(settingValue);
  if (config.baseUrl) return config.baseUrl;
  if (SERVERLESS && req) return `${req.protocol}://${req.get('host')}`;
  return `http://${lanIp()}:${config.port}`;
}
