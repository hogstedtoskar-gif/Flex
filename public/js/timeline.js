/* timeline.js — renders a compact SVG timeline for a single day.
 *
 * Usage:
 *   const svg = Timeline.render({
 *     entries: day.entries,            // array of { type, start, end, projectId?, tags? }
 *     settings,                        // for officeStart / officeEnd window
 *     projects,                        // array of { id, name, color, archived } — used for fill
 *     now: new Date(),                 // for dashed "now" line + open-segment live end
 *     showNow: true,                   // hide the now-marker on past days
 *     compact: false                   // slimmer variant for small surfaces
 *   });
 *
 * The returned <svg> element has a `refreshNow(date)` method bolted on
 * that updates only the open segment's width and the "now" marker
 * without rebuilding the rest of the DOM. That lets the dashboard's
 * elapsed-ticker keep the timeline alive at 1 Hz without thrashing.
 *
 * Design notes:
 *   - Minutes are linear along the X axis; the visible range always
 *     spans the widest of [earliest segment, latest segment, office
 *     window, 08:00–17:00 default]. Padded 15 min either side for
 *     breathing room.
 *   - Work segments get their project color if available, otherwise
 *     the CSS var --regular. Lunch is always dim/striped. Open
 *     segments get a subtle animated outline.
 *   - Tooltip is a plain <title> element — native, no JS required.
 */
