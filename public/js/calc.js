/* calc.js - Pure time math functions. No DOM, no storage. */

const Calc = (() => {

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function toDateKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseDateKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function parseHM(hm) {
    if (!hm || typeof hm !== 'string') return null;
    const parts = hm.split(':');
    if (parts.length < 2) return null;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  }

  function formatHours(hours, opts = {}) {
    if (hours == null || Number.isNaN(hours)) return '—';
    const sign = hours < 0 ? '-' : '';
    const abs = Math.abs(hours);
    const totalMinutes = Math.round(abs * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (opts.compact) return sign + h + 'h' + (m ? ' ' + m + 'm' : '');
    return sign + h + 'h ' + pad(m) + 'm';
  }

  function minutesToHours(min) { return min / 60; }

  /**
   * Normalise settings.workDays into a length-7 boolean array indexed by
   * Date.getDay() (0=Sun..6=Sat). Falls back to Mon–Fri when the setting
   * is missing or malformed (same as the default).
   */
  function workDaysArray(settings) {
    const DEFAULT = [false, true, true, true, true, true, false];
    const src = settings && settings.workDays;
    if (!Array.isArray(src) || src.length !== 7) return DEFAULT.slice();
    return src.map((v) => !!v);
  }

  function countWorkDays(settings) {
    return workDaysArray(settings).reduce((n, v) => n + (v ? 1 : 0), 0);
  }

  function isWorkDay(date, settings) {
    if (!date) return true;
    return workDaysArray(settings)[date.getDay()];
  }

  /**
   * Compute duration for an entry. Handles open (missing end) entries as 0.
   * Supports overnight by wrap-around if end < start.
   */
  function entryMinutes(entry) {
    const s = parseHM(entry.start);
    const e = parseHM(entry.end);
    if (s == null || e == null) return 0;
    let diff = e - s;
    if (diff < 0) diff += 24 * 60;
    return diff;
  }

  /**
   * Parse the configured office-hours window. Returns null when no
   * valid window is set, meaning "treat all work as in-office" (the
   * pre-office-hours behavior, kept for backward compatibility).
   */
  function officeWindow(settings) {
    const s = parseHM(settings && settings.officeStart);
    const e = parseHM(settings && settings.officeEnd);
    if (s == null || e == null || e <= s) return null;
    return { start: s, end: e };
  }

  /**
   * Split a work entry into in-office vs outside-office minutes given
   * a window. Handles overnight wrap by checking today's window and
   * the next day's window.
   */
  function entryOfficeSplit(entry, window) {
    const total = entryMinutes(entry);
    if (!window || total === 0) {
      return { total, inOffice: total, outside: 0 };
    }
    const s = parseHM(entry.start);
    const e = parseHM(entry.end);
    if (s == null || e == null) return { total, inOffice: 0, outside: 0 };
    let segStart = s;
    let segEnd = e;
    if (segEnd < segStart) segEnd += 24 * 60;
    let inOffice = 0;
    for (const offset of [0, 24 * 60]) {
      const lo = Math.max(segStart, window.start + offset);
      const hi = Math.min(segEnd, window.end + offset);
      if (hi > lo) inOffice += hi - lo;
    }
    if (inOffice > total) inOffice = total; // numeric safety
    return { total, inOffice, outside: total - inOffice };
  }

  /**
   * Validate entries for a single day.
   * Returns { errors: [{ id, message }], warnings: [{ id?, message }] }.
   */
  function validateDay(entries) {
    const errors = [];
    const warnings = [];
    if (!entries || !entries.length) return { errors, warnings };

    // Check each entry
    for (const e of entries) {
      const s = parseHM(e.start);
      const eh = parseHM(e.end);
      if (e.start && s == null) errors.push({ id: e.id, message: 'Invalid start time' });
      if (e.end && eh == null) errors.push({ id: e.id, message: 'Invalid end time' });
      if (s != null && eh != null) {
        const diff = eh - s;
        if (diff <= 0) {
          // allow negative only if user really meant overnight; treat 0 as error
          if (diff === 0) errors.push({ id: e.id, message: 'Zero duration' });
        }
      }
      if (!e.start) errors.push({ id: e.id, message: 'Missing start time' });
    }

    // Open segments (missing end)
    const openCount = entries.filter(e => e.start && !e.end).length;
    if (openCount > 1) {
      errors.push({ message: 'Multiple open segments (missing end time)' });
    }

    // Overlap check across closed entries.
    //
    // Consistent with entryMinutes(): when `end < start` we assume the
    // segment wraps past midnight and extend its end by +24h. For
    // subsequent segments that start *before* the first segment began
    // (again in wall-clock order) we project them onto the same +24h
    // axis so they compare correctly with the wrapped segment.
    const closedRaw = entries
      .filter(e => e.start && e.end && parseHM(e.start) != null && parseHM(e.end) != null);
    if (closedRaw.length > 1) {
      const firstStart = Math.min(...closedRaw.map(e => parseHM(e.start)));
      const closed = closedRaw.map(e => {
        let s = parseHM(e.start);
        let eh = parseHM(e.end);
        if (eh < s) eh += 24 * 60;
        // If the whole segment looks earlier than the earliest start,
        // assume it belongs to the "next day" half of the axis.
        if (s < firstStart && eh <= firstStart) {
          s += 24 * 60;
          eh += 24 * 60;
        }
        return { id: e.id, s, eh };
      }).sort((a, b) => a.s - b.s);

      for (let i = 1; i < closed.length; i++) {
        if (closed[i].s < closed[i - 1].eh) {
          errors.push({
            id: closed[i].id,
            message: 'Overlaps with another segment'
          });
        }
      }
    }

    return { errors, warnings };
  }

  /**
   * Compute totals for a single day.
   *
   * When an office window is configured, regular hours and flex can
   * only be earned inside it; outside-hours work is overtime-eligible
   * only (and is discarded if the weekly overtime target is already
   * full — see computeWeek).
   *
   * Returns: {
   *   workedHours, inOfficeHours, outsideHours, lunchHours,
   *   regular, extra, extraInOffice, extraOutside,
   *   shortfall, hasOpen, officeEnforced, isWorkDay
   * }
   *
   * `date` is optional but strongly recommended: it lets the function
   * apply the per-weekday `settings.workDays` rule (non-work days never
   * earn regular hours or create shortfall, and all worked time is
   * re-bucketed to `extraOutside` so it can only fill the overtime
   * target — never become flex).
   */
  function computeDay(day, settings, date) {
    const entries = (day && day.entries) || [];
    const window = officeWindow(settings);
    const workDay = isWorkDay(date, settings);
    // Days with zero recorded entries are treated as "not tracked", not
    // as "you owe the full daily target". This keeps weekends, holidays,
    // vacation, sick days, and future days from dragging the weekly
    // flexNet and the all-time flex balance into a big negative.
    // Days that ARE recorded but fall short of the target still count
    // (shortfall is real in that case).
    if (entries.length === 0) {
      return {
        workedHours: 0, workedHoursRaw: 0,
        inOfficeHours: 0, outsideHours: 0,
        lunchHours: 0, lunchDeduction: 0,
        regular: 0, extra: 0, extraInOffice: 0, extraOutside: 0,
        shortfall: 0, hasOpen: false,
        officeEnforced: !!window,
        isWorkDay: workDay
      };
    }
    let workedMin = 0;
    let inOfficeMin = 0;
    let lunchMin = 0;
    let hasOpen = false;
    for (const e of entries) {
      if (!e.start) continue;
      if (!e.end) { hasOpen = true; continue; }
      if (e.type === 'work') {
        const split = entryOfficeSplit(e, window);
        workedMin += split.total;
        inOfficeMin += split.inOffice;
      } else if (e.type === 'lunch') {
        lunchMin += entryMinutes(e);
      }
    }
    const workedHoursRaw = minutesToHours(workedMin);
    const inOfficeHoursRaw = minutesToHours(inOfficeMin);
    const outsideHoursRaw = Math.max(0, workedHoursRaw - inOfficeHoursRaw);
    const lunchHours = minutesToHours(lunchMin);

    // Auto-deduct: when the day's worked time exceeds the threshold and
    // the recorded lunch is shorter than the configured minimum, take
    // the shortfall out of worked time (in-office first, outside only
    // if nothing else is left). Configure via minLunchMinutes (0 = off)
    // and lunchThresholdHours.
    const minLunchHours = Math.max(0, (settings.minLunchMinutes || 0) / 60);
    const lunchThreshold = Number.isFinite(settings.lunchThresholdHours)
      ? settings.lunchThresholdHours
      : 6;
    let lunchDeduction = 0;
    if (minLunchHours > 0 && workedHoursRaw > lunchThreshold && lunchHours < minLunchHours) {
      lunchDeduction = minLunchHours - lunchHours;
    }
    let inOfficeHours = inOfficeHoursRaw;
    let outsideHours = outsideHoursRaw;
    if (lunchDeduction > 0) {
      const fromInOffice = Math.min(lunchDeduction, inOfficeHours);
      inOfficeHours -= fromInOffice;
      const remaining = lunchDeduction - fromInOffice;
      if (remaining > 0) {
        outsideHours = Math.max(0, outsideHours - remaining);
      }
    }
    const workedHours = inOfficeHours + outsideHours;

    const daily = settings.regularHoursPerDay;
    let regular, extraInOffice, extraOutside, shortfall, reportedInOffice, reportedOutside;
    if (workDay) {
      regular = Math.min(inOfficeHours, daily);
      extraInOffice = Math.max(0, inOfficeHours - daily);
      extraOutside = outsideHours;
      shortfall = Math.max(0, daily - inOfficeHours);
      reportedInOffice = inOfficeHours;
      reportedOutside = outsideHours;
    } else {
      // Non-work day (e.g. weekend by default): worked time never
      // becomes regular or flex, and never creates shortfall. All
      // worked time is routed to extraOutside so it can only fill
      // the weekly overtime target; any leftover is discarded
      // (same treatment as "outside office hours" on a workday).
      regular = 0;
      extraInOffice = 0;
      extraOutside = workedHours;
      shortfall = 0;
      // Surface all hours as "outside" in the per-day stats too,
      // so the Diary view consistently labels weekend work as
      // overtime-only rather than as regular office time.
      reportedInOffice = 0;
      reportedOutside = workedHours;
    }
    const extra = extraInOffice + extraOutside;
    return {
      workedHours,
      workedHoursRaw,
      inOfficeHours: reportedInOffice,
      outsideHours: reportedOutside,
      lunchHours,
      lunchDeduction,
      regular,
      extra,
      extraInOffice,
      extraOutside,
      shortfall,
      hasOpen,
      officeEnforced: !!window,
      isWorkDay: workDay
    };
  }

  /**
   * Get the Date corresponding to the start of the week containing `date`.
   * weekStartDay: 0=Sun, 1=Mon, 6=Sat.
   */
  function weekStart(date, weekStartDay) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dow = d.getDay();
    const diff = (dow - weekStartDay + 7) % 7;
    d.setDate(d.getDate() - diff);
    return d;
  }

  function weekEnd(date, weekStartDay) {
    const s = weekStart(date, weekStartDay);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    return e;
  }

  function addDays(date, n) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + n);
    return d;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  /**
   * Determine which overtime period week index a given date belongs to (0-based).
   * Returns -1 if outside period.
   */
  function periodWeekIndex(date, settings) {
    if (!settings.overtimePeriodStart || !settings.overtimePeriodWeeks) return -1;
    const startDate = parseDateKey(settings.overtimePeriodStart);
    const periodStart = weekStart(startDate, settings.weekStartDay);
    const targetWeekStart = weekStart(date, settings.weekStartDay);
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const idx = Math.round((targetWeekStart - periodStart) / msPerWeek);
    if (idx < 0 || idx >= settings.overtimePeriodWeeks) return -1;
    return idx;
  }

  /**
   * Compute a full week's allocation. Walks days in order.
   *
   * Allocation rules (see README for the long version):
   *   - Inside the overtime period, outside-office extras fill the
   *     weekly overtime target FIRST (they cannot become flex, so it's
   *     use-it-or-lose-it). Then in-office extras fill the remainder.
   *     Any leftover in-office extras become flex gain. Any leftover
   *     outside extras are counted as `outsideUnusedHours` (lost).
   *   - Outside the overtime period, only in-office extras become
   *     flex; outside extras are always lost.
   */
  function computeWeek(weekStartDate, daysMap, settings) {
    const inPeriod = periodWeekIndex(weekStartDate, settings) !== -1;
    const target = settings.weeklyOvertimeTargetHours;

    const days = [];
    let overtimeFilled = 0;
    let flexGain = 0;
    let shortfall = 0;
    let regularTotal = 0;
    let workedTotal = 0;
    let outsideUnusedTotal = 0;
    let inOfficeTotal = 0;
    let outsideTotal = 0;

    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStartDate, i);
      const key = toDateKey(d);
      const day = daysMap[key];
      const c = computeDay(day, settings, d);
      let toOvertime = 0;
      let toFlex = 0;
      let outsideUnused = 0;

      if (inPeriod) {
        let remaining = Math.max(0, target - overtimeFilled);
        // Outside-hours extras: fill overtime first, remainder is lost.
        const otFromOutside = Math.min(remaining, c.extraOutside);
        remaining -= otFromOutside;
        outsideUnused = c.extraOutside - otFromOutside;
        // In-office extras: fill overtime, remainder becomes flex.
        const otFromOffice = Math.min(remaining, c.extraInOffice);
        toOvertime = otFromOutside + otFromOffice;
        toFlex = c.extraInOffice - otFromOffice;
      } else {
        // No overtime bucket active this week.
        toOvertime = 0;
        toFlex = c.extraInOffice;
        outsideUnused = c.extraOutside;
      }

      overtimeFilled += toOvertime;
      flexGain += toFlex;
      outsideUnusedTotal += outsideUnused;
      shortfall += c.shortfall;
      regularTotal += c.regular;
      workedTotal += c.workedHours;
      inOfficeTotal += c.inOfficeHours;
      outsideTotal += c.outsideHours;

      days.push({
        date: d,
        dateKey: key,
        day,
        computed: c,
        overtimeHours: toOvertime,
        flexGainHours: toFlex,
        outsideUnusedHours: outsideUnused
      });
    }

    return {
      weekStart: weekStartDate,
      weekEnd: addDays(weekStartDate, 6),
      inPeriod,
      target,
      overtimeFilled,
      flexGain,
      outsideUnused: outsideUnusedTotal,
      inOfficeTotal,
      outsideTotal,
      shortfall,
      flexNet: flexGain - shortfall,
      regularTotal,
      workedTotal,
      days
    };
  }

  /**
   * Compute cumulative flex balance up to and including `upToDate`.
   *
   * Semantics:
   *   - `flexOpeningBalance` is your flex at the START of `flexOpeningDate`
   *     (so set the date to the first day you started tracking here; the
   *     balance from your previous tool goes in the opening field).
   *   - From `flexOpeningDate` onwards, each day that has at least one
   *     recorded entry contributes `flexGain - shortfall` on top.
   *   - Days with no entries at all never contribute (treated as not-tracked,
   *     not as "you owe the full daily target"). This prevents weekends,
   *     holidays, and future days from silently sinking the balance.
   *   - If `flexOpeningDate` is blank, every recorded day contributes.
   *
   * Overtime allocation is still week-scoped (runs across all 7 days in a
   * week); we just filter which days' flex contributions get *summed*.
   */
  function computeFlexBalance(daysMap, settings, upToDate) {
    const opening = parseFloat(settings.flexOpeningBalance) || 0;
    const keys = Object.keys(daysMap).sort();
    if (!keys.length) return opening;

    const firstDate = parseDateKey(keys[0]);
    const lastDate = upToDate || parseDateKey(keys[keys.length - 1]);
    let cursor = weekStart(firstDate, settings.weekStartDay);
    const limit = weekEnd(lastDate, settings.weekStartDay);

    const openingCutoff = settings.flexOpeningDate
      ? parseDateKey(settings.flexOpeningDate)
      : null;

    let total = opening;
    for (let i = 0; i < 520 && cursor <= limit; i++) {
      const weekFinish = addDays(cursor, 6);
      // Entire week is strictly before the opening date -> already baked
      // into the opening balance, skip it.
      if (openingCutoff && weekFinish < openingCutoff) {
        cursor = addDays(cursor, 7);
        continue;
      }
      const w = computeWeek(cursor, daysMap, settings);
      for (const d of w.days) {
        if (openingCutoff && d.date < openingCutoff) continue;
        if (d.date > lastDate) continue;
        const hasEntries = !!(d.day && d.day.entries && d.day.entries.length);
        if (!hasEntries) continue;
        total += d.flexGainHours - d.computed.shortfall;
      }
      cursor = addDays(cursor, 7);
    }
    return total;
  }

  /**
   * Compute overtime period summary: per-week filled, total filled, total required.
   */
  function computeOvertimePeriod(daysMap, settings) {
    const result = {
      totalRequired: settings.weeklyOvertimeTargetHours * settings.overtimePeriodWeeks,
      totalFilled: 0,
      weeks: []
    };
    if (!settings.overtimePeriodStart || !settings.overtimePeriodWeeks) return result;
    const startDate = parseDateKey(settings.overtimePeriodStart);
    let cursor = weekStart(startDate, settings.weekStartDay);
    for (let i = 0; i < settings.overtimePeriodWeeks; i++) {
      const w = computeWeek(cursor, daysMap, settings);
      result.weeks.push({
        index: i,
        weekStart: new Date(cursor),
        filled: w.overtimeFilled,
        target: settings.weeklyOvertimeTargetHours
      });
      result.totalFilled += w.overtimeFilled;
      cursor = addDays(cursor, 7);
    }
    return result;
  }

  /**
   * Compute monthly rows (one per week) for a given month.
   */
  function computeMonth(year, month, daysMap, settings) {
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const firstWeekStart = weekStart(first, settings.weekStartDay);
    const lastWeekStart = weekStart(last, settings.weekStartDay);
    const weeks = [];
    let cursor = new Date(firstWeekStart);
    const totals = { regular: 0, overtime: 0, flexNet: 0, worked: 0 };
    while (cursor <= lastWeekStart) {
      const w = computeWeek(cursor, daysMap, settings);
      weeks.push(w);
      totals.regular += w.regularTotal;
      totals.overtime += w.overtimeFilled;
      totals.flexNet += w.flexNet;
      totals.worked += w.workedTotal;
      cursor = addDays(cursor, 7);
    }
    return { year, month, weeks, totals };
  }

  /**
   * Current "state" of today based on last entry.
   * Returns 'off' | 'working' | 'lunch'.
   *
   * Thin wrapper around FSM.currentStatus that also reports the full
   * lastEntry for UI code that wants to render "Last clock-out at X".
   */
  function currentStatus(day) {
    const entries = (day && day.entries) || [];
    if (!entries.length) return { state: 'off' };
    const open = entries.find(e => e.start && !e.end);
    if (open) {
      return { state: open.type === 'lunch' ? 'lunch' : 'working', openEntry: open };
    }
    const sorted = entries.slice().sort((a, b) => (parseHM(a.start) || 0) - (parseHM(b.start) || 0));
    const last = sorted[sorted.length - 1];
    return { state: 'off', lastEntry: last };
  }

  /**
   * Find the earliest-dated open segment in a daysMap. Delegates to
   * FSM.findOpenAcrossDays when the shared module is loaded; falls
   * back to a local implementation for environments where FSM isn't
   * available (e.g. unit tests loading calc.js in isolation).
   */
  function findOpenAcrossDays(daysMap) {
    if (typeof FSM !== 'undefined' && FSM.findOpenAcrossDays) {
      return FSM.findOpenAcrossDays(daysMap);
    }
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

  /**
   * Global status across ALL recorded days. Unlike currentStatus(day),
   * this also finds an open segment that belongs to a previous day
   * (e.g. you clocked in yesterday and forgot to clock out).
   *
   * Returns:
   *   { state: 'off',     today, lastEntry? }
   *   { state: 'working', today, openEntry, openDateKey }
   *   { state: 'lunch',   today, openEntry, openDateKey }
   */
  function globalStatus(daysMap, todayKey) {
    const today = (daysMap && todayKey && daysMap[todayKey]) || { entries: [] };
    const open = findOpenAcrossDays(daysMap);
    if (open) {
      const type = open.entry.type === 'lunch' ? 'lunch' : 'working';
      return {
        state: type,
        today,
        openEntry: open.entry,
        openDateKey: open.dateKey
      };
    }
    // No open segment anywhere — fall back to today-only status so that
    // "last clock-out today" still shows up nicely.
    const t = currentStatus(today);
    return { ...t, today, openDateKey: null };
  }

  /**
   * ISO week number for a given date.
   */
  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return { year: d.getUTCFullYear(), week };
  }

  function isoWeekString(date) {
    const { year, week } = isoWeek(date);
    return year + '-W' + pad(week);
  }

  /**
   * Aggregate total worked minutes per project across a set of days.
   *
   * Segments without a `projectId` are bucketed under `''` (meaning
   * "untagged"). Lunch segments are ignored — tags apply to work
   * only.
   *
   * Returns a sorted array: [{ projectId, hours, segmentCount, tags: Set }]
   * with `projectId === ''` representing untagged, sorted by hours desc.
   */
  function aggregateByProject(daysMap, fromKey, toKey) {
    const buckets = new Map();
    const keys = Object.keys(daysMap || {}).sort();
    for (const key of keys) {
      if (fromKey && key < fromKey) continue;
      if (toKey && key > toKey) continue;
      const day = daysMap[key];
      const entries = (day && day.entries) || [];
      for (const e of entries) {
        if (e.type !== 'work') continue;
        if (!e.start || !e.end) continue;
        const mins = entryMinutes(e);
        if (!mins) continue;
        const pid = e.projectId != null ? String(e.projectId) : '';
        if (!buckets.has(pid)) {
          buckets.set(pid, { projectId: pid, minutes: 0, segmentCount: 0, tags: new Set() });
        }
        const b = buckets.get(pid);
        b.minutes += mins;
        b.segmentCount++;
        if (Array.isArray(e.tags)) for (const t of e.tags) b.tags.add(t);
      }
    }
    return Array.from(buckets.values())
      .map((b) => ({
        projectId: b.projectId,
        hours: b.minutes / 60,
        segmentCount: b.segmentCount,
        tags: Array.from(b.tags).sort()
      }))
      .sort((a, b) => b.hours - a.hours);
  }

  function parseIsoWeek(str) {
    // "YYYY-Www"
    const m = /^(\d{4})-W(\d{2})$/.exec(str);
    if (!m) return null;
    const year = parseInt(m[1], 10);
    const week = parseInt(m[2], 10);
    // ISO week 1: week containing Jan 4
    const jan4 = new Date(year, 0, 4);
    const jan4Day = jan4.getDay() || 7;
    const week1Start = new Date(year, 0, 4 - (jan4Day - 1));
    const result = new Date(week1Start);
    result.setDate(result.getDate() + (week - 1) * 7);
    return result; // Monday of that ISO week
  }

  return {
    pad,
    toDateKey,
    parseDateKey,
    parseHM,
    formatHours,
    entryMinutes,
    officeWindow,
    entryOfficeSplit,
    validateDay,
    computeDay,
    workDaysArray,
    countWorkDays,
    isWorkDay,
    weekStart,
    weekEnd,
    addDays,
    sameDay,
    periodWeekIndex,
    computeWeek,
    computeFlexBalance,
    computeOvertimePeriod,
    computeMonth,
    currentStatus,
    findOpenAcrossDays,
    globalStatus,
    isoWeek,
    isoWeekString,
    parseIsoWeek,
    aggregateByProject
  };
})();
