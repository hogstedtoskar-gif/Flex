/* app.js - View router, state, event wiring. */

(() => {
  const App = {
    state: Storage.load(),
    currentView: 'dashboard',
    diaryDate: Calc.toDateKey(new Date()),
    weekPickerDate: Calc.toDateKey(new Date()),
    monthPicker: (() => {
      const d = new Date();
      return d.getFullYear() + '-' + Calc.pad(d.getMonth() + 1);
    })()
  };

  function persist() {
    Storage.save(App.state);
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
    if (App.currentView === 'dashboard') renderDashboard(root);
    else if (App.currentView === 'diary') renderDiary(root);
    else if (App.currentView === 'summary') renderSummary(root);
    else if (App.currentView === 'settings') renderSettings(root);
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
    const status = Calc.currentStatus(day);

    view.querySelector('[data-today-date]').textContent = UI.formatDate(today);

    // Status row
    const statusEl = view.querySelector('[data-status]');
    statusEl.classList.add('status-' + status.state);
    let statusText = 'Not clocked in';
    if (status.state === 'working') {
      statusText = 'Working since ' + (status.openEntry.start || '?');
    } else if (status.state === 'lunch') {
      statusText = 'On lunch since ' + (status.openEntry.start || '?');
    } else if (status.lastEntry) {
      statusText = 'Last clock-out ' + (status.lastEntry.end || '?');
    }
    statusEl.appendChild(UI.el('span', { text: statusText }));
    statusEl.appendChild(UI.el('span', {
      class: 'muted',
      text: status.state === 'off' ? '—' : 'Now: ' + nowHM()
    }));

    // Action buttons
    const btnIn = view.querySelector('[data-action="clock-in"]');
    const btnOut = view.querySelector('[data-action="clock-out"]');
    const btnLunchStart = view.querySelector('[data-action="lunch-start"]');
    const btnLunchEnd = view.querySelector('[data-action="lunch-end"]');

    const canClockIn = status.state === 'off';
    const canClockOut = status.state === 'working';
    const canLunchStart = status.state === 'working';
    const canLunchEnd = status.state === 'lunch';

    btnIn.disabled = !canClockIn;
    btnOut.disabled = !canClockOut;
    btnLunchStart.disabled = !canLunchStart;
    btnLunchEnd.disabled = !canLunchEnd;

    btnIn.addEventListener('click', () => clockIn(todayKey));
    btnOut.addEventListener('click', () => clockOut(todayKey));
    btnLunchStart.addEventListener('click', () => lunchStart(todayKey));
    btnLunchEnd.addEventListener('click', () => lunchEnd(todayKey));

    // Today totals
    const c = Calc.computeDay(day, settings);
    const todayTotals = view.querySelector('[data-today-totals]');
    todayTotals.appendChild(UI.stat('Worked', Calc.formatHours(c.workedHours)));
    todayTotals.appendChild(UI.stat('Regular', Calc.formatHours(c.regular)));
    todayTotals.appendChild(UI.stat('Extra', Calc.formatHours(c.extra), c.extra > 0 ? 'overtime' : ''));
    todayTotals.appendChild(UI.stat('Lunch', Calc.formatHours(c.lunchHours)));

    // Week
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

    const weekProgress = view.querySelector('[data-week-progress]');
    if (week.inPeriod) {
      weekProgress.appendChild(UI.progressBar(
        'Weekly overtime filled',
        week.overtimeFilled,
        settings.weeklyOvertimeTargetHours
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
      settings.regularHoursPerDay * 5,
      'regular'
    ));

    // Overtime period
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

    // Flex balance
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

    // Manual entry form
    setupManualEntry(view);

    // Alerts
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

  function clockIn(dateKey) {
    const day = ensureDay(dateKey);
    const status = Calc.currentStatus(day);
    if (status.state !== 'off') {
      UI.toast('Already clocked in', 'error');
      return;
    }
    day.entries.push({
      id: Storage.uuid(),
      type: 'work',
      start: nowHM(),
      end: ''
    });
    persist();
    UI.toast('Clocked in', 'success');
    render();
  }

  function clockOut(dateKey) {
    const day = ensureDay(dateKey);
    const status = Calc.currentStatus(day);
    if (status.state !== 'working') {
      UI.toast('Not currently working', 'error');
      return;
    }
    status.openEntry.end = nowHM();
    persist();
    UI.toast('Clocked out', 'success');
    render();
  }

  function lunchStart(dateKey) {
    const day = ensureDay(dateKey);
    const status = Calc.currentStatus(day);
    if (status.state !== 'working') {
      UI.toast('You must be clocked in first', 'error');
      return;
    }
    const now = nowHM();
    status.openEntry.end = now;
    day.entries.push({
      id: Storage.uuid(),
      type: 'lunch',
      start: now,
      end: ''
    });
    persist();
    UI.toast('Lunch started', 'info');
    render();
  }

  function lunchEnd(dateKey) {
    const day = ensureDay(dateKey);
    const status = Calc.currentStatus(day);
    if (status.state !== 'lunch') {
      UI.toast('Not on lunch', 'error');
      return;
    }
    const now = nowHM();
    status.openEntry.end = now;
    day.entries.push({
      id: Storage.uuid(),
      type: 'work',
      start: now,
      end: ''
    });
    persist();
    UI.toast('Back to work', 'success');
    render();
  }

  function setupManualEntry(view) {
    const form = view.querySelector('[data-manual-form]');
    const errEl = view.querySelector('[data-manual-error]');
    if (!form) return;

    form.elements['date'].value = Calc.toDateKey(new Date());

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      errEl.textContent = '';

      const f = form.elements;
      const date = f['date'].value;
      const clockIn = f['clockIn'].value;
      const clockOut = f['clockOut'].value;
      const lunchStart = f['lunchStart'].value;
      const lunchEnd = f['lunchEnd'].value;
      const mode = f['mode'].value;

      if (!date || !clockIn || !clockOut) {
        errEl.textContent = 'Date, clock in and clock out are required.';
        return;
      }

      const inMin = Calc.parseHM(clockIn);
      const outMin = Calc.parseHM(clockOut);
      if (inMin == null || outMin == null || outMin <= inMin) {
        errEl.textContent = 'Clock out must be later than clock in on the same day.';
        return;
      }

      const hasLunch = lunchStart || lunchEnd;
      if (hasLunch && (!lunchStart || !lunchEnd)) {
        errEl.textContent = 'Provide both lunch start and lunch end, or leave both empty.';
        return;
      }

      const newSegments = [];
      if (hasLunch) {
        const ls = Calc.parseHM(lunchStart);
        const le = Calc.parseHM(lunchEnd);
        if (ls == null || le == null || le <= ls) {
          errEl.textContent = 'Lunch end must be later than lunch start.';
          return;
        }
        if (ls < inMin || le > outMin) {
          errEl.textContent = 'Lunch must fall within clock in and clock out.';
          return;
        }
        newSegments.push({ id: Storage.uuid(), type: 'work', start: clockIn, end: lunchStart });
        newSegments.push({ id: Storage.uuid(), type: 'lunch', start: lunchStart, end: lunchEnd });
        newSegments.push({ id: Storage.uuid(), type: 'work', start: lunchEnd, end: clockOut });
      } else {
        newSegments.push({ id: Storage.uuid(), type: 'work', start: clockIn, end: clockOut });
      }

      const day = ensureDay(date);
      if (mode === 'replace') {
        day.entries = newSegments;
      } else {
        day.entries = (day.entries || []).concat(newSegments);
      }

      // Validate result
      const { errors } = Calc.validateDay(day.entries);
      if (errors.length) {
        errEl.textContent = 'Saved, but the day has issues: ' + errors.map(e => e.message).join('; ');
      }

      persist();
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
    const c = Calc.computeDay(day, settings);

    const summaryEl = view.querySelector('[data-diary-summary]');
    summaryEl.appendChild(UI.stat('Worked', Calc.formatHours(c.workedHours)));
    summaryEl.appendChild(UI.stat('Regular', Calc.formatHours(c.regular)));
    summaryEl.appendChild(UI.stat('Extra', Calc.formatHours(c.extra), c.extra > 0 ? 'overtime' : ''));
    summaryEl.appendChild(UI.stat('Lunch', Calc.formatHours(c.lunchHours)));

    // Validation
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

    // Entries
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

    // Add
    view.querySelector('[data-action="add-entry"]').addEventListener('click', () => {
      const d = ensureDay(key);
      d.entries.push({ id: Storage.uuid(), type: 'work', start: '', end: '' });
      persist();
      render();
    });

    // Note
    const noteEl = view.querySelector('[data-diary-note]');
    noteEl.value = day.note || '';
    noteEl.addEventListener('change', () => {
      const d = ensureDay(key);
      d.note = noteEl.value;
      pruneDay(key);
      persist();
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

    const startInput = UI.el('input', { type: 'time', value: entry.start || '' });
    startInput.addEventListener('change', () => updateEntry(dateKey, entry.id, { start: startInput.value }));

    const endInput = UI.el('input', { type: 'time', value: entry.end || '' });
    endInput.addEventListener('change', () => updateEntry(dateKey, entry.id, { end: endInput.value }));

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

    if (errorMsg) {
      row.title = errorMsg;
    }
    return row;
  }

  function updateEntry(dateKey, entryId, patch) {
    const day = ensureDay(dateKey);
    const e = (day.entries || []).find(x => x.id === entryId);
    if (!e) return;
    Object.assign(e, patch);
    persist();
    render();
  }

  function deleteEntry(dateKey, entryId) {
    const day = App.state.days[dateKey];
    if (!day) return;
    day.entries = (day.entries || []).filter(x => x.id !== entryId);
    pruneDay(dateKey);
    persist();
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

    // Week controls
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

    // Month controls
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
        settings.regularHoursPerDay * 5 + settings.weeklyOvertimeTargetHours
      ));
    }
    monthChart.appendChild(UI.chartLegend());
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
      'Day', 'Date', 'Worked', 'Regular', 'Overtime', 'Flex gain', 'Shortfall'
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
    form.elements['weeklyOvertimeTargetHours'].value = s.weeklyOvertimeTargetHours;
    form.elements['overtimePeriodStart'].value = s.overtimePeriodStart || '';
    form.elements['overtimePeriodWeeks'].value = s.overtimePeriodWeeks;
    form.elements['defaultLunchMinutes'].value = s.defaultLunchMinutes;
    form.elements['flexOpeningBalance'].value = s.flexOpeningBalance || 0;
    form.elements['flexOpeningDate'].value = s.flexOpeningDate || '';

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = form.elements;
      App.state.settings = {
        weekStartDay: parseInt(f['weekStartDay'].value, 10),
        regularHoursPerDay: parseFloat(f['regularHoursPerDay'].value) || 0,
        weeklyOvertimeTargetHours: parseFloat(f['weeklyOvertimeTargetHours'].value) || 0,
        overtimePeriodStart: f['overtimePeriodStart'].value,
        overtimePeriodWeeks: parseInt(f['overtimePeriodWeeks'].value, 10) || 0,
        defaultLunchMinutes: parseInt(f['defaultLunchMinutes'].value, 10) || 0,
        flexOpeningBalance: parseFloat(f['flexOpeningBalance'].value) || 0,
        flexOpeningDate: f['flexOpeningDate'].value || ''
      };
      persist();
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
        const parsed = Storage.importJson(text);
        App.state = parsed;
        persist();
        UI.toast('Imported ' + Object.keys(parsed.days).length + ' days', 'success');
        render();
      } catch (err) {
        UI.toast('Import failed: ' + err.message, 'error');
      } finally {
        importInput.value = '';
      }
    });

    view.querySelector('[data-action="reset-all"]').addEventListener('click', () => {
      if (!UI.confirmDialog('Delete ALL time-tracking data? This cannot be undone.')) return;
      Storage.reset();
      App.state = Storage.emptyState();
      UI.toast('All data reset', 'info');
      render();
    });
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
      const todayKey = Calc.toDateKey(new Date());
      const k = ev.key.toLowerCase();
      if (k === 'i') { clockIn(todayKey); }
      else if (k === 'o') { clockOut(todayKey); }
      else if (k === 'l') {
        const status = Calc.currentStatus(App.state.days[todayKey]);
        if (status.state === 'working') lunchStart(todayKey);
        else if (status.state === 'lunch') lunchEnd(todayKey);
      }
      else if (k === '1') setView('dashboard');
      else if (k === '2') setView('diary');
      else if (k === '3') setView('summary');
      else if (k === '4') setView('settings');
    });
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

  function init() {
    setupTabs();
    setupHotkeys();
    setupLiveClock();
    setView('dashboard');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
