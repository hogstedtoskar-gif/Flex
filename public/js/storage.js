/* storage.js - Talks to the backend REST API.
 *
 * The frontend keeps a local mirror of the state (App.state in app.js).
 * Mutations call the corresponding endpoint to persist on the server.
 * Multiple writes are coalesced into a small in-flight queue so a burst of
 * UI changes does not produce a thundering herd of HTTP requests.
 */

const Storage = (() => {
  const API_BASE = '/api';

  const DEFAULT_SETTINGS = {
    weekStartDay: 1,
    regularHoursPerDay: 8,
    weeklyOvertimeTargetHours: 6,
    overtimePeriodStart: Calc.toDateKey(new Date()),
    overtimePeriodWeeks: 4,
    defaultLunchMinutes: 30,
    minLunchMinutes: 30,
    lunchThresholdHours: 6,
    flexOpeningBalance: 0,
    flexOpeningDate: '',
    officeStart: '07:30',
    officeEnd: '17:30'
  };

  function emptyState() {
    return {
      version: 1,
      settings: { ...DEFAULT_SETTINGS },
      days: {}
    };
  }

  let onUnauthorizedHandler = null;
  function setUnauthorizedHandler(fn) { onUnauthorizedHandler = fn; }

  async function http(path, opts = {}) {
    const init = {
      method: opts.method || 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin'
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(API_BASE + path, init);
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const j = await res.json();
        if (j && j.error) detail = j.error;
      } catch (_) { /* ignore */ }
      const err = new Error('HTTP ' + res.status + ': ' + detail);
      err.status = res.status;
      if (res.status === 401 && !opts.skipUnauthorizedHandler) {
        if (onUnauthorizedHandler) onUnauthorizedHandler();
      }
      throw err;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  }

  /* -------- auth -------- */

  async function authConfig() {
    try {
      const data = await http('/auth/config', { skipUnauthorizedHandler: true });
      return data || { allowRegistration: false };
    } catch (_) {
      return { allowRegistration: false };
    }
  }

  async function whoami() {
    try {
      const data = await http('/auth/me', { skipUnauthorizedHandler: true });
      return (data && data.user) || null;
    } catch (err) {
      if (err.status === 401) return null;
      throw err;
    }
  }

  async function login(username, password) {
    const data = await http('/auth/login', {
      method: 'POST',
      body: { username, password },
      skipUnauthorizedHandler: true
    });
    return data && data.user;
  }

  async function logout() {
    pendingDays.clear();
    pendingSettings = null;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    try {
      await http('/auth/logout', { method: 'POST', skipUnauthorizedHandler: true });
    } catch (_) { /* best effort */ }
  }

  async function register(username, password) {
    const data = await http('/auth/register', {
      method: 'POST',
      body: { username, password },
      skipUnauthorizedHandler: true
    });
    return data && data.user;
  }

  async function changePassword(currentPassword, newPassword) {
    await http('/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
      skipUnauthorizedHandler: true
    });
  }

  async function load() {
    try {
      const state = await http('/state');
      const merged = emptyState();
      merged.settings = { ...merged.settings, ...((state && state.settings) || {}) };
      merged.days = (state && state.days) || {};
      return merged;
    } catch (err) {
      console.error('Failed to load state from server:', err);
      throw err;
    }
  }

  // -------- per-day persistence with debounced coalescing --------
  const pendingDays = new Map(); // dateKey -> { day | null (delete) }
  let flushTimer = null;
  let flushPromise = null;
  let pendingSettings = null;
  let onErrorHandler = null;

  function setErrorHandler(fn) { onErrorHandler = fn; }
  function reportError(err) {
    if (onErrorHandler) onErrorHandler(err);
    else console.error('Storage error:', err);
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPromise = flush().catch(reportError);
    }, 150);
  }

  async function flush() {
    // Snapshot and clear pending queues so newer writes can re-queue.
    const dayWrites = Array.from(pendingDays.entries());
    pendingDays.clear();
    const settingsWrite = pendingSettings;
    pendingSettings = null;

    for (const [dateKey, payload] of dayWrites) {
      if (payload === null) {
        await http('/days/' + encodeURIComponent(dateKey), { method: 'DELETE' });
      } else {
        await http('/days/' + encodeURIComponent(dateKey), { method: 'PUT', body: payload });
      }
    }
    if (settingsWrite) {
      await http('/settings', { method: 'PUT', body: settingsWrite });
    }
  }

  function saveDay(dateKey, day) {
    pendingDays.set(dateKey, day);
    scheduleFlush();
  }

  function deleteDay(dateKey) {
    pendingDays.set(dateKey, null);
    scheduleFlush();
  }

  function saveSettings(settings) {
    pendingSettings = settings;
    scheduleFlush();
  }

  async function flushNow() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (flushPromise) {
      try { await flushPromise; } catch (_) { /* reported already */ }
    }
    if (pendingDays.size || pendingSettings) {
      await flush();
    }
  }

  async function reset() {
    pendingDays.clear();
    pendingSettings = null;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await http('/reset', { method: 'POST' });
  }

  async function importJson(text) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON structure');
    if (!parsed.days || typeof parsed.days !== 'object') throw new Error('Missing "days" object');
    const state = emptyState();
    state.settings = { ...state.settings, ...(parsed.settings || {}) };
    state.days = parsed.days;
    pendingDays.clear();
    pendingSettings = null;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await http('/state', { method: 'PUT', body: state });
    return state;
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // -------- export helpers (purely client-side, unchanged behavior) --------
  function exportJson(state) {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    triggerDownload(blob, 'timetracker-backup-' + Calc.toDateKey(new Date()) + '.json');
  }

  function exportCsv(state) {
    const settings = state.settings;
    const keys = Object.keys(state.days).sort();
    const rows = [[
      'Date', 'Weekday', 'Worked (h)', 'In Office (h)', 'Outside (h)',
      'Regular (h)', 'Extra (h)',
      'Overtime (h)', 'Flex gain (h)', 'Outside unused (h)',
      'Shortfall (h)', 'Lunch (h)', 'Auto-lunch deduction (h)',
      'In Period', 'Segments', 'Note'
    ]];

    const byWeek = new Map();
    for (const key of keys) {
      const d = Calc.parseDateKey(key);
      const ws = Calc.weekStart(d, settings.weekStartDay);
      const wsKey = Calc.toDateKey(ws);
      if (!byWeek.has(wsKey)) byWeek.set(wsKey, ws);
    }

    const dayAlloc = new Map();
    for (const ws of byWeek.values()) {
      const w = Calc.computeWeek(ws, state.days, settings);
      for (const d of w.days) {
        dayAlloc.set(d.dateKey, {
          overtime: d.overtimeHours,
          flexGain: d.flexGainHours,
          outsideUnused: d.outsideUnusedHours || 0,
          inPeriod: w.inPeriod
        });
      }
    }

    const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const key of keys) {
      const day = state.days[key];
      const date = Calc.parseDateKey(key);
      const c = Calc.computeDay(day, settings);
      const alloc = dayAlloc.get(key) || { overtime: 0, flexGain: 0, outsideUnused: 0, inPeriod: false };
      const segStr = (day.entries || [])
        .map(e => `${e.type[0].toUpperCase()}:${e.start || '--:--'}-${e.end || '--:--'}`)
        .join(' | ');
      rows.push([
        key,
        weekdayNames[date.getDay()],
        c.workedHours.toFixed(2),
        c.inOfficeHours.toFixed(2),
        c.outsideHours.toFixed(2),
        c.regular.toFixed(2),
        c.extra.toFixed(2),
        alloc.overtime.toFixed(2),
        alloc.flexGain.toFixed(2),
        alloc.outsideUnused.toFixed(2),
        c.shortfall.toFixed(2),
        c.lunchHours.toFixed(2),
        (c.lunchDeduction || 0).toFixed(2),
        alloc.inPeriod ? 'yes' : 'no',
        segStr,
        (day.note || '').replace(/\r?\n/g, ' ')
      ]);
    }

    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, 'timetracker-' + Calc.toDateKey(new Date()) + '.csv');
  }

  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    DEFAULT_SETTINGS,
    emptyState,
    load,
    saveDay,
    deleteDay,
    saveSettings,
    flushNow,
    reset,
    uuid,
    exportJson,
    exportCsv,
    importJson,
    setErrorHandler,
    setUnauthorizedHandler,
    authConfig,
    whoami,
    login,
    logout,
    register,
    changePassword
  };
})();
