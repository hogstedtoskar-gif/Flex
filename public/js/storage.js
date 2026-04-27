/* storage.js - Talks to the backend REST API.
 *
 * The frontend keeps a local mirror of the state (App.state in app.js).
 * Mutations call the corresponding endpoint to persist on the server.
 * Multiple writes are coalesced into a small in-flight queue so a burst of
 * UI changes does not produce a thundering herd of HTTP requests.
 */

const Storage = (() => {
  const API_BASE = '/api';

  // ⚠️  KEEP IN SYNC with `server/db.js` (`const DEFAULT_SETTINGS`).
  //     server/smoke-test.js has a static parity check that fails if
  //     these objects drift — see the "Default-settings parity" block
  //     in that file.
  const DEFAULT_SETTINGS = {
    weekStartDay: 1,
    regularHoursPerDay: 8,
    weeklyOvertimeTargetHours: 6,
    weeklyOvertimeTargetsByWeek: [],
    overtimePeriodStart: Calc.toDateKey(new Date()),
    overtimePeriodWeeks: 4,
    defaultLunchMinutes: 30,
    minLunchMinutes: 30,
    lunchThresholdHours: 6,
    flexOpeningBalance: 0,
    flexOpeningDate: '',
    officeStart: '07:30',
    officeEnd: '17:30',
    // Which weekdays count as working days (indexed by Date.getDay():
    // 0=Sun, 1=Mon, ..., 6=Sat). On non-working days, worked hours are
    // treated overtime-only (just like "outside office hours") and the
    // day never contributes shortfall.
    workDays: [false, true, true, true, true, true, false],
    // Optional default project applied to new work segments when
    // nothing explicit is picked.
    defaultProjectId: ''
  };

  function emptyState() {
    return {
      version: 1,
      settings: { ...DEFAULT_SETTINGS },
      days: {},
      projects: []
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

  /* -------- api tokens (phone widget) -------- */

  async function listTokens() {
    const data = await http('/auth/tokens');
    return (data && data.tokens) || [];
  }

  async function createToken(label) {
    return http('/auth/tokens', {
      method: 'POST',
      body: { label: label || 'widget' }
    });
  }

  async function deleteToken(id) {
    await http('/auth/tokens/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  /* -------- quick actions (used by /quick page and by external widgets) -------- */

  async function quickStatus() {
    return http('/quick/status?tz=' + encodeURIComponent(guessTz()));
  }

  async function quickAction(action) {
    return http('/quick/' + action + '?tz=' + encodeURIComponent(guessTz()), {
      method: 'POST'
    });
  }

  function guessTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch (_) { return ''; }
  }

  async function load() {
    try {
      const state = await http('/state');
      const merged = emptyState();
      merged.settings = { ...merged.settings, ...((state && state.settings) || {}) };
      merged.days = (state && state.days) || {};
      merged.projects = Array.isArray(state && state.projects) ? state.projects : [];
      return merged;
    } catch (err) {
      console.error('Failed to load state from server:', err);
      throw err;
    }
  }

  /* -------- projects -------- */
  async function listProjects() {
    const data = await http('/projects');
    return (data && data.projects) || [];
  }
  async function createProject(name, color) {
    return http('/projects', { method: 'POST', body: { name, color: color || null } });
  }
  async function updateProject(id, patch) {
    return http('/projects/' + encodeURIComponent(id), { method: 'PATCH', body: patch });
  }
  async function deleteProject(id) {
    await http('/projects/' + encodeURIComponent(id), { method: 'DELETE' });
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

  /**
   * Synchronously dispatch any pending writes using fetch with
   * `keepalive: true`. Designed to be called from `pagehide` /
   * `visibilitychange: hidden` — browsers allow in-flight keepalive
   * requests to complete even after the tab is closed or navigated
   * away, whereas plain fetch() or async/await `flushNow()` can be
   * dropped mid-flight.
   *
   * Returns immediately; responses are not awaited and errors are
   * swallowed (we have no UI surface to report them once the page
   * is gone).
   */
  function flushKeepalive() {
    if (!pendingDays.size && !pendingSettings) return;
    const dayWrites = Array.from(pendingDays.entries());
    pendingDays.clear();
    const settingsWrite = pendingSettings;
    pendingSettings = null;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

    const base = API_BASE;
    const opts = (method, body) => {
      const init = {
        method,
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Accept': 'application/json' }
      };
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      return init;
    };
    for (const [dateKey, payload] of dayWrites) {
      const url = base + '/days/' + encodeURIComponent(dateKey);
      try {
        if (payload === null) fetch(url, opts('DELETE'));
        else fetch(url, opts('PUT', payload));
      } catch (_) { /* nothing we can do at tab-close */ }
    }
    if (settingsWrite) {
      try { fetch(base + '/settings', opts('PUT', settingsWrite)); }
      catch (_) { /* ignore */ }
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
    state.projects = Array.isArray(parsed.projects) ? parsed.projects : [];
    pendingDays.clear();
    pendingSettings = null;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const returned = await http('/state', { method: 'PUT', body: state });
    return returned || state;
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
    const projectById = new Map(
      (state.projects || []).map((p) => [Number(p.id), p])
    );
    const projectLabel = (pid) => {
      if (pid == null || pid === '') return '';
      const p = projectById.get(Number(pid));
      return p ? p.name : ('#' + pid);
    };

    const keys = Object.keys(state.days).sort();
    const rows = [[
      'Date', 'Weekday', 'Worked (h)', 'In Office (h)', 'Outside (h)',
      'Regular (h)', 'Extra (h)',
      'Overtime (h)', 'Flex gain (h)', 'Outside unused (h)',
      'Shortfall (h)', 'Lunch (h)', 'Auto-lunch deduction (h)',
      'In Period', 'Projects (h)', 'Tags', 'Segments', 'Note'
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
      const c = Calc.computeDay(day, settings, date);
      const alloc = dayAlloc.get(key) || { overtime: 0, flexGain: 0, outsideUnused: 0, inPeriod: false };
      const entries = day.entries || [];

      // Per-day totals bucketed by project (work segments only).
      const byProject = new Map();
      const allTags = new Set();
      for (const e of entries) {
        if (e.type !== 'work' || !e.start || !e.end) continue;
        const mins = Calc.entryMinutes(e);
        if (!mins) continue;
        const key2 = e.projectId != null ? String(e.projectId) : '';
        byProject.set(key2, (byProject.get(key2) || 0) + mins);
        if (Array.isArray(e.tags)) for (const t of e.tags) allTags.add(t);
      }
      const projectsCell = Array.from(byProject.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([pid, mins]) => {
          const label = pid === '' ? 'Untagged' : projectLabel(pid);
          return label + ':' + (mins / 60).toFixed(2) + 'h';
        })
        .join('; ');
      const tagsCell = Array.from(allTags).sort().join(', ');

      const segStr = entries
        .map((e) => {
          const type = (e.type || '?')[0].toUpperCase();
          const base = `${type}:${e.start || '--:--'}-${e.end || '--:--'}`;
          const extras = [];
          if (e.type === 'work' && e.projectId != null) {
            extras.push(projectLabel(e.projectId));
          }
          if (Array.isArray(e.tags) && e.tags.length) {
            extras.push('#' + e.tags.join(' #'));
          }
          return extras.length ? `${base} [${extras.join(' ')}]` : base;
        })
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
        projectsCell,
        tagsCell,
        segStr,
        (day.note || '').replace(/\r?\n/g, ' ')
      ]);
    }

    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, 'timetracker-' + Calc.toDateKey(new Date()) + '.csv');
  }

  /**
   * Fine-grained per-segment CSV: one row per time entry. Useful for
   * slicing project/tag totals externally (pivot tables, BI tools).
   */
  function exportSegmentsCsv(state) {
    const settings = state.settings;
    const projectById = new Map(
      (state.projects || []).map((p) => [Number(p.id), p])
    );
    const keys = Object.keys(state.days).sort();
    const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const officeWin = Calc.officeWindow(settings);

    const rows = [[
      'Date', 'Weekday', 'Segment #', 'Type',
      'Start', 'End', 'Duration (h)',
      'Project ID', 'Project', 'Project color', 'Project archived',
      'Tags', 'In office (h)', 'Outside (h)', 'Note'
    ]];

    for (const key of keys) {
      const day = state.days[key];
      const date = Calc.parseDateKey(key);
      const entries = day.entries || [];
      const note = (day.note || '').replace(/\r?\n/g, ' ');
      entries.forEach((e, i) => {
        const mins = Calc.entryMinutes(e);
        const hours = mins ? (mins / 60) : 0;
        let inOffice = 0;
        if (mins && e.type === 'work') {
          try {
            const split = Calc.entryOfficeSplit(e, officeWin);
            if (split && typeof split.inOffice === 'number') {
              inOffice = split.inOffice / 60;
            }
          } catch (_) { /* ignore */ }
        }
        const outside = Math.max(0, hours - inOffice);
        const p = e.projectId != null ? projectById.get(Number(e.projectId)) : null;
        rows.push([
          key,
          weekdayNames[date.getDay()],
          String(i + 1),
          e.type || '',
          e.start || '',
          e.end || '',
          hours.toFixed(2),
          e.projectId != null ? String(e.projectId) : '',
          p ? p.name : '',
          p && p.color ? p.color : '',
          p && p.archived ? 'yes' : '',
          Array.isArray(e.tags) ? e.tags.join(', ') : '',
          inOffice.toFixed(2),
          outside.toFixed(2),
          i === 0 ? note : ''
        ]);
      });
    }

    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, 'timetracker-segments-' + Calc.toDateKey(new Date()) + '.csv');
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
    flushKeepalive,
    reset,
    uuid,
    exportJson,
    exportCsv,
    exportSegmentsCsv,
    importJson,
    setErrorHandler,
    setUnauthorizedHandler,
    authConfig,
    whoami,
    login,
    logout,
    register,
    changePassword,
    listTokens,
    createToken,
    deleteToken,
    quickStatus,
    quickAction,
    listProjects,
    createProject,
    updateProject,
    deleteProject
  };
})();
