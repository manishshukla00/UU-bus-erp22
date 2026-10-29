/*
 * Database: one small set of helpers used by the whole server.
 *
 *   Local / own server  ->  SQLite file data/bus-erp.sqlite (Node's built-in node:sqlite, no setup)
 *   Netlify (online)    ->  Turso (hosted SQLite) when TURSO_DATABASE_URL is set
 *
 * Both speak the same SQL, so every query in the app works on both.
 *
 *   get(sql, ...params)   -> first row or undefined
 *   all(sql, ...params)   -> array of rows
 *   run(sql, ...params)   -> { changes, lastInsertRowid }
 *   read([...queries])    -> several SELECTs in ONE trip to the database (faster on Turso)
 *   batch([...queries])   -> several writes in one go: all succeed or none (a transaction)
 * A query in read()/batch() is 'SQL' or ['SQL', param1, param2, ...].
 */
import fs from 'node:fs';
import { createClient } from '@libsql/client/web';
import { config, credentialsFile } from './config.js';
import { hashPassword, generatePassword, passwordProblem } from './security.js';

// SQL parameters: booleans become 1/0 and undefined becomes NULL
const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
const toStatement = (q) => (typeof q === 'string' ? { sql: q, args: [] } : { sql: q[0], args: clean(q.slice(1)) });
const returnsRows = (sql) => /^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql);

// ---------------------------------------------------------------- driver 1: local SQLite file
async function openSqliteFile(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const statements = new Map(); // prepared statements are reused
  const prepare = (sql) => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  const runOne = ({ sql, args }) => {
    if (returnsRows(sql)) {
      const rows = prepare(sql).all(...args);
      return { changes: rows.length, lastInsertRowid: null, rows };
    }
    const r = prepare(sql).run(...args);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid), rows: [] };
  };

  return {
    run: async (sql, args) => runOne({ sql, args: clean(args) }),
    get: async (sql, args) => prepare(sql).get(...clean(args)),
    all: async (sql, args) => prepare(sql).all(...clean(args)),
    read: async (queries) => queries.map(toStatement).map(({ sql, args }) => prepare(sql).all(...args)),
    batch: async (queries) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = queries.map(toStatement).map(runOne);
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    exec: async (sql) => db.exec(sql),
    close: async () => db.close(),
  };
}

// ---------------------------------------------------------------- driver 2: Turso (hosted)
function openTurso(url, authToken) {
  const client = createClient({ url, authToken: authToken || undefined, intMode: 'number' });
  // Turso returns rows as arrays + column names; turn them into plain objects
  const objects = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
  const result = (rs) => ({
    changes: rs.rowsAffected,
    lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid),
    rows: objects(rs),
  });
  return {
    run: async (sql, args) => result(await client.execute({ sql, args: clean(args) })),
    get: async (sql, args) => objects(await client.execute({ sql, args: clean(args) }))[0],
    all: async (sql, args) => objects(await client.execute({ sql, args: clean(args) })),
    read: async (queries) => (await client.batch(queries.map(toStatement), 'read')).map(objects),
    batch: async (queries) => (await client.batch(queries.map(toStatement), 'write')).map(result),
    exec: (sql) => client.executeMultiple(sql),
    close: async () => client.close(),
  };
}

// One connection per server process (or per serverless instance), opened on first use
let connection = null;
function db() {
  if (!connection) {
    connection = Promise.resolve(config.dbUrl ? openTurso(config.dbUrl, config.dbAuthToken) : openSqliteFile(config.dbPath))
      .catch((e) => { connection = null; throw e; });
  }
  return connection;
}

export const dbKind = () => (config.dbUrl ? 'turso' : 'sqlite');
export const now = () => Date.now();

export const run = async (sql, ...params) => (await db()).run(sql, params);
export const get = async (sql, ...params) => (await db()).get(sql, params);
export const all = async (sql, ...params) => (await db()).all(sql, params);
export const read = async (queries) => (queries.length ? (await db()).read(queries) : []);
export const batch = async (queries) => (queries.length ? (await db()).batch(queries) : []);
export const execRaw = async (sql) => (await db()).exec(sql);

