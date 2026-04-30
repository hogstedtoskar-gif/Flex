/* db.js — SQLite-backed store for the Time Tracker.
 *
 * Uses Node's built-in node:sqlite (stable in Node >=24, available with
 * --experimental-sqlite in 22.5..23). No native build step required.
 *
 * Schema (multi-user):
 *   users          (id, username UNIQUE, password_hash, created_at)
 *   sessions       (token PRIMARY KEY, user_id, created_at, last_seen)
 *   user_settings  (user_id PRIMARY KEY, value JSON)
 *   days           (user_id, date, note, entries JSON, pto, updated_at)
 *                  PRIMARY KEY (user_id, date)
 *   api_tokens     (id, user_id, token_hash, label, created_at, last_used_at)
 *                  Long-lived bearer tokens for the phone-widget endpoints.
 *   projects       (id, user_id, name, color, archived, created_at)
 *                  Optional project tag per work segment. Segments reference
 *                  a project by id in the `entries` JSON on `days`.
 *
 * Old single-user databases (schema with plain `days.date` PK and a
 * global `meta.settings` row) are migrated on first open: a bootstrap
 * user is created and the existing data is re-parented to it.
 */

const fs = require('fs');
const path = require('path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error(
    'node:sqlite is unavailable. Run with Node >=24, or with Node 22.5+ ' +
    'using --experimental-sqlite. Original error: ' + err.message
  );
  throw err;
}

/**
 * Default user settings.
 *
 * ⚠️  KEEP IN SYNC with `public/js/storage.js` (const `DEFAULT_SETTINGS`).
 * The client seeds its local mirror from this shape before the first
 * /api/state response returns, so a key drifting here causes the UI
 * to briefly render with the wrong defaults on first load.
 *
 * `server/smoke-test.js` contains a static parity check that fails
 * CI if the two objects diverge.
 */
const DEFAULT_SETTINGS = {
  weekStartDay: 1,
  regularHoursPerDay: 8,
  weeklyOvertimeTargetMinutes: 360,
  weeklyOvertimeTargetsByWeekMinutes: [],
  overtimePeriodStart: todayKey(),
  overtimePeriodWeeks: 4,
  defaultLunchMinutes: 30,
  // Auto-deduct lunch: when worked hours exceed lunchThresholdHours
  // and the recorded lunch is less than minLunchMinutes, the missing
  // lunch time is deducted from worked hours. Set minLunchMinutes to
  // 0 to disable.
  minLunchMinutes: 30,
  lunchThresholdHours: 6,
  flexOpeningBalance: 0,
  flexOpeningDate: '',
  // Office hours window: work outside this range cannot become regular
  // hours or flex — only overtime. Leave start/end blank to disable.
  officeStart: '07:30',
  officeEnd: '17:30',
  // Which weekdays count as working days (indexed by Date.getDay():
  // 0=Sun, 1=Mon, ..., 6=Sat). Non-working days never earn regular
  // hours and never contribute shortfall; worked time on them can
  // only fill the weekly overtime target.
  workDays: [false, true, true, true, true, true, false],
  // Optional default project applied to new work segments when none
  // is picked in the UI / widget (empty string = untagged).
  defaultProjectId: ''
};