(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function parseHM(hm) {
    if (typeof hm !== 'string') return null;
    const m = /^([01]\d|2[0-3]):[0-5]\d$/.exec(hm);
    if (!m) return null;
    return parseInt(hm.slice(0, 2), 10) * 60 + parseInt(hm.slice(3, 5), 10);
  }

  function fmtHM(mins) {
    const m = ((mins % (24 * 60)) + (24 * 60)) % (24 * 60);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return (h < 10 ? '0' + h : h) + ':' + (mm < 10 ? '0' + mm : mm);
  }

  function projectById(projects, id) {
    if (id == null || id === '') return null;
    const n = Number(id);
    return (projects || []).find((p) => Number(p.id) === n) || null;
  }

  function nowMinutes(nowDate) {
    const d = nowDate || new Date();
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  }

  function el(name, attrs, text) {
    const node = document.createElementNS(SVG_NS, name);
    if (attrs) for (const k in attrs) {
      if (attrs[k] != null) node.setAttribute(k, String(attrs[k]));
    }
    if (text != null) node.textContent = text;
    return node;
  }

  function resolveRange(entries, settings) {
    let lo = 8 * 60;
    let hi = 17 * 60;
    const ws = parseHM(settings && settings.officeStart);
    const we = parseHM(settings && settings.officeEnd);
    if (ws != null && we != null && we > ws) {
      lo = Math.min(lo, ws);
      hi = Math.max(hi, we);
    }
    for (const e of entries || []) {
      const s = parseHM(e.start);
      if (s != null) lo = Math.min(lo, s);
      const en = parseHM(e.end);
      if (en != null) {
        let endMin = en;
        if (s != null && en < s) endMin += 24 * 60; // overnight
        hi = Math.max(hi, endMin);
      }
    }
    lo = Math.max(0, lo - 15);
    hi = Math.min(48 * 60, hi + 15);
    if (hi <= lo) hi = lo + 60;
    return { lo, hi };
  }

  function render(opts) {
    opts = opts || {};
    const entries = (opts.entries || []).slice();
    const settings = opts.settings || {};
    const projects = opts.projects || [];
    const nowDate = opts.now || new Date();
    const showNow = opts.showNow !== false;
    const compact = !!opts.compact;

    const H = compact ? 40 : 56;
    const barTop = compact ? 14 : 20;
    const barH = compact ? 18 : 24;
    const padX = 8;

    const { lo, hi } = resolveRange(entries, settings);
    const span = Math.max(1, hi - lo);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('day-timeline');
    if (compact) svg.classList.add('compact');
    svg.setAttribute('viewBox', '0 0 1000 ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Timeline of work segments');

    function x(min) {
      return padX + ((min - lo) / span) * (1000 - 2 * padX);
    }

    // Office window shading — draw first so segments sit on top.
    const ws = parseHM(settings.officeStart);
    const we = parseHM(settings.officeEnd);
    if (ws != null && we != null && we > ws) {
      const office = el('rect', {
        class: 'timeline-office',
        x: x(ws), y: barTop,
        width: Math.max(0, x(we) - x(ws)),
        height: barH
      });
      svg.appendChild(office);
    }

    // Background bar — makes empty time visible.
    svg.appendChild(el('rect', {
      class: 'timeline-track',
      x: padX, y: barTop,
      width: 1000 - 2 * padX, height: barH
    }));

    // Hour ticks + labels every 2 hours, minor ticks every 1h.
    const firstHour = Math.ceil(lo / 60);
    const lastHour = Math.floor(hi / 60);
    for (let h = firstHour; h <= lastHour; h++) {
      const min = h * 60;
      const xp = x(min);
      const major = h % 2 === 0;
      svg.appendChild(el('line', {
        class: 'timeline-tick' + (major ? ' major' : ''),
        x1: xp, x2: xp,
        y1: barTop + barH,
        y2: barTop + barH + (major ? 5 : 3)
      }));
      if (major && !compact) {
        svg.appendChild(el('text', {
          class: 'timeline-tick-label',
          x: xp, y: barTop + barH + 16,
          'text-anchor': 'middle'
        }, fmtHM(min % (24 * 60))));
      }
    }

    // Segments.
    const openRects = [];
    for (const e of entries) {
      const s = parseHM(e.start);
      if (s == null) continue;
      let en = parseHM(e.end);
      let isOpen = false;
      if (en == null) {
        if (!e.end) {
          en = nowMinutes(nowDate);
          isOpen = true;
        } else continue;
      }
      if (en < s) en += 24 * 60; // overnight
      if (en <= s) continue;
      const rectX = x(s);
      const rectW = Math.max(1, x(en) - rectX);
      const isLunch = e.type === 'lunch';
      const p = !isLunch ? projectById(projects, e.projectId) : null;

      const rect = el('rect', {
        class: 'timeline-seg'
          + (isLunch ? ' lunch' : ' work')
          + (isOpen ? ' open' : '')
          + (p ? ' tinted' : ''),
        x: rectX, y: barTop,
        width: rectW, height: barH,
        rx: 3, ry: 3,
        'data-entry-id': e.id || '',
        'data-start': fmtHM(s)
      });
      if (p && p.color) rect.setAttribute('fill', p.color);

      const titleParts = [];
      titleParts.push((isLunch ? 'Lunch' : 'Work') + ' · ' + fmtHM(s) + '–' + fmtHM(en % (24 * 60)));
      const durMin = Math.round(en - s);
      titleParts.push((durMin / 60).toFixed(2) + ' h');
      if (p) titleParts.push('Project: ' + p.name + (p.archived ? ' (archived)' : ''));
      if (Array.isArray(e.tags) && e.tags.length) {
        titleParts.push('Tags: ' + e.tags.join(', '));
      }
      if (isOpen) titleParts.push('In progress');
      rect.appendChild(el('title', null, titleParts.join('\n')));
      svg.appendChild(rect);
      if (isOpen) openRects.push({ rect, startMin: s });
    }

    // "Now" marker — dashed vertical line.
    let nowLine = null;
    if (showNow) {
      const n = nowMinutes(nowDate);
      if (n >= lo && n <= hi) {
        nowLine = el('line', {
          class: 'timeline-now',
          x1: x(n), x2: x(n),
          y1: barTop - 3, y2: barTop + barH + 3
        });
        svg.appendChild(nowLine);
      }
    }

    // Empty-state hint when there are zero segments.
    if (!entries.length) {
      svg.appendChild(el('text', {
        class: 'timeline-empty',
        x: 500, y: barTop + barH / 2 + 4,
        'text-anchor': 'middle'
      }, 'No entries yet'));
    }

    // Live-update hook used by the dashboard ticker for open segments.
    svg.refreshNow = function refreshNow(date) {
      const nd = date || new Date();
      const n = nowMinutes(nd);
      for (const or of openRects) {
        const endMin = Math.max(or.startMin, n);
        const rectX = x(or.startMin);
        or.rect.setAttribute('width', String(Math.max(1, x(endMin) - rectX)));
      }
      if (nowLine && n >= lo && n <= hi) {
        nowLine.setAttribute('x1', String(x(n)));
        nowLine.setAttribute('x2', String(x(n)));
      }
    };

    return svg;
  }

  const api = { render, parseHM, fmtHM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Timeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
