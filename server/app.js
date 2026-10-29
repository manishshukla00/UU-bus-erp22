/*
 * The Express app: security headers, the React pages and the /api routes.
 * Started by server/index.js (your computer or own server) or netlify/functions/server.js (Netlify).
 */
import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { ready, cleanup, get } from './db.js';
import { HttpError, intParam } from './http.js';
import { loadSession, requireAuth } from './middleware/auth.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { subscribe, pollEvents } from './services/events.js';
import { autoEndStaleTrips } from './services/trips.js';
import { photoRoutes } from './services/photos.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import inchargeRoutes from './routes/incharge.js';
import checkinRoutes from './routes/checkin.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

// ---------------------------------------------------------------- security headers
const https = config.serverless || config.cookieSecure;
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"], // no inline scripts
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'https:'], // student photos may be https links
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'manifest-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"], // nobody can put the site in a frame
      ...(https ? { 'upgrade-insecure-requests': [] } : {}),
    },
  },
  hsts: https ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

// ---------------------------------------------------------------- React app files (dist/)
// `npm run build` puts the React app in dist/. File names in dist/assets change with every build,
// so browsers may keep them for a year. (On Netlify the CDN serves these and only /api reaches us.)
const DIST = path.join(config.root, 'dist');
const INDEX = path.join(DIST, 'index.html');
app.use('/assets', express.static(path.join(DIST, 'assets'), { immutable: true, maxAge: '365d', fallthrough: false }));
app.use(express.static(DIST, { index: false, maxAge: config.isProd ? '1h' : 0 }));

/** A plain "please finish the setup" page, shown instead of crashing. */
function setupPage(res, title, items) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res.status(503).set('Cache-Control', 'no-store').type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Setup needed</title><h1>${esc(title)}</h1><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul><p>See the README.</p>`,
  );
}

// ---------------------------------------------------------------- before every request
let lastCleanup = 0;
let lastTripCheck = 0;
app.use(async (req, res, next) => {
  // missing settings (e.g. SESSION_SECRET on Netlify): explain instead of failing
  if (config.problems.length) {
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'Server is not configured yet', problems: config.problems });
    return setupPage(res, 'Finish the server setup', config.problems);
  }
  // the database must be reachable and its tables created (instant after the first request)
  try {
    await ready();
  } catch (e) {
    console.error('Database not reachable:', e);
    const msg = 'Cannot reach the database. Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.';
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: msg });
    return setupPage(res, 'Database unavailable', [msg]);
  }
  // every 10 minutes: delete expired sessions and old data (Netlify has no background timers)
  if (Date.now() - lastCleanup > 10 * 60_000) {
    lastCleanup = Date.now();
    cleanup().catch((e) => console.error('cleanup failed', e));
  }
  // every minute: end trips someone forgot to end (after 4 hours, or at midnight)
  if (req.path.startsWith('/api/') && Date.now() - lastTripCheck > 60_000) {
    lastTripCheck = Date.now();
    try { await autoEndStaleTrips(); } catch (e) { console.error('trip check failed', e); }
  }
  next();
});

// request bodies: JSON (imports of a whole workbook may be large) and plain CSV text
app.use(['/api/admin/import', '/api/admin/students/import'], express.json({ limit: config.serverless ? '4mb' : '10mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: config.serverless ? '4mb' : '10mb' }));
app.use(loadSession); // sets req.user when a staff member is signed in

// ---------------------------------------------------------------- API
app.use('/api', apiLimiter, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.get('/api/health', async (req, res) => {
  const users = (await get('SELECT COUNT(*) AS c FROM users')).c;
  res.json({ ok: true, live: config.liveMode, serverless: config.serverless, hasUsers: users > 0, time: Date.now() });
});
app.use('/api/auth', authRoutes); // sign in / out, change password
app.use('/api/admin', adminRoutes); // transport console
app.use('/api/incharge', inchargeRoutes); // bus portals
app.use('/api/checkin', checkinRoutes); // student verification (no login)
app.use('/api/photos', photoRoutes); // stored selfies

// live updates: instant push (own server) or polling (Netlify)
app.get('/api/events', requireAuth('admin', 'operator', 'incharge'), (req, res) => {
  if (config.liveMode !== 'sse') throw new HttpError(409, 'Live updates use polling on this server', { code: 'USE_POLL' });
  subscribe(req, res, req.user);
});
app.get('/api/events/poll', requireAuth('admin', 'operator', 'incharge'), async (req, res) => {
  const after = req.query.after && req.query.after !== '0' ? intParam(req.query.after, 'cursor') : 0;
  res.json(await pollEvents(req.user, after));
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------------------------------------------------------------- pages
// Every page is the React app (it decides what to show); the API enforces the rules.
const PAGES = /^\/(?:login|admin|incharge|bus\/[^/]+|checkin(?:\/[^/]+)?)?\/?$/;
app.get(PAGES, (req, res) => {
  if (!fs.existsSync(INDEX)) return setupPage(res, 'Build the web app', ['Run "npm run build" first.']);
  res.set('Cache-Control', 'no-cache');
  res.sendFile(INDEX);
});
// anything else: the React app's "page not found"
app.use((req, res) => {
  res.status(404);
  if (req.method === 'GET' && req.accepts('html') && fs.existsSync(INDEX)) return res.sendFile(INDEX);
  res.type('text').send('Not found');
});

// ---------------------------------------------------------------- errors
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err?.status === 404 || err?.statusCode === 404) return res.status(404).type('text').send('Not found');
  if (err?.status === 400) return res.status(400).json({ error: 'Bad request' });
  console.error(`Error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

export default app;
