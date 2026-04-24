/* quick.js — Widget-friendly state transitions.
 *
 * HTTP wrapper around the shared state machine in public/js/fsm.js
 * so that a plain HTTP POST from an iOS Shortcut or Android widget
 * can drive clock-in/out/lunch. The same FSM module is used by the
 * browser dashboard (public/js/app.js) — do not duplicate its rules
 * here; go edit fsm.js instead.
 *
 * The "now" time used for the transition defaults to the server's
 * local clock, but can be overridden with:
 *   - query/body `tz`   — IANA timezone name (e.g. "Europe/Stockholm")
 *   - query/body `date` — YYYY-MM-DD (override the day the entry lands in)
 *   - query/body `time` — HH:MM (override the clock time of the action)
 * These let a widget pass the phone's timezone/clock explicitly when
 * the server runs in a different zone.
 */

const path = require('path');
const FSM = require(path.join(__dirname, '..', 'public', 'js', 'fsm.js'));

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function localNowInTz(tz) {
  const now = new Date();
  if (!tz) {
    return {
      dateKey: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()),
      hm: pad(now.getHours()) + ':' + pad(now.getMinutes())
    };
  }
  // Use Intl to format the current instant in the requested zone.
  let parts;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  } catch (_) {
    // Fall back to server-local if the TZ name is bogus.
    return localNowInTz(null);
  }
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${hh}:${parts.minute}`
  };
}

function resolveWhen(input) {
  const src = input || {};
  const tz = typeof src.tz === 'string' ? src.tz : '';
  const { dateKey, hm } = localNowInTz(tz);
  const overrideDate = typeof src.date === 'string' && DATE_RE.test(src.date) ? src.date : null;
  const overrideTime = typeof src.time === 'string' && TIME_RE.test(src.time) ? src.time : null;
  return {
    dateKey: overrideDate || dateKey,
    hm: overrideTime || hm
  };
}

// Alias the pure time helper from the shared FSM module so existing
// call sites read naturally.
const parseHM = FSM.parseHM;
const currentStatus = FSM.currentStatus;

function uuid() {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return require('crypto').randomUUID();
}

function sortClosedAsc(entries) {
  return entries
    .filter((e) => e.start && e.end)
    .slice()
    .sort((a, b) => (parseHM(a.start) || 0) - (parseHM(b.start) || 0));
}

function totalsForDay(entries) {
  let workedMin = 0;
  let lunchMin = 0;
  for (const e of entries) {
    if (!e.start || !e.end) continue;
    const s = parseHM(e.start);
    const f = parseHM(e.end);
    if (s == null || f == null) continue;
    let diff = f - s;
    if (diff < 0) diff += 24 * 60;
    if (e.type === 'lunch') lunchMin += diff;
    else workedMin += diff;
  }
  return {
    workedHours: Math.round((workedMin / 60) * 100) / 100,
    lunchHours: Math.round((lunchMin / 60) * 100) / 100
  };
}

function snapshot(dateKey, day) {
  const entries = (day && day.entries) || [];
  const status = currentStatus(entries);
  return {
    date: dateKey,
    state: status.state,
    since: status.since || null,
    today: totalsForDay(entries)
  };
}

function conflict(msg) {
  const err = new Error(msg);
  err.status = 409;
  return err;
}

// --- transitions ------------------------------------------------------
//
// The core state-machine rules live in public/js/fsm.js; this module
// owns the day-routing (which dateKey gets written) and the persistence
// glue. If you need to change clock-in/out/lunch semantics, edit fsm.js
// so the browser gets the same change for free.

function findOpenDay(state) {
  for (const [k, d] of Object.entries(state.days)) {
    if (FSM.currentStatus(d.entries).openId) return { key: k, day: d };
  }
  return null;
}

function clockIn(store, userId, input) {
  const { dateKey, hm } = resolveWhen(input);
  const state = store.getState(userId);
  // Block a new clock-in if any day already has an open segment.
  const existing = findOpenDay(state);
  if (existing) {
    const st = FSM.currentStatus(existing.day.entries);
    throw conflict(`Already ${st.state} since ${st.since || '?'}`
      + (existing.key !== dateKey ? ` on ${existing.key}` : ''));
  }
  const day = state.days[dateKey] || { entries: [], note: '' };
  const result = FSM.clockIn(day.entries, hm, uuid);
  if (!result.ok) throw conflict(result.error);
  day.entries = result.entries;
  store.setDay(userId, dateKey, day);
  return snapshot(dateKey, day);
}

function clockOut(store, userId, input) {
  const { dateKey, hm } = resolveWhen(input);
  const state = store.getState(userId);
  // Prefer the caller-supplied dateKey when it has the open segment,
  // otherwise close the open segment wherever it lives (handles "clocked
  // in yesterday, tapped the widget this morning").
  let day = state.days[dateKey];
  let key = dateKey;
  if (!day || !FSM.currentStatus(day.entries).openId) {
    const hit = findOpenDay(state);
    if (hit) { day = hit.day; key = hit.key; }
  }
  if (!day) throw conflict('Not clocked in');
  const result = FSM.clockOut(day.entries, hm);
  if (!result.ok) throw conflict(result.error);
  day.entries = result.entries;
  store.setDay(userId, key, day);
  return snapshot(key, day);
}

function lunchToggle(store, userId, input) {
  const { dateKey, hm } = resolveWhen(input);
  const state = store.getState(userId);
  let day = state.days[dateKey];
  let key = dateKey;
  if (!day || !FSM.currentStatus(day.entries).openId) {
    const hit = findOpenDay(state);
    if (hit) { day = hit.day; key = hit.key; }
  }
  if (!day) throw conflict('Not clocked in');
  const result = FSM.lunchToggle(day.entries, hm, uuid);
  if (!result.ok) throw conflict(result.error);
  day.entries = result.entries;
  store.setDay(userId, key, day);
  return snapshot(key, day);
}

function statusOf(store, userId, input) {
  const { dateKey } = resolveWhen(input);
  const state = store.getState(userId);
  let day = state.days[dateKey];
  let key = dateKey;
  if (!day || FSM.currentStatus(day.entries).state === 'off') {
    const hit = findOpenDay(state);
    if (hit) { day = hit.day; key = hit.key; }
  }
  return snapshot(key, day || { entries: [], note: '' });
}

module.exports = {
  clockIn,
  clockOut,
  lunchToggle,
  statusOf,
  // exposed for tests
  _internals: { currentStatus, parseHM, totalsForDay, resolveWhen, sortClosedAsc }
};
