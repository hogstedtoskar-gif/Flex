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
    formatRange
  };
})();
