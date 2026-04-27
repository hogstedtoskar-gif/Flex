/* app.js - View router, state, event wiring.
 *
 * The state lives in App.state. Every mutation is mirrored to the server
 * via Storage.* helpers (which debounce + coalesce HTTP writes).
 */

(() => {
  const App = {
    state: Storage.emptyState(),
    currentView: 'dashboard',
    diaryDate: Calc.toDateKey(new Date()),
    weekPickerDate: Calc.toDateKey(new Date()),
    monthPicker: (() => {
      const d = new Date();
      return d.getFullYear() + '-' + Calc.pad(d.getMonth() + 1);
    })(),
    ready: false,
    user: null,
    authView: 'login', // 'login' | 'register'
    // Project currently selected on the Dashboard picker. '' = untagged.
    // Initialised on first dashboard render from settings.defaultProjectId.
    dashProjectId: null
  };

  /* =========================================================
     Persistence helpers — keep server in sync with App.state.
     The Storage layer debounces, so calling these in a tight
     loop is safe.
     ========================================================= */
  function persistDay(key) {
    const d = App.state.days[key];
    if (d) Storage.saveDay(key, d);
    else Storage.deleteDay(key);
  }

  function persistSettings() {
    Storage.saveSettings(App.state.settings);
  }

  function ensureDay(key) {
    if (!App.state.days[key]) {
      App.state.days[key] = { entries: [], note: '' };
    }
    return App.state.days[key];
  }

  function pruneDay(key) {
    const d = App.state.days[key];
    if (!d) return;
    if ((!d.entries || !d.entries.length) && !d.note) {
      delete App.state.days[key];
    }
  }

  /* =========================================================
     PROJECT helpers — shared across views.
     ========================================================= */
  function activeProjects() {
    return (App.state.projects || []).filter((p) => !p.archived);
  }

  function allProjects() {
    return App.state.projects || [];
  }

  function projectById(id) {
    if (id == null || id === '') return null;
    const n = Number(id);
    if (!Number.isFinite(n)) return null;
    return (App.state.projects || []).find((p) => p.id === n) || null;
  }

  // Split a comma-separated tag string into a deduped array.
  // Matches the server's sanitisation (10 max, 32 chars each) so
  // the UI never shows more than it can save.
  function parseTagsInput(raw) {
    if (!raw) return [];
    const out = [];
    const seen = new Set();
    for (const chunk of String(raw).split(',')) {
      const v = chunk.trim().slice(0, 32);
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
      if (out.length >= 10) break;
    }
    return out;
  }

  // Fill a <select> with the user's projects. `selectedId` is coerced
  // to a string for comparison; an empty string represents "untagged".
  function populateProjectSelect(select, selectedId, opts) {
    if (!select) return;
    const options = opts || {};
    const includeUntagged = options.includeUntagged !== false;
    const untaggedLabel = options.untaggedLabel || '— Untagged —';
    const includeArchived = !!options.includeArchived;
    const archivedIdToKeep = options.keepArchivedId != null ? Number(options.keepArchivedId) : null;
    UI.clear(select);
    if (includeUntagged) {
      select.appendChild(UI.el('option', { value: '', text: untaggedLabel }));
    }
    const pool = allProjects();
    const wanted = selectedId != null ? String(selectedId) : '';
    for (const p of pool) {
      if (p.archived && !includeArchived && p.id !== archivedIdToKeep) continue;
      const label = p.name + (p.archived ? ' (archived)' : '');
      const opt = UI.el('option', { value: String(p.id), text: label });
      if (String(p.id) === wanted) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function setupProjectsUI(view) {
    const form = view.querySelector('[data-projects-form]');
    const listEl = view.querySelector('[data-projects-list]');
    if (!form || !listEl) return;

    function paint() {
      UI.clear(listEl);
      const projects = allProjects();
      if (!projects.length) {
        listEl.appendChild(UI.el('div', {
          class: 'projects-empty',
          text: 'No projects yet. Add one above to start labelling your time.'
        }));
        return;
      }
      for (const p of projects) {
        listEl.appendChild(projectRow(p));
      }
    }

    function projectRow(p) {
      const row = UI.el('div', { class: 'projects-row' + (p.archived ? ' archived' : '') });
      const swatch = UI.el('span', {
        class: 'project-swatch',
        style: p.color ? 'background:' + p.color : ''
      });
      const nameInput = UI.el('input', {
        type: 'text',
        class: 'project-name-input',
        value: p.name,
        maxlength: '64'
      });
      const colorInput = UI.el('input', {
        type: 'color',
        class: 'project-color-input',
        value: p.color || '#4f8cff'
      });

      async function patch(fields) {
        try {
          const updated = await Storage.updateProject(p.id, fields);
          const idx = App.state.projects.findIndex((x) => x.id === p.id);
          if (idx >= 0) App.state.projects[idx] = updated;
          // When a project is renamed/archived, refresh dependent views.
          render();
        } catch (err) {
          UI.toast('Update failed: ' + prettifyError(err), 'error');
          paint();
        }
      }

      nameInput.addEventListener('change', () => {
        const next = nameInput.value.trim();
        if (!next || next === p.name) { nameInput.value = p.name; return; }
        patch({ name: next });
      });
      colorInput.addEventListener('change', () => {
        const next = colorInput.value;
        if (next === p.color) return;
        patch({ color: next });
      });

      const archiveBtn = UI.el('button', {
        class: 'btn btn-ghost btn-sm',
        text: p.archived ? 'Restore' : 'Archive'
      });
      archiveBtn.addEventListener('click', () => patch({ archived: !p.archived }));

      const delBtn = UI.el('button', { class: 'btn btn-ghost btn-sm', text: 'Delete' });
      delBtn.addEventListener('click', async () => {
        if (!UI.confirmDialog('Delete "' + p.name + '"? This only works if no entries reference it — otherwise archive it.')) return;
        try {
          await Storage.deleteProject(p.id);
          App.state.projects = App.state.projects.filter((x) => x.id !== p.id);
          UI.toast('Project deleted', 'info');
          render();
        } catch (err) {
          UI.toast(prettifyError(err), 'error');
        }
      });

      row.appendChild(swatch);
      row.appendChild(nameInput);
      row.appendChild(colorInput);
      row.appendChild(archiveBtn);
      row.appendChild(delBtn);
      return row;
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = form.elements;
      const name = (f['name'].value || '').trim();
      const color = f['color'].value || null;
      if (!name) return;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        const p = await Storage.createProject(name, color);
        App.state.projects.push(p);
        form.reset();
        f['color'].value = '#4f8cff';
        UI.toast('Project "' + p.name + '" created', 'success');
        render();
      } catch (err) {
        UI.toast(prettifyError(err), 'error');
      } finally {
        submit.disabled = false;
      }
    });

    paint();
  }

  function setView(name) {
    App.currentView = name;
    for (const t of document.querySelectorAll('.tab')) {
      t.classList.toggle('active', t.dataset.view === name);
    }
    render();
  }

  function render() {
    const root = document.getElementById('view-root');
    UI.clear(root);
    updateTopbar();
    if (!App.user) {
      if (App.authView === 'register') renderRegister(root);
      else renderLogin(root);
      return;
    }
    if (!App.ready) {
      root.appendChild(UI.el('div', { class: 'card', text: 'Loading your data…' }));
      return;
    }
    if (App.currentView === 'dashboard') renderDashboard(root);
    else if (App.currentView === 'diary') renderDiary(root);
    else if (App.currentView === 'summary') renderSummary(root);
    else if (App.currentView === 'quick') renderQuick(root);
    else if (App.currentView === 'settings') renderSettings(root);
  }

  function updateTopbar() {
    const tabs = document.getElementById('tabs');
    const badge = document.getElementById('user-badge');
    const name = document.getElementById('user-name');
    if (tabs) tabs.toggleAttribute('hidden', !App.user);
    if (badge) badge.toggleAttribute('hidden', !App.user);
    if (name) name.textContent = App.user ? App.user.username : '';
    // Used by the mobile bottom-nav CSS to reserve body padding only
    // when the tabs are actually showing (i.e. after login).
    document.body.classList.toggle('has-tabs', !!App.user);
  }

  /* =========================================================
     AUTH VIEWS
     ========================================================= */
  function renderLogin(root) {
    const view = UI.cloneTemplate('tpl-login');
    root.appendChild(view);

    if (App.allowRegistration) {
      const hint = view.querySelector('[data-register-hint]');
      if (hint) hint.hidden = false;
      const link = view.querySelector('[data-action="show-register"]');
      if (link) link.addEventListener('click', (ev) => {
        ev.preventDefault();
        App.authView = 'register';
        render();
      });
    }

    const form = view.querySelector('[data-login-form]');
    const err = view.querySelector('[data-login-error]');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      const f = form.elements;
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const user = await Storage.login(f['username'].value.trim(), f['password'].value);
        await onAuthenticated(user);
      } catch (e) {
        err.textContent = prettifyError(e);
      } finally {
        submitBtn.disabled = false;
      }
    });

    setTimeout(() => form.elements['username'].focus(), 0);
  }

  function renderRegister(root) {
    const view = UI.cloneTemplate('tpl-register');
    root.appendChild(view);

    view.querySelector('[data-action="show-login"]').addEventListener('click', (ev) => {
      ev.preventDefault();
      App.authView = 'login';
      render();
    });

    const form = view.querySelector('[data-register-form]');
    const err = view.querySelector('[data-register-error]');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      const f = form.elements;
      if (f['password'].value !== f['confirm'].value) {
        err.textContent = 'Passwords do not match.';
        return;
      }
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const user = await Storage.register(f['username'].value.trim(), f['password'].value);
        await onAuthenticated(user);
      } catch (e) {
        err.textContent = prettifyError(e);
      } finally {
        submitBtn.disabled = false;
      }
    });

    setTimeout(() => form.elements['username'].focus(), 0);
  }

  function prettifyError(err) {
    const msg = err && err.message ? err.message : String(err);
    return msg.replace(/^HTTP \d+:\s*/, '');
  }

  async function onAuthenticated(user) {
    App.user = user;
    App.authView = 'login';
    try {
      App.state = await Storage.load();
      App.ready = true;
      setView(initialViewFromUrl());
    } catch (err) {
      App.ready = false;
      render();
      UI.toast('Could not load your data: ' + prettifyError(err), 'error');
    }
  }

  async function handleLogout() {
    await Storage.logout();
    App.user = null;
    App.ready = false;
    App.state = Storage.emptyState();
    App.currentView = 'dashboard';
    render();
  }

  /* =========================================================
     DASHBOARD
     ========================================================= */
  function renderDashboard(root) {
    const view = UI.cloneTemplate('tpl-dashboard');
    root.appendChild(view);

    const today = new Date();
    const todayKey = Calc.toDateKey(today);
    const day = App.state.days[todayKey];
    const settings = App.state.settings;
    // Use globalStatus so an open segment that started on a PREVIOUS
    // day (e.g. clocked in last night, never clocked out) is still
    // recognised in the UI. This matches server/quick.js and avoids
    // the "two open segments on two different days" bug.
    const status = Calc.globalStatus(App.state.days, todayKey);
    const statusOnAnotherDay = status.openDateKey && status.openDateKey !== todayKey;

    view.querySelector('[data-today-date]').textContent = UI.formatDate(today);

    const statusEl = view.querySelector('[data-status]');
    statusEl.classList.add('status-' + status.state);
    let statusText = 'Not clocked in';
    if (status.state === 'working') {
      statusText = 'Working since ' + (status.openEntry.start || '?');
      if (statusOnAnotherDay) statusText += ' on ' + status.openDateKey;
    } else if (status.state === 'lunch') {
      statusText = 'On lunch since ' + (status.openEntry.start || '?');
      if (statusOnAnotherDay) statusText += ' on ' + status.openDateKey;
    } else if (status.lastEntry) {
      statusText = 'Last clock-out ' + (status.lastEntry.end || '?');
    }
    const statusLeft = UI.el('span', {}, [statusText]);
    if (status.state !== 'off' && status.openEntry && status.openEntry.projectId != null) {
      const p = projectById(status.openEntry.projectId);
      if (p) {
        statusLeft.appendChild(UI.el('span', {
          class: 'project-chip',
          style: p.color ? 'background:' + p.color : '',
          text: p.name
        }));
      }
    }
    statusEl.appendChild(statusLeft);
    if ((status.state === 'working' || status.state === 'lunch') && status.openEntry && status.openEntry.start) {
      statusEl.appendChild(UI.el('span', {
        class: 'muted',
        'data-elapsed-ticker': '',
        'data-elapsed-start': status.openEntry.start,
        'data-elapsed-start-date': status.openDateKey || todayKey,
        text: formatElapsedSince(status.openEntry.start, status.openDateKey, todayKey)
      }));
    } else {
      statusEl.appendChild(UI.el('span', { class: 'muted', text: '—' }));
    }

    // Project picker: shown only when the user has at least one project.
    // The selection is used for clock-in (new work segment) and for
    // lunch-end (resume work). On first render we seed it from the
    // default in settings.
    const pickerWrap = view.querySelector('[data-project-picker]');
    const pickerSel = view.querySelector('[data-dashboard-project]');
    const pickerHint = view.querySelector('[data-project-picker-hint]');
    const haveProjects = activeProjects().length > 0;
    if (pickerWrap) pickerWrap.hidden = !haveProjects;
    if (haveProjects && pickerSel) {
      if (App.dashProjectId == null) {
        App.dashProjectId = String(settings.defaultProjectId || '');
      }
      populateProjectSelect(pickerSel, App.dashProjectId, {
        includeUntagged: true,
        untaggedLabel: '— Untagged —'
      });
      pickerSel.addEventListener('change', () => {
        App.dashProjectId = pickerSel.value;
        updateProjectHint();
      });
      const updateProjectHint = () => {
        if (!pickerHint) return;
        if (status.state === 'working') {
          pickerHint.textContent = 'Next segment (after lunch or re-clock in) uses this project.';
        } else if (status.state === 'lunch') {
          pickerHint.textContent = 'End lunch to resume work with this project.';
        } else {
          pickerHint.textContent = 'Applied when you clock in.';
        }
      };
      updateProjectHint();
    }

    const btnIn = view.querySelector('[data-action="clock-in"]');
    const btnOut = view.querySelector('[data-action="clock-out"]');
    const btnLunchStart = view.querySelector('[data-action="lunch-start"]');
    const btnLunchEnd = view.querySelector('[data-action="lunch-end"]');

    btnIn.disabled = !(status.state === 'off');
    btnOut.disabled = !(status.state === 'working');
    btnLunchStart.disabled = !(status.state === 'working');
    btnLunchEnd.disabled = !(status.state === 'lunch');

    // When the open segment belongs to a previous day (e.g. clocked in
    // last night), transitions operate on THAT day, not today, so the
    // segment finally closes where it was opened.
    const openKey = status.openDateKey || todayKey;
    const pickerProjectId = () => (pickerSel ? pickerSel.value : '');
    btnIn.addEventListener('click', () => clockIn(todayKey, { projectId: pickerProjectId() }));
    btnOut.addEventListener('click', () => clockOut(openKey));
    btnLunchStart.addEventListener('click', () => lunchStart(openKey));
    btnLunchEnd.addEventListener('click', () => lunchEnd(openKey, { projectId: pickerProjectId() }));

    const c = Calc.computeDay(dayForLiveTotals(day, status), settings, today);

    const todayTimeline = view.querySelector('[data-today-timeline]');
    if (todayTimeline && typeof Timeline !== 'undefined') {
      todayTimeline.appendChild(Timeline.render({
        entries: (day && day.entries) || [],
        settings,
        projects: App.state.projects || [],
        now: new Date(),
        showNow: true
      }));
    }

    const todayTotals = view.querySelector('[data-today-totals]');
    todayTotals.appendChild(UI.stat('Worked', Calc.formatHours(c.workedHours)));
    todayTotals.appendChild(UI.stat('Regular', Calc.formatHours(c.regular)));
    todayTotals.appendChild(UI.stat('Extra', Calc.formatHours(c.extra), c.extra > 0 ? 'overtime' : ''));
    if (c.officeEnforced && c.outsideHours > 0) {
      todayTotals.appendChild(UI.stat(
        'Outside', Calc.formatHours(c.outsideHours), 'overtime'
      ));
    }
    todayTotals.appendChild(UI.stat('Lunch', Calc.formatHours(c.lunchHours)));
    if (c.lunchDeduction > 0) {
      todayTotals.appendChild(UI.stat(
        'Auto-lunch',
        '−' + Calc.formatHours(c.lunchDeduction),
        'negative'
      ));
    }

    const wsDate = Calc.weekStart(today, settings.weekStartDay);
    const week = Calc.computeWeek(wsDate, App.state.days, settings);
    view.querySelector('[data-week-range]').textContent = UI.formatRange(week.weekStart, week.weekEnd);

    const weekTotals = view.querySelector('[data-week-totals]');
    weekTotals.appendChild(UI.stat('Worked', Calc.formatHours(week.workedTotal)));
    weekTotals.appendChild(UI.stat('Regular', Calc.formatHours(week.regularTotal)));
    weekTotals.appendChild(UI.stat('Overtime', Calc.formatHours(week.overtimeFilled), 'overtime'));
    weekTotals.appendChild(UI.stat(
      'Flex (net)',
      Calc.formatHours(week.flexNet),
      week.flexNet > 0 ? 'positive' : (week.flexNet < 0 ? 'negative' : '')
    ));
    if (week.outsideUnused > 0) {
      weekTotals.appendChild(UI.stat(
        'Outside unused',
        Calc.formatHours(week.outsideUnused),
        'negative'
      ));
    }

    const weekProgress = view.querySelector('[data-week-progress]');
    if (week.inPeriod) {
      weekProgress.appendChild(UI.progressBar(
        'Weekly overtime filled',
        week.overtimeFilled,
        week.target
      ));
    } else {
      weekProgress.appendChild(UI.el('div', {
        class: 'muted small',
        text: 'This week is outside the configured overtime period.'
      }));
    }
    weekProgress.appendChild(UI.progressBar(
      'Regular hours',
      week.regularTotal,
      settings.regularHoursPerDay * Calc.countWorkDays(settings),
      'regular'
    ));

    const period = Calc.computeOvertimePeriod(App.state.days, settings);
    const periodRange = view.querySelector('[data-period-range]');
    if (settings.overtimePeriodStart && settings.overtimePeriodWeeks > 0) {
      const startDate = Calc.parseDateKey(settings.overtimePeriodStart);
      const periodStart = Calc.weekStart(startDate, settings.weekStartDay);
      const periodEnd = Calc.addDays(periodStart, settings.overtimePeriodWeeks * 7 - 1);
      periodRange.textContent = UI.formatRange(periodStart, periodEnd);
    } else {
      periodRange.textContent = 'Not configured';
    }

    const periodSummary = view.querySelector('[data-period-summary]');
    periodSummary.appendChild(UI.el('span', {
      class: 'big',
      text: Calc.formatHours(period.totalFilled, { compact: true })
    }));
    periodSummary.appendChild(UI.el('span', {
      class: 'muted',
      text: 'of ' + Calc.formatHours(period.totalRequired, { compact: true }) + ' required'
    }));
    const remaining = Math.max(0, period.totalRequired - period.totalFilled);
    periodSummary.appendChild(UI.el('span', {
      class: 'muted',
      text: '• ' + Calc.formatHours(remaining, { compact: true }) + ' remaining'
    }));

    const periodWeeksEl = view.querySelector('[data-period-weeks]');
    for (const w of period.weeks) {
      const label = 'Week ' + (w.index + 1) + ' (' + UI.formatDateShort(w.weekStart) + ')';
      periodWeeksEl.appendChild(UI.progressBar(label, w.filled, w.target));
    }

    const flexBalance = Calc.computeFlexBalance(App.state.days, settings);
    const opening = parseFloat(settings.flexOpeningBalance) || 0;
    const earned = flexBalance - opening;
    const flexDisplay = view.querySelector('[data-flex-display]');
    flexDisplay.appendChild(UI.el('span', {
      class: 'big ' + (flexBalance >= 0 ? 'positive' : 'negative'),
      text: Calc.formatHours(flexBalance)
    }));
    flexDisplay.appendChild(UI.el('span', {
      class: 'muted',
      text: flexBalance >= 0 ? 'surplus' : 'deficit'
    }));
    if (opening !== 0) {
      const asOf = settings.flexOpeningDate ? ' as of ' + settings.flexOpeningDate : '';
      flexDisplay.appendChild(UI.el('div', {
        class: 'muted small',
        style: 'margin-top:8px; flex-basis:100%;',
        text: 'Opening ' + Calc.formatHours(opening, { compact: true }) + asOf
          + ' + earned ' + Calc.formatHours(earned, { compact: true })
      }));
    }

    setupManualEntry(view);

    const alerts = view.querySelector('[data-alerts]');
    const unfinished = findUnfinishedDays();
    for (const { dateKey } of unfinished) {
      if (dateKey === todayKey) continue;
      alerts.appendChild(UI.el('div', {
        class: 'alert alert-warning',
        text: 'Unfinished day on ' + dateKey + ' — open segment with no end time.'
      }));
    }
  }

  function nowHM() {
    const d = new Date();
    return Calc.pad(d.getHours()) + ':' + Calc.pad(d.getMinutes());
  }

  function formatElapsedSince(startHM, startDateKey, todayKey) {
    const start = Calc.parseHM(startHM);
    if (start == null) return '';
    const d = new Date();
    const nowMin = d.getHours() * 60 + d.getMinutes();
    const nowSec = d.getSeconds();
    let totalSec = (nowMin - start) * 60 + nowSec;
    if (totalSec < 0) totalSec += 24 * 60 * 60;
    // If the open segment started on a previous calendar day, add a
    // full day for every day difference between then and today.
    if (startDateKey && todayKey && startDateKey !== todayKey) {
      const startDate = Calc.parseDateKey(startDateKey);
      const nowDate = Calc.parseDateKey(todayKey);
      const daysDiff = Math.max(0, Math.round((nowDate - startDate) / (24 * 60 * 60 * 1000)));
      totalSec += daysDiff * 24 * 60 * 60;
    }
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return h + 'h ' + Calc.pad(m) + 'm ' + Calc.pad(s) + 's';
  }

  function dayForLiveTotals(day, status) {
    if (!day || !Array.isArray(day.entries)) return day;
    if (!status || status.state !== 'working' || !status.openEntry || !status.openEntry.id) {
      return day;
    }
    const now = nowHM();
    return {
      ...day,
      entries: day.entries.map((e) => {
        if (e.id === status.openEntry.id && e.type === 'work' && e.start && !e.end) {
          return { ...e, end: now };
        }
        return e;
      })
    };
  }

  function clockIn(dateKey, opts) {
    // Block new clock-in if there's an open segment on ANY day.
    // Previously this only looked at today, which let a forgotten
    // clock-out on a previous day coexist with a new clock-in today.
    const existing = FSM.findOpenAcrossDays(App.state.days);
    if (existing) {
      const where = existing.dateKey === dateKey ? '' : ' on ' + existing.dateKey;
      UI.toast(
        'Already ' + (existing.entry.type === 'lunch' ? 'on lunch' : 'clocked in')
          + ' since ' + (existing.entry.start || '?') + where,
        'error'
      );
      return;
    }
    const day = ensureDay(dateKey);
    const fsmOpts = normaliseProjectOpts(opts, App.state.settings);
    const result = FSM.clockIn(day.entries, nowHM(), Storage.uuid, fsmOpts);
    if (!result.ok) { UI.toast(result.error, 'error'); return; }
    day.entries = result.entries;
    persistDay(dateKey);
    UI.toast('Clocked in', 'success');
    render();
  }

  // Accepts either { projectId } or nothing. Falls back to
  // settings.defaultProjectId when the caller didn't pass one.
  function normaliseProjectOpts(opts, settings) {
    const out = {};
    let pid = opts && 'projectId' in opts ? opts.projectId : undefined;
    if (pid === undefined) pid = (settings && settings.defaultProjectId) || '';
    if (pid != null && pid !== '') {
      const n = Number(pid);
      if (Number.isFinite(n)) out.projectId = n;
    }
    return out;
  }

  function resolveOpenDay(expectedType, preferredKey) {
    // Prefer the caller-supplied dateKey when it actually has the
    // matching open segment. Otherwise fall back to a cross-day
    // search so yesterday's forgotten clock-in can still be closed
    // from the dashboard, a hotkey, or the widget.
    if (preferredKey) {
      const d = App.state.days[preferredKey];
      if (d) {
        const s = Calc.currentStatus(d);
        if ((expectedType === 'working' && s.state === 'working')
          || (expectedType === 'lunch' && s.state === 'lunch')) {
          return { dateKey: preferredKey, day: d, openEntry: s.openEntry };
        }
      }
    }
    const found = Calc.findOpenAcrossDays(App.state.days);
    if (!found) return null;
    const wantWorking = expectedType === 'working';
    const isLunch = found.entry.type === 'lunch';
    if (wantWorking && isLunch) return null;
    if (!wantWorking && !isLunch) return null;
    return {
      dateKey: found.dateKey,
      day: App.state.days[found.dateKey],
      openEntry: found.entry
    };
  }

  function clockOut(dateKey) {
    const open = resolveOpenDay('working', dateKey);
    if (!open) {
      UI.toast('Not currently working', 'error');
      return;
    }
    const result = FSM.clockOut(open.day.entries, nowHM());
    if (!result.ok) { UI.toast(result.error, 'error'); return; }
    open.day.entries = result.entries;
    persistDay(open.dateKey);
    UI.toast('Clocked out', 'success');
    render();
  }

  function lunchStart(dateKey) {
    const open = resolveOpenDay('working', dateKey);
    if (!open) {
      UI.toast('You must be clocked in first', 'error');
      return;
    }
    const result = FSM.lunchStart(open.day.entries, nowHM(), Storage.uuid);
    if (!result.ok) { UI.toast(result.error, 'error'); return; }
    open.day.entries = result.entries;
    persistDay(open.dateKey);
    UI.toast('Lunch started', 'info');
    render();
  }

  function lunchEnd(dateKey, opts) {
    const open = resolveOpenDay('lunch', dateKey);
    if (!open) {
      UI.toast('Not on lunch', 'error');
      return;
    }
    // If the caller didn't explicitly pass a project (e.g. from a
    // hotkey), let FSM.lunchEnd inherit from the previous work
    // segment. Only when the dashboard picker forces a value do we
    // override.
    let fsmOpts;
    if (opts && 'projectId' in opts) {
      fsmOpts = { projectId: opts.projectId };
      if (fsmOpts.projectId === '' || fsmOpts.projectId == null) fsmOpts.projectId = null;
      else {
        const n = Number(fsmOpts.projectId);
        fsmOpts.projectId = Number.isFinite(n) ? n : null;
      }
    }
    const result = FSM.lunchEnd(open.day.entries, nowHM(), Storage.uuid, fsmOpts);
    if (!result.ok) { UI.toast(result.error, 'error'); return; }
    open.day.entries = result.entries;
    persistDay(open.dateKey);
    UI.toast('Back to work', 'success');
    render();
  }

  function setupManualEntry(view) {
    const form = view.querySelector('[data-manual-form]');
    const errEl = view.querySelector('[data-manual-error]');
    if (!form) return;

    UI.upgradeTime24Inputs(form);
    form.elements['date'].value = Calc.toDateKey(new Date());

    const projectLabel = view.querySelector('[data-manual-project-label]');
    const projectSel = view.querySelector('[data-manual-project]');
    if (projectSel) {
      const haveProjects = activeProjects().length > 0;
      if (projectLabel) projectLabel.hidden = !haveProjects;
      populateProjectSelect(projectSel, App.state.settings.defaultProjectId || '', {
        includeUntagged: true,
        untaggedLabel: '— Untagged —'
      });
    }

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      errEl.textContent = '';

      const f = form.elements;
      const date = f['date'].value;
      // Coerce to canonical HH:MM (handles Enter-to-submit where blur
      // hasn't fired yet, and "9:5" / "0905" style typing).
      const clockIn = UI.normaliseTime24(f['clockIn'].value);
      const clockOut = UI.normaliseTime24(f['clockOut'].value);
      const lunchStart = UI.normaliseTime24(f['lunchStart'].value);
      const lunchEnd = UI.normaliseTime24(f['lunchEnd'].value);
      f['clockIn'].value = clockIn;
      f['clockOut'].value = clockOut;
      f['lunchStart'].value = lunchStart;
      f['lunchEnd'].value = lunchEnd;
      const mode = f['mode'].value;

      if (!date || !clockIn || !clockOut) {
        errEl.textContent = 'Date, clock in and clock out are required.';
        return;
      }

      const inMin = Calc.parseHM(clockIn);
      const outMinRaw = Calc.parseHM(clockOut);
      if (inMin == null || outMinRaw == null) {
        errEl.textContent = 'Clock in and clock out are required.';
        return;
      }
      if (outMinRaw === inMin) {
        errEl.textContent = 'Clock in and clock out cannot be identical.';
        return;
      }
      // Allow overnight shifts: if clockOut <= clockIn we assume the
      // shift crosses midnight. Internally we represent the "end" side
      // on an extended minute axis (+24h) for overlap checks only.
      const overnight = outMinRaw < inMin;
      const outMin = overnight ? outMinRaw + 24 * 60 : outMinRaw;

      const hasLunch = lunchStart || lunchEnd;
      if (hasLunch && (!lunchStart || !lunchEnd)) {
        errEl.textContent = 'Provide both lunch start and lunch end, or leave both empty.';
        return;
      }

      // Project + tags apply to the WORK segments we create. A
      // lunch segment never carries a project (it's non-work time).
      const projectIdRaw = f['projectId'] ? f['projectId'].value : '';
      const projectId = projectIdRaw && Number.isFinite(Number(projectIdRaw))
        ? Number(projectIdRaw)
        : null;
      const tagsRaw = f['tags'] ? f['tags'].value : '';
      const tags = parseTagsInput(tagsRaw);
      const workExtras = {};
      if (projectId != null) workExtras.projectId = projectId;
      if (tags.length) workExtras.tags = tags;

      const newSegments = [];
      if (hasLunch) {
        const lsRaw = Calc.parseHM(lunchStart);
        const leRaw = Calc.parseHM(lunchEnd);
        if (lsRaw == null || leRaw == null) {
          errEl.textContent = 'Invalid lunch time.';
          return;
        }
        // Project lunch onto the same extended axis as clockIn/clockOut.
        // A lunch "before" clockIn in wall-clock time is assumed to be
        // on the next calendar day (overnight shift case).
        const ls = lsRaw < inMin ? lsRaw + 24 * 60 : lsRaw;
        const le = leRaw < inMin ? leRaw + 24 * 60 : leRaw;
        if (le <= ls) {
          errEl.textContent = 'Lunch end must be later than lunch start.';
          return;
        }
        if (ls < inMin || le > outMin) {
          errEl.textContent = 'Lunch must fall within clock in and clock out.';
          return;
        }
        newSegments.push({ id: Storage.uuid(), type: 'work', start: clockIn, end: lunchStart, ...workExtras });
        newSegments.push({ id: Storage.uuid(), type: 'lunch', start: lunchStart, end: lunchEnd });
        newSegments.push({ id: Storage.uuid(), type: 'work', start: lunchEnd, end: clockOut, ...workExtras });
      } else {
        newSegments.push({ id: Storage.uuid(), type: 'work', start: clockIn, end: clockOut, ...workExtras });
      }

      const day = ensureDay(date);
      if (mode === 'replace') {
        day.entries = newSegments;
      } else {
        day.entries = (day.entries || []).concat(newSegments);
      }

      const { errors } = Calc.validateDay(day.entries);
      if (errors.length) {
        errEl.textContent = 'Saved, but the day has issues: ' + errors.map(e => e.message).join('; ');
      }

      persistDay(date);
      UI.toast('Entry saved for ' + date, 'success');
      form.reset();
      form.elements['date'].value = Calc.toDateKey(new Date());
      render();
    });

    form.addEventListener('reset', () => {
      errEl.textContent = '';
      setTimeout(() => { form.elements['date'].value = Calc.toDateKey(new Date()); }, 0);
    });
  }

  function findUnfinishedDays() {
    const today = Calc.toDateKey(new Date());
    const result = [];
    for (const [key, day] of Object.entries(App.state.days)) {
      if (key >= today) continue;
      const hasOpen = (day.entries || []).some(e => e.start && !e.end);
      if (hasOpen) result.push({ dateKey: key });
    }
    return result;
  }

  /* =========================================================
     DIARY
     ========================================================= */
  function renderDiary(root) {
    const view = UI.cloneTemplate('tpl-diary');
    root.appendChild(view);

    const dateInput = view.querySelector('[data-diary-date]');
    dateInput.value = App.diaryDate;
    dateInput.addEventListener('change', () => {
      if (dateInput.value) {
        App.diaryDate = dateInput.value;
        render();
      }
    });

    view.querySelector('[data-action="prev-day"]').addEventListener('click', () => shiftDiary(-1));
    view.querySelector('[data-action="next-day"]').addEventListener('click', () => shiftDiary(1));
    view.querySelector('[data-action="today-day"]').addEventListener('click', () => {
      App.diaryDate = Calc.toDateKey(new Date());
      render();
    });

    const key = App.diaryDate;
    const day = App.state.days[key] || { entries: [], note: '' };
    const settings = App.state.settings;
    const diaryDate = Calc.parseDateKey(key);
    const c = Calc.computeDay(day, settings, diaryDate);

    const summaryEl = view.querySelector('[data-diary-summary]');
    summaryEl.appendChild(UI.stat('Worked', Calc.formatHours(c.workedHours)));
    summaryEl.appendChild(UI.stat('Regular', Calc.formatHours(c.regular)));
    summaryEl.appendChild(UI.stat('Extra', Calc.formatHours(c.extra), c.extra > 0 ? 'overtime' : ''));
    if (c.officeEnforced && c.outsideHours > 0) {
      summaryEl.appendChild(UI.stat(
        'Outside', Calc.formatHours(c.outsideHours), 'overtime'
      ));
    }
    summaryEl.appendChild(UI.stat('Lunch', Calc.formatHours(c.lunchHours)));
    if (c.lunchDeduction > 0) {
      summaryEl.appendChild(UI.stat(
        'Auto-lunch',
        '−' + Calc.formatHours(c.lunchDeduction),
        'negative'
      ));
    }

    const todayKey = Calc.toDateKey(new Date());
    const diaryTimelineEl = view.querySelector('[data-diary-timeline]');
    if (diaryTimelineEl && typeof Timeline !== 'undefined') {
      diaryTimelineEl.appendChild(Timeline.render({
        entries: day.entries || [],
        settings,
        projects: App.state.projects || [],
        now: new Date(),
        showNow: key === todayKey
      }));
    }

    const validation = Calc.validateDay(day.entries || []);
    const validationEl = view.querySelector('[data-diary-validation]');
    for (const err of validation.errors) {
      validationEl.appendChild(UI.el('div', {
        class: 'alert alert-danger',
        text: 'Error: ' + err.message
      }));
    }
    for (const w of validation.warnings) {
      validationEl.appendChild(UI.el('div', {
        class: 'alert alert-warning',
        text: 'Warning: ' + w.message
      }));
    }
    const openCount = (day.entries || []).filter(e => e.start && !e.end).length;
    if (openCount && key < Calc.toDateKey(new Date())) {
      validationEl.appendChild(UI.el('div', {
        class: 'alert alert-warning',
        text: 'This past day still has an open segment without an end time.'
      }));
    }
    if (c.officeEnforced && c.outsideHours > 0) {
      validationEl.appendChild(UI.el('div', {
        class: 'alert alert-info',
        text: 'Outside office hours (' + (settings.officeStart || '') + '–'
          + (settings.officeEnd || '') + '): '
          + Calc.formatHours(c.outsideHours, { compact: true })
          + ' — counts toward overtime only, never regular or flex.'
      }));
    }
    if (c.lunchDeduction > 0) {
      validationEl.appendChild(UI.el('div', {
        class: 'alert alert-warning',
        text: 'Auto-lunch deduction: '
          + Calc.formatHours(c.lunchDeduction, { compact: true })
          + ' removed from worked time. Recorded lunch ('
          + Calc.formatHours(c.lunchHours, { compact: true })
          + ') is below the '
          + (settings.minLunchMinutes || 30) + '-minute minimum for a '
          + Calc.formatHours(c.workedHoursRaw, { compact: true })
          + ' work day.'
      }));
    }

    const entriesEl = view.querySelector('[data-diary-entries]');
    const errorById = new Map();
    for (const err of validation.errors) {
      if (err.id) errorById.set(err.id, err.message);
    }

    const entries = (day.entries || []).slice().sort((a, b) => {
      const as = Calc.parseHM(a.start) || 0;
      const bs = Calc.parseHM(b.start) || 0;
      return as - bs;
    });
    if (!entries.length) {
      entriesEl.appendChild(UI.el('div', {
        class: 'empty-state',
        text: 'No segments yet. Click "Add segment" to record working time.'
      }));
    } else {
      for (const e of entries) {
        entriesEl.appendChild(renderEntryRow(key, e, errorById.get(e.id)));
      }
    }

    view.querySelector('[data-action="add-entry"]').addEventListener('click', () => {
      const d = ensureDay(key);
      d.entries.push({ id: Storage.uuid(), type: 'work', start: '', end: '' });
      persistDay(key);
      render();
    });

    const noteEl = view.querySelector('[data-diary-note]');
    noteEl.value = day.note || '';
    noteEl.addEventListener('change', () => {
      const d = ensureDay(key);
      d.note = noteEl.value;
      pruneDay(key);
      persistDay(key);
    });
  }

  function renderEntryRow(dateKey, entry, errorMsg) {
    const row = UI.el('div', { class: 'entry-row' + (errorMsg ? ' invalid' : '') });

    const typeSel = UI.el('select');
    for (const t of ['work', 'lunch']) {
      const opt = UI.el('option', { value: t, text: t.charAt(0).toUpperCase() + t.slice(1) });
      if (entry.type === t) opt.selected = true;
      typeSel.appendChild(opt);
    }
    typeSel.addEventListener('change', () => updateEntry(dateKey, entry.id, { type: typeSel.value }));

    const startInput = UI.time24Input(entry.start || '', (v) => updateEntry(dateKey, entry.id, { start: v }));
    const endInput = UI.time24Input(entry.end || '', (v) => updateEntry(dateKey, entry.id, { end: v }));

    const minutes = Calc.entryMinutes(entry);
    const durText = (entry.start && entry.end)
      ? Calc.formatHours(minutes / 60, { compact: true })
      : (entry.start && !entry.end ? 'open' : '—');
    const durEl = UI.el('div', { class: 'entry-duration', text: durText });

    const actions = UI.el('div', { class: 'entry-actions' });
    const delBtn = UI.el('button', { class: 'btn btn-ghost', text: 'Delete' });
    delBtn.addEventListener('click', () => deleteEntry(dateKey, entry.id));
    actions.appendChild(delBtn);

    row.appendChild(typeSel);
    row.appendChild(startInput);
    row.appendChild(endInput);
    row.appendChild(durEl);
    row.appendChild(actions);

    // Optional meta row: project + tags. Only meaningful for work
    // segments; lunch rows get an explanatory placeholder so the
    // grid alignment stays consistent. Shown when the user has any
    // projects, or when this entry already carries a project/tags.
    const hasAnyProjects = activeProjects().length > 0
      || (App.state.projects || []).some((p) => p.id === Number(entry.projectId));
    const hasMeta = entry.projectId != null || (Array.isArray(entry.tags) && entry.tags.length);
    if (hasAnyProjects || hasMeta) {
      const meta = UI.el('div', { class: 'entry-meta' });
      if (entry.type === 'work') {
        const projectSel = UI.el('select', { class: 'entry-project' });
        populateProjectSelect(projectSel, entry.projectId != null ? String(entry.projectId) : '', {
          includeUntagged: true,
          untaggedLabel: '— Untagged —',
          includeArchived: false,
          keepArchivedId: entry.projectId
        });
        projectSel.addEventListener('change', () => {
          const val = projectSel.value;
          const patch = {};
          if (!val) patch.projectId = null;
          else {
            const n = Number(val);
            patch.projectId = Number.isFinite(n) ? n : null;
          }
          updateEntry(dateKey, entry.id, patch);
        });
        const tagsInput = UI.el('input', {
          type: 'text',
          class: 'entry-tags',
          placeholder: 'tags, comma-separated',
          maxlength: '200',
          value: Array.isArray(entry.tags) ? entry.tags.join(', ') : ''
        });
        tagsInput.addEventListener('change', () => {
          updateEntry(dateKey, entry.id, { tags: parseTagsInput(tagsInput.value) });
        });
        meta.appendChild(projectSel);
        meta.appendChild(tagsInput);
      } else {
        meta.appendChild(UI.el('span', {
          class: 'muted small',
          text: 'Lunch segments are not tagged.'
        }));
      }
      row.appendChild(meta);
    }

    if (errorMsg) row.title = errorMsg;
    return row;
  }

  function updateEntry(dateKey, entryId, patch) {
    const day = ensureDay(dateKey);
    const e = (day.entries || []).find(x => x.id === entryId);
    if (!e) return;
    // Normalise tags: accept array or comma-string.
    if ('tags' in patch) {
      if (typeof patch.tags === 'string') patch.tags = parseTagsInput(patch.tags);
      if (!Array.isArray(patch.tags) || patch.tags.length === 0) {
        delete e.tags;
        delete patch.tags;
      }
    }
    // A null projectId means "untagged" — drop the field entirely so
    // the JSON blob stays compact for the common case.
    if ('projectId' in patch && (patch.projectId == null || patch.projectId === '')) {
      delete e.projectId;
      delete patch.projectId;
    }
    Object.assign(e, patch);
    persistDay(dateKey);
    render();
  }

  function deleteEntry(dateKey, entryId) {
    const day = App.state.days[dateKey];
    if (!day) return;
    day.entries = (day.entries || []).filter(x => x.id !== entryId);
    pruneDay(dateKey);
    persistDay(dateKey);
    render();
  }

  function shiftDiary(delta) {
    const d = Calc.parseDateKey(App.diaryDate);
    App.diaryDate = Calc.toDateKey(Calc.addDays(d, delta));
    render();
  }

  /* =========================================================
     SUMMARY
     ========================================================= */
  function renderSummary(root) {
    const view = UI.cloneTemplate('tpl-summary');
    root.appendChild(view);

    const settings = App.state.settings;

    const weekPicker = view.querySelector('[data-week-picker]');
    weekPicker.value = Calc.isoWeekString(Calc.parseDateKey(App.weekPickerDate));
    weekPicker.addEventListener('change', () => {
      const parsed = Calc.parseIsoWeek(weekPicker.value);
      if (parsed) {
        App.weekPickerDate = Calc.toDateKey(parsed);
        render();
      }
    });
    view.querySelector('[data-action="prev-week"]').addEventListener('click', () => {
      const d = Calc.parseDateKey(App.weekPickerDate);
      App.weekPickerDate = Calc.toDateKey(Calc.addDays(d, -7));
      render();
    });
    view.querySelector('[data-action="next-week"]').addEventListener('click', () => {
      const d = Calc.parseDateKey(App.weekPickerDate);
      App.weekPickerDate = Calc.toDateKey(Calc.addDays(d, 7));
      render();
    });

    const ws = Calc.weekStart(Calc.parseDateKey(App.weekPickerDate), settings.weekStartDay);
    const week = Calc.computeWeek(ws, App.state.days, settings);

    const weekTableContainer = view.querySelector('[data-week-table]');
    weekTableContainer.appendChild(renderWeekTable(week));

    const weekProjectsEl = view.querySelector('[data-week-projects]');
    if (weekProjectsEl) {
      const fromKey = Calc.toDateKey(week.weekStart);
      const toKey = Calc.toDateKey(week.weekEnd);
      const breakdown = Calc.aggregateByProject(App.state.days, fromKey, toKey);
      weekProjectsEl.appendChild(renderProjectBreakdown('By project (this week)', breakdown));
    }

    const monthPicker = view.querySelector('[data-month-picker]');
    monthPicker.value = App.monthPicker;
    monthPicker.addEventListener('change', () => {
      if (monthPicker.value) {
        App.monthPicker = monthPicker.value;
        render();
      }
    });
    view.querySelector('[data-action="prev-month"]').addEventListener('click', () => shiftMonth(-1));
    view.querySelector('[data-action="next-month"]').addEventListener('click', () => shiftMonth(1));

    const [mYear, mMonth] = App.monthPicker.split('-').map(Number);
    const month = Calc.computeMonth(mYear, mMonth - 1, App.state.days, settings);

    const monthTable = view.querySelector('[data-month-table]');
    monthTable.appendChild(renderMonthTable(month));

    const monthChart = view.querySelector('[data-month-chart]');
    for (const w of month.weeks) {
      const label = UI.formatDateShort(w.weekStart);
      monthChart.appendChild(UI.chartRow(
        label,
        w.regularTotal,
        w.overtimeFilled,
        w.flexGain,
        settings.regularHoursPerDay * Calc.countWorkDays(settings) + w.target
      ));
    }
    monthChart.appendChild(UI.chartLegend());

    const monthProjectsEl = view.querySelector('[data-month-projects]');
    if (monthProjectsEl) {
      const monthFirst = new Date(mYear, mMonth - 1, 1);
      const monthLast = new Date(mYear, mMonth, 0);
      const breakdown = Calc.aggregateByProject(
        App.state.days,
        Calc.toDateKey(monthFirst),
        Calc.toDateKey(monthLast)
      );
      monthProjectsEl.appendChild(renderProjectBreakdown('By project (this month)', breakdown));
    }
  }

  // Render a table: project | hours | % of total | segments.
  // Untagged is always last; `tags` for each row feed a small chip
  // strip under the project name.
  function renderProjectBreakdown(title, rows) {
    const wrap = UI.el('div', { class: 'project-breakdown' });
    wrap.appendChild(UI.el('h3', { class: 'project-breakdown-title', text: title }));

    if (!rows.length) {
      wrap.appendChild(UI.el('div', {
        class: 'muted small',
        text: 'No work segments in this period.'
      }));
      return wrap;
    }

    const total = rows.reduce((n, r) => n + r.hours, 0) || 1;
    const table = UI.el('table', { class: 'data-table project-table' });
    const thead = UI.el('thead');
    thead.appendChild(rowEl('th', ['Project', 'Hours', 'Share', 'Segments']));
    table.appendChild(thead);

    const tbody = UI.el('tbody');
    // Sort so that untagged appears last, otherwise keep the hours-desc order.
    const sorted = rows.slice().sort((a, b) => {
      if (a.projectId === '' && b.projectId !== '') return 1;
      if (b.projectId === '' && a.projectId !== '') return -1;
      return b.hours - a.hours;
    });
    for (const r of sorted) {
      const p = r.projectId ? projectById(r.projectId) : null;
      const name = r.projectId === ''
        ? 'Untagged'
        : (p ? p.name : 'Project #' + r.projectId);
      const nameCell = UI.el('td');
      const nameLine = UI.el('div', { class: 'project-name-cell' });
      if (p && p.color) {
        nameLine.appendChild(UI.el('span', {
          class: 'project-swatch tiny',
          style: 'background:' + p.color
        }));
      }
      nameLine.appendChild(UI.el('span', { text: name }));
      if (p && p.archived) {
        nameLine.appendChild(UI.el('span', { class: 'muted small', text: '(archived)' }));
      }
      nameCell.appendChild(nameLine);
      if (r.tags.length) {
        const tagsStrip = UI.el('div', { class: 'project-tags' });
        for (const t of r.tags) {
          tagsStrip.appendChild(UI.el('span', { class: 'tag-chip', text: '#' + t }));
        }
        nameCell.appendChild(tagsStrip);
      }

      const tr = UI.el('tr');
      tr.appendChild(nameCell);
      tr.appendChild(UI.el('td', { text: Calc.formatHours(r.hours, { compact: true }) }));
      tr.appendChild(UI.el('td', { text: ((r.hours / total) * 100).toFixed(1) + '%' }));
      tr.appendChild(UI.el('td', { text: String(r.segmentCount) }));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const tfoot = UI.el('tfoot');
    tfoot.appendChild(rowEl('td', [
      'Total',
      Calc.formatHours(total, { compact: true }),
      '100%',
      String(rows.reduce((n, r) => n + r.segmentCount, 0))
    ]));
    table.appendChild(tfoot);

    wrap.appendChild(table);
    return wrap;
  }

  function shiftMonth(delta) {
    const [y, m] = App.monthPicker.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    App.monthPicker = d.getFullYear() + '-' + Calc.pad(d.getMonth() + 1);
    render();
  }

  function renderWeekTable(week) {
    const table = UI.el('table', { class: 'data-table' });
    const thead = UI.el('thead');
    thead.appendChild(rowEl('th', [
      'Day', 'Date', 'Worked', 'Regular', 'Outside', 'Overtime', 'Flex gain', 'Shortfall'
    ]));
    table.appendChild(thead);

    const tbody = UI.el('tbody');
    const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const d of week.days) {
      const c = d.computed;
      tbody.appendChild(rowEl('td', [
        weekdayNames[d.date.getDay()],
        d.dateKey,
        Calc.formatHours(c.workedHours, { compact: true }),
        Calc.formatHours(c.regular, { compact: true }),
        c.outsideHours > 0 ? Calc.formatHours(c.outsideHours, { compact: true }) : '—',
        Calc.formatHours(d.overtimeHours, { compact: true }),
        Calc.formatHours(d.flexGainHours, { compact: true }),
        c.shortfall > 0 ? Calc.formatHours(c.shortfall, { compact: true }) : '—'
      ]));
    }
    table.appendChild(tbody);

    const tfoot = UI.el('tfoot');
    tfoot.appendChild(rowEl('td', [
      'Total', '',
      Calc.formatHours(week.workedTotal, { compact: true }),
      Calc.formatHours(week.regularTotal, { compact: true }),
      Calc.formatHours(week.outsideTotal || 0, { compact: true }),
      Calc.formatHours(week.overtimeFilled, { compact: true }),
      Calc.formatHours(week.flexGain, { compact: true }),
      Calc.formatHours(week.shortfall, { compact: true })
    ]));
    table.appendChild(tfoot);
    return table;
  }

  function renderMonthTable(month) {
    const table = UI.el('table', { class: 'data-table' });
    const thead = UI.el('thead');
    thead.appendChild(rowEl('th', [
      'Week starting', 'Worked', 'Regular', 'Overtime', 'Flex net', 'In period'
    ]));
    table.appendChild(thead);

    const tbody = UI.el('tbody');
    for (const w of month.weeks) {
      tbody.appendChild(rowEl('td', [
        UI.formatDateShort(w.weekStart),
        Calc.formatHours(w.workedTotal, { compact: true }),
        Calc.formatHours(w.regularTotal, { compact: true }),
        Calc.formatHours(w.overtimeFilled, { compact: true }),
        Calc.formatHours(w.flexNet, { compact: true }),
        w.inPeriod ? 'yes' : '—'
      ]));
    }
    table.appendChild(tbody);

    const tfoot = UI.el('tfoot');
    tfoot.appendChild(rowEl('td', [
      'Totals',
      Calc.formatHours(month.totals.worked, { compact: true }),
      Calc.formatHours(month.totals.regular, { compact: true }),
      Calc.formatHours(month.totals.overtime, { compact: true }),
      Calc.formatHours(month.totals.flexNet, { compact: true }),
      ''
    ]));
    table.appendChild(tfoot);
    return table;
  }

  function rowEl(cellTag, values) {
    const tr = UI.el('tr');
    for (const v of values) tr.appendChild(UI.el(cellTag, { text: v }));
    return tr;
  }

  /* =========================================================
     SETTINGS
     ========================================================= */
  function renderSettings(root) {
    const view = UI.cloneTemplate('tpl-settings');
    root.appendChild(view);

    const form = view.querySelector('[data-settings-form]');
    const s = App.state.settings;

    form.elements['weekStartDay'].value = String(s.weekStartDay);
    form.elements['regularHoursPerDay'].value = s.regularHoursPerDay;
    form.elements['officeStart'].value = s.officeStart || '';
    form.elements['officeEnd'].value = s.officeEnd || '';
    form.elements['weeklyOvertimeTargetHours'].value = s.weeklyOvertimeTargetHours;
    form.elements['overtimePeriodStart'].value = s.overtimePeriodStart || '';
    form.elements['overtimePeriodWeeks'].value = s.overtimePeriodWeeks;
    form.elements['defaultLunchMinutes'].value = s.defaultLunchMinutes;
    form.elements['minLunchMinutes'].value = s.minLunchMinutes != null ? s.minLunchMinutes : 30;
    form.elements['lunchThresholdHours'].value = s.lunchThresholdHours != null ? s.lunchThresholdHours : 6;
    form.elements['flexOpeningBalance'].value = s.flexOpeningBalance || 0;
    form.elements['flexOpeningDate'].value = s.flexOpeningDate || '';

    const weekTargetsList = view.querySelector('[data-weekly-targets-list]');
    const initialOverrides = Array.isArray(s.weeklyOvertimeTargetsByWeek)
      ? s.weeklyOvertimeTargetsByWeek.slice()
      : [];

    function readWeekTargetDrafts() {
      if (!weekTargetsList) return [];
      const rows = weekTargetsList.querySelectorAll('[data-week-target-index]');
      const out = [];
      for (const input of rows) {
        const idx = parseInt(input.getAttribute('data-week-target-index'), 10);
        if (!Number.isFinite(idx) || idx < 0) continue;
        out[idx] = input.value;
      }
      return out;
    }

    function renderWeekTargetRows(seedValues) {
      if (!weekTargetsList) return;
      UI.clear(weekTargetsList);
      const weeks = Math.max(0, parseInt(form.elements['overtimePeriodWeeks'].value, 10) || 0);
      if (!weeks) {
        weekTargetsList.appendChild(UI.el('div', {
          class: 'muted small',
          text: 'Set overtime period length above to configure per-week targets.'
        }));
        return;
      }
      const startRaw = form.elements['overtimePeriodStart'].value;
      const hasStart = /^\d{4}-\d{2}-\d{2}$/.test(startRaw);
      const weekStartDay = parseInt(form.elements['weekStartDay'].value, 10) || 1;
      let startWeek = null;
      if (hasStart) {
        startWeek = Calc.weekStart(Calc.parseDateKey(startRaw), weekStartDay);
      }
      for (let i = 0; i < weeks; i++) {
        let label = 'Week ' + (i + 1);
        if (startWeek) {
          const d = Calc.addDays(startWeek, i * 7);
          label += ' (' + UI.formatDateShort(d) + ')';
        }
        const val = seedValues && seedValues[i] != null ? String(seedValues[i]) : '';
        weekTargetsList.appendChild(UI.el('label', {}, [
          UI.el('span', { text: label }),
          UI.el('input', {
            type: 'number',
            min: '0',
            max: '168',
            step: '0.25',
            value: val,
            'data-week-target-index': String(i)
          })
        ]));
      }
    }

    renderWeekTargetRows(initialOverrides);
    for (const name of ['overtimePeriodWeeks', 'overtimePeriodStart', 'weekStartDay']) {
      form.elements[name].addEventListener('change', () => {
        renderWeekTargetRows(readWeekTargetDrafts());
      });
    }

    populateProjectSelect(form.elements['defaultProjectId'], s.defaultProjectId || '', {
      includeUntagged: true,
      untaggedLabel: '— None (untagged) —'
    });

    const workDays = Calc.workDaysArray(s);
    for (const box of form.querySelectorAll('[data-work-day]')) {
      const dow = parseInt(box.getAttribute('data-work-day'), 10);
      box.checked = !!workDays[dow];
    }

    // The office-time inputs use the 24h widget (wireTime24 handles masking).
    UI.upgradeTime24Inputs(form);

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = form.elements;
      const officeStart = UI.normaliseTime24(f['officeStart'].value);
      const officeEnd = UI.normaliseTime24(f['officeEnd'].value);
      f['officeStart'].value = officeStart;
      f['officeEnd'].value = officeEnd;
      const wd = [false, false, false, false, false, false, false];
      for (const box of form.querySelectorAll('[data-work-day]')) {
        const dow = parseInt(box.getAttribute('data-work-day'), 10);
        if (dow >= 0 && dow < 7) wd[dow] = box.checked;
      }
      App.state.settings = {
        weekStartDay: parseInt(f['weekStartDay'].value, 10),
        regularHoursPerDay: parseFloat(f['regularHoursPerDay'].value) || 0,
        weeklyOvertimeTargetHours: parseFloat(f['weeklyOvertimeTargetHours'].value) || 0,
        weeklyOvertimeTargetsByWeek: (() => {
          const out = [];
          const weeks = parseInt(f['overtimePeriodWeeks'].value, 10) || 0;
          const drafts = readWeekTargetDrafts();
          for (let i = 0; i < weeks; i++) {
            const raw = drafts[i];
            if (raw == null || raw === '') {
              out[i] = null;
              continue;
            }
            const n = parseFloat(raw);
            out[i] = Number.isFinite(n) ? Math.max(0, n) : null;
          }
          while (out.length && out[out.length - 1] == null) out.pop();
          return out;
        })(),
        overtimePeriodStart: f['overtimePeriodStart'].value,
        overtimePeriodWeeks: parseInt(f['overtimePeriodWeeks'].value, 10) || 0,
        defaultLunchMinutes: parseInt(f['defaultLunchMinutes'].value, 10) || 0,
        minLunchMinutes: parseInt(f['minLunchMinutes'].value, 10) || 0,
        lunchThresholdHours: parseFloat(f['lunchThresholdHours'].value) || 0,
        flexOpeningBalance: parseFloat(f['flexOpeningBalance'].value) || 0,
        flexOpeningDate: f['flexOpeningDate'].value || '',
        officeStart: officeStart,
        officeEnd: officeEnd,
        workDays: wd,
        defaultProjectId: f['defaultProjectId'].value || ''
      };
      persistSettings();
      UI.toast('Settings saved', 'success');
      render();
    });

    view.querySelector('[data-action="export-json"]').addEventListener('click', () => {
      Storage.exportJson(App.state);
      UI.toast('Backup exported', 'success');
    });
    view.querySelector('[data-action="export-csv"]').addEventListener('click', () => {
      Storage.exportCsv(App.state);
      UI.toast('CSV exported', 'success');
    });
    const segCsvBtn = view.querySelector('[data-action="export-segments-csv"]');
    if (segCsvBtn) {
      segCsvBtn.addEventListener('click', () => {
        Storage.exportSegmentsCsv(App.state);
        UI.toast('Segments CSV exported', 'success');
      });
    }

    const importInput = view.querySelector('[data-import-file]');
    importInput.addEventListener('change', async () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;
      if (!UI.confirmDialog('This will REPLACE all current data with the imported file. Continue?')) {
        importInput.value = '';
        return;
      }
      try {
        const text = await file.text();
        const parsed = await Storage.importJson(text);
        App.state = parsed;
        UI.toast('Imported ' + Object.keys(parsed.days).length + ' days', 'success');
        render();
      } catch (err) {
        UI.toast('Import failed: ' + err.message, 'error');
      } finally {
        importInput.value = '';
      }
    });

    view.querySelector('[data-action="reset-all"]').addEventListener('click', async () => {
      if (!UI.confirmDialog('Delete ALL time-tracking data? This cannot be undone.')) return;
      try {
        await Storage.reset();
        App.state = Storage.emptyState();
        UI.toast('All data reset', 'info');
        render();
      } catch (err) {
        UI.toast('Reset failed: ' + err.message, 'error');
      }
    });

    setupProjectsUI(view);
    setupTokensUI(view);

    const pwdForm = view.querySelector('[data-password-form]');
    const pwdErr = view.querySelector('[data-password-error]');
    if (pwdForm) {
      pwdForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        pwdErr.textContent = '';
        const f = pwdForm.elements;
        if (f['newPassword'].value !== f['confirm'].value) {
          pwdErr.textContent = 'New passwords do not match.';
          return;
        }
        const submitBtn = pwdForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        try {
          await Storage.changePassword(f['currentPassword'].value, f['newPassword'].value);
          pwdForm.reset();
          UI.toast('Password changed', 'success');
        } catch (err) {
          pwdErr.textContent = prettifyError(err);
        } finally {
          submitBtn.disabled = false;
        }
      });
    }
  }

  /* =========================================================
     QUICK (phone-optimized clock-in/out view)
     ========================================================= */
  function renderQuick(root) {
    const view = UI.cloneTemplate('tpl-quick');
    root.appendChild(view);

    const statusEl = view.querySelector('[data-quick-status]');
    const textEl = view.querySelector('.quick-status-text');
    const subEl = view.querySelector('.quick-status-sub');
    const totalsEl = view.querySelector('[data-quick-totals]');
    const btnIn = view.querySelector('[data-quick-action="clock-in"]');
    const btnLunch = view.querySelector('[data-quick-action="lunch-toggle"]');
    const btnOut = view.querySelector('[data-quick-action="clock-out"]');
    const lunchLabel = view.querySelector('[data-quick-lunch-label]');
    const goSettings = view.querySelector('[data-action="go-settings"]');

    function applyStatus(s) {
      statusEl.classList.remove('state-off', 'state-working', 'state-lunch');
      statusEl.classList.add('state-' + s.state);
      if (s.state === 'working') {
        textEl.textContent = 'Clocked in';
        subEl.textContent = s.since ? 'since ' + s.since : '';
      } else if (s.state === 'lunch') {
        textEl.textContent = 'On lunch';
        subEl.textContent = s.since ? 'since ' + s.since : '';
      } else {
        textEl.textContent = 'Not clocked in';
        subEl.textContent = s.date || '';
      }

      UI.clear(totalsEl);
      if (s.today) {
        totalsEl.appendChild(UI.stat('Worked today', Calc.formatHours(s.today.workedHours || 0)));
        totalsEl.appendChild(UI.stat('Lunch today', Calc.formatHours(s.today.lunchHours || 0)));
      }

      btnIn.disabled = s.state !== 'off';
      btnOut.disabled = s.state !== 'working';
      btnLunch.disabled = s.state === 'off';
      lunchLabel.textContent = s.state === 'lunch' ? 'End lunch' : 'Start lunch';
    }

    async function refresh() {
      try {
        const s = await Storage.quickStatus();
        applyStatus(s);
      } catch (err) {
        textEl.textContent = 'Offline';
        subEl.textContent = prettifyError(err);
      }
    }

    async function doAction(action) {
      const button = view.querySelector('[data-quick-action="' + action + '"]');
      if (!button) return;
      button.disabled = true;
      try {
        const s = await Storage.quickAction(action);
        applyStatus(s);
        // Also refresh local state so the other views see the change
        // without a full reload.
        try { App.state = await Storage.load(); } catch (_) { /* ignore */ }
        UI.toast(action.replace('-', ' ') + ' ok', 'success');
      } catch (err) {
        UI.toast(prettifyError(err), 'error');
        await refresh();
      }
    }

    btnIn.addEventListener('click', () => doAction('clock-in'));
    btnOut.addEventListener('click', () => doAction('clock-out'));
    btnLunch.addEventListener('click', () => doAction('lunch-toggle'));

    if (goSettings) {
      goSettings.addEventListener('click', (ev) => {
        ev.preventDefault();
        setView('settings');
      });
    }

    refresh();

    // If this render was triggered by a `?action=...` URL (PWA shortcut),
    // fire that action automatically once.
    const params = new URLSearchParams(window.location.search);
    const auto = params.get('action');
    if (auto && ['clock-in', 'clock-out', 'lunch-toggle'].includes(auto)) {
      // Drop it from the URL so a refresh doesn't fire again.
      history.replaceState({}, '', window.location.pathname);
      setTimeout(() => doAction(auto), 50);
    }
  }

  /* =========================================================
     TOKENS (phone widget management, lives inside Settings)
     ========================================================= */
  function setupTokensUI(view) {
    const form = view.querySelector('[data-tokens-form]');
    const reveal = view.querySelector('[data-tokens-reveal]');
    const revealVal = view.querySelector('[data-tokens-reveal-value]');
    const revealVal2 = view.querySelector('[data-tokens-reveal-value2]');
    const revealVal3 = view.querySelector('[data-tokens-reveal-value3]');
    const tokensUrl = view.querySelector('[data-tokens-url]');
    const tokensUrl2 = view.querySelector('[data-tokens-url2]');
    const listEl = view.querySelector('[data-tokens-list]');
    const copyBtn = view.querySelector('[data-action="copy-token"]');
    if (!form || !listEl) return;

    const widgetUrl = window.location.origin + '/api/quick/clock-in';
    if (tokensUrl) tokensUrl.textContent = widgetUrl;
    if (tokensUrl2) tokensUrl2.textContent = widgetUrl;

    async function refreshList() {
      try {
        const tokens = await Storage.listTokens();
        UI.clear(listEl);
        if (!tokens.length) {
          listEl.appendChild(UI.el('div', {
            class: 'tokens-empty',
            text: 'No tokens yet. Create one above to set up a phone widget.'
          }));
          return;
        }
        for (const t of tokens) {
          const row = UI.el('div', { class: 'tokens-row' });
          const info = UI.el('div');
          info.appendChild(UI.el('div', { class: 'tokens-row-label', text: t.label || 'widget' }));
          const metaBits = [];
          if (t.created_at) metaBits.push('created ' + t.created_at);
          metaBits.push(t.last_used_at ? ('last used ' + t.last_used_at) : 'never used');
          info.appendChild(UI.el('div', {
            class: 'tokens-row-meta',
            text: metaBits.join(' · ')
          }));
          row.appendChild(info);
          const del = UI.el('button', { class: 'btn btn-ghost btn-sm', text: 'Revoke' });
          del.addEventListener('click', async () => {
            if (!UI.confirmDialog('Revoke this token? Any widget using it will stop working.')) return;
            try {
              await Storage.deleteToken(t.id);
              UI.toast('Token revoked', 'info');
              refreshList();
            } catch (err) {
              UI.toast('Revoke failed: ' + prettifyError(err), 'error');
            }
          });
          row.appendChild(del);
          listEl.appendChild(row);
        }
      } catch (err) {
        UI.clear(listEl);
        listEl.appendChild(UI.el('div', {
          class: 'tokens-empty',
          text: 'Could not load tokens: ' + prettifyError(err)
        }));
      }
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const label = (form.elements['label'].value || '').trim() || 'widget';
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const created = await Storage.createToken(label);
        form.reset();
        reveal.hidden = false;
        if (revealVal) revealVal.textContent = created.token;
        if (revealVal2) revealVal2.textContent = created.token;
        if (revealVal3) revealVal3.textContent = created.token;
        UI.toast('Token created — copy it now!', 'success');
        refreshList();
      } catch (err) {
        UI.toast('Create failed: ' + prettifyError(err), 'error');
      } finally {
        submitBtn.disabled = false;
      }
    });

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const val = revealVal && revealVal.textContent;
        if (!val) return;
        try {
          await navigator.clipboard.writeText(val);
          UI.toast('Copied to clipboard', 'success');
        } catch (_) {
          UI.toast('Could not copy — select and copy manually', 'error');
        }
      });
    }

    refreshList();
  }

  /* =========================================================
     INIT
     ========================================================= */
  function setupTabs() {
    for (const t of document.querySelectorAll('.tab')) {
      t.addEventListener('click', () => setView(t.dataset.view));
    }
  }

  function setupHotkeys() {
    document.addEventListener('keydown', (ev) => {
      if (ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (!App.ready || !App.user) return;
      const todayKey = Calc.toDateKey(new Date());
      const k = ev.key.toLowerCase();
      if (k === 'i') { clockIn(todayKey); }
      else if (k === 'o') { clockOut(todayKey); }
      else if (k === 'l') {
        const status = Calc.globalStatus(App.state.days, todayKey);
        if (status.state === 'working') lunchStart(status.openDateKey || todayKey);
        else if (status.state === 'lunch') lunchEnd(status.openDateKey || todayKey);
      }
      else if (k === '1') setView('dashboard');
      else if (k === '2') setView('diary');
      else if (k === '3') setView('summary');
      else if (k === '4') setView('quick');
      else if (k === '5') setView('settings');
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Only register on HTTPS or localhost — browsers block it otherwise.
    const ok = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!ok) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  function initialViewFromUrl() {
    // If the user opens /quick (or the PWA was launched with start_url
    // = /quick), jump straight to the Quick view after login.
    if (window.location.pathname === '/quick') return 'quick';
    return 'dashboard';
  }

  function setupLiveClock() {
    const node = document.getElementById('live-clock');
    if (!node) return;
    const tick = () => {
      const d = new Date();
      node.textContent = Calc.pad(d.getHours()) + ':' + Calc.pad(d.getMinutes()) + ':' + Calc.pad(d.getSeconds());
    };
    tick();
    setInterval(tick, 1000);
  }

  function setupLiveDashboardRefresh() {
    // Keep the dashboard totals moving while a work segment is open.
    setInterval(() => {
      if (!App.user || !App.ready) return;
      if (App.currentView !== 'dashboard') return;
      render();
    }, 30000);
  }

  function setupLiveElapsedTicker() {
    // Tick any "elapsed since HH:MM" displays every second. This lets the
    // dashboard show a continuously-running counter while clocked in or
    // on lunch, without a full re-render. Also nudges any rendered
    // timelines so their open-segment bar + "now" marker track the
    // wall clock without re-rendering the whole view.
    setInterval(() => {
      const nodes = document.querySelectorAll('[data-elapsed-ticker][data-elapsed-start]');
      const todayKey = Calc.toDateKey(new Date());
      for (const node of nodes) {
        const start = node.getAttribute('data-elapsed-start');
        const startDate = node.getAttribute('data-elapsed-start-date') || todayKey;
        if (start) node.textContent = formatElapsedSince(start, startDate, todayKey);
      }
      const now = new Date();
      const timelines = document.querySelectorAll('svg.day-timeline');
      for (const svg of timelines) {
        if (typeof svg.refreshNow === 'function') svg.refreshNow(now);
      }
    }, 1000);
  }

  function setupBeforeUnloadFlush() {
    // Durable flush on tab close / navigation away.
    //
    // `beforeunload` cannot reliably await async work and browsers may
    // drop in-flight fetches on navigation. `pagehide` + keepalive
    // fetch is the modern replacement: the browser allows in-flight
    // keepalive requests to finish even after the tab is gone. We
    // also fire on `visibilitychange: hidden` because on iOS Safari
    // (and when the page is put into bfcache) that is the last event
    // we're guaranteed to receive.
    const flush = () => {
      try { Storage.flushKeepalive(); } catch (_) { /* ignore */ }
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  Storage.setErrorHandler((err) => {
    UI.toast('Save failed: ' + err.message, 'error');
  });

  // If the server tells us we are no longer authenticated (e.g. the
  // session got revoked), drop to the login screen instead of looping
  // failed writes.
  Storage.setUnauthorizedHandler(() => {
    if (!App.user) return;
    App.user = null;
    App.ready = false;
    App.state = Storage.emptyState();
    App.currentView = 'dashboard';
    render();
    UI.toast('Session expired — please sign in again.', 'info');
  });

  function setupLogout() {
    const btn = document.getElementById('logout-btn');
    if (btn) btn.addEventListener('click', handleLogout);
  }

  async function init() {
    setupTabs();
    setupHotkeys();
    setupLiveClock();
    setupLiveDashboardRefresh();
    setupLiveElapsedTicker();
    setupBeforeUnloadFlush();
    setupLogout();
    registerServiceWorker();

    // When launched as a PWA directly into /quick, hide the chrome so
    // the Quick page is the whole app.
    if (window.matchMedia('(display-mode: standalone)').matches
        && window.location.pathname === '/quick') {
      document.body.classList.add('pwa-quick-only');
    }

    const cfg = await Storage.authConfig();
    App.allowRegistration = !!cfg.allowRegistration;

    try {
      const user = await Storage.whoami();
      if (!user) {
        render();
        return;
      }
      App.user = user;
      App.state = await Storage.load();
      App.ready = true;
      setView(initialViewFromUrl());
    } catch (err) {
      const root = document.getElementById('view-root');
      UI.clear(root);
      root.appendChild(UI.el('div', {
        class: 'card alert alert-danger',
        text: 'Could not reach the server: ' + prettifyError(err)
          + ' — make sure the backend is running.'
      }));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
