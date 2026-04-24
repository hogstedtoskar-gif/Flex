/* fsm.js — Pure clock-state transitions shared by the server
 *         (server/quick.js) and the client (public/js/app.js).
 *
 * All functions here are deterministic and operate on a plain
 * "entries" array — the same shape that's persisted per day in the
 * database and in App.state.days[dateKey].entries.
 *
 * Why share? Previously the widget API (server/quick.js) and the
 * browser dashboard each implemented their own state machine. Even
 * small divergences (different error messages, different edge-case
 * handling for zero-length or overlapping segments) caused subtle
 * bugs when the two paths disagreed. Now both call into these
 * helpers, so the state machine has a single source of truth.
 *
 * The module is loaded two ways:
 *   - Browser: as a plain <script> — exposes `window.FSM`.
 *   - Server:  via `require('../public/js/fsm.js')` — exposes
 *     the same functions on `module.exports`.
 *
 * Each transition function takes the current `entries` array, a new
 * clock-time "hm" string ("HH:MM"), and returns either
 *   { ok: true, entries: <new array> }
 * or
 *   { ok: false, error: '<human-readable message>' }
 * Nothing is mutated; callers replace the old array with the returned
 * one. A `makeId` function must be passed in because UUID generation
 * is platform-specific (Web Crypto vs node:crypto).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.FSM = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function parseHM(hm) {
    if (typeof hm !== 'string') return null;
    const m = /^([01]\d|2[0-3]):[0-5]\d$/.exec(hm);
    if (!m) return null;
    return parseInt(hm.slice(0, 2), 10) * 60 + parseInt(hm.slice(3, 5), 10);
  }

  /**
   * Describe the open segment on an entries array (if any).
   * Returns one of:
   *   { state: 'off' }
   *   { state: 'working', openId, since }
   *   { state: 'lunch',   openId, since }
   */
  function currentStatus(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const open = list.find((e) => e && e.start && !e.end);
    if (!open) return { state: 'off' };
    return {
      state: open.type === 'lunch' ? 'lunch' : 'working',
      openId: open.id,
      since: open.start
    };
  }

  /**
   * Find the earliest-dated open segment across a daysMap
   * ({ 'YYYY-MM-DD': { entries: [...] } }). Returns
   * `{ dateKey, entry }` or `null`.
   */
  function findOpenAcrossDays(daysMap) {
    if (!daysMap) return null;
    const keys = Object.keys(daysMap).sort();
    for (const key of keys) {
      const d = daysMap[key];
      const entries = (d && d.entries) || [];
      const open = entries.find((e) => e && e.start && !e.end);
      if (open) return { dateKey: key, entry: open };
    }
    return null;
  }

  function clockIn(entries, hm, makeId) {
    if (!parseHM(hm)) return { ok: false, error: 'Invalid time' };
    const st = currentStatus(entries);
    if (st.state !== 'off') {
      return {
        ok: false,
        error: 'Already ' + st.state + ' since ' + (st.since || '?')
      };
    }
    return {
      ok: true,
      entries: (entries || []).concat([{
        id: makeId(), type: 'work', start: hm, end: ''
      }])
    };
  }

  function clockOut(entries, hm) {
    if (!parseHM(hm)) return { ok: false, error: 'Invalid time' };
    const st = currentStatus(entries);
    if (st.state !== 'working') {
      return { ok: false, error: 'Not currently working' };
    }
    return {
      ok: true,
      entries: entries.map((e) => e.id === st.openId ? { ...e, end: hm } : e)
    };
  }

  function lunchStart(entries, hm, makeId) {
    if (!parseHM(hm)) return { ok: false, error: 'Invalid time' };
    const st = currentStatus(entries);
    if (st.state !== 'working') {
      return { ok: false, error: 'Must be clocked in first' };
    }
    return {
      ok: true,
      entries: entries
        .map((e) => e.id === st.openId ? { ...e, end: hm } : e)
        .concat([{ id: makeId(), type: 'lunch', start: hm, end: '' }])
    };
  }

  function lunchEnd(entries, hm, makeId) {
    if (!parseHM(hm)) return { ok: false, error: 'Invalid time' };
    const st = currentStatus(entries);
    if (st.state !== 'lunch') {
      return { ok: false, error: 'Not on lunch' };
    }
    return {
      ok: true,
      entries: entries
        .map((e) => e.id === st.openId ? { ...e, end: hm } : e)
        .concat([{ id: makeId(), type: 'work', start: hm, end: '' }])
    };
  }

  /** Convenience: from 'working' go to lunch, from 'lunch' go back to work. */
  function lunchToggle(entries, hm, makeId) {
    const st = currentStatus(entries);
    if (st.state === 'working') return lunchStart(entries, hm, makeId);
    if (st.state === 'lunch') return lunchEnd(entries, hm, makeId);
    return { ok: false, error: 'Not clocked in — can\'t toggle lunch' };
  }

  return {
    parseHM,
    currentStatus,
    findOpenAcrossDays,
    clockIn,
    clockOut,
    lunchStart,
    lunchEnd,
    lunchToggle
  };
});
