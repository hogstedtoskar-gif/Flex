/* quick.js — Widget-friendly state transitions.
 *
 * Implements the same clock-in / clock-out / lunch state machine that
 * lives in public/js/app.js, but server-side so a plain HTTP POST from
 * an iOS Shortcut or Android widget can drive it.
 *
 * The "now" time used for the transition defaults to the server's local
 * clock, but can be overridden with:
 *   - query/body `tz`   — IANA timezone name (e.g. "Europe/Stockholm")
 *   - query/body `date` — YYYY-MM-DD (override the day the entry lands in)
 *   - query/body `time` — HH:MM (override the clock time of the action)
 * These let a widget pass the phone's timezone/clock explicitly when
 * the server runs in a different zone.
 */

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

function parseHM(hm) {
  const m = TIME_RE.exec(hm || '');
  if (!m) return null;
  return parseInt(hm.slice(0, 2), 10) * 60 + parseInt(hm.slice(3, 5), 10);
}

function currentStatus(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const open = list.find((e) => e && e.start && !e.end);
  if (open) {
    return {
      state: open.type === 'lunch' ? 'lunch' : 'working',
      since: open.start,
      openId: open.id
    };
  }
  return { state: 'off' };
}

function uuid() {
  // Node 20+ has crypto.randomUUID on the global object.
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

function clockIn(store, userId, input) {
  const { dateKey, hm } = resolveWhen(input);
  const state = store.getState(userId);
  const day = state.days[dateKey] || { entries: [], note: '' };
  const status = currentStatus(day.entries);
  if (status.state !== 'off') {
    throw conflict(`Already ${status.state} since ${status.since || '?'}`);
  }
  day.entries = day.entries.concat([{ id: uuid(), type: 'work', start: hm, end: '' }]);
  store.setDay(userId, dateKey, day);
  return snapshot(dateKey, day);
}

function clockOut(store, userId, input) {
  const { dateKey, hm } = resolveWhen(input);
  const state = store.getState(userId);
  // Clocking out should close the most recent open entry on either
  // today or the day it started on — but for simplicity we only touch
  // today's day. If there's no open entry on `dateKey`, fall back to
  // the day that has one (handles the "clocked in yesterday, widget
  // tapped the next morning" case).
  let day = state.days[dateKey];
  let key = dateKey;
  if (!day || !currentStatus(day.entries).openId) {
    for (const [k, d] of Object.entries(state.days)) {
      if (currentStatus(d.entries).openId) { day = d; key = k; break; }
    }
  }
  if (!day) throw conflict('Not clocked in');
  const status = currentStatus(day.entries);
  if (status.state !== 'working') {
    throw conflict(`Cannot clock out while ${status.state}`);
  }
  day.entries = day.entries.map((e) => e.id === status.openId ? { ...e, end: hm } : e);
  store.setDay(userId, key, day);
  return snapshot(key, day);
}

function lunchToggle(store, userId, input) {
  const { dateKey, hm } = resolveWhen(input);
  const state = store.getState(userId);
  let day = state.days[dateKey];
  let key = dateKey;
  if (!day || !day.entries || !day.entries.length) {
    for (const [k, d] of Object.entries(state.days)) {
      if (currentStatus(d.entries).openId) { day = d; key = k; break; }
    }
  }
  if (!day) throw conflict('Not clocked in');
  const status = currentStatus(day.entries);
  if (status.state === 'working') {
    // start lunch
    day.entries = day.entries.map((e) => e.id === status.openId ? { ...e, end: hm } : e)
      .concat([{ id: uuid(), type: 'lunch', start: hm, end: '' }]);
    store.setDay(userId, key, day);
    return snapshot(key, day);
  }
  if (status.state === 'lunch') {
    // end lunch + resume work
    day.entries = day.entries.map((e) => e.id === status.openId ? { ...e, end: hm } : e)
      .concat([{ id: uuid(), type: 'work', start: hm, end: '' }]);
    store.setDay(userId, key, day);
    return snapshot(key, day);
  }
  throw conflict('Not clocked in — can\'t toggle lunch');
}

function statusOf(store, userId, input) {
  const { dateKey } = resolveWhen(input);
  const state = store.getState(userId);
  let day = state.days[dateKey];
  let key = dateKey;
  if (!day || currentStatus(day.entries).state === 'off') {
    for (const [k, d] of Object.entries(state.days)) {
      if (currentStatus(d.entries).openId) { day = d; key = k; break; }
    }
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
