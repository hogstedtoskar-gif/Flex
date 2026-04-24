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
const quick = require('./quick');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'));
const DB_PATH = path.join(DATA_DIR, 'timetracker.db');
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION === '1';

fs.mkdirSync(DATA_DIR, { recursive: true });

const store = open(DB_PATH);
auth.initApiTokenPepper(DATA_DIR);
bootstrap(store);
// Clean up stale sessions on startup and every 6h afterwards.
try { store.purgeOldSessions(`-${auth.SESSION_MAX_AGE_DAYS}`); } catch (_) { /* noop */ }
const purgeTimer = setInterval(() => {
  try { store.purgeOldSessions(`-${auth.SESSION_MAX_AGE_DAYS}`); } catch (_) { /* noop */ }
}, 6 * 60 * 60 * 1000);
purgeTimer.unref();

const app = express();

app.disable('x-powered-by');
// When running behind a reverse proxy (nginx, Caddy, Cloudflare, ...)
// the admin should set TRUST_PROXY=1 so that req.ip reflects the real
// client address via X-Forwarded-For instead of the proxy's own IP.
// Without this the per-IP auth rate limiter below would throttle every
// user together because they all share the proxy's loopback address.
if (/^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || '')) {
  app.set('trust proxy', true);
}
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

/* ----------------- Auth rate limiting -----------------
 * Login and register run scrypt, which is CPU-heavy by design, so an
 * attacker hammering these endpoints can both DoS the box and brute
 * force passwords. We apply a sliding-window counter keyed on BOTH the
 * remote IP and the username. Either bucket overflowing triggers a 429.
 *
 * Successful attempts are NOT credited back — otherwise an attacker who
 * knows their own good password could keep the counter at zero while
 * probing someone else's account from a shared IP. The window expires
 * naturally so legitimate users are never locked out for long.
 *
 * TODO: behind a reverse proxy, req.ip is the proxy's address unless
 * TRUST_PROXY=1 is set (wired up above). */

const authHitsByIp = new Map();
const authHitsByUser = new Map();
const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_MAX_PER_IP = 10;
const AUTH_MAX_PER_USER = 5;

function bumpAuthHits(map, key, max, now) {
  const entry = map.get(key) || { count: 0, firstAt: now };
  if (now - entry.firstAt > AUTH_WINDOW_MS) {
    entry.count = 0;
    entry.firstAt = now;
  }
  entry.count++;
  map.set(key, entry);
  if (entry.count > max) {
    return Math.ceil((AUTH_WINDOW_MS - (now - entry.firstAt)) / 1000);
  }
  return 0;
}

function rateLimitAuth({ useIp, usernameFrom }) {
  return function (req, res, next) {
    const now = Date.now();
    let retryAfter = 0;

    if (useIp && req.ip) {
      const wait = bumpAuthHits(authHitsByIp, 'ip:' + req.ip, AUTH_MAX_PER_IP, now);
      if (wait > retryAfter) retryAfter = wait;
    }

    let username = '';
    if (usernameFrom === 'body') {
      const raw = req.body && req.body.username;
      if (typeof raw === 'string') username = raw.trim().toLowerCase();
    } else if (usernameFrom === 'user') {
      if (req.user && req.user.username) username = String(req.user.username).trim().toLowerCase();
    }
    if (username) {
      const wait = bumpAuthHits(authHitsByUser, 'user:' + username, AUTH_MAX_PER_USER, now);
      if (wait > retryAfter) retryAfter = wait;
    }

    if (retryAfter > 0) {
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: `Too many attempts — try again in ${retryAfter} seconds`
      });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authHitsByIp) {
    if (now - v.firstAt > AUTH_WINDOW_MS * 5) authHitsByIp.delete(k);
  }
  for (const [k, v] of authHitsByUser) {
    if (now - v.firstAt > AUTH_WINDOW_MS * 5) authHitsByUser.delete(k);
  }
}, AUTH_WINDOW_MS).unref();

/* ----------------- Auth API (public) ----------------- */

const authApi = express.Router();

authApi.get('/config', (_req, res) => {
  res.json({ allowRegistration: ALLOW_REGISTRATION });
});

authApi.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.user });
});

