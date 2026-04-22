/* auth.js — Password hashing, session cookies, and Express middleware.
 *
 * Design:
 *   - Passwords are hashed with scrypt (built into node:crypto). Hashes
 *     are stored as "scrypt$N$r$p$salt_b64$hash_b64" so parameters can
 *     evolve without a forced rehash.
 *   - Sessions are opaque 32-byte random tokens. The server keeps them
 *     in SQLite; the client sees only the cookie `tt_session=<token>`.
 *     Cookie is HttpOnly + SameSite=Lax. Same-origin + Lax gives us
 *     enough CSRF protection for this LAN app.
 *   - `requireAuth` middleware looks up the session and attaches
 *     `req.user = { id, username }`. Public routes opt out by not using it.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'tt_session';
const SESSION_MAX_AGE_DAYS = 30;
const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60;

// scrypt parameters: N=16384 (2^14), r=8, p=1 is OWASP's baseline.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALTLEN = 16;

function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 6) {
    const err = new Error('password must be at least 6 characters');
    err.status = 400;
    throw err;
  }
  const salt = crypto.randomBytes(SCRYPT_SALTLEN);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64')
  ].join('$');
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  // Placeholder '!' means the user has no usable password yet.
  if (stored === '!') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, { N, r, p });
  } catch (_) {
    return false;
  }
  return actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected);
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/* ---------------- cookies ---------------- */

function parseCookies(header) {
  const out = Object.create(null);
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    let v = part.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  }
  return out;
}

function setSessionCookie(res, token, req) {
  const secure = isRequestSecure(req);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, req) {
  const secure = isRequestSecure(req);
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function isRequestSecure(req) {
  if (!req) return false;
  if (req.secure) return true;
  const xf = req.headers && req.headers['x-forwarded-proto'];
  if (typeof xf === 'string' && xf.split(',')[0].trim() === 'https') return true;
  return false;
}

/* ---------------- middleware ---------------- */

function cookieMiddleware() {
  return (req, _res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    next();
  };
}

function loadSession(store) {
  return (req, _res, next) => {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (token) {
      const session = store.getSession(token);
      if (session) {
        req.user = { id: session.user_id, username: session.username };
        req.sessionToken = token;
      }
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  SESSION_MAX_AGE_DAYS,
  hashPassword,
  verifyPassword,
  newSessionToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  cookieMiddleware,
  loadSession,
  requireAuth
};
