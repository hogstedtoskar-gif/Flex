/* server.js — Express app for the Time Tracker.
 *
 * Serves the static UI from ../public and exposes a small REST API
 * backed by SQLite (see db.js). Multi-user: each request must carry a
 * session cookie (see auth.js); data is scoped per user.
 *
 * Configurable via env:
 *   PORT                (default 8787)
 *   HOST                (default 0.0.0.0)
 *   DATA_DIR            (default ./data, relative to this file)
 *   PUBLIC_DIR          (default ../public, relative to this file)
 *   BOOTSTRAP_USER      (optional — created on first start if no users exist)
 *   BOOTSTRAP_PASSWORD  (required when BOOTSTRAP_USER is set)
 *   ALLOW_REGISTRATION  ("1" to expose POST /api/auth/register)
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const { open } = require('./db');
const auth = require('./auth');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'));
const DB_PATH = path.join(DATA_DIR, 'timetracker.db');
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION === '1';

fs.mkdirSync(DATA_DIR, { recursive: true });

const store = open(DB_PATH);
bootstrap(store);
// Clean up stale sessions on startup and every 6h afterwards.
try { store.purgeOldSessions(`-${auth.SESSION_MAX_AGE_DAYS}`); } catch (_) { /* noop */ }
const purgeTimer = setInterval(() => {
  try { store.purgeOldSessions(`-${auth.SESSION_MAX_AGE_DAYS}`); } catch (_) { /* noop */ }
}, 6 * 60 * 60 * 1000);
purgeTimer.unref();

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use(auth.cookieMiddleware());
app.use(auth.loadSession(store));

app.use((req, _res, next) => {
  if (req.path.startsWith('/api')) {
    const who = req.user ? req.user.username : '-';
    process.stdout.write(`[${new Date().toISOString()}] ${who} ${req.method} ${req.path}\n`);
  }
  next();
});

/* ----------------- Auth API (public) ----------------- */

const authApi = express.Router();

authApi.get('/config', (_req, res) => {
  res.json({ allowRegistration: ALLOW_REGISTRATION });
});

authApi.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.user });
});

authApi.post('/login', (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) throw httpErr(400, 'username and password are required');
    const row = store.getUserByUsername(username);
    if (!row || !auth.verifyPassword(password, row.password_hash)) {
      // Intentionally vague to avoid leaking which half was wrong.
      throw httpErr(401, 'invalid username or password');
    }
    const token = auth.newSessionToken();
    store.createSession(row.id, token);
    auth.setSessionCookie(res, token, req);
    res.json({ user: { id: row.id, username: row.username } });
  } catch (err) { next(err); }
});

authApi.post('/logout', (req, res) => {
  if (req.sessionToken) {
    try { store.deleteSession(req.sessionToken); } catch (_) { /* noop */ }
  }
  auth.clearSessionCookie(res, req);
  res.status(204).end();
});

authApi.post('/change-password', auth.requireAuth, (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      throw httpErr(400, 'currentPassword and newPassword are required');
    }
    const row = store.getUserByUsername(req.user.username);
    if (!row || !auth.verifyPassword(currentPassword, row.password_hash)) {
      throw httpErr(401, 'current password is incorrect');
    }
    store.setPassword(row.id, auth.hashPassword(newPassword));
    // Invalidate every other session; keep the current one alive.
    store.deleteUserSessions(row.id);
    const token = auth.newSessionToken();
    store.createSession(row.id, token);
    auth.setSessionCookie(res, token, req);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

if (ALLOW_REGISTRATION) {
  authApi.post('/register', (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) throw httpErr(400, 'username and password are required');
      const user = store.createUser(username, auth.hashPassword(password));
      const token = auth.newSessionToken();
      store.createSession(user.id, token);
      auth.setSessionCookie(res, token, req);
      res.status(201).json({ user });
    } catch (err) { next(err); }
  });
}

app.use('/api/auth', authApi);

/* ----------------- Health (public) ----------------- */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

/* ----------------- Protected API ----------------- */

const api = express.Router();
api.use(auth.requireAuth);

api.get('/state', (req, res, next) => {
  try { res.json(store.getState(req.user.id)); }
  catch (err) { next(err); }
});

api.put('/state', (req, res, next) => {
  try { res.json(store.replaceAll(req.user.id, req.body)); }
  catch (err) { next(err); }
});

api.put('/settings', (req, res, next) => {
  try { res.json(store.setSettings(req.user.id, req.body)); }
  catch (err) { next(err); }
});

api.put('/days/:date', (req, res, next) => {
  try {
    const result = store.setDay(req.user.id, req.params.date, req.body);
    if (result === null) return res.status(204).end();
    res.json(result);
  } catch (err) { next(err); }
});

api.delete('/days/:date', (req, res, next) => {
  try {
    store.deleteDay(req.user.id, req.params.date);
    res.status(204).end();
  } catch (err) { next(err); }
});

api.post('/reset', (req, res, next) => {
  try { res.json(store.resetUser(req.user.id)); }
  catch (err) { next(err); }
});

app.use('/api', api);

/* ----------------- Static UI ----------------- */

if (!fs.existsSync(PUBLIC_DIR)) {
  console.warn(`[warn] PUBLIC_DIR not found: ${PUBLIC_DIR}`);
}
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next(err);
  });
});

/* ----------------- Error handler ----------------- */

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 400;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.message || 'Internal error' });
});

/* ----------------- Bootstrap + shutdown ----------------- */

function bootstrap(store) {
  const bootUser = process.env.BOOTSTRAP_USER;
  const bootPass = process.env.BOOTSTRAP_PASSWORD;
  if (!bootUser) return;

  const existing = store.getUserByUsername(bootUser);
  if (existing) return;

  const loginableUsers = store.listUsers().filter(
    (u) => u.username !== '_legacy'
  );
  if (loginableUsers.length > 0) return;

  if (!bootPass) {
    console.warn('[bootstrap] BOOTSTRAP_USER is set but BOOTSTRAP_PASSWORD is empty; skipping.');
    return;
  }

  const legacy = store.getUserByUsername('_legacy');
  if (legacy) {
    // Adopt any migrated single-user data into this brand-new account.
    store.renameUser(legacy.id, bootUser);
    store.setPassword(legacy.id, auth.hashPassword(bootPass));
    console.log(`[bootstrap] claimed migrated data as user "${bootUser}".`);
  } else {
    const user = store.createUser(bootUser, auth.hashPassword(bootPass));
    console.log(`[bootstrap] created initial user "${user.username}".`);
  }
}

function httpErr(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

const server = app.listen(PORT, HOST, () => {
  console.log(`Time Tracker listening on http://${HOST}:${PORT}`);
  console.log(`  data:     ${DB_PATH}`);
  console.log(`  static:   ${PUBLIC_DIR}`);
  console.log(`  register: ${ALLOW_REGISTRATION ? 'open' : 'disabled (use admin.js)'}`);
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}, closing.`);
  clearInterval(purgeTimer);
  server.close(() => {
    try { store.db.close(); } catch (_) { /* noop */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