authApi.post('/login', rateLimitAuth({ useIp: true, usernameFrom: 'body' }), (req, res, next) => {
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

authApi.post('/change-password', auth.requireAuth, rateLimitAuth({ useIp: false, usernameFrom: 'user' }), (req, res, next) => {
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

/* API tokens — managed from the browser only (not from another token).
 * This is enforced by `requireSession` below so a stolen widget token
 * can't be used to mint more tokens or look at existing labels. */
function requireSession(req, _res, next) {
  if (!req.user) { const e = new Error('Not authenticated'); e.status = 401; return next(e); }
  if (!req.sessionToken) { const e = new Error('Session required'); e.status = 403; return next(e); }
  next();
}

authApi.get('/tokens', requireSession, (req, res, next) => {
  try { res.json({ tokens: store.listApiTokens(req.user.id) }); }
  catch (err) { next(err); }
});

authApi.post('/tokens', requireSession, (req, res, next) => {
  try {
    const label = (req.body && req.body.label) || 'widget';
    const existing = store.listApiTokens(req.user.id);
    if (existing.length >= 10) throw httpErr(400, 'Maximum of 10 tokens per user');
    const { plaintext, hash } = auth.newApiToken();
    const row = store.createApiToken(req.user.id, hash, label);
    res.status(201).json({
      id: row.id,
      label: row.label,
      // The plaintext is only returned HERE, never again.
      token: plaintext
    });
  } catch (err) { next(err); }
});

authApi.delete('/tokens/:id', requireSession, (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw httpErr(400, 'bad token id');
    const ok = store.deleteApiToken(req.user.id, id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

if (ALLOW_REGISTRATION) {
  authApi.post('/register', rateLimitAuth({ useIp: true, usernameFrom: 'body' }), (req, res, next) => {
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

/* ----------------- Quick actions (phone widget) -----------------
 * Accepts either a session cookie OR Authorization: Bearer ttk_... .
 * Rate-limited per token to stop a runaway widget / accidental double
 * tap from flooding the server. */

const quickHitsByToken = new Map();
const QUICK_WINDOW_MS = 60 * 1000;
const QUICK_MAX_PER_WINDOW = 30;
function rateLimitQuick(req, _res, next) {
  const key = req.apiTokenId ? 'tok:' + req.apiTokenId : ('sess:' + (req.user && req.user.id));
  const now = Date.now();
  const entry = quickHitsByToken.get(key) || { count: 0, firstAt: now };
  if (now - entry.firstAt > QUICK_WINDOW_MS) {
    entry.count = 0;
    entry.firstAt = now;
  }
  entry.count++;
  quickHitsByToken.set(key, entry);
  if (entry.count > QUICK_MAX_PER_WINDOW) {
    const retry = Math.ceil((QUICK_WINDOW_MS - (now - entry.firstAt)) / 1000);
    const err = new Error('Too many requests');
    err.status = 429;
    return next(err);
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of quickHitsByToken) {
    if (now - v.firstAt > QUICK_WINDOW_MS * 5) quickHitsByToken.delete(k);
  }
}, QUICK_WINDOW_MS).unref();

const quickApi = express.Router();
quickApi.use(auth.loadBearerToken(store));
quickApi.use(auth.requireAuth);
quickApi.use(rateLimitQuick);

function resolveQuickInput(req) {
  return {
    tz: (req.body && req.body.tz) || req.query.tz || '',
    date: (req.body && req.body.date) || req.query.date || '',
    time: (req.body && req.body.time) || req.query.time || '',
    project: (req.body && req.body.project) || req.query.project || '',
    tags: (req.body && req.body.tags) || req.query.tags || ''
  };
}

quickApi.get('/status', (req, res, next) => {
  try { res.json(quick.statusOf(store, req.user.id, resolveQuickInput(req))); }
  catch (err) { next(err); }
});

quickApi.post('/clock-in', (req, res, next) => {
  try { res.json(quick.clockIn(store, req.user.id, resolveQuickInput(req))); }
  catch (err) { next(err); }
});

quickApi.post('/clock-out', (req, res, next) => {
  try { res.json(quick.clockOut(store, req.user.id, resolveQuickInput(req))); }
  catch (err) { next(err); }
});

quickApi.post('/lunch-toggle', (req, res, next) => {
  try { res.json(quick.lunchToggle(store, req.user.id, resolveQuickInput(req))); }
  catch (err) { next(err); }
});

app.use('/api/quick', quickApi);

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

/* -------- projects -------- */

api.get('/projects', (req, res, next) => {
  try { res.json({ projects: store.listProjects(req.user.id) }); }
  catch (err) { next(err); }
});

api.post('/projects', (req, res, next) => {
  try {
    const body = req.body || {};
    const row = store.createProject(req.user.id, { name: body.name, color: body.color });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

api.patch('/projects/:id', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw httpErr(400, 'bad project id');
    const row = store.updateProject(req.user.id, id, req.body || {});
    res.json(row);
  } catch (err) { next(err); }
});

api.delete('/projects/:id', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw httpErr(400, 'bad project id');
    const ok = store.deleteProject(req.user.id, id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) { next(err); }
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
