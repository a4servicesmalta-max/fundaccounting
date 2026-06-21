/* Fund Autopilot — app shell runtime (window.FA). Plain JS, no build.
   Views register via FA.registerView(name, { label, render }). */
(function () {
  'use strict';

  // ---- Icons (inline SVG, stroke = currentColor) ----------------------------
  const P = (d) => `<path d="${d}"/>`;
  const ICONS = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    documents: P('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z') + P('M14 2v6h6') + P('M8 13h8') + P('M8 17h8'),
    bank: P('M3 21h18') + P('M5 21V10l7-5 7 5v11') + P('M9 21v-6h6v6'),
    review: P('M9 11l3 3L22 4') + P('M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'),
    loans: '<rect x="2" y="5" width="20" height="14" rx="2"/>' + P('M2 10h20') + P('M6 15h4'),
    aging: P('M7 7h14') + P('M7 7l-4 4 4 4') + P('M17 17H3') + P('M17 17l4-4-4-4'),
    books: P('M2 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H2z') + P('M22 4h-6a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H22z'),
    settings: P('M4 6h10') + P('M18 6h2') + P('M4 12h2') + P('M10 12h10') + P('M4 18h7') + P('M15 18h5') + '<circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="13" cy="18" r="2"/>',
    help: '<circle cx="12" cy="12" r="9"/>' + P('M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7') + P('M12 17h.01'),
    logout: P('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4') + P('M16 17l5-5-5-5') + P('M21 12H9'),
    search: '<circle cx="11" cy="11" r="7"/>' + P('M21 21l-4.3-4.3'),
    bell: P('M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9') + P('M13.7 21a2 2 0 0 1-3.4 0'),
    chevron: P('M6 9l6 6 6-6'),
    plus: P('M12 5v14') + P('M5 12h14'),
    upload: P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4') + P('M17 8l-5-5-5 5') + P('M12 3v12'),
    check: P('M20 6L9 17l-5-5'),
    arrow: P('M5 12h14') + P('M13 5l7 7-7 7'),
    paperclip: P('M21 8l-9.5 9.5a4 4 0 0 1-5.7-5.7L14 4a2.7 2.7 0 0 1 3.8 3.8L9.4 16'),
    clock: '<circle cx="12" cy="12" r="9"/>' + P('M12 7v5l3 2'),
    x: P('M18 6L6 18') + P('M6 6l12 12'),
  };
  function icon(name, cls) {
    const body = ICONS[name] || '';
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls}"` : ''}>${body}</svg>`;
  }

  // ---- DOM builder ----------------------------------------------------------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
        else node.setAttribute(k, v);
      }
    }
    const add = (c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) return c.forEach(add);
      node.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    };
    children.forEach(add);
    return node;
  }

  // ---- fetch wrapper (never throws) -----------------------------------------
  async function api(path, opts) {
    opts = opts || {};
    const init = { method: opts.method || (opts.json !== undefined || opts.body !== undefined ? 'POST' : 'GET'), headers: {} };
    if (opts.json !== undefined) { init.body = JSON.stringify(opts.json); init.headers['Content-Type'] = 'application/json'; }
    else if (opts.body !== undefined) init.body = opts.body;
    if (opts.headers) Object.assign(init.headers, opts.headers);
    try {
      const res = await fetch(path, init);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        if (!res.ok) return { error: 'Request failed (' + res.status + ')' };
        return await res.text();
      }
      const data = await res.json();
      if (!res.ok) return { error: (data && data.error) || ('Request failed (' + res.status + ')') };
      return data;
    } catch (e) {
      return { error: 'Could not reach the app. Is it still running?' };
    }
  }

  // ---- formatters -----------------------------------------------------------
  function num(n) {
    const v = Number(n);
    if (!isFinite(v)) return '0';
    return v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function money(n, ccy) {
    ccy = ccy || 'EUR';
    const sym = { EUR: '€', USD: '$', GBP: '£', PLN: 'zł ', CHF: 'CHF ' }[ccy] || (ccy + ' ');
    const v = Number(n) || 0;
    return (v < 0 ? '-' : '') + sym + num(Math.abs(v));
  }
  function pct(n) { return (Number(n) || 0).toFixed(1) + '%'; }
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function monthLabel(yyyymm) {
    if (!yyyymm || !/^\d{4}-\d{2}$/.test(yyyymm)) return 'All months';
    const [y, m] = yyyymm.split('-');
    return MONTHS[+m - 1] + ' ' + y;
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const sm = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getUTCDate() + ' ' + sm[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  // ---- state ----------------------------------------------------------------
  const state = { period: 'all', health: { aiConfigured: false, model: '' }, view: 'overview', reviews: { drafts: 0, bank: 0 } };
  const periodCbs = [];
  function periodQuery() { return state.period && state.period !== 'all' ? '?period=' + state.period : ''; }
  function setPeriod(p) { state.period = p || 'all'; periodCbs.forEach((cb) => { try { cb(state.period); } catch (e) {} }); render(state.view); }
  function onPeriodChange(cb) { periodCbs.push(cb); }

  // ---- toast + confirm ------------------------------------------------------
  function toast(msg, kind) {
    const wrap = document.getElementById('toastWrap');
    const t = el('div', { class: 'toast ' + (kind || '') }, msg);
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 3200);
  }
  function confirmAction(msg) {
    return new Promise((resolve) => {
      const close = (v) => { back.remove(); resolve(v); };
      const back = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === back) close(false); } },
        el('div', { class: 'modal' },
          el('h3', null, 'Are you sure?'),
          el('p', null, msg),
          el('div', { class: 'modal-actions' },
            el('button', { class: 'btn btn-ghost btn-sm', onclick: () => close(false) }, 'Cancel'),
            el('button', { class: 'btn btn-dark btn-sm', onclick: () => close(true) }, 'Yes, continue'))));
      document.body.appendChild(back);
    });
  }

  // ---- view registry + router ----------------------------------------------
  const views = {};
  function registerView(name, def) { views[name] = def; }
  async function render(name) {
    state.view = name;
    document.querySelectorAll('.nav-item[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
    const mount = document.getElementById('view');
    mount.innerHTML = '';
    const def = views[name];
    if (!def || typeof def.render !== 'function') {
      mount.appendChild(el('div', { class: 'empty' }, 'Coming together…'));
      return;
    }
    try { await def.render(mount, window.FA); }
    catch (e) { mount.innerHTML = ''; mount.appendChild(el('div', { class: 'empty' }, 'Something went wrong loading this screen.')); }
  }
  function navigate(name) { render(name); }

  // ---- chrome (health, badges, greeting) ------------------------------------
  function applyHealth(h) {
    state.health = { aiConfigured: !!(h && h.aiConfigured), model: (h && h.model) || '' };
    const dot = document.getElementById('aiDot');
    const title = document.getElementById('aiStatusTitle');
    const sub = document.getElementById('aiStatusSub');
    const hint = document.getElementById('keyHint');
    if (state.health.aiConfigured) {
      if (dot) dot.className = 'ai-dot on'; if (title) title.textContent = 'AI reader connected'; if (sub) sub.textContent = 'Reading documents live';
      if (hint) hint.style.display = 'none';
    } else {
      if (dot) dot.className = 'ai-dot off'; if (title) title.textContent = 'AI not connected'; if (sub) sub.textContent = 'Add your API key';
      if (hint) hint.style.display = '';
    }
  }
  async function refreshChrome() {
    const h = await api('/api/health'); if (h && !h.error) applyHealth(h);
    const s = await api('/api/status');
    let pending = 0;
    if (s && s.counts) pending = s.counts.pending || 0;
    const bt = await api('/api/bank/transactions?status=REVIEW');
    let needs = 0;
    if (bt && !bt.error) { const arr = bt.transactions || bt || []; needs = Array.isArray(arr) ? arr.length : 0; }

    state.reviews = { drafts: pending, bank: needs };
    const rb = document.getElementById('reviewBadge'); if (rb) rb.textContent = pending ? String(pending) : '';
    const bb = document.getElementById('bankBadge'); if (bb) bb.textContent = needs ? String(needs) : '';
    // The bell lights whenever anything is waiting for review (drafts OR bank lines).
    const dot = document.getElementById('bellDot'); if (dot) dot.classList.toggle('on', (pending + needs) > 0);
  }
  function setGreeting() {
    const h = new Date().getHours();
    const g = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const node = document.getElementById('greeting'); if (node) node.textContent = g;
  }

  // ---- boot -----------------------------------------------------------------
  function paintIcons() {
    document.querySelectorAll('.ico[data-ico]').forEach((s) => { s.innerHTML = icon(s.dataset.ico); });
  }
  let booted = false;
  async function boot() {
    if (booted) return; booted = true;
    paintIcons();
    setGreeting();
    document.querySelectorAll('.nav-item[data-view]').forEach((a) => a.addEventListener('click', () => navigate(a.dataset.view)));
    // The notifications bell takes you to whatever needs reviewing.
    const bell = document.getElementById('bellBtn');
    if (bell) bell.addEventListener('click', () => {
      const r = state.reviews || { drafts: 0, bank: 0 };
      if (r.bank > 0 && r.bank >= r.drafts) { navigate('bank'); toast(r.bank + ' bank transaction' + (r.bank === 1 ? '' : 's') + ' to review.', ''); }
      else if (r.drafts > 0) { navigate('review'); toast(r.drafts + ' draft' + (r.drafts === 1 ? '' : 's') + ' to review.', ''); }
      else { toast('Nothing to review right now — you’re all caught up.', 'success'); }
    });

    const so = document.getElementById('startOverNav');
    if (so) so.addEventListener('click', async () => {
      if (await confirmAction('This wipes all loaded documents, entries, bank data and reports so you can begin again. This cannot be undone.')) {
        const r = await api('/api/reset', { method: 'POST' });
        if (r && r.error) toast(r.error, 'error'); else location.reload();
      }
    });
    await refreshChrome();
    render('overview');
  }

  window.FA = {
    el, api, money, num, pct, monthLabel, fmtDate, icon, state, setPeriod, onPeriodChange,
    periodQuery, navigate, registerView, refreshChrome, toast, confirmAction, boot,
  };
})();