/** Very long write lists (imports of thousands of rows) go in chunks of 400. */
export async function batchChunks(queries, size = 400) {
  const out = [];
  for (let i = 0; i < queries.length; i += size) out.push(...(await batch(queries.slice(i, i + size))));
  return out;
}

// ---------------------------------------------------------------- tables
// "IF NOT EXISTS" everywhere: running this on an existing database changes nothing.
const SCHEMA = [
  // buses and their pickup points (routes)
  `CREATE TABLE IF NOT EXISTS buses (
    id INTEGER PRIMARY KEY,
    number TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    route TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stops (
    id INTEGER PRIMARY KEY,
    bus_id INTEGER NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    UNIQUE(bus_id, name COLLATE NOCASE))`,

  // staff accounts: admin (super admin), operator (read-only), incharge (one bus)
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','operator','incharge')),
    password_hash TEXT NOT NULL,
    bus_id INTEGER REFERENCES buses(id) ON DELETE SET NULL,
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    password_view TEXT)`, // encrypted copy, so the super admin can look up an incharge's password
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    ip TEXT, ua TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)',

  // students (verify with their UUID or enrollment number)
  `CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY,
    uuid TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    course TEXT NOT NULL DEFAULT '',
    year TEXT NOT NULL DEFAULT '',
    specialization TEXT NOT NULL DEFAULT '',
    bus_id INTEGER REFERENCES buses(id) ON DELETE SET NULL,
    stop_id INTEGER REFERENCES stops(id) ON DELETE SET NULL,
    phone TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    photo_url TEXT NOT NULL DEFAULT '',
    enrollment_no TEXT NOT NULL DEFAULT '')`,
  'CREATE INDEX IF NOT EXISTS students_bus ON students(bus_id)',
  'CREATE INDEX IF NOT EXISTS students_name ON students(name COLLATE NOCASE)',
  'CREATE INDEX IF NOT EXISTS students_enrollment ON students(enrollment_no COLLATE NOCASE)',
  // selfies taken at first verification (base64 JPEG), kept until an admin removes them
  `CREATE TABLE IF NOT EXISTS student_photos (
    student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    data TEXT NOT NULL,
    device_id TEXT,
    created_at INTEGER NOT NULL)`,

  // trips: one bus run (to college / from college); only one running trip per bus
  `CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY,
    bus_id INTEGER NOT NULL REFERENCES buses(id),
    incharge_id INTEGER NOT NULL REFERENCES users(id),
    direction TEXT NOT NULL CHECK(direction IN ('to_college','from_college')),
    secret TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_by INTEGER REFERENCES users(id),
    note TEXT NOT NULL DEFAULT '')`,
  "CREATE UNIQUE INDEX IF NOT EXISTS trips_one_active_per_bus ON trips(bus_id) WHERE status = 'active'",
  'CREATE INDEX IF NOT EXISTS trips_started ON trips(started_at)',

  // phones: each phone is tied to the first student who verifies with it
  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
    ua TEXT,
    bound_at INTEGER,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS devices_student ON devices(student_id)',
  // the short private session a phone gets after scanning the QR
  `CREATE TABLE IF NOT EXISTS checkin_sessions (
    id TEXT PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    ip TEXT, ua TEXT,
    lookups INTEGER NOT NULL DEFAULT 0,
    student_id INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS checkin_sessions_exp ON checkin_sessions(expires_at)',

  // verifications: one per student per trip, one per phone per trip
  `CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    device_id TEXT,
    ip TEXT,
    method TEXT NOT NULL DEFAULT 'qr' CHECK(method IN ('qr','manual')),
    flags TEXT NOT NULL DEFAULT '',
    marked_by INTEGER REFERENCES users(id),
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(trip_id, student_id))`,
  'CREATE UNIQUE INDEX IF NOT EXISTS checkins_one_device_per_trip ON checkins(trip_id, device_id) WHERE device_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS checkins_student ON checkins(student_id)',
  'CREATE INDEX IF NOT EXISTS checkins_created ON checkins(created_at)',
  // repeat scans by someone already verified on that trip
  `CREATE TABLE IF NOT EXISTS duplicates (
    id INTEGER PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    device_id TEXT,
    created_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS duplicates_trip ON duplicates(trip_id)',
  'CREATE INDEX IF NOT EXISTS duplicates_created ON duplicates(created_at)',

  // everything else: audit log, settings, live events (for polling screens), rate-limit counters
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER,
    actor_name TEXT,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    details TEXT NOT NULL DEFAULT '',
    ip TEXT,
    created_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at)',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    bus_id INTEGER,
    incharge_id INTEGER,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS events_created ON events(created_at)',
  'CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, reset_at INTEGER NOT NULL)',
];

/** Create any missing table (one trip to the database). Returns how many staff accounts exist. */
export async function createTables() {
  const results = await batch([...SCHEMA, 'SELECT COUNT(*) AS c FROM users']);
  return results[results.length - 1].rows[0].c;
}

// ---------------------------------------------------------------- settings
// Settings change rarely but are read on every scan, so they are kept in memory for 10 seconds.
let settingsCache = null;
async function loadSettings() {
  if (settingsCache && Date.now() - settingsCache.time < 10_000) return settingsCache.values;
  const rows = await all('SELECT key, value FROM settings');
  settingsCache = { time: Date.now(), values: new Map(rows.map((r) => [r.key, r.value])) };
  return settingsCache.values;
}
export const getSetting = async (key, fallback = '') => (await loadSettings()).get(key) ?? fallback;
export async function setSetting(key, value) {
  await run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  if (settingsCache) settingsCache.values.set(key, String(value));
}

// ---------------------------------------------------------------- first start
/**
 * When there are no staff accounts yet, create "admin".
 * Its password comes from ADMIN_PASSWORD, or (on your own computer/server) is generated and
 * saved to data/initial-admin.txt. The admin must choose a new password at first sign-in.
 */
async function createFirstAdmin() {
  let password = process.env.ADMIN_PASSWORD || '';
  if (password && passwordProblem(password)) {
    console.warn(`ADMIN_PASSWORD ignored: ${passwordProblem(password)}`);
    password = '';
  }
  if (!password) {
    if (config.serverless) {
      console.warn('No admin account yet. Set the ADMIN_PASSWORD environment variable.');
      return null;
    }
    password = generatePassword(16);
  }
  const t = now();
  const r = await run(
    'INSERT OR IGNORE INTO users(username, name, role, password_hash, active, must_change_password, created_at, updated_at) VALUES(?, ?, ?, ?, 1, 1, ?, ?)',
    'admin', 'Administrator', 'admin', hashPassword(password), t, t,
  );
  if (!r.changes) return null;
  let file = null;
  if (!config.serverless) {
    file = credentialsFile('initial-admin.txt');
    fs.writeFileSync(file, `UU Bus ERP first admin login\n\nusername: admin\npassword: ${password}\n\nYou must change this password on first login. Delete this file afterwards.\n`, { mode: 0o600 });
  }
  return { username: 'admin', password, file };
}

/** Tables + first admin, once per process. Every request waits for this (it is instant after the first time). */
let readyPromise = null;
export function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const staff = await createTables();
      const firstAdmin = staff === 0 ? await createFirstAdmin() : null;
      return { firstAdmin };
    })().catch((e) => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

/** Housekeeping: expired staff sessions, old check-in sessions, old live events and rate-limit rows. */
export async function cleanup() {
  const t = now();
  await batch([
    ['DELETE FROM sessions WHERE expires_at < ?', t],
    ['DELETE FROM checkin_sessions WHERE expires_at < ?', t - 3_600_000],
    ['DELETE FROM events WHERE created_at < ?', t - 6 * 3_600_000],
    ['DELETE FROM rate_limits WHERE reset_at < ?', t],
  ]);
}

export async function closeDb() {
  if (!connection) return;
  try { await (await connection).close(); } catch { /* already closed */ }
  connection = null;
  readyPromise = null;
}
