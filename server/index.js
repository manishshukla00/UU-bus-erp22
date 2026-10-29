/*
 * Starts the server on your computer or your own server: `npm start` (or `npm run dev`).
 * On Netlify the same app runs from netlify/functions/server.js instead.
 */
import { config, lanIp } from './config.js';
import { ready, cleanup, closeDb, dbKind } from './db.js';
import { closeAll } from './services/events.js';
import { baseUrl } from './services/qr.js';
import app from './app.js';

if (config.problems.length) {
  console.error(`Configuration problems:\n - ${config.problems.join('\n - ')}`);
  process.exit(1);
}

// create the tables (and the first admin account on a brand-new database)
const { firstAdmin } = await ready();
const qrBase = await baseUrl();

const server = app.listen(config.port, config.host, () => {
  const lines = [
    '',
    '  UU Bus ERP is running',
    `  Local:     http://localhost:${config.port}`,
    `  Network:   http://${lanIp()}:${config.port}`,
    `  QR links:  ${qrBase}  (change in Admin > Settings or BASE_URL)`,
    `  Database:  ${dbKind() === 'sqlite' ? config.dbPath : 'Turso'}`,
    `  Live:      ${config.liveMode === 'sse' ? 'instant push' : 'polling'}`,
  ];
  if (firstAdmin) {
    lines.push('', '  FIRST RUN: admin account created', `  username: ${firstAdmin.username}`, `  password: ${firstAdmin.password}`);
    if (firstAdmin.file) lines.push(`  (also saved to ${firstAdmin.file} - delete it after first login)`);
  }
  console.log(lines.join('\n') + '\n');
});

// every 10 minutes: remove expired sessions and old data
setInterval(() => cleanup().catch((e) => console.error('cleanup failed', e)), 10 * 60_000).unref();

// Ctrl+C or a service stop: close live connections and the database cleanly
function shutdown() {
  closeAll();
  server.close(() => closeDb().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => console.error('Unhandled error:', e));
