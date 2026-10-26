import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { ready, cleanup, get, dbStats } from './db.js';
import { HttpError, intParam } from './http.js';
import { loadSession, requireAuth } from './middleware/auth.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { subscribe, pollEvents } from './services/events.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import inchargeRoutes from './routes/incharge.js';
import checkinRoutes from './routes/checkin.js';
import { photoRoutes } from './services/photos.js';

/*
 * The Express application, shared by:
 *  - src/server.js  (long-running local / VPS server)
 *  - api/index.js   (Vercel serverless function)
 */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

const isHttps = config.serverless || config.cookieSecure;
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        // student photos are linked from wherever the college hosts them (https only)
        'img-src': ["'self'", 'data:', 'https:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        ...(isHttps ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    hsts: isHttps ? { maxAge: 15_552_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }),
);
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

// The React app (built by `npm run build` into dist/). Static files first: no session lookup or body
// parsing for them. Hashed bundles never change, so browsers keep them for a year.
// On Netlify and Vercel the CDN serves dist/ and only /api reaches this app.
const DIST = path.join(config.root, 'dist');
const INDEX = path.join(DIST, 'index.html');
app.use('/assets', express.static(path.join(DIST, 'assets'), { index: false, immutable: true, maxAge: '365d', fallthrough: false }));
app.use(express.static(DIST, { index: false, maxAge: config.isProd ? '1h' : 0, etag: true }));

// ------------------------------------------------------------------ timing
// Server-Timing: total time and database round trips for every API call (visible in the browser's
// network panel), so slow requests can be measured from anywhere.
app.use('/api', (req, res, next) => {
  const stats = { n: 0, ms: 0 };
  const start = performance.now();
  const writeHead = res.writeHead;
  res.writeHead = function timedWriteHead(...args) {
    if (!this.headersSent) this.setHeader('Server-Timing', `db;dur=${stats.ms.toFixed(0)};desc="${stats.n} round trips", app;dur=${(performance.now() - start).toFixed(0)}`);
    return writeHead.apply(this, args);
  };
  dbStats.run(stats, next);
});

// ------------------------------------------------------------------ setup gate
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function setupPage(res, title, items) {
  res.status(503).set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Setup needed · UU Bus ERP</title></head><body><main><div><h1>${escapeHtml(title)}</h1><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul><p>See the "Deploy" sections of the README. Redeploy after changing environment variables.</p></div></main></body></html>`);
}

let lastCleanup = 0;
app.use(async (req, res, next) => {
  if (config.problems.length) {
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'Server is not configured yet', problems: config.problems });
    return setupPage(res, 'Finish the server setup', config.problems);
  }
  try {
    await ready();
  } catch (e) {
    console.error('Database not reachable:', e);
    const msg = 'Cannot reach the database. Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.';
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: msg });
    return setupPage(res, 'Database unavailable', [msg]);
  }
  // opportunistic housekeeping (serverless has no background timers)
  if (Date.now() - lastCleanup > 10 * 60_000) {
    lastCleanup = Date.now();
    cleanup().catch((e) => console.error('cleanup failed', e));
  }
  next();
});

// bulk imports (an Excel workbook or CSV of thousands of students) may be large; everything else is small
const importLimit = config.serverless ? '4mb' : '10mb';
app.use(['/api/admin/import', '/api/admin/students/import'], express.json({ limit: importLimit }));
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: config.serverless ? '4mb' : '10mb' }));
app.use(loadSession);

// ------------------------------------------------------------------ API
app.use('/api', apiLimiter, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/api/health', async (req, res) => {
  const users = (await get('SELECT COUNT(*) AS c FROM users')).c;
  res.json({ ok: true, live: config.liveMode, serverless: config.serverless, region: process.env.AWS_REGION || null, hasUsers: users > 0, time: Date.now() });
});
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/incharge', inchargeRoutes);
app.use('/api/checkin', checkinRoutes);
app.use('/api/photos', photoRoutes);
app.get('/api/events', requireAuth('admin', 'operator', 'incharge'), (req, res) => {
  if (config.liveMode !== 'sse') throw new HttpError(409, 'Live updates use polling on this server', { code: 'USE_POLL' });
  subscribe(req, res, req.user);
});
app.get('/api/events/poll', requireAuth('admin', 'operator', 'incharge'), async (req, res) => {
  const raw = req.query.after ?? '0';
  const after = raw === '0' || raw === '' ? 0 : intParam(raw, 'cursor');
  res.json(await pollEvents(req.user, after));
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ------------------------------------------------------------------ pages
// Every page is the React app; it signs people in, routes them and enforces nothing the API doesn't.
const PAGES = /^\/(?:login|admin|incharge|bus\/[^/]+|checkin(?:\/[^/]+)?)?\/?$/;
app.get(PAGES, (req, res) => {
  if (!fs.existsSync(INDEX)) {
    return setupPage(res, 'Build the web app', ['The React app has not been built yet. Run "npm run build" (or "npm run dev" while developing).']);
  }
  res.set('Cache-Control', 'no-cache');
  res.sendFile(INDEX);
});
// anything else: the app's own "page not found" screen
app.use((req, res) => {
  res.status(404);
  if (req.method === 'GET' && req.accepts('html') && fs.existsSync(INDEX)) return res.sendFile(INDEX);
  res.type('text').send('Not found');
});

// ------------------------------------------------------------------ errors
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err?.status === 400) return res.status(400).json({ error: 'Bad request' });
  // a missing static file (e.g. an old bundle name after a new build)
  if (err?.status === 404 || err?.statusCode === 404) return res.status(404).type('text').send('Not found');
  console.error(`[${new Date().toISOString()}] Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

export default app;
