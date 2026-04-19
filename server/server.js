/* server.js — Express app for the Time Tracker.
 *
 * Serves the static UI from ../public and exposes a tiny REST API
 * backed by SQLite (see db.js). Designed to run on a LAN (no auth).
 *
 * Configurable via env:
 *   PORT       (default 8787)
 *   HOST       (default 0.0.0.0)
 *   DATA_DIR   (default ./data, relative to this file)
 *   PUBLIC_DIR (default ../public, relative to this file)
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const { open } = require('./db');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'));
const DB_PATH = path.join(DATA_DIR, 'timetracker.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const store = open(DB_PATH);
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

// Light request log to make debugging easier.
app.use((req, _res, next) => {
  if (req.path.startsWith('/api')) {
    process.stdout.write(`[${new Date().toISOString()}] ${req.method} ${req.path}\n`);
  }
  next();
});

// ---------- API ----------
const api = express.Router();

api.get('/health', (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

api.get('/state', (_req, res, next) => {
  try { res.json(store.getState()); }
  catch (err) { next(err); }
});

api.put('/state', (req, res, next) => {
  try { res.json(store.replaceAll(req.body)); }
  catch (err) { next(err); }
});

api.put('/settings', (req, res, next) => {
  try { res.json(store.setSettings(req.body)); }
  catch (err) { next(err); }
});

api.put('/days/:date', (req, res, next) => {
  try {
    const result = store.setDay(req.params.date, req.body);
    if (result === null) return res.status(204).end();
    res.json(result);
  } catch (err) { next(err); }
});

api.delete('/days/:date', (req, res, next) => {
  try {
    store.deleteDay(req.params.date);
    res.status(204).end();
  } catch (err) { next(err); }
});

api.post('/reset', (_req, res, next) => {
  try { res.json(store.reset()); }
  catch (err) { next(err); }
});

app.use('/api', api);

// ---------- Static UI ----------
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

// SPA-ish fallback: any unmatched non-API GET serves index.html.
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next(err);
  });
});

// ---------- Error handler ----------
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  const status = err.status || 400;
  res.status(status).json({ error: err.message || 'Internal error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Time Tracker listening on http://${HOST}:${PORT}`);
  console.log(`  data:   ${DB_PATH}`);
  console.log(`  static: ${PUBLIC_DIR}`);
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}, closing.`);
  server.close(() => {
    try { store.db.close(); } catch (_) { /* noop */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
