/* bank.js — Bank statements view (A4 redesign).
   Owns ONLY this file. Registers itself via FA.registerView('bank', …).
   Reuses the proven legacy fetch/render logic (public_legacy/app.js), re-skinned
   onto the new design-system classes. Never throws; guards missing data. */
(function () {
  'use strict';
  if (!window.FA || typeof FA.registerView !== 'function') return;

  // Compact bank-table styling (visual only; injected once).
  function ensureBankStyles() {
    if (document.getElementById('fa-bank-styles')) return;
    var css = [
      '.tbl-compact td,.tbl-compact th{padding-top:7px;padding-bottom:7px;font-size:13px}',
      '.tbl-compact thead th{font-size:11px;letter-spacing:.3px;text-transform:uppercase}',
    ].join('');
    var s = document.createElement('style');
    s.id = 'fa-bank-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ---- chart of accounts for the "Post to" picklist --------------------------
  // Loaded live from /api/chart (which grows as new accounts are created), with a
  // built-in fallback so the picker still works if that call ever fails.
  var CHART_ACCOUNTS = [
    { code: '1010', name: 'Bank' },
    { code: '1100', name: 'Accounts receivable (debtors)' },
    { code: '2010', name: 'Accounts payable (creditors)' },
    { code: '2300', name: 'Loans payable (borrowings)' },
    { code: '4000', name: 'Investment income' },
    { code: '4010', name: 'Other income' },
    { code: '6000', name: 'Rent' },
    { code: '6100', name: 'Legal & professional fees' },
    { code: '6200', name: 'Office & administration' },
    { code: '6300', name: 'Bank charges' },
    { code: '6400', name: 'Interest expense' },
    { code: '6500', name: 'Salaries & wages' },
    { code: '6800', name: 'Foreign exchange gain/loss' },
    { code: '6850', name: 'Investment write-offs' },
    { code: '9999', name: 'Suspense — to review' },
    { code: '030', name: 'Investments in shares (control)' },
    { code: '032', name: 'Loans granted (control)' },
  ];
  var NAME_BY_CODE = {};
  function rebuildNames() { NAME_BY_CODE = {}; CHART_ACCOUNTS.forEach(function (a) { NAME_BY_CODE[a.code] = a.name; }); }
  rebuildNames();
  function chartName(code) { return NAME_BY_CODE[code] || (code ? String(code) : '—'); }

  async function loadChart(FA) {
    var r = await FA.api('/api/chart');
    if (r && !r.error && Array.isArray(r.accounts) && r.accounts.length) {
      CHART_ACCOUNTS = r.accounts.map(function (a) { return { code: a.code, name: a.name }; });
      rebuildNames();
    }
  }

  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function friendlyMonth(period) {
    if (!period || !/^\d{4}-\d{2}/.test(String(period))) return String(period || '');
    var p = String(period);
    var idx = Number(p.slice(5, 7)) - 1;
    var year = p.slice(0, 4);
    return (idx >= 0 && idx < 12 ? MONTH_NAMES[idx] : p) + ' ' + year;
  }
  // "2025-05","2025-06" -> "May–June 2025"; mixed years fall back to a list.
  function summariseMonths(periods) {
    var list = (periods || []).filter(Boolean).slice().sort();
    if (!list.length) return '';
    if (list.length === 1) return friendlyMonth(list[0]);
    var years = {};
    list.forEach(function (p) { years[String(p).slice(0, 4)] = 1; });
    if (Object.keys(years).length === 1) {
      var names = list.map(function (p) {
        var idx = Number(String(p).slice(5, 7)) - 1;
        return (idx >= 0 && idx < 12) ? MONTH_NAMES[idx] : p;
      });
      return names[0] + '–' + names[names.length - 1] + ' ' + String(list[0]).slice(0, 4);
    }
    return list.map(friendlyMonth).join(', ');
  }

  // ---- module state (re-pulled on every render so it's safe to re-enter) -----
  var accounts = [];
  var selectedId = null;
  var filterStatus = 'all';   // all | review | auto | posted
  var filterText = '';        // free-text search over description / account
  var filterFrom = '';        // YYYY-MM-DD inclusive lower bound (date filter)
  var filterTo = '';          // YYYY-MM-DD inclusive upper bound
  var currentTxns = [];       // last-fetched transactions for the selected account
  var currentCcy = 'EUR';
  var eurByTxn = {};           // txnId -> { eur, rate, rateDate, source }  (non-EUR accounts)
  var fxData = null;           // /api/bank/fx response for the selected account
  var tableHost = null;        // where the (filterable) transactions table is painted
  var accountDetailHost = null; // the selected-account detail container (for re-render)
  var acctOpening = NaN;       // opening balance (native) for the bracket row
  var acctClosing = NaN;       // closing balance (native) for the bracket row

  // ===========================================================================
  // RENDER ENTRY
  // ===========================================================================
  FA.registerView('bank', {
    label: 'Bank statements',
    render: function (mount, ctx) { return renderView(mount, ctx || window.FA); },
  });

  async function renderView(mount, FA) {
    var el = FA.el;
    mount.innerHTML = '';

    var fileInput = el('input', { type: 'file', accept: '.csv,.pdf', multiple: 'multiple', style: { display: 'none' } });

    // Header.
    mount.appendChild(el('div', { class: 'spread', style: { marginBottom: '18px', maxWidth: '1040px' } },
      el('div', null,
        el('div', { class: 'section-title' }, 'Bank statements'),
        el('div', { class: 'section-help', style: { maxWidth: '600px' } },
          'Drop a CSV or PDF and we read the opening balance, every transaction and the closing balance — kept separate per bank. Re-upload an overlapping period and we keep each month once.')),
      el('button', { class: 'btn btn-dark', onclick: function () { fileInput.click(); } },
        el('span', { class: 'ico', html: FA.icon('upload') }), 'Import statement')));

    // Upload zone + a place for the plain-language summary.
    var summaryBox = el('div', { style: { display: 'none', marginTop: '14px' } });
    var dropzone = buildDropzone(FA, fileInput, summaryBox, function () { return bodyHost; });
    mount.appendChild(el('div', { class: 'card card-pad', style: { marginBottom: '18px', maxWidth: '1040px' } }, dropzone, fileInput, summaryBox));

    // Body container — accounts, tiles, dedup, table all get (re)painted here.
    var bodyHost = el('div');
    mount.appendChild(bodyHost);

    await loadChart(FA);
    await loadAccounts(FA, bodyHost);
  }

  // ---- upload dropzone -------------------------------------------------------
  function buildDropzone(FA, fileInput, summaryBox, getBodyHost) {
    var el = FA.el;
    var label = el('div', { class: 'muted', style: { fontSize: '14px' } },
      el('div', { style: { fontWeight: '600', color: 'var(--ink)', marginBottom: '4px' } }, 'Drop bank statements here'),
      el('div', null, 'CSV or PDF · multiple files welcome · each bank is read separately'));
    var zone = el('div', { class: 'dropzone' }, label);

    function handle(files) {
      var arr = Array.prototype.slice.call(files || []).filter(function (f) {
        return /\.(csv|pdf)$/i.test(f.name);
      });
      if (!arr.length) { FA.toast('Please choose PDF or CSV bank statements.', 'warn'); return; }
      doUpload(FA, arr, zone, label, summaryBox, getBodyHost);
    }

    zone.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () { handle(fileInput.files); fileInput.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('drag'); });
    });
    zone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) handle(e.dataTransfer.files);
    });
    return zone;
  }

  async function doUpload(FA, files, zone, label, summaryBox, getBodyHost) {
    var el = FA.el;
    var prev = label.innerHTML;
    zone.classList.add('drag');
    label.innerHTML = '';
    label.appendChild(el('div', { class: 'row', style: { justifyContent: 'center' } },
      el('span', { class: 'spinner' }),
      el('span', null, files.length === 1 ? 'Reading your statement…' : 'Reading your ' + files.length + ' statements…')));

    var form = new FormData();
    files.forEach(function (f) { form.append('files[]', f, f.name); });
    var r = await FA.api('/api/bank/upload', { method: 'POST', body: form });

    zone.classList.remove('drag');
    label.innerHTML = prev;

    if (!r || r.error) {
      summaryBox.style.display = '';
      summaryBox.innerHTML = '';
      summaryBox.appendChild(el('div', { class: 'banner banner-warn' }, (r && r.error) || 'That upload did not go through. Please try again.'));
      return;
    }

    renderUploadSummary(FA, r, files.length, summaryBox);

    // Refresh accounts/table and the sidebar badges.
    var bodyHost = getBodyHost();
    if (bodyHost) await loadAccounts(FA, bodyHost);
    if (typeof FA.refreshChrome === 'function') FA.refreshChrome();
  }

  /** Plain-language summary; degrades across {results:[…]} or top-level aggregate shapes. */
  function renderUploadSummary(FA, data, fileCount, box) {
    var el = FA.el;
    box.innerHTML = '';
    box.style.display = '';

    var results = Array.isArray(data.results) ? data.results
      : Array.isArray(data.statements) ? data.statements : [];
    var read = Number(data.read != null ? data.read : (data.processed != null ? data.processed : results.length)) || results.length || fileCount || 0;

    var added = Number(data.added);
    var skipped = [];
    var footingOk = data.footingOk;
    var footingDiff = Number(data.footingDiff);

    if (!isFinite(added) || results.length) {
      added = 0; var allTie = true; var anyTie = false;
      results.forEach(function (res) {
        added += Number(res && res.added) || 0;
        var sm = (res && res.skippedMonths) || [];
        if (Array.isArray(sm)) skipped = skipped.concat(sm);
        if (res && res.footingOk === false) allTie = false;
        if (res && res.footingOk === true) anyTie = true;
      });
      if (footingOk == null) footingOk = anyTie ? allTie : undefined;
    }
    if (Array.isArray(data.skippedMonths)) skipped = skipped.concat(data.skippedMonths);
    // de-dup + sort skipped months
    var seen = {}; skipped = skipped.filter(function (m) { if (!m || seen[m]) return false; seen[m] = 1; return true; }).sort();

    var parts = [];
    parts.push('Read ' + read + ' statement' + (read === 1 ? '' : 's'));
    if (isFinite(added)) parts.push(added + ' new month' + (added === 1 ? '' : 's') + ' added');
    if (skipped.length) parts.push(summariseMonths(skipped) + ' skipped (already loaded)');
    if (footingOk === true) parts.push('balances tie');
    else if (footingOk === false) parts.push("doesn't tie" + (isFinite(footingDiff) ? ' (diff ' + FA.money(Math.abs(footingDiff)) + ')' : ''));

    var ok = footingOk !== false;
    box.appendChild(el('div', { class: ok ? 'footing-ok' : 'footing-bad', style: { fontSize: '13.5px' } },
      el('span', { html: FA.icon('check') }),
      el('span', null, parts.join(' · ') + '.')));
  }

  // ---- accounts + body -------------------------------------------------------
  async function loadAccounts(FA, host) {
    var el = FA.el;
    var r = await FA.api('/api/bank/accounts');
    host.innerHTML = '';

    if (!r || r.error) {
      host.appendChild(el('div', { class: 'empty' }, (r && r.error) || 'No bank statements yet — upload one above.'));
      return;
    }
    accounts = Array.isArray(r.accounts) ? r.accounts : (Array.isArray(r) ? r : []);
    accounts = accounts.filter(function (a) { return a && a.id; });

    if (!accounts.length) {
      host.appendChild(el('div', { class: 'empty' }, 'No bank statements yet — upload one above.'));
      return;
    }

    if (!selectedId || !accounts.some(function (a) { return a.id === selectedId; })) {
      selectedId = accounts[0].id;
    }

    // Account selector cards.
    host.appendChild(buildAccountCards(FA, host));

    // Selected-account detail (tiles, dedup, table, preview).
    var detail = el('div');
    host.appendChild(detail);
    await renderAccount(FA, detail);
  }

  function buildAccountCards(FA, host) {
    var el = FA.el;
    var wrap = el('div', { class: 'row', style: { gap: '16px', marginBottom: '18px', flexWrap: 'wrap', alignItems: 'stretch' } });
    accounts.forEach(function (a) {
      var active = a.id === selectedId;
      var ref = [a.currency, a.accountRef].filter(Boolean).join(' · ');
      var card = el('div', {
        class: 'card',
        style: {
          flex: '1', minWidth: '220px', cursor: 'pointer', padding: '18px 20px',
          border: '2px solid ' + (active ? 'var(--primary)' : 'var(--hairline-light)'),
          boxShadow: active ? '0 6px 20px rgba(73,79,223,.12)' : 'none',
        },
        onclick: function () {
          if (selectedId === a.id) return;
          selectedId = a.id;
          loadAccounts(FA, host);
        },
      },
        el('div', { class: 'row', style: { gap: '12px', marginBottom: '10px' } },
          el('div', {
            style: {
              width: '42px', height: '42px', borderRadius: '12px', flex: 'none',
              background: active ? 'var(--primary)' : '#000', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            },
            html: FA.icon('bank'),
          }),
          el('div', { style: { minWidth: '0' } },
            el('div', { style: { fontWeight: '600', fontSize: '15px' } }, a.bankName || 'Bank account'),
            el('div', { class: 'muted', style: { fontSize: '12px' } }, ref || a.id))));
      wrap.appendChild(card);
    });
    return wrap;
  }

  async function renderAccount(FA, host) {
    var el = FA.el;
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'row', style: { padding: '20px 0' } },
      el('span', { class: 'spinner' }), el('span', { class: 'muted' }, 'Loading transactions…')));

    accountDetailHost = host;
    var acct = accounts.filter(function (a) { return a.id === selectedId; })[0] || {};
    var ccy = acct.currency || 'EUR';
    currentCcy = ccy;

    var res = await Promise.all([
      FA.api('/api/bank/statements' + FA.periodQuery()),
      FA.api('/api/bank/transactions?accountId=' + encodeURIComponent(selectedId) +
        (FA.state.period && FA.state.period !== 'all' ? '&period=' + FA.state.period : '')),
    ]);
    var stmtRes = res[0], txnRes = res[1];

    host.innerHTML = '';

    // Statements belonging to this account (newest period last).
    var mine = [];
    if (stmtRes && !stmtRes.error) {
      var all = Array.isArray(stmtRes.statements) ? stmtRes.statements : (Array.isArray(stmtRes) ? stmtRes : []);
      mine = all.filter(function (s) { return s && s.bankAccountId === selectedId; })
        .sort(function (a, b) { return String(a.periodStart || '').localeCompare(String(b.periodStart || '')); });
    }
    var latest = mine.length ? mine[mine.length - 1] : null;
    acctOpening = mine.length ? Number(mine[0].openingBalance) : NaN;
    acctClosing = latest ? Number(latest.closingBalance) : NaN;

    // Balance tiles + footing badge.
    host.appendChild(buildBalanceTiles(FA, latest, ccy));

    // GL-vs-bank reconciliation panel (trap T10) — ties statement to the books.
    var reconHost = el('div');
    host.appendChild(reconHost);
    FA.api('/api/bank/reconcile?accountId=' + encodeURIComponent(selectedId)).then(function (rr) {
      if (rr && !rr.error && rr.reconciliation) reconHost.appendChild(buildReconCard(FA, rr.reconciliation, ccy));
    });

    // Dedup notice (any statement that skipped already-loaded months).
    var skipped = [];
    mine.forEach(function (s) {
      var sm = (s && (s.skippedMonths || s.deduplicatedMonths)) || [];
      if (Array.isArray(sm)) skipped = skipped.concat(sm);
    });
    var seen = {}; skipped = skipped.filter(function (m) { if (!m || seen[m]) return false; seen[m] = 1; return true; }).sort();
    if (skipped.length) {
      host.appendChild(el('div', { class: 'footing-ok', style: { marginBottom: '16px', padding: '11px 14px', fontSize: '13px', borderRadius: '12px' } },
        el('span', { html: FA.icon('check') }),
        el('span', null, summariseMonths(skipped) + ' skipped — already loaded. We kept each month once and continued the running balance with no double-counting.')));
    }

    // Transactions for this account.
    var txns = [];
    if (txnRes && !txnRes.error) {
      txns = Array.isArray(txnRes.transactions) ? txnRes.transactions : (Array.isArray(txnRes) ? txnRes : []);
    }
    currentTxns = Array.isArray(txns) ? txns : [];
    eurByTxn = {};
    fxData = null;

    // Euro exchange — for a non-EUR account, fetch daily ECB rates and convert.
    if (ccy !== 'EUR') {
      var fxHost = el('div');
      host.appendChild(fxHost);
      fxHost.appendChild(el('div', { class: 'muted', style: { margin: '4px 0 14px', fontSize: '13px' } },
        el('span', { class: 'spinner' }), ' Fetching daily euro exchange rates…'));
      FA.api('/api/bank/fx?accountId=' + encodeURIComponent(selectedId)).then(function (fx) {
        fxHost.innerHTML = '';
        if (fx && !fx.error && fx.needed) {
          fxData = fx;
          (fx.lines || []).forEach(function (l) { eurByTxn[l.id] = { eur: l.eur, balanceEur: l.balanceEur, rate: l.rate, rateDate: l.rateDate, source: l.source }; });
          fxHost.appendChild(buildEuroExchangeCard(FA, fx, ccy));
          paintTable(FA); // repaint so the EUR balance column + bracket rows appear
        }
      });
    }

    // Toolbar (filter + classify guide) and the transactions table.
    host.appendChild(buildToolbar(FA));
    tableHost = el('div');
    host.appendChild(tableHost);
    paintTable(FA);

    if (txnRes && txnRes.error) {
      host.appendChild(el('div', { class: 'banner banner-warn' }, txnRes.error));
    }
  }

  // ---- filter toolbar --------------------------------------------------------
  function buildToolbar(FA) {
    var el = FA.el;
    var statuses = [
      { v: 'all', label: 'All' },
      { v: 'review', label: 'To review' },
      { v: 'auto', label: 'Auto' },
      { v: 'posted', label: 'Posted' },
    ];
    var sel = el('select', { class: 'select', style: { height: '36px' }, title: 'Filter by status' });
    statuses.forEach(function (s) {
      var o = el('option', { value: s.v }, s.label);
      if (s.v === filterStatus) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { filterStatus = sel.value || 'all'; paintTable(FA); });

    var search = el('input', { class: 'input', type: 'search', placeholder: 'Search description…', style: { height: '36px', minWidth: '200px' } });
    search.value = filterText;
    search.addEventListener('input', function () { filterText = search.value || ''; paintTable(FA); });

    var fromIn = el('input', { class: 'input', type: 'date', title: 'From date', style: { height: '36px' } });
    fromIn.value = filterFrom;
    fromIn.addEventListener('change', function () { filterFrom = fromIn.value || ''; paintTable(FA); });
    var toIn = el('input', { class: 'input', type: 'date', title: 'To date', style: { height: '36px' } });
    toIn.value = filterTo;
    toIn.addEventListener('change', function () { filterTo = toIn.value || ''; paintTable(FA); });

    var unknown = currentTxns.filter(isUnclassified).length;
    var matchBtn = el('button', { class: 'btn btn-secondary btn-sm', title: 'Match bank lines to uploaded invoices & bills and settle the debtor/creditor' },
      el('span', { class: 'ico', html: FA.icon('paperclip') }), 'Match invoices & bills');
    matchBtn.addEventListener('click', function () { runRematch(FA, matchBtn); });

    var classifyBtn = el('button', { class: 'btn btn-dark btn-sm', title: 'Let the AI suggest accounts for the unknown transactions' },
      el('span', { class: 'ico', html: FA.icon('review') }), 'Help me classify' + (unknown ? ' (' + unknown + ')' : ''));
    classifyBtn.addEventListener('click', function () { openClassifyGuide(FA); });

    // Approve every high-confidence (auto-categorised, real account) line in one click.
    var ready = currentTxns.filter(isReadyToApprove).length;
    var approveBtn = el('button', { class: 'btn btn-primary btn-sm',
      title: 'Post every high-confidence (auto-categorised) transaction; low-confidence lines stay for review' },
      el('span', { class: 'ico', html: FA.icon('review') }), 'Approve all ready' + (ready ? ' (' + ready + ')' : ''));
    if (!ready) approveBtn.disabled = true;
    approveBtn.addEventListener('click', function () { runApproveAll(FA, approveBtn); });

    return el('div', { class: 'card card-pad spread', style: { gap: '12px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '14px' } },
      el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', alignItems: 'center' } },
        el('span', { class: 'muted', style: { fontSize: '13px' } }, 'Filter'), sel, search,
        el('span', { class: 'muted', style: { fontSize: '13px' } }, 'Dates'), fromIn,
        el('span', { class: 'muted', style: { fontSize: '13px' } }, '→'), toIn),
      el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, matchBtn, classifyBtn, approveBtn));
  }

  // A high-confidence line ready to bulk-approve: auto-categorised, real account, no date flag.
  function isReadyToApprove(t) {
    var s = String(t.status || '').toUpperCase();
    return s === 'AUTO' && t.postToCode && t.postToCode !== '9999' && !t.dateFlag;
  }

  async function runApproveAll(FA, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }
    var body = { accountId: selectedId };
    if (FA.state.period && FA.state.period !== 'all') body.period = FA.state.period;
    var r = await FA.api('/api/bank/transactions/approve-all', { json: body });
    if (!r || r.error) {
      if (btn) { btn.disabled = false; btn.textContent = 'Approve all ready'; }
      FA.toast((r && r.error) || 'Could not approve.', 'error');
      return;
    }
    var n = Number(r.approved) || 0;
    FA.toast(n ? (n + ' transaction' + (n === 1 ? '' : 's') + ' approved'
      + (r.skipped ? ('; ' + r.skipped + ' left for review') : '') + '.') : 'Nothing ready to approve.', n ? 'success' : '');
    await renderAccount(FA, accountDetailHost);
    if (typeof FA.refreshChrome === 'function') FA.refreshChrome();
  }

  async function runRematch(FA, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Matching…'; }
    var r = await FA.api('/api/bank/rematch', { method: 'POST' });
    if (!r || r.error) {
      if (btn) { btn.disabled = false; btn.textContent = 'Match invoices & bills'; }
      FA.toast((r && r.error) || 'Could not run matching.', 'error');
      return;
    }
    var n = Number(r.matched) || 0;
    FA.toast(n ? (n + ' transaction' + (n === 1 ? '' : 's') + ' matched & settled against invoices/bills.') : 'No new matches — nothing to settle.', n ? 'success' : '');
    await renderAccount(FA, accountDetailHost);
    if (typeof FA.refreshChrome === 'function') FA.refreshChrome();
  }

  function isUnclassified(t) {
    var s = String(t.status || '').toUpperCase();
    return s === 'REVIEW' || t.postToCode === '9999' || !t.postToCode;
  }

  function passesFilter(t) {
    var s = String(t.status || '').toUpperCase();
    if (filterStatus === 'review' && s !== 'REVIEW') return false;
    if (filterStatus === 'auto' && s !== 'AUTO') return false;
    if (filterStatus === 'posted' && s !== 'POSTED') return false;
    if (filterText) {
      var hay = ((t.description || '') + ' ' + (t.postToName || '') + ' ' + (t.postToCode || '')).toLowerCase();
      if (hay.indexOf(filterText.toLowerCase()) < 0) return false;
    }
    var d = String(t.date || '');
    if (filterFrom && d < filterFrom) return false;
    if (filterTo && d > filterTo) return false;
    return true;
  }

  function paintTable(FA) {
    if (!tableHost) return;
    var rows = currentTxns.filter(passesFilter);
    tableHost.innerHTML = '';
    tableHost.appendChild(buildTxnCard(FA, rows, currentTxns.length, currentCcy));
  }

  // ---- euro exchange card ----------------------------------------------------
  function buildEuroExchangeCard(FA, fx, ccy) {
    var el = FA.el;
    var t = fx.totals || {};
    var sources = {};
    (fx.lines || []).forEach(function (l) { sources[l.source] = 1; });
    var live = sources.live || sources.cache;
    return el('div', { class: 'card card-pad', style: { marginBottom: '16px', borderLeft: '3px solid var(--primary)' } },
      el('div', { class: 'spread', style: { gap: '12px', flexWrap: 'wrap', alignItems: 'center' } },
        el('div', null,
          el('div', { style: { fontWeight: '600', fontFamily: 'var(--font-display)' } }, 'Euro exchange'),
          el('div', { class: 'section-help', style: { margin: '2px 0 0', maxWidth: '560px' } },
            'This account is in ' + ccy + '. Each line is converted to euro at that day’s ' +
            (live ? 'ECB reference rate' : 'best available rate') + ', so your books stay in EUR.')),
        el('div', { class: 'row', style: { gap: '22px', flexWrap: 'wrap' } },
          fx.openingEur != null ? fxTotal(FA, 'Opening (EUR)', fx.openingEur) : null,
          fxTotal(FA, 'Money in', t.inEur, false, '#428619'),
          fxTotal(FA, 'Money out', t.outEur, false, '#e23b4a'),
          fx.closingEur != null ? fxTotal(FA, 'Closing (EUR)', fx.closingEur, true) : fxTotal(FA, 'Net (EUR)', t.netEur, true))));
  }
  function fxTotal(FA, label, value, strong, color) {
    var el = FA.el;
    return el('div', null,
      el('div', { class: 'muted', style: { fontSize: '11.5px' } }, label),
      el('div', { style: { fontFamily: 'var(--font-display)', fontWeight: strong ? '700' : '600', fontSize: '18px', color: color || 'inherit' } },
        FA.money(Number(value) || 0, 'EUR')));
  }

  function buildBalanceTiles(FA, stmt, ccy) {
    var el = FA.el;
    var opening = stmt ? Number(stmt.openingBalance) : NaN;
    var closing = stmt ? Number(stmt.closingBalance) : NaN;
    var net = (isFinite(opening) && isFinite(closing)) ? closing - opening : NaN;

    var tie = stmt ? stmt.footingOk !== false : true;
    var diff = stmt ? (Number(stmt.footingDiff) || 0) : 0;
    var footing = stmt
      ? el('span', {
          class: tie ? 'footing-ok' : 'footing-bad',
          title: tie ? 'Opening + movements equals the closing balance.' : 'The figures on this statement do not add up to the closing balance.',
        },
        tie ? '✓ balances tie' : ("doesn't tie (diff " + FA.money(Math.abs(diff), ccy) + ')'))
      : null;

    function tile(label, value, extra) {
      return el('div', { class: 'card', style: { padding: '20px' } },
        el('div', { class: 'spread', style: { marginBottom: '8px' } },
          el('div', { class: 'muted', style: { fontSize: '12.5px' } }, label),
          extra || null),
        el('div', { style: { fontFamily: 'var(--font-display)', fontSize: '26px', fontWeight: '600', letterSpacing: '-.5px' } }, value));
    }

    function tileColored(label, value, color, extra) {
      return el('div', { class: 'card', style: { padding: '20px' } },
        el('div', { class: 'spread', style: { marginBottom: '8px' } },
          el('div', { class: 'muted', style: { fontSize: '12.5px' } }, label),
          extra || null),
        el('div', { style: { fontFamily: 'var(--font-display)', fontSize: '26px', fontWeight: '600', letterSpacing: '-.5px', color: color || 'inherit' } }, value));
    }

    return el('div', { class: 'grid-3', style: { marginBottom: '16px' } },
      tile('Opening balance', isFinite(opening) ? FA.money(opening, ccy) : '—'),
      tileColored('Net change', isFinite(net) ? (net >= 0 ? '+' : '') + FA.money(net, ccy) : '—',
        isFinite(net) ? (net >= 0 ? '#428619' : '#e23b4a') : null),
      tile('Closing balance', isFinite(closing) ? FA.money(closing, ccy) : '—', footing));
  }

  // GL-vs-bank reconciliation card (trap T10): statement closing vs posted GL
  // balance + the reconciling items that explain any difference.
  function buildReconCard(FA, recon, ccy) {
    var el = FA.el;
    var items = (recon.reconcilingItems || []).concat([]);
    var unc = recon.uncategorised || [];
    var tied = recon.reconciled;
    var head = el('div', { class: 'spread', style: { alignItems: 'center', marginBottom: '10px' } },
      el('div', { style: { fontWeight: '600', fontFamily: 'var(--font-display)' } }, 'Reconciliation (books vs bank)'),
      el('span', { class: 'badge ' + (tied ? 'lime' : 'warn') }, tied ? '✓ Reconciled' : 'Difference ' + FA.money(recon.difference, ccy)));
    var rows = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 16px', fontSize: '13px' } },
      el('div', { class: 'muted' }, 'Statement closing balance'), el('div', { class: 'num t-right' }, FA.money(recon.statementClosing, ccy)),
      el('div', { class: 'muted' }, 'Balance per the books (posted)'), el('div', { class: 'num t-right' }, FA.money(recon.glBalance, ccy)),
      el('div', { style: { fontWeight: '600' } }, 'Difference'), el('div', { class: 'num t-right', style: { fontWeight: '600' } }, FA.money(recon.difference, ccy)));
    var card = el('div', { class: 'card card-pad', style: { marginBottom: '16px', borderLeft: '3px solid ' + (tied ? 'var(--lime, #c7ef3e)' : 'var(--accent-warning, #ec7e00)') } }, head, rows);
    if (items.length) {
      card.appendChild(el('div', { class: 'muted', style: { margin: '12px 0 4px', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '.3px', fontWeight: '600' } }, 'Reconciling items (on the statement, not in the books)'));
      items.forEach(function (it) {
        card.appendChild(el('div', { class: 'spread', style: { padding: '5px 0', borderBottom: '1px solid var(--hairline-light)', fontSize: '13px' } },
          el('span', null, FA.fmtDate(it.date) + ' · ' + (it.description || '—'),
            el('span', { class: 'badge warn', style: { marginLeft: '8px', fontSize: '10px' } }, it.reason === 'HELD_IMPOSSIBLE_DATE' ? 'held: bad date' : 'rejected')),
          el('span', { class: 'num' }, FA.money(it.amount, ccy))));
      });
    }
    if (unc.length) {
      card.appendChild(el('div', { class: 'muted', style: { marginTop: '10px', fontSize: '12px' } },
        unc.length + ' posted line' + (unc.length === 1 ? '' : 's') + ' still in suspense (9999) — classify ' + (unc.length === 1 ? 'it' : 'them') + ' below to finish the books.'));
    }
    return card;
  }

  function buildTxnCard(FA, txns, totalCount, ccy) {
    var el = FA.el;
    var hasEur = !!fxData && ccy !== 'EUR';
    var card = el('div', { class: 'card', style: { overflow: 'hidden' } });
    var countLabel = txns.length === totalCount
      ? (totalCount + ' transaction' + (totalCount === 1 ? '' : 's'))
      : ('Showing ' + txns.length + ' of ' + totalCount);
    card.appendChild(el('div', { class: 'spread', style: { padding: '18px 22px', borderBottom: '1px solid var(--hairline-light)' } },
      el('div', { style: { fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: '600' } }, 'Transactions'),
      el('div', { class: 'muted', style: { fontSize: '12px' } }, countLabel)));

    if (!txns.length) {
      card.appendChild(el('div', { class: 'empty' }, totalCount ? 'No transactions match this filter.' : 'No transactions on this account yet.'));
      return card;
    }

    var headCells = [
      el('th', null, 'Date'),
      el('th', null, 'Description'),
      el('th', { class: 't-right' }, 'Money in'),
      el('th', { class: 't-right' }, 'Money out'),
      el('th', { class: 't-right' }, 'Running balance'),
    ];
    if (hasEur) headCells.push(el('th', { class: 't-right' }, 'Balance (EUR)'));
    headCells.push(el('th', null, 'Post to'), el('th', null, 'Linked'));

    ensureBankStyles();
    var table = el('table', { class: 'tbl tbl-compact' });
    table.appendChild(el('thead', null, el('tr', null, headCells)));
    var tbody = el('tbody');

    // Opening/closing balance rows bracket the running balance, but only when the
    // full unfiltered list is showing (so the running balance reconciles top to bottom).
    var showingAll = filterStatus === 'all' && !filterText && !filterFrom && !filterTo;
    if (showingAll && isFinite(acctOpening)) {
      tbody.appendChild(buildBalanceRow(FA, 'Opening balance', acctOpening, ccy, fxData ? fxData.openingEur : null, hasEur));
    }
    txns.forEach(function (t) { tbody.appendChild(buildTxnRow(FA, t, ccy, hasEur)); });
    if (showingAll && isFinite(acctClosing)) {
      tbody.appendChild(buildBalanceRow(FA, 'Closing balance', acctClosing, ccy, fxData ? fxData.closingEur : null, hasEur));
    }

    table.appendChild(tbody);
    card.appendChild(el('div', { style: { overflowX: 'auto' } }, table));
    return card;
  }

  // An opening/closing balance row — bold, tinted, no money-in/out, shows the
  // balance in the Running balance column (and EUR balance column when present).
  function buildBalanceRow(FA, label, nativeVal, ccy, eurVal, hasEur) {
    var el = FA.el;
    var style = { background: 'var(--surface-soft)', fontWeight: '600' };
    var cells = [
      el('td', { style: style }, ''),
      el('td', { style: style }, label),
      el('td', { style: style }, ''),
      el('td', { style: style }, ''),
      el('td', { class: 't-right num', style: style }, isFinite(nativeVal) ? FA.money(nativeVal, ccy) : '—'),
    ];
    if (hasEur) cells.push(el('td', { class: 't-right num', style: style }, eurVal != null ? FA.money(eurVal, 'EUR') : '—'));
    cells.push(el('td', { style: style }, ''), el('td', { style: style }, ''));
    return el('tr', null, cells);
  }

  function buildTxnRow(FA, t, ccy, hasEur) {
    var el = FA.el;
    var amt = Number(t.amount) || 0;
    var bal = (t.balance == null || !isFinite(Number(t.balance))) ? '' : FA.money(t.balance, ccy);

    // Trap T2: an impossible date shows a warning chip + a Fix control instead of
    // a silently-coerced date.
    var dateCell;
    if (t.dateFlag) {
      var fixBtn = el('button', { class: 'btn btn-ghost btn-sm', style: { padding: '2px 8px', fontSize: '11px' },
        title: t.dateFlag.reason || 'Impossible date — needs correcting' }, 'Fix date');
      fixBtn.addEventListener('click', function () { openFixDate(FA, t); });
      dateCell = el('td', null,
        el('div', { class: 'row', style: { gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
          el('span', { class: 'badge warn', title: t.dateFlag.reason || '' }, '⚠ ' + (t.dateFlag.raw || 'bad date')),
          fixBtn));
    } else {
      dateCell = el('td', null, FA.fmtDate(t.date));
    }

    // Trap T13: a matched net-zero pair (charge ↔ refund) shows a small badge.
    var descCell = t.netZeroPair
      ? el('td', null,
          t.description || '—',
          el('span', { class: 'badge', style: { marginLeft: '8px', background: '#e0e7ff', color: '#3730a3' },
            title: 'Matched as a net-zero pair (' + (t.netZeroPair.role === 'CHARGE' ? 'charge' : 'refund') + ') — cancels its counterpart, no double-count' },
            '↔ net-zero'))
      : el('td', null, t.description || '—');

    var cells = [
      dateCell,
      descCell,
      el('td', { class: 't-right num', style: amt > 0 ? { color: 'var(--accent-light-green)', fontWeight: '600' } : null }, amt > 0 ? FA.money(amt, ccy) : ''),
      el('td', { class: 't-right num' }, amt < 0 ? FA.money(Math.abs(amt), ccy) : ''),
      el('td', { class: 't-right num' }, bal),
    ];
    if (hasEur) {
      var fx = eurByTxn[t.id];
      // Show the running balance in EUR; tooltip carries this line's EUR amount + rate.
      cells.push(el('td', {
        class: 't-right num',
        title: fx ? (FA.money(fx.eur, 'EUR') + ' this line · 1 ' + ccy + ' = ' + FA.num(fx.rate) + ' EUR on ' + fx.rateDate) : '',
      }, (fx && fx.balanceEur != null) ? FA.money(fx.balanceEur, 'EUR') : '—'));
    }
    cells.push(buildPostToCell(FA, t), buildDocCell(FA, t));
    return el('tr', null, cells);
  }

  // The editable account picker (select + "＋ New account…"), shared by AUTO,
  // REVIEW and the "Edit" action on POSTED rows. Posting/changing it re-posts.
  function buildAccountPicker(FA, t, status) {
    var el = FA.el;
    var code = t.postToCode || '';
    var wrap = el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } });
    var sel = el('select', { class: 'select', style: { height: '36px', minWidth: '210px' }, 'aria-label': 'Choose the account to post this to' });
    if (status !== 'AUTO') sel.appendChild(el('option', { value: '' }, 'Choose account…'));
    CHART_ACCOUNTS.forEach(function (a) {
      var opt = el('option', { value: a.code }, a.code + ' · ' + a.name);
      if (a.code === code) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.appendChild(el('option', { value: '__new__' }, '＋ New account…'));
    sel.addEventListener('change', function () {
      var chosen = sel.value;
      if (!chosen) return;
      if (chosen === '__new__') { showNewAccountForm(FA, t, wrap, sel); return; }
      postTo(FA, t.id, chosen, sel);
    });
    wrap.appendChild(sel);
    var split = el('button', { class: 'btn btn-ghost btn-sm', title: 'Split this line across several accounts (e.g. principal + interest)' }, 'Split');
    split.addEventListener('click', function () { openSplitModal(FA, t); });
    wrap.appendChild(split);
    return wrap;
  }

  // Trap T2: small inline prompt to correct an impossible date (defaults to the
  // engine's suggested last-valid-day-of-month).
  async function openFixDate(FA, t) {
    var flag = t.dateFlag || {};
    var def = flag.suggestion || '';
    var input = window.prompt(
      'This statement line has an impossible date (' + (flag.raw || '') + ').\n' +
      (flag.reason || '') + '\n\nEnter the correct date (YYYY-MM-DD):',
      def);
    if (!input) return;
    var r = await FA.api('/api/bank/transactions/' + encodeURIComponent(t.id) + '/fix-date', { json: { date: input.trim() } });
    if (r && r.error) { FA.toast(r.error, 'error'); return; }
    FA.toast('Date corrected to ' + input.trim() + '.', 'success');
    if (accountDetailHost) renderAccount(FA, accountDetailHost);
  }

  // Modal: allocate one bank line across multiple accounts; must sum to the amount.
  function openSplitModal(FA, t) {
    var el = FA.el;
    var ccy = currentCcy;
    var target = Number(t.amount) || 0;
    var rows = [];
    var listHost = el('div');
    var sumLabel = el('div', { class: 'muted', style: { margin: '8px 0', fontSize: '13px' } });
    var saveBtn = el('button', { class: 'btn btn-primary btn-sm', disabled: 'disabled' }, 'Save split');

    function updateSum() {
      var s = Math.round(rows.reduce(function (a, r) { return a + (Number(r.amt.value) || 0); }, 0) * 100) / 100;
      var ok = Math.abs(s - target) < 0.01;
      sumLabel.textContent = 'Allocated ' + FA.money(s, ccy) + ' of ' + FA.money(target, ccy) + (ok ? '  ✓' : '  — must match the line');
      saveBtn.disabled = !ok || rows.length < 2;
    }
    function addRow(code, amount) {
      var sel = el('select', { class: 'select', style: { height: '34px', minWidth: '210px' } });
      CHART_ACCOUNTS.forEach(function (a) { var o = el('option', { value: a.code }, a.code + ' · ' + a.name); if (a.code === code) o.selected = true; sel.appendChild(o); });
      var amt = el('input', { class: 'input', type: 'number', step: '0.01', style: { height: '34px', width: '120px' }, value: amount != null ? String(amount) : '' });
      amt.addEventListener('input', updateSum);
      var rm = el('button', { class: 'btn btn-ghost btn-sm' }, '✕');
      var row = el('div', { class: 'row', style: { gap: '6px', marginBottom: '6px' } }, sel, amt, rm);
      var entry = { sel: sel, amt: amt, row: row };
      rm.addEventListener('click', function () { row.remove(); rows = rows.filter(function (r) { return r !== entry; }); updateSum(); });
      rows.push(entry); listHost.appendChild(row);
    }
    saveBtn.addEventListener('click', async function () {
      var allocations = rows.map(function (r) { return { code: r.sel.value, amount: Number(r.amt.value) || 0 }; });
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      var res = await FA.api('/api/bank/transactions/' + encodeURIComponent(t.id) + '/split', { json: { allocations: allocations } });
      if (!res || res.error) { saveBtn.disabled = false; saveBtn.textContent = 'Save split'; FA.toast((res && res.error) || 'Could not split.', 'error'); return; }
      FA.toast('Transaction split posted.', 'success');
      back.remove();
      await renderAccount(FA, accountDetailHost);
      if (typeof FA.refreshChrome === 'function') FA.refreshChrome();
    });

    addRow(t.postToCode && t.postToCode !== '9999' && t.postToCode !== 'SPLIT' ? t.postToCode : '', target);
    addRow('', 0);
    updateSum();
    var addBtn = el('button', { class: 'btn btn-ghost btn-sm' }, '＋ Add line');
    addBtn.addEventListener('click', function () { addRow('', 0); updateSum(); });

    var back = el('div', { class: 'modal-backdrop', onclick: function (e) { if (e.target === back) back.remove(); } },
      el('div', { class: 'modal', style: { maxWidth: '580px', width: '92vw' } },
        el('h3', null, 'Split this transaction'),
        el('p', { class: 'muted', style: { marginTop: '-4px' } }, 'Allocate ' + FA.money(target, ccy) + ' (' + (t.description || '') + ') across accounts — e.g. loan principal + interest income.'),
        listHost, addBtn, sumLabel,
        el('div', { class: 'modal-actions' },
          el('button', { class: 'btn btn-ghost btn-sm', onclick: function () { back.remove(); } }, 'Cancel'), saveBtn)));
    document.body.appendChild(back);
  }

  function buildPostToCell(FA, t) {
    var el = FA.el;
    var td = el('td');
    var status = String(t.status || '').toUpperCase();
    var code = t.postToCode || '';
    var name = t.postToName || chartName(code);

    if (status === 'POSTED') {
      // Posted, but still editable — "Edit" reveals the account picker to re-post.
      var edit = el('button', { class: 'btn btn-ghost btn-sm', title: 'Change the account this is posted to' }, 'Edit');
      edit.addEventListener('click', function () { td.innerHTML = ''; td.appendChild(buildAccountPicker(FA, t, 'REVIEW')); });
      td.appendChild(el('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        el('span', null, name || '—'),
        el('span', { class: 'badge lime' }, 'Posted'),
        edit));
      return td;
    }

    // AUTO (high-confidence) and REVIEW rows get the editable picker up-front.
    var wrap = buildAccountPicker(FA, t, status);
    if (status === 'AUTO') {
      wrap.appendChild(el('span', { class: 'chip', title: 'We picked this automatically — change it above if needed, or approve.' }, 'auto'));
      var approve = el('button', { class: 'btn btn-primary btn-sm' }, 'Approve');
      approve.addEventListener('click', function () { approveTxn(FA, t.id, approve); });
      wrap.appendChild(approve);
    }
    td.appendChild(wrap);
    return td;
  }

  function buildDocCell(FA, t) {
    var el = FA.el;
    var td = el('td');
    if (t.matchedDocumentId) {
      td.appendChild(el('a', {
        href: '/api/documents/' + encodeURIComponent(t.matchedDocumentId) + '/file',
        target: '_blank', rel: 'noopener', title: t.matchedDocumentName || 'Open the matched document',
        style: { display: 'inline-flex', color: 'var(--primary)' }, html: FA.icon('paperclip'),
      }));
    } else {
      td.appendChild(el('span', { class: 'muted' }, '—'));
    }
    return td;
  }

  // ---- "＋ New account…" inline form -----------------------------------------
  function showNewAccountForm(FA, t, wrap, sel) {
    var el = FA.el;
    sel.style.display = 'none';
    var codeIn = el('input', { class: 'input', placeholder: 'Code (e.g. 6600)', style: { height: '36px', width: '120px' } });
    var nameIn = el('input', { class: 'input', placeholder: 'Account name', style: { height: '36px', minWidth: '180px' } });
    var create = el('button', { class: 'btn btn-primary btn-sm' }, 'Create & post');
    var cancel = el('button', { class: 'btn btn-ghost btn-sm' }, 'Cancel');
    var form = el('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', alignItems: 'center' } }, codeIn, nameIn, create, cancel);
    wrap.appendChild(form);
    try { codeIn.focus(); } catch (e) {}

    cancel.addEventListener('click', function () { renderAccount(FA, accountDetailHost); });
    create.addEventListener('click', function () {
      var code = (codeIn.value || '').trim();
      var name = (nameIn.value || '').trim();
      if (!code) { FA.toast('Give the new account a code.', 'warn'); try { codeIn.focus(); } catch (e) {} return; }
      create.disabled = true; create.textContent = 'Creating…';
      postTo(FA, t.id, code, sel, name);
    });
  }

  // ---- actions ---------------------------------------------------------------
  async function postTo(FA, id, code, selectEl, name) {
    if (selectEl) selectEl.disabled = true;
    var body = { code: code };
    if (name) body.name = name;
    var r = await FA.api('/api/bank/transactions/' + encodeURIComponent(id) + '/post-to', { json: body });
    if (!r || r.error) {
      if (selectEl) selectEl.disabled = false;
      FA.toast((r && r.error) || 'Could not post that transaction.', 'error');
      return;
    }
    // A brand-new account won't be in our local list yet — refresh it so it shows
    // everywhere (and is reusable on the next transaction).
    await loadChart(FA);
    FA.toast('Posted to ' + (name || chartName(code)) + '.', 'success');
    await renderAccount(FA, accountDetailHost);
    if (typeof FA.refreshChrome === 'function') FA.refreshChrome();
  }

  async function approveTxn(FA, id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }
    var r = await FA.api('/api/bank/transactions/' + encodeURIComponent(id) + '/approve', { method: 'POST' });
    if (!r || r.error) {
      if (btn) { btn.disabled = false; btn.textContent = 'Approve'; }
      FA.toast((r && r.error) || 'Could not approve that transaction.', 'error');
      return;
    }
    FA.toast('Posted to your books.', 'success');
    await renderAccount(FA, accountDetailHost);
    if (typeof FA.refreshChrome === 'function') FA.refreshChrome();
  }

  // ---- interactive AI classification guide -----------------------------------
  async function openClassifyGuide(FA) {
    var el = FA.el;
    var back = el('div', { class: 'modal-backdrop', onclick: function (e) { if (e.target === back) back.remove(); } });
    var body = el('div', { class: 'modal', style: { maxWidth: '640px', width: '92vw' } });
    back.appendChild(body);
    document.body.appendChild(back);

    body.appendChild(el('h3', null, 'Let’s classify your transactions'));
    var status = el('div', { class: 'muted', style: { marginTop: '-4px' } },
      el('span', { class: 'spinner' }), ' Reading the unknown transactions and asking the AI what they are…');
    body.appendChild(status);

    var r = await FA.api('/api/bank/classify-suggest', { json: { accountId: selectedId } });
    if (!r || r.error) {
      status.innerHTML = '';
      status.appendChild(el('div', { class: 'banner banner-warn' }, (r && r.error) || 'Could not get suggestions just now.'));
      body.appendChild(el('div', { class: 'modal-actions' }, el('button', { class: 'btn btn-ghost btn-sm', onclick: function () { back.remove(); } }, 'Close')));
      return;
    }
    var groups = Array.isArray(r.groups) ? r.groups : [];
    if (!groups.length) {
      status.innerHTML = '';
      status.appendChild(el('div', { class: 'footing-ok', style: { padding: '11px 14px', borderRadius: '12px' } },
        el('span', { html: FA.icon('check') }), el('span', null, 'Nothing left to classify — every transaction has an account.')));
      body.appendChild(el('div', { class: 'modal-actions' }, el('button', { class: 'btn btn-dark btn-sm', onclick: function () { back.remove(); } }, 'Done')));
      return;
    }

    // Step through each distinct group.
    var idx = 0;
    var appliedTotal = 0;
    var stepHost = el('div');
    body.innerHTML = '';
    body.appendChild(el('h3', null, 'Let’s classify your transactions'));
    body.appendChild(el('p', { class: 'muted', style: { marginTop: '-4px' } },
      'For each kind of transaction, confirm the account or pick another — we’ll apply it to every matching line.'));
    body.appendChild(stepHost);

    function renderStep() {
      var el = FA.el;
      stepHost.innerHTML = '';
      if (idx >= groups.length) {
        stepHost.appendChild(el('div', { class: 'footing-ok', style: { padding: '11px 14px', borderRadius: '12px' } },
          el('span', { html: FA.icon('check') }),
          el('span', null, 'All done — ' + appliedTotal + ' transaction' + (appliedTotal === 1 ? '' : 's') + ' classified.')));
        stepHost.appendChild(el('div', { class: 'modal-actions' },
          el('button', { class: 'btn btn-dark btn-sm', onclick: function () { back.remove(); renderAccount(FA, accountDetailHost); if (FA.refreshChrome) FA.refreshChrome(); } }, 'Finish')));
        return;
      }
      var g = groups[idx];
      var suggestedCode = g.suggestedCode || '9999';

      stepHost.appendChild(el('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '6px' } }, 'Step ' + (idx + 1) + ' of ' + groups.length));
      stepHost.appendChild(el('div', { class: 'card card-pad', style: { marginBottom: '12px' } },
        el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, '“' + g.sample + '”'),
        el('div', { class: 'muted', style: { fontSize: '13px' } }, g.count + ' transaction' + (g.count === 1 ? '' : 's') + ' like this'),
        g.rationale ? el('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } }, 'AI: ' + g.rationale) : null,
        g.isNewAccount && g.suggestedCode ? el('div', { style: { marginTop: '6px' } }, el('span', { class: 'chip' }, 'suggests a new account: ' + g.suggestedCode + ' · ' + g.suggestedName)) : null));

      var sel = el('select', { class: 'select', style: { height: '38px', minWidth: '260px' } });
      // Ensure the suggested (possibly new) account is selectable.
      var known = {};
      CHART_ACCOUNTS.forEach(function (a) { known[a.code] = true; });
      if (g.suggestedCode && !known[g.suggestedCode]) {
        sel.appendChild(el('option', { value: g.suggestedCode, selected: 'selected' }, g.suggestedCode + ' · ' + (g.suggestedName || g.suggestedCode) + ' (new)'));
      }
      CHART_ACCOUNTS.forEach(function (a) {
        var o = el('option', { value: a.code }, a.code + ' · ' + a.name);
        if (a.code === suggestedCode) o.selected = true;
        sel.appendChild(o);
      });

      var apply = el('button', { class: 'btn btn-primary btn-sm' }, 'Apply to all ' + g.count);
      var skip = el('button', { class: 'btn btn-ghost btn-sm' }, 'Skip');
      apply.addEventListener('click', async function () {
        apply.disabled = true; apply.textContent = 'Applying…';
        var code = sel.value;
        var name = g.suggestedCode === code ? g.suggestedName : (chartName(code));
        var res = await FA.api('/api/bank/classify-apply', { json: { accountId: selectedId, signature: g.signature, code: code, name: name } });
        if (!res || res.error) { apply.disabled = false; apply.textContent = 'Apply to all ' + g.count; FA.toast((res && res.error) || 'Could not apply.', 'error'); return; }
        appliedTotal += Number(res.applied) || 0;
        await loadChart(FA);
        idx++; renderStep();
      });
      skip.addEventListener('click', function () { idx++; renderStep(); });

      stepHost.appendChild(el('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        el('span', { class: 'muted', style: { fontSize: '13px' } }, 'Post to'), sel));
      stepHost.appendChild(el('div', { class: 'modal-actions' }, skip, apply));
    }
    renderStep();
  }
})();