function todayKey() {
  const d = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** Max minutes in a week (7×24×60) — cap for overtime targets. */
const MAX_OVERTIME_MINUTES_PER_WEEK = 10080;

/**
 * Migrate legacy hour-based overtime fields to minute-based storage and
 * strip deprecated keys. Call on every settings read/write/import.
 */
function normalizeUserSettings(incoming) {
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  const merged = { ...DEFAULT_SETTINGS, ...inc };

  let minutes;
  if (Object.prototype.hasOwnProperty.call(inc, 'weeklyOvertimeTargetMinutes')) {
    minutes = parseInt(inc.weeklyOvertimeTargetMinutes, 10);
    if (!Number.isFinite(minutes) || minutes < 0) minutes = DEFAULT_SETTINGS.weeklyOvertimeTargetMinutes;
  } else if (Object.prototype.hasOwnProperty.call(inc, 'weeklyOvertimeTargetHours')) {
    const h = parseFloat(inc.weeklyOvertimeTargetHours);
    minutes = Number.isFinite(h) ? Math.round(h * 60) : DEFAULT_SETTINGS.weeklyOvertimeTargetMinutes;
  } else {
    minutes = parseInt(merged.weeklyOvertimeTargetMinutes, 10);
    if (!Number.isFinite(minutes) || minutes < 0) minutes = DEFAULT_SETTINGS.weeklyOvertimeTargetMinutes;
  }
  merged.weeklyOvertimeTargetMinutes = Math.min(
    MAX_OVERTIME_MINUTES_PER_WEEK,
    Math.max(0, minutes)
  );

  let listMin;
  if (Object.prototype.hasOwnProperty.call(inc, 'weeklyOvertimeTargetsByWeekMinutes')) {
    listMin = inc.weeklyOvertimeTargetsByWeekMinutes;
  } else if (Object.prototype.hasOwnProperty.call(inc, 'weeklyOvertimeTargetsByWeek')) {
    const listH = inc.weeklyOvertimeTargetsByWeek;
    if (Array.isArray(listH) && listH.length) {
      listMin = listH.map((x) => {
        if (x == null || x === '') return null;
        const n = Number(x);
        return Number.isFinite(n) ? Math.round(n * 60) : null;
      });
    } else {
      listMin = [];
    }
  } else {
    listMin = merged.weeklyOvertimeTargetsByWeekMinutes;
  }
  const cleaned = Array.isArray(listMin)
    ? listMin.map((x) => {
      if (x == null || x === '') return null;
      const n = parseInt(x, 10);
      if (!Number.isFinite(n)) return null;
      return Math.min(MAX_OVERTIME_MINUTES_PER_WEEK, Math.max(0, n));
    })
    : [];
  while (cleaned.length && cleaned[cleaned.length - 1] == null) cleaned.pop();
  merged.weeklyOvertimeTargetsByWeekMinutes = cleaned;

  delete merged.weeklyOvertimeTargetHours;
  delete merged.weeklyOvertimeTargetsByWeek;
  return merged;
}

function isDateKey(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function columnSet(db, table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(cols.map((c) => c.name));
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return !!row;
}

/** Add `pto` flag to `days` for paid-time-off (older DBs predate this column). */
function ensureDaysPtoColumn(db) {
  if (!tableExists(db, 'days')) return;
  const cols = columnSet(db, 'days');
  if (cols.has('pto')) return;
  db.exec('ALTER TABLE days ADD COLUMN pto INTEGER NOT NULL DEFAULT 0');
}

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  ensureSchema(db);
  migrateLegacyIfNeeded(db);
  ensureDaysPtoColumn(db);

  const stmts = prepareStatements(db);

  /* ---------------- users ---------------- */

  function createUser(username, passwordHash) {
    if (typeof username !== 'string' || !username.trim()) {
      throw badRequest('username is required');
    }
    const name = username.trim();
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name)) {
      throw badRequest('username must be 1-32 chars of [A-Za-z0-9_.-]');
    }
    try {
      const info = stmts.insertUser.run(name, passwordHash);
      const id = Number(info.lastInsertRowid);
      stmts.insertUserSettings.run(id, JSON.stringify(DEFAULT_SETTINGS));
      return { id, username: name };
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        throw conflict('username already exists');
      }
      throw err;
    }
  }

  function getUserByUsername(username) {
    if (!username) return null;
    const row = stmts.userByName.get(String(username).trim());
    return row || null;
  }

  function getUserById(id) {
    const row = stmts.userById.get(id);
    return row || null;
  }

  function listUsers() {
    return stmts.allUsers.all();
  }

  function setPassword(userId, passwordHash) {
    const info = stmts.updatePassword.run(passwordHash, userId);
    return info.changes > 0;
  }

  function deleteUser(userId) {
    const info = stmts.deleteUser.run(userId);
    return info.changes > 0;
  }

  function renameUser(userId, newName) {
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(newName || '')) {
      throw badRequest('username must be 1-32 chars of [A-Za-z0-9_.-]');
    }
    try {
      const info = stmts.renameUser.run(newName, userId);
      return info.changes > 0;
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        throw conflict('username already exists');
      }
      throw err;
    }
  }

  /* ---------------- sessions ---------------- */

  function createSession(userId, token) {
    stmts.insertSession.run(token, userId);
    return token;
  }

  function getSession(token) {
    if (!token) return null;
    const row = stmts.sessionByToken.get(token);
    if (!row) return null;
    // Touch last_seen so active sessions slide forward.
    stmts.touchSession.run(token);
    return row;
  }

  function deleteSession(token) {
    stmts.deleteSession.run(token);
  }

  function deleteUserSessions(userId) {
    stmts.deleteSessionsForUser.run(userId);
  }

  function purgeOldSessions(maxAgeDays) {
    stmts.purgeSessions.run(maxAgeDays);
  }

  /* ---------------- per-user state ---------------- */

  function getState(userId) {
    const settings = getSettings(userId);
    const days = {};
    for (const row of stmts.allDaysForUser.all(userId)) {
      let entries = [];
      try { entries = JSON.parse(row.entries); } catch (_) { entries = []; }
      const dayObj = { entries, note: row.note || '' };
      if (row.pto) dayObj.pto = true;
      days[row.date] = dayObj;
    }
    const projects = listProjects(userId);
    return { version: 1, settings, days, projects };
  }

  function getSettings(userId) {
    const row = stmts.getUserSettings.get(userId);
    let settings = { ...DEFAULT_SETTINGS };
    if (row) {
      try { settings = normalizeUserSettings(JSON.parse(row.value)); }
      catch (_) { /* fall back */ }
    }
    return settings;
  }

  function setSettings(userId, settings) {
    if (!settings || typeof settings !== 'object') {
      throw badRequest('settings must be an object');
    }
    const merged = normalizeUserSettings({ ...settings });
    stmts.upsertUserSettings.run(userId, JSON.stringify(merged));
    return merged;
  }

  function setDay(userId, dateKey, day) {
    if (!isDateKey(dateKey)) throw badRequest('Invalid date key: ' + dateKey);
    if (!day || typeof day !== 'object') throw badRequest('day must be an object');
    const rawEntries = Array.isArray(day.entries) ? day.entries : [];
    const entries = sanitizeEntries(userId, rawEntries);
    const note = typeof day.note === 'string' ? day.note : '';
    const pto = !!(day.pto);
    if (!entries.length && !note && !pto) {
      stmts.deleteDay.run(userId, dateKey);
      return null;
    }
    stmts.upsertDay.run(userId, dateKey, note, JSON.stringify(entries), pto ? 1 : 0);
    const out = { entries, note };
    if (pto) out.pto = true;
    return out;
  }

  // Strip unknown fields, coerce types, and validate projectId / tags.
  //
  // Unknown projectIds silently become null (not 400) because the UI
  // could theoretically send the id of a project the user deleted from
  // another tab — treating that as "untagged" matches the "stable by
  // default" ethos and avoids breaking an in-flight write.
  function sanitizeEntries(userId, entries) {
    const validProjectIds = new Set(
      stmts.listProjectsForUser.all(userId).map((r) => r.id)
    );
    return entries.map((e) => {
      if (!e || typeof e !== 'object') return null;
      const out = {
        id: typeof e.id === 'string' && e.id ? e.id : String(Date.now()) + Math.random().toString(36).slice(2),
        type: e.type === 'lunch' ? 'lunch' : 'work',
        start: typeof e.start === 'string' ? e.start : '',
        end: typeof e.end === 'string' ? e.end : ''
      };
      if (e.projectId != null && e.projectId !== '') {
        const pid = Number(e.projectId);
        if (Number.isFinite(pid) && validProjectIds.has(pid)) {
          out.projectId = pid;
        }
      }
      if (Array.isArray(e.tags)) {
        const tags = [];
        const seen = new Set();
        for (const t of e.tags) {
          if (typeof t !== 'string') continue;
          const trimmed = t.trim().slice(0, 32);
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          tags.push(trimmed);
          if (tags.length >= 10) break;
        }
        if (tags.length) out.tags = tags;
      }
      return out;
    }).filter(Boolean);
  }

  function deleteDay(userId, dateKey) {
    if (!isDateKey(dateKey)) throw badRequest('Invalid date key: ' + dateKey);
    const info = stmts.deleteDay.run(userId, dateKey);
    return info.changes > 0;
  }

  function withTx(fn) {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw err;
    }
  }

  function replaceAll(userId, state) {
    if (!state || typeof state !== 'object') throw badRequest('state must be an object');
    if (!state.days || typeof state.days !== 'object') throw badRequest('state.days is required');
    return withTx(() => {
      // Replace projects first, so the sanitizer running inside
      // the day loop sees the new id-space.
      stmts.deleteAllProjectsForUser.run(userId);
      const idMap = new Map(); // old id (any) -> new id
      if (Array.isArray(state.projects)) {
        for (const p of state.projects) {
          if (!p || typeof p !== 'object') continue;
          const name = typeof p.name === 'string' ? p.name.trim().slice(0, 64) : '';
          if (!name) continue;
          const color = coerceColor(p.color);
          const archived = p.archived ? 1 : 0;
          const info = stmts.insertProject.run(userId, name, color, archived);
          const newId = Number(info.lastInsertRowid);
          if (p.id != null) idMap.set(p.id, newId);
          if (p.id != null) idMap.set(String(p.id), newId);
          if (p.id != null) idMap.set(Number(p.id), newId);
        }
      }
      stmts.deleteAllDaysForUser.run(userId);
      if (state.settings) {
        stmts.upsertUserSettings.run(
          userId,
          JSON.stringify(normalizeUserSettings(state.settings))
        );
      }
      for (const [date, day] of Object.entries(state.days)) {
        if (!isDateKey(date)) continue;
        if (!day || typeof day !== 'object') continue;
        const rawEntries = Array.isArray(day.entries) ? day.entries : [];
        // Re-map any projectId that referred to the import's own id space.
        const remapped = rawEntries.map((e) => {
          if (e && e.projectId != null && idMap.has(e.projectId)) {
            return { ...e, projectId: idMap.get(e.projectId) };
          }
          return e;
        });
        const entries = sanitizeEntries(userId, remapped);
        const note = typeof day.note === 'string' ? day.note : '';
        const pto = !!(day.pto);
        if (!entries.length && !note && !pto) continue;
        stmts.upsertDay.run(userId, date, note, JSON.stringify(entries), pto ? 1 : 0);
      }
      return getState(userId);
    });
  }

  function resetUser(userId) {
    return withTx(() => {
      stmts.deleteAllDaysForUser.run(userId);
      stmts.deleteAllProjectsForUser.run(userId);
      stmts.upsertUserSettings.run(userId, JSON.stringify(DEFAULT_SETTINGS));
      return getState(userId);
    });
  }

  /* ---------------- projects ---------------- */

  function listProjects(userId) {
    return stmts.listProjectsForUser.all(userId).map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      archived: !!r.archived
    }));
  }

  function createProject(userId, { name, color }) {
    const clean = typeof name === 'string' ? name.trim().slice(0, 64) : '';
    if (!clean) throw badRequest('project name is required');
    const c = coerceColor(color);
    try {
      const info = stmts.insertProject.run(userId, clean, c, 0);
      return { id: Number(info.lastInsertRowid), name: clean, color: c, archived: false };
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw conflict('project name already exists');
      throw err;
    }
  }

  function updateProject(userId, projectId, patch) {
    const existing = stmts.projectByIdForUser.get(projectId, userId);
    if (!existing) throw notFound('project not found');
    const name = patch && typeof patch.name === 'string'
      ? patch.name.trim().slice(0, 64)
      : existing.name;
    if (!name) throw badRequest('project name is required');
    const color = patch && 'color' in patch
      ? coerceColor(patch.color)
      : existing.color;
    const archived = patch && 'archived' in patch
      ? (patch.archived ? 1 : 0)
      : existing.archived;
    try {
      stmts.updateProject.run(name, color, archived, projectId, userId);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw conflict('project name already exists');
      throw err;
    }
    return { id: projectId, name, color, archived: !!archived };
  }

  function deleteProject(userId, projectId) {
    // Refuse when the project is still referenced by at least one
    // entry — the admin should archive it instead (deleting would
    // silently unlabel history).
    const referenced = isProjectReferenced(userId, projectId);
    if (referenced) throw conflict('project has entries — archive it instead');
    const info = stmts.deleteProject.run(projectId, userId);
    return info.changes > 0;
  }

  function isProjectReferenced(userId, projectId) {
    const needle = `"projectId":${projectId}`;
    const row = stmts.anyDayWithProjectRef.get(userId, `%${needle}%`);
    return !!row;
  }

  function coerceColor(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
  }

  /* ---------------- api tokens ---------------- */

  function createApiToken(userId, tokenHash, label) {
    const safeLabel = (label && String(label).slice(0, 64)) || 'widget';
    const info = stmts.insertApiToken.run(userId, tokenHash, safeLabel);
    return {
      id: Number(info.lastInsertRowid),
      label: safeLabel
    };
  }

  function listApiTokens(userId) {
    return stmts.listApiTokensForUser.all(userId).map((r) => ({
      id: r.id,
      label: r.label,
      created_at: r.created_at,
      last_used_at: r.last_used_at
    }));
  }

  function deleteApiToken(userId, id) {
    const info = stmts.deleteApiToken.run(id, userId);
    return info.changes > 0;
  }

  function deleteApiTokensForUser(userId) {
    stmts.deleteApiTokensForUser.run(userId);
  }

  // Called by auth middleware to resolve a bearer token to a user row.
  // We look up by hash (hashes are deterministic because tokens are
  // high-entropy, so we don't need a per-row salt). See auth.js for
  // the HMAC-SHA-256 based scheme.
  function getUserByApiTokenHash(tokenHash) {
    const row = stmts.apiTokenByHash.get(tokenHash);
    if (!row) return null;
    // Touch last_used_at so the user can see which tokens are active.
    stmts.touchApiToken.run(row.token_id);
    return { id: row.user_id, username: row.username, token_id: row.token_id };
  }

  return {
    db,
    DEFAULT_SETTINGS,
    // users
    createUser,
    getUserByUsername,
    getUserById,
    listUsers,
    setPassword,
    deleteUser,
    renameUser,
    // sessions
    createSession,
    getSession,
    deleteSession,
    deleteUserSessions,
    purgeOldSessions,
    // state
    getState,
    getSettings,
    setSettings,
    setDay,
    deleteDay,
    replaceAll,
    resetUser,
    // projects
    listProjects,
    createProject,
    updateProject,
    deleteProject,
    // api tokens
    createApiToken,
    listApiTokens,
    deleteApiToken,
    deleteApiTokensForUser,
    getUserByApiTokenHash
  };
}

