/* db.js — SQLite-backed store for the Time Tracker.
 *
 * Uses Node's built-in node:sqlite (stable in Node >=24, available with
 * --experimental-sqlite in 22.5..23). No native build step required.
 *
 * Schema is intentionally tiny: one row per day (entries stored as JSON),
 * plus a key/value table for the settings document. Per-day writes mean
 * the UI can persist exactly what changed without rewriting everything.
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

const DEFAULT_SETTINGS = {
  weekStartDay: 1,
  regularHoursPerDay: 8,
  weeklyOvertimeTargetHours: 6,
  overtimePeriodStart: todayKey(),
  overtimePeriodWeeks: 4,
  defaultLunchMinutes: 30,
  flexOpeningBalance: 0,
  flexOpeningDate: ''
};

function todayKey() {
  const d = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function isDateKey(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // WAL is friendlier under crash and lets readers run alongside writes.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS days (
      date TEXT PRIMARY KEY,
      note TEXT NOT NULL DEFAULT '',
      entries TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed default settings on first run.
  const settingsRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('settings');
  if (!settingsRow) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('settings', JSON.stringify(DEFAULT_SETTINGS));
  }

  const stmts = {
    getSettings: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setSettings: db.prepare(
      `INSERT INTO meta (key, value) VALUES ('settings', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ),
    allDays: db.prepare('SELECT date, note, entries FROM days ORDER BY date'),
    upsertDay: db.prepare(
      `INSERT INTO days (date, note, entries, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(date) DO UPDATE SET
         note = excluded.note,
         entries = excluded.entries,
         updated_at = excluded.updated_at`
    ),
    deleteDay: db.prepare('DELETE FROM days WHERE date = ?'),
    deleteAllDays: db.prepare('DELETE FROM days'),
    deleteAllMeta: db.prepare('DELETE FROM meta')
  };

  function getState() {
    const settingsRaw = stmts.getSettings.get('settings');
    let settings = { ...DEFAULT_SETTINGS };
    if (settingsRaw) {
      try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(settingsRaw.value) }; }
      catch (_) { /* fall back to defaults */ }
    }
    const days = {};
    for (const row of stmts.allDays.all()) {
      let entries = [];
      try { entries = JSON.parse(row.entries); } catch (_) { entries = []; }
      days[row.date] = { entries, note: row.note || '' };
    }
    return { version: 1, settings, days };
  }

  function setSettings(settings) {
    if (!settings || typeof settings !== 'object') throw new Error('settings must be an object');
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    stmts.setSettings.run(JSON.stringify(merged));
    return merged;
  }

  function setDay(dateKey, day) {
    if (!isDateKey(dateKey)) throw new Error('Invalid date key: ' + dateKey);
    if (!day || typeof day !== 'object') throw new Error('day must be an object');
    const entries = Array.isArray(day.entries) ? day.entries : [];
    const note = typeof day.note === 'string' ? day.note : '';
    if (!entries.length && !note) {
      stmts.deleteDay.run(dateKey);
      return null;
    }
    stmts.upsertDay.run(dateKey, note, JSON.stringify(entries));
    return { entries, note };
  }

  function deleteDay(dateKey) {
    if (!isDateKey(dateKey)) throw new Error('Invalid date key: ' + dateKey);
    const info = stmts.deleteDay.run(dateKey);
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

  function replaceAll(state) {
    if (!state || typeof state !== 'object') throw new Error('state must be an object');
    if (!state.days || typeof state.days !== 'object') throw new Error('state.days is required');
    return withTx(() => {
      stmts.deleteAllDays.run();
      if (state.settings) {
        stmts.setSettings.run(JSON.stringify({ ...DEFAULT_SETTINGS, ...state.settings }));
      }
      for (const [date, day] of Object.entries(state.days)) {
        if (!isDateKey(date)) continue;
        if (!day || typeof day !== 'object') continue;
        const entries = Array.isArray(day.entries) ? day.entries : [];
        const note = typeof day.note === 'string' ? day.note : '';
        if (!entries.length && !note) continue;
        stmts.upsertDay.run(date, note, JSON.stringify(entries));
      }
      return getState();
    });
  }

  function reset() {
    return withTx(() => {
      stmts.deleteAllDays.run();
      stmts.deleteAllMeta.run();
      stmts.setSettings.run(JSON.stringify(DEFAULT_SETTINGS));
      return getState();
    });
  }

  return {
    db,
    getState,
    setSettings,
    setDay,
    deleteDay,
    replaceAll,
    reset,
    DEFAULT_SETTINGS
  };
}

module.exports = { open, DEFAULT_SETTINGS };
