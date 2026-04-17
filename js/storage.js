/* storage.js - localStorage persistence, import/export. */

const Storage = (() => {
  const KEY = 'timetracker.v1';

  const DEFAULT_SETTINGS = {
    weekStartDay: 1,
    regularHoursPerDay: 8,
    weeklyOvertimeTargetHours: 6,
    overtimePeriodStart: Calc.toDateKey(new Date()),
    overtimePeriodWeeks: 4,
    defaultLunchMinutes: 30,
    flexOpeningBalance: 0,
    flexOpeningDate: ''
  };

  function emptyState() {
    return {
      version: 1,
      settings: { ...DEFAULT_SETTINGS },
      days: {}
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return emptyState();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return emptyState();
      const state = emptyState();
      state.settings = { ...state.settings, ...(parsed.settings || {}) };
      state.days = parsed.days || {};
      return state;
    } catch (err) {
      console.error('Failed to load state:', err);
      return emptyState();
    }
  }

  function save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      console.error('Failed to save state:', err);
      return false;
    }
  }

  function reset() {
    localStorage.removeItem(KEY);
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function exportJson(state) {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    triggerDownload(blob, 'timetracker-backup-' + Calc.toDateKey(new Date()) + '.json');
  }

  function exportCsv(state) {
    const settings = state.settings;
    const keys = Object.keys(state.days).sort();
    const rows = [[
      'Date', 'Weekday', 'Worked (h)', 'Regular (h)', 'Extra (h)',
      'Overtime (h)', 'Flex gain (h)', 'Shortfall (h)', 'Lunch (h)',
      'In Period', 'Segments', 'Note'
    ]];

    // Group keys by week to compute overtime allocation per day
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
          inPeriod: w.inPeriod
        });
      }
    }

    const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const key of keys) {
      const day = state.days[key];
      const date = Calc.parseDateKey(key);
      const c = Calc.computeDay(day, settings);
      const alloc = dayAlloc.get(key) || { overtime: 0, flexGain: 0, inPeriod: false };
      const segStr = (day.entries || [])
        .map(e => `${e.type[0].toUpperCase()}:${e.start || '--:--'}-${e.end || '--:--'}`)
        .join(' | ');
      rows.push([
        key,
        weekdayNames[date.getDay()],
        c.workedHours.toFixed(2),
        c.regular.toFixed(2),
        c.extra.toFixed(2),
        alloc.overtime.toFixed(2),
        alloc.flexGain.toFixed(2),
        c.shortfall.toFixed(2),
        c.lunchHours.toFixed(2),
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

  function importJson(text) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON structure');
    if (!parsed.days || typeof parsed.days !== 'object') throw new Error('Missing "days" object');
    const state = emptyState();
    state.settings = { ...state.settings, ...(parsed.settings || {}) };
    state.days = parsed.days;
    return state;
  }

  return {
    KEY,
    DEFAULT_SETTINGS,
    emptyState,
    load,
    save,
    reset,
    uuid,
    exportJson,
    exportCsv,
    importJson
  };
})();