/* ---------------- schema + migration ---------------- */

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY,
      value   TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      label        TEXT NOT NULL DEFAULT 'widget',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
    CREATE TABLE IF NOT EXISTS projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      name       TEXT    NOT NULL,
      color      TEXT,
      archived   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
  `);

  // The `days` table may exist in legacy form (PK on date only, no user_id).
  // We create the new shape only if the table is missing entirely. The
  // migration step below handles the upgrade path.
  if (!tableExists(db, 'days')) {
    db.exec(`
      CREATE TABLE days (
        user_id    INTEGER NOT NULL,
        date       TEXT    NOT NULL,
        note       TEXT    NOT NULL DEFAULT '',
        entries    TEXT    NOT NULL DEFAULT '[]',
        updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, date),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
  }
}

function migrateLegacyIfNeeded(db) {
  if (!tableExists(db, 'days')) return;
  const cols = columnSet(db, 'days');
  const needsDaysMigration = !cols.has('user_id');
  const hasLegacyMeta = tableExists(db, 'meta');

  if (!needsDaysMigration && !hasLegacyMeta) return;

  // Gather legacy rows first (before we start rewriting tables).
  let legacyDays = [];
  if (needsDaysMigration) {
    legacyDays = db.prepare('SELECT date, note, entries FROM days').all();
  }
  let legacySettings = null;
  if (hasLegacyMeta) {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'settings'").get();
    if (row) legacySettings = row.value;
  }

  // If nothing to carry over, just reshape quickly.
  const hasAnyLegacyData = legacyDays.length > 0 || legacySettings;

  db.exec('BEGIN');
  try {
    if (needsDaysMigration) {
      db.exec(`
        CREATE TABLE days_new (
          user_id    INTEGER NOT NULL,
          date       TEXT    NOT NULL,
          note       TEXT    NOT NULL DEFAULT '',
          entries    TEXT    NOT NULL DEFAULT '[]',
          updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, date),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `);
      db.exec('DROP TABLE days;');
      db.exec('ALTER TABLE days_new RENAME TO days;');
    }

    if (hasAnyLegacyData) {
      // Re-parent orphaned legacy data to a placeholder user row. The
      // real password will be set by the bootstrap step (or admin CLI);
      // the marker '!' makes that hash un-loginable until replaced.
      const placeholderName = '_legacy';
      let placeholder = db
        .prepare('SELECT id FROM users WHERE username = ?')
        .get(placeholderName);
      if (!placeholder) {
        const info = db
          .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
          .run(placeholderName, '!');
        placeholder = { id: Number(info.lastInsertRowid) };
      }
      const uid = placeholder.id;

      if (legacySettings) {
        db.prepare(
          `INSERT INTO user_settings (user_id, value) VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET value = excluded.value`
        ).run(uid, legacySettings);
      }
      const insert = db.prepare(
        `INSERT INTO days (user_id, date, note, entries)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, date) DO UPDATE SET
           note = excluded.note,
           entries = excluded.entries,
           updated_at = datetime('now')`
      );
      for (const r of legacyDays) {
        insert.run(uid, r.date, r.note || '', r.entries || '[]');
      }
    }

    if (hasLegacyMeta) db.exec('DROP TABLE meta;');
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }

  if (hasAnyLegacyData) {
    console.log(
      '[migrate] legacy single-user data was re-parented to user "_legacy". ' +
      'Use `node server/admin.js rename-user _legacy <name>` and ' +
      '`set-password <name>` to claim it, or set BOOTSTRAP_USER/BOOTSTRAP_PASSWORD.'
    );
  }
}

