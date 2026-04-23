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

    // Overlap check across closed entries
    const closed = entries
      .filter(e => e.start && e.end && parseHM(e.start) != null && parseHM(e.end) != null)
      .map(e => ({ id: e.id, s: parseHM(e.start), eh: parseHM(e.end) }))
      .sort((a, b) => a.s - b.s);

    for (let i = 1; i < closed.length; i++) {
      if (closed[i].s < closed[i - 1].eh) {
        errors.push({
          id: closed[i].id,
          message: 'Overlaps with another segment'
        });
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
   *   shortfall, hasOpen, officeEnforced
   * }
   */
  function computeDay(day, settings) {
    const entries = (day && day.entries) || [];
    const window = officeWindow(settings);
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
    const regular = Math.min(inOfficeHours, daily);
    const extraInOffice = Math.max(0, inOfficeHours - daily);
    const extraOutside = outsideHours;
    const extra = extraInOffice + extraOutside;
    const shortfall = Math.max(0, daily - inOfficeHours);
    return {
      workedHours,
      workedHoursRaw,
      inOfficeHours,
      outsideHours,
      lunchHours,
      lunchDeduction,
      regular,
      extra,
      extraInOffice,
      extraOutside,
      shortfall,
      hasOpen,
      officeEnforced: !!window
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
      const c = computeDay(day, settings);
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
   */
  function currentStatus(day) {
    const entries = (day && day.entries) || [];
    if (!entries.length) return { state: 'off' };
    // Find the entry without end (the open one)
    const open = entries.find(e => e.start && !e.end);
    if (open) {
      return { state: open.type === 'lunch' ? 'lunch' : 'working', openEntry: open };
    }
    // Otherwise sort by start and look at last
    const sorted = entries.slice().sort((a, b) => (parseHM(a.start) || 0) - (parseHM(b.start) || 0));
    const last = sorted[sorted.length - 1];
    return { state: 'off', lastEntry: last };
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
    isoWeek,
    isoWeekString,
    parseIsoWeek
  };
})();
