/* ui.js - DOM helpers, toasts, chart rendering. */

const UI = (() => {

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v !== null && v !== undefined && v !== false) {
        node.setAttribute(k, v === true ? '' : v);
      }
    }
    const kids = Array.isArray(children) ? children : [children];
    for (const c of kids) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function cloneTemplate(id) {
    const tpl = document.getElementById(id);
    return tpl.content.firstElementChild.cloneNode(true);
  }

  let toastCounter = 0;
  function toast(message, kind = 'info', timeout = 2800) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const node = el('div', { class: 'toast toast-' + kind, text: message });
    root.appendChild(node);
    const id = ++toastCounter;
    node.dataset.id = id;
    setTimeout(() => {
      node.style.transition = 'opacity 0.2s';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 220);
    }, timeout);
  }

  function stat(label, value, cls) {
    const v = el('div', { class: 'stat-value' + (cls ? ' ' + cls : ''), text: value });
    return el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label', text: label }),
      v
    ]);
  }

  function progressBar(label, current, target, cls) {
    const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
    return el('div', { class: 'progress' }, [
      el('div', { class: 'progress-label' }, [
        el('span', { text: label }),
        el('span', { text: Calc.formatHours(current) + ' / ' + Calc.formatHours(target) })
      ]),
      el('div', { class: 'progress-bar' }, [
        el('div', {
          class: 'progress-fill' + (cls ? ' ' + cls : ''),
          style: 'width:' + pct.toFixed(1) + '%'
        })
      ])
    ]);
  }

  function chartRow(label, regular, overtime, flex, totalDenominator) {
    const total = Math.max(totalDenominator, regular + overtime + Math.max(0, flex));
    const regPct = total > 0 ? (regular / total) * 100 : 0;
    const otPct = total > 0 ? (overtime / total) * 100 : 0;
    const flexPct = total > 0 ? (Math.max(0, flex) / total) * 100 : 0;
    const bar = el('div', { class: 'chart-bar' }, [
      el('div', { class: 'chart-seg chart-seg-regular', style: 'width:' + regPct.toFixed(1) + '%' }),
      el('div', { class: 'chart-seg chart-seg-overtime', style: 'width:' + otPct.toFixed(1) + '%' }),
      el('div', { class: 'chart-seg chart-seg-flex', style: 'width:' + flexPct.toFixed(1) + '%' })
    ]);
    const legend = el('span', {
      text: Calc.formatHours(regular, { compact: true })
        + ' + ' + Calc.formatHours(overtime, { compact: true }) + ' OT'
        + (flex !== 0 ? ' / ' + Calc.formatHours(flex, { compact: true }) + ' flex' : '')
    });
    return el('div', { class: 'chart-row' }, [
      el('span', { text: label }),
      bar,
      legend
    ]);
  }

  function chartLegend() {
    return el('div', { class: 'chart-legend' }, [
      el('span', {}, [el('span', { class: 'chart-swatch', style: 'background:var(--regular)' }), 'Regular']),
      el('span', {}, [el('span', { class: 'chart-swatch', style: 'background:var(--overtime)' }), 'Overtime']),
      el('span', {}, [el('span', { class: 'chart-swatch', style: 'background:var(--flex-pos)' }), 'Flex gain'])
    ]);
  }

  function confirmDialog(message) {
    return window.confirm(message);
  }

  function formatDate(date) {
    return date.toLocaleDateString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
    });
  }

  function formatDateShort(date) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatRange(a, b) {
    return formatDateShort(a) + ' – ' + formatDateShort(b);
  }

  // --- 24h time input ----------------------------------------------------
  // Native <input type="time"> follows the OS locale in Chromium, so it
  // can force AM/PM on en-US machines regardless of the page's lang. To
  // guarantee 24h across every browser/OS we use a text input with a
  // digit mask and coerce the value to strict HH:MM on blur.

  const TIME24_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  // Loosely normalise "H:MM" / "HHMM" / "H.MM" etc. into "HH:MM" (24h).
  // Returns '' when the input can't be coerced.
  function normaliseTime24(raw) {
    if (raw == null) return '';
    let s = String(raw).trim();
    if (!s) return '';
    // Accept "HHMM" without a separator.
    if (/^\d{3,4}$/.test(s)) {
      s = s.length === 3
        ? s.slice(0, 1) + ':' + s.slice(1)
        : s.slice(0, 2) + ':' + s.slice(2);
    }
    // Accept "." or space as separator.
    s = s.replace(/[.\s]/g, ':');
    const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return '';
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (Number.isNaN(h) || Number.isNaN(min)) return '';
    if (h < 0 || h > 23 || min < 0 || min > 59) return '';
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return pad(h) + ':' + pad(min);
  }

  // Wire a single text input for 24h entry. Safe to call multiple times
  // on the same node — it tags itself and no-ops on the second pass.
  function wireTime24(input) {
    if (!input || input.dataset.time24Wired === '1') return;
    input.dataset.time24Wired = '1';

    input.type = 'text';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('maxlength', '5');
    input.setAttribute('placeholder', input.getAttribute('placeholder') || 'HH:MM');
    // Purely advisory — the real check is in JS:
    input.setAttribute('pattern', '^([01]\\d|2[0-3]):[0-5]\\d$');
    input.classList.add('time24');

    // Live mask: only digits and a single colon, auto-insert after 2 digits.
    input.addEventListener('input', () => {
      let v = input.value.replace(/[^\d:]/g, '');
      const firstColon = v.indexOf(':');
      if (firstColon !== -1) {
        v = v.slice(0, firstColon + 1) + v.slice(firstColon + 1).replace(/:/g, '');
      }
      if (firstColon === -1 && v.length >= 3) {
        v = v.slice(0, 2) + ':' + v.slice(2);
      }
      if (v.length > 5) v = v.slice(0, 5);
      if (v !== input.value) input.value = v;
      input.classList.toggle('invalid', v !== '' && !TIME24_RE.test(v));
    });

    // Coerce to canonical HH:MM on blur so downstream code always sees
    // a well-formed value (or '' if the user typed nonsense).
    input.addEventListener('blur', () => {
      const canon = normaliseTime24(input.value);
      if (canon !== input.value) {
        input.value = canon;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      input.classList.toggle('invalid', input.value !== '' && !TIME24_RE.test(input.value));
    });
  }

  // Upgrade every .time24 input inside `root` (defaults to document).
  function upgradeTime24Inputs(root) {
    const scope = root || document;
    scope.querySelectorAll('input.time24, input[data-time24]').forEach(wireTime24);
  }

  // Build a fresh 24h time input and return it. `onChange` fires with the
  // *canonical* value (possibly '') whenever the field produces a change event.
  function time24Input(value, onChange, extraAttrs) {
    const attrs = Object.assign(
      { type: 'text', class: 'time24', value: value || '' },
      extraAttrs || {}
    );
    const node = el('input', attrs);
    wireTime24(node);
    if (typeof onChange === 'function') {
      node.addEventListener('change', () => onChange(node.value));
    }
    return node;
  }

  return {
    el,
    clear,
    cloneTemplate,
    toast,
    stat,
    progressBar,
    chartRow,
    chartLegend,
    confirmDialog,
    formatDate,
    formatDateShort,
    formatRange,
    time24Input,
    upgradeTime24Inputs,
    normaliseTime24
  };
})();