function prepareStatements(db) {
  return {
    // users
    insertUser: db.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)'
    ),
    userByName: db.prepare(
      'SELECT id, username, password_hash, created_at FROM users WHERE username = ?'
    ),
    userById: db.prepare(
      'SELECT id, username, created_at FROM users WHERE id = ?'
    ),
    allUsers: db.prepare(
      'SELECT id, username, created_at FROM users ORDER BY username'
    ),
    updatePassword: db.prepare(
      'UPDATE users SET password_hash = ? WHERE id = ?'
    ),
    renameUser: db.prepare(
      'UPDATE users SET username = ? WHERE id = ?'
    ),
    deleteUser: db.prepare(
      'DELETE FROM users WHERE id = ?'
    ),

    // sessions
    insertSession: db.prepare(
      'INSERT INTO sessions (token, user_id) VALUES (?, ?)'
    ),
    sessionByToken: db.prepare(`
      SELECT s.token, s.user_id, s.created_at, s.last_seen,
             u.username
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `),
    touchSession: db.prepare(
      "UPDATE sessions SET last_seen = datetime('now') WHERE token = ?"
    ),
    deleteSession: db.prepare(
      'DELETE FROM sessions WHERE token = ?'
    ),
    deleteSessionsForUser: db.prepare(
      'DELETE FROM sessions WHERE user_id = ?'
    ),
    purgeSessions: db.prepare(
      "DELETE FROM sessions WHERE last_seen < datetime('now', ? || ' days')"
    ),

    // settings
    getUserSettings: db.prepare(
      'SELECT value FROM user_settings WHERE user_id = ?'
    ),
    insertUserSettings: db.prepare(
      'INSERT INTO user_settings (user_id, value) VALUES (?, ?)'
    ),
    upsertUserSettings: db.prepare(
      `INSERT INTO user_settings (user_id, value) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET value = excluded.value`
    ),

    // days
    allDaysForUser: db.prepare(
      'SELECT date, note, entries, pto FROM days WHERE user_id = ? ORDER BY date'
    ),
    upsertDay: db.prepare(
      `INSERT INTO days (user_id, date, note, entries, pto, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, date) DO UPDATE SET
         note = excluded.note,
         entries = excluded.entries,
         pto = excluded.pto,
         updated_at = excluded.updated_at`
    ),
    deleteDay: db.prepare(
      'DELETE FROM days WHERE user_id = ? AND date = ?'
    ),
    deleteAllDaysForUser: db.prepare(
      'DELETE FROM days WHERE user_id = ?'
    ),

    // api tokens
    insertApiToken: db.prepare(
      'INSERT INTO api_tokens (user_id, token_hash, label) VALUES (?, ?, ?)'
    ),
    listApiTokensForUser: db.prepare(
      'SELECT id, label, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC'
    ),
    deleteApiToken: db.prepare(
      'DELETE FROM api_tokens WHERE id = ? AND user_id = ?'
    ),
    deleteApiTokensForUser: db.prepare(
      'DELETE FROM api_tokens WHERE user_id = ?'
    ),
    apiTokenByHash: db.prepare(`
      SELECT t.id AS token_id, t.user_id, u.username
      FROM api_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?
    `),
    touchApiToken: db.prepare(
      "UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?"
    ),

    // projects
    listProjectsForUser: db.prepare(
      'SELECT id, name, color, archived FROM projects WHERE user_id = ? ORDER BY archived, name'
    ),
    projectByIdForUser: db.prepare(
      'SELECT id, name, color, archived FROM projects WHERE id = ? AND user_id = ?'
    ),
    insertProject: db.prepare(
      'INSERT INTO projects (user_id, name, color, archived) VALUES (?, ?, ?, ?)'
    ),
    updateProject: db.prepare(
      'UPDATE projects SET name = ?, color = ?, archived = ? WHERE id = ? AND user_id = ?'
    ),
    deleteProject: db.prepare(
      'DELETE FROM projects WHERE id = ? AND user_id = ?'
    ),
    deleteAllProjectsForUser: db.prepare(
      'DELETE FROM projects WHERE user_id = ?'
    ),
    // Fast-ish "is this project referenced?" check. We store the
    // entries as a JSON blob, so a LIKE on `"projectId":<id>` is the
    // simplest way without adding a second table. Good enough for a
    // multi-user-but-per-user-small dataset.
    anyDayWithProjectRef: db.prepare(
      'SELECT 1 FROM days WHERE user_id = ? AND entries LIKE ? LIMIT 1'
    )
  };
}

/* ---------------- error helpers ---------------- */

function badRequest(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

function conflict(msg) {
  const err = new Error(msg);
  err.status = 409;
  return err;
}

function notFound(msg) {
  const err = new Error(msg);
  err.status = 404;
  return err;
}

module.exports = { open, DEFAULT_SETTINGS, normalizeUserSettings };
