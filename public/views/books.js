/* Fund Autopilot — Books & reports view.
   Period toolbar (working month + filter + start new month) and three report
   tabs (Portfolio / Ledger / Trial balance), each with a Download CSV link.
   All figures come from POSTED journal lines via the report endpoints — never
   fabricated here. Defensive throughout: never throws, guards missing data. */
(function () {
  'use strict';

  var TABS = [
    {
      id: 'portfolio',
      label: 'Portfolio',
      help: 'A snapshot of what each holding is worth in your books.',
    },
    {
      id: 'ledger',
      label: 'Ledger',
      help: 'Every approved entry, line by line.',
    },
    {
      id: 'trial-balance',
      label: 'Trial balance',
      help: 'Each account totalled up — debits should equal credits.',
    },
    {
      id: 'pnl',
      label: 'Profit & loss',
      help: 'Income less expenses for the period — your management P&L.',
    },
    {
      id: 'balance-sheet',
      label: 'Balance sheet',
      help: 'What the fund owns and owes as at the period end.',
    },
    {
      id: 'audit',
      label: 'Audit trail',
      help: 'An immutable, tamper-evident log of every edit, posting and reversal — who, what and when.',
    },
  ];

  // Active tab persists across re-renders within a session.
  var activeTab = 'portfolio';

  function prettyInstrument(i) {
    if (i === 'SHARES') return 'Shares';
    if (i === 'LOAN') return 'Loan';
    return i || '—';
  }

  /** Suggest the month AFTER the latest period present, else '2025-04'. */
  function suggestNextMonth(periods) {
    var list = (Array.isArray(periods) ? periods : [])
      .map(function (p) { return p && p.period; })
      .filter(Boolean);
    if (!list.length) return '2025-04';
    var latest = list.slice().sort().pop();
    var m = /^(\d{4})-(\d{2})$/.exec(latest);
    if (!m) return '2025-04';
    var year = Number(m[1]);
    var mon = Number(m[2]) + 1;
    if (mon > 12) { mon = 1; year += 1; }
    return year + '-' + String(mon).padStart(2, '0');
  }

  function exportHref(tab, FA) {
    return '/api/export/' + tab + FA.periodQuery();
  }

  window.FA.registerView('books', { label: 'Books & reports', render: render });

  async function render(mount, FA) {
    var el = FA.el;

    // ---- Header --------------------------------------------------------------
    var fsBtn = el('a', { class: 'btn btn-dark btn-sm', href: '/api/report/fs' + FA.periodQuery(), target: '_blank', rel: 'noopener',
      title: 'Open a printable financial-statements pack (P&L, balance sheet, trial balance) with a cover page' },
      el('span', { class: 'ico', html: FA.icon('books') }), 'Financial statements report');
    // Download a ZIP of every supporting document for the selected period (read at
    // click time so it follows the month/year filter; no filter = the whole book).
    var evBtn = el('button', { class: 'btn btn-ghost btn-sm',
      title: 'Download a ZIP of all supporting evidence for the selected period, with a manifest of what each file supports',
      onclick: function () { window.open('/api/evidence/zip' + FA.periodQuery(), '_blank', 'noopener'); } },
      el('span', { class: 'ico', html: FA.icon('documents') }), 'Download evidence pack');
    mount.appendChild(
      el('div', { class: 'spread', style: { marginBottom: '18px', alignItems: 'flex-start', gap: '16px' } },
        el('div', null,
          el('h1', { class: 'section-title' }, 'Books & reports'),
          el('p', { class: 'section-help' },
            "Everything you've approved, totted up. Download any report as a spreadsheet, the full financial-statements pack, or a ZIP of all supporting evidence for the period.")),
        el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, evBtn, fsBtn)));

    // ---- Period toolbar ------------------------------------------------------
    var toolbar = el('div', { class: 'card card-pad spread', style: { gap: '16px', flexWrap: 'wrap', marginBottom: '18px' } });
    mount.appendChild(toolbar);

    var workingLabel = el('div', { class: 'muted' }, 'Working month: …');
    var periodSelect = el('select', { class: 'select', title: 'Filter the books by month' });
    var leftSide = el('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap', alignItems: 'center' } },
      workingLabel, periodSelect);
    toolbar.appendChild(leftSide);

    // Start-new-month control: a month input + confirm button (revealed on click).
    var monthInput = el('input', { type: 'month', class: 'input', style: { display: 'none', width: 'auto' } });
    var confirmBtn = el('button', { class: 'btn btn-dark btn-sm', style: { display: 'none' } }, 'Confirm');
    var startBtn = el('button', { class: 'btn btn-secondary btn-sm' },
      el('span', { class: 'ico', html: FA.icon('plus') }), 'Start new month');
    var lockBtn = el('button', { class: 'btn btn-ghost btn-sm', style: { display: 'none' } }, 'Lock month');
    var rightSide = el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, lockBtn, startBtn, monthInput, confirmBtn);
    toolbar.appendChild(rightSide);

    // Populate the toolbar from /api/periods (defensive — keep it usable on failure).
    var periodsData = await FA.api('/api/periods');
    var periods = (periodsData && !periodsData.error && Array.isArray(periodsData.periods)) ? periodsData.periods : [];
    var current = (periodsData && !periodsData.error && periodsData.current) || null;
    var suggested = suggestNextMonth(periods);

    workingLabel.textContent = 'Working month: ' + (current ? FA.monthLabel(current) : 'All months');

    // Build the month filter: All months + one option per period (with counts).
    periodSelect.appendChild(el('option', { value: 'all' }, 'All months'));
    periods.forEach(function (p) {
      if (!p || !p.period) return;
      var pending = Number(p.pending) || 0;
      var posted = Number(p.posted) || 0;
      var label = FA.monthLabel(p.period) + ' (' + pending + ' to review · ' + posted + ' booked)';
      periodSelect.appendChild(el('option', { value: p.period }, label));
    });
    // Reflect the shared period state; clamp to 'all' if it no longer exists.
    var known = { all: true };
    periods.forEach(function (p) { if (p && p.period) known[p.period] = true; });
    periodSelect.value = known[FA.state.period] ? FA.state.period : 'all';

    // The shared period filter threads through everything: changing it calls
    // FA.setPeriod, which re-renders this whole view (rebuilding the toolbar and
    // re-fetching the active report with the new FA.periodQuery()).
    periodSelect.addEventListener('change', function () {
      FA.setPeriod(periodSelect.value || 'all');
    });

    startBtn.addEventListener('click', function () {
      var showing = monthInput.style.display !== 'none';
      if (showing) {
        monthInput.style.display = 'none';
        confirmBtn.style.display = 'none';
        return;
      }
      monthInput.value = suggested || '2025-04';
      monthInput.style.display = '';
      confirmBtn.style.display = '';
      try { monthInput.focus(); } catch (e) {}
    });

    confirmBtn.addEventListener('click', async function () {
      var period = (monthInput.value || '').trim();
      if (!/^\d{4}-\d{2}$/.test(period)) {
        FA.toast('Please pick a valid month.', 'warn');
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Starting…';
      var r = await FA.api('/api/period', { json: { period: period } });
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm';
      if (r && r.error) { FA.toast(r.error, 'error'); return; }
      FA.toast('Started ' + FA.monthLabel(period) + '.', 'success');
      // New month becomes both the working month and the active filter; this
      // re-renders the view (which re-reads /api/periods → updated working month).
      FA.setPeriod(period);
    });

    // ---- Period lock (close the filtered month so nothing else posts into it) -
    // Only meaningful for a specific month (not the "All months" view).
    var locksData = await FA.api('/api/period-locks');
    var lockedList = (locksData && !locksData.error && Array.isArray(locksData.locked)) ? locksData.locked : [];
    var filtered = FA.state.period;
    function paintLock() {
      if (!filtered || filtered === 'all') { lockBtn.style.display = 'none'; return; }
      var isLocked = lockedList.indexOf(filtered) >= 0;
      lockBtn.style.display = '';
      lockBtn.textContent = isLocked ? 'Reopen ' + FA.monthLabel(filtered) : 'Lock ' + FA.monthLabel(filtered);
      lockBtn.className = 'btn btn-sm ' + (isLocked ? 'btn-secondary' : 'btn-ghost');
      lockBtn.title = isLocked
        ? 'This month is closed — no posting, editing or reversing into it. Click to reopen.'
        : 'Close this month: once locked, nothing can be posted, edited or reversed into it.';
    }
    paintLock();
    if (filtered && filtered !== 'all') {
      // Show a closed badge in the working label when the filtered month is locked.
      if (lockedList.indexOf(filtered) >= 0) {
        workingLabel.appendChild(el('span', { class: 'badge warn', style: { marginLeft: '8px' } }, 'Closed'));
      }
    }
    lockBtn.addEventListener('click', async function () {
      var isLocked = lockedList.indexOf(filtered) >= 0;
      var action = isLocked ? 'unlock' : 'lock';
      if (!isLocked) {
        var ok = await FA.confirmAction('Close ' + FA.monthLabel(filtered) +
          '? After locking, no entry can be posted, edited or reversed into this month until you reopen it.');
        if (!ok) return;
      }
      lockBtn.disabled = true;
      var r = await FA.api('/api/period-locks', { json: { period: filtered, action: action } });
      lockBtn.disabled = false;
      if (r && r.error) { FA.toast(r.error, 'error'); return; }
      lockedList = Array.isArray(r.locked) ? r.locked : lockedList;
      FA.toast(isLocked ? FA.monthLabel(filtered) + ' reopened.' : FA.monthLabel(filtered) + ' closed (locked).',
        isLocked ? 'info' : 'success');
      reRenderBooks(FA, mount);
    });

    // ---- Opening balances (start from an existing trial balance) -------------
    var openingCard = el('div', { class: 'card card-pad', style: { marginBottom: '18px' } });
    mount.appendChild(openingCard);
    await fillOpeningCard(openingCard, FA, mount);

    // ---- Tabs ----------------------------------------------------------------
    var tabsBar = el('div', { class: 'tabs', style: { marginBottom: '16px' } });
    TABS.forEach(function (t) {
      var tab = el('button', { class: 'tab' + (t.id === activeTab ? ' active' : '') }, t.label);
      tab.addEventListener('click', function () {
        if (t.id === activeTab) return;
        activeTab = t.id;
        tabsBar.querySelectorAll('.tab').forEach(function (n) { n.classList.remove('active'); });
        tab.classList.add('active');
        renderTab(reportCard, FA);
      });
      tabsBar.appendChild(tab);
    });
    mount.appendChild(tabsBar);

    // ---- Report card (re-filled per active tab) ------------------------------
    var reportCard = el('div', { class: 'card' });
    mount.appendChild(reportCard);
    await renderTab(reportCard, FA);
  }

  function tabMeta(id) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return TABS[i];
    return TABS[0];
  }

  // ---- Opening balances ------------------------------------------------------
  // A client who already keeps books can import their existing trial balance as
  // the brought-forward starting position, then keep building on it.
  async function fillOpeningCard(card, FA, viewMount) {
    var el = FA.el;
    card.innerHTML = '';

    var r = await FA.api('/api/opening');
    var ob = (r && !r.error) ? r.openingBalance : null;

    var info = el('div', null,
      el('div', { style: { fontWeight: '600', fontFamily: 'var(--font-display)' } }, 'Opening balances'),
      el('div', { class: 'section-help', style: { margin: '2px 0 0', maxWidth: '560px' } },
        ob
          ? (ob.lines.length + ' account' + (ob.lines.length === 1 ? '' : 's') + ' brought forward into ' +
             FA.monthLabel(ob.period) + '. Your trial balance, ledger and portfolio build on top of these.')
          : 'Already keep books elsewhere? Import your existing trial balance and the autopilot continues from it instead of starting at zero.'));

    var actions = el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } });
    if (ob) actions.appendChild(el('span', { class: 'badge lime' }, 'In place'));
    var primary = el('button', { class: 'btn btn-dark btn-sm' },
      el('span', { class: 'ico', html: FA.icon('upload') }), ob ? 'Replace' : 'Import trial balance');
    primary.addEventListener('click', function () {
      openOpeningModal(FA, function () { reRenderBooks(FA, viewMount); });
    });
    actions.appendChild(primary);
    if (ob) {
      var clearBtn = el('button', { class: 'btn btn-ghost btn-sm' }, 'Clear');
      clearBtn.addEventListener('click', async function () {
        var ok = await FA.confirmAction('Remove the imported opening balances? Entries you have approved since are kept.');
        if (!ok) return;
        var d = await FA.api('/api/opening', { method: 'DELETE' });
        if (d && d.error) { FA.toast(d.error, 'error'); return; }
        FA.toast('Opening balances cleared.', 'success');
        reRenderBooks(FA, viewMount);
      });
      actions.appendChild(clearBtn);
    }

    card.appendChild(el('div', { class: 'spread', style: { gap: '16px', flexWrap: 'wrap', alignItems: 'center' } }, info, actions));
  }

  // Re-render the whole Books view in place (after an opening-balance change so
  // every report reflects the new starting position).
  function reRenderBooks(FA, viewMount) {
    if (!viewMount) return;
    viewMount.innerHTML = '';
    render(viewMount, FA);
  }

  // Modal: paste or upload a trial balance, preview it, then import when balanced.
  function openOpeningModal(FA, onDone) {
    var el = FA.el;

    var ta = el('textarea', {
      class: 'input',
      rows: '9',
      spellcheck: 'false',
      style: { width: '100%', minHeight: '150px', fontFamily: 'var(--font-mono, monospace)', fontSize: '12.5px', resize: 'vertical' },
    });
    ta.value = '';
    ta.placeholder = 'Paste your trial balance (CSV)…\n\n'
      + 'Code,Account,Debit,Credit\n'
      + '1010,Bank,250000,\n'
      + '030-gamivo,Gamivo S.A. (shares),250000,\n'
      + '030-booste,Booste S.A. (shares),180000,\n'
      + '032-climax,Climax Sp. z o.o. (loan),120000,\n'
      + '3000,Share capital,,800000';

    var fileInput = el('input', { type: 'file', accept: '.csv,.txt', style: { display: 'none' } });
    var preview = el('div', { style: { marginTop: '12px' } });
    var importBtn = el('button', { class: 'btn btn-primary btn-sm', disabled: 'disabled' }, 'Import as opening balances');

    function close() { back.remove(); }

    async function doPreview() {
      var csv = ta.value || '';
      preview.innerHTML = '';
      importBtn.disabled = true;
      if (!csv.trim()) { return; }
      preview.appendChild(el('div', { class: 'muted', style: { fontSize: '13px' } }, el('span', { class: 'spinner' }), ' Reading…'));
      var r = await FA.api('/api/opening/preview', { json: { csv: csv } });
      preview.innerHTML = '';
      if (!r || r.error) { preview.appendChild(el('div', { class: 'banner banner-warn' }, (r && r.error) || 'Could not read that.')); return; }
      preview.appendChild(renderPreviewTable(FA, r));
      importBtn.disabled = !r.balanced;
    }

    var debounce;
    ta.addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(doPreview, 350); });

    var fileBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' },
      el('span', { class: 'ico', html: FA.icon('upload') }), 'Choose a CSV file');
    fileBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { ta.value = String(reader.result || ''); doPreview(); };
      reader.readAsText(f);
      fileInput.value = '';
    });

    importBtn.addEventListener('click', async function () {
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      var r = await FA.api('/api/opening', { json: { csv: ta.value || '' } });
      if (!r || r.error) {
        importBtn.disabled = false;
        importBtn.textContent = 'Import as opening balances';
        FA.toast((r && r.error) || 'Could not import that trial balance.', 'error');
        return;
      }
      FA.toast('Opening balances imported.', 'success');
      close();
      if (typeof onDone === 'function') onDone();
      if (typeof FA.refreshChrome === 'function') FA.refreshChrome();
    });

    var back = el('div', { class: 'modal-backdrop', onclick: function (e) { if (e.target === back) close(); } },
      el('div', { class: 'modal', style: { maxWidth: '640px', width: '92vw' } },
        el('h3', null, 'Start from an existing trial balance'),
        el('p', { class: 'muted', style: { marginTop: '-4px' } },
          'Paste or upload your current trial balance. We read it as-is — it must balance (debits equal credits) before it can become your starting position.'),
        el('div', { class: 'banner', style: { marginBottom: '10px', fontSize: '12.5px' } },
          el('strong', null, 'Tip — break down portfolios and loans by company. '),
          'Give each shareholding its own ',
          el('code', null, '030-<company>'),
          ' line and each loan its own ',
          el('code', null, '032-<company>'),
          ' line (e.g. ',
          el('code', null, '030-gamivo'),
          ', ',
          el('code', null, '032-climax'),
          '). Those opening figures then show as individual holdings in Portfolio and Loans, and a later sale or repayment draws down the right one. Plain ',
          el('code', null, '030'),
          ' / ',
          el('code', null, '032'),
          ' single lines also work.'),
        ta,
        el('div', { class: 'row', style: { gap: '8px', marginTop: '10px' } }, fileBtn, fileInput),
        preview,
        el('div', { class: 'modal-actions' },
          el('button', { class: 'btn btn-ghost btn-sm', onclick: close }, 'Cancel'),
          importBtn)));
    document.body.appendChild(back);
    try { ta.focus(); } catch (e) {}
  }

  function renderPreviewTable(FA, r) {
    var el = FA.el;
    var rows = Array.isArray(r.rows) ? r.rows : [];
    var wrap = el('div');

    if (Array.isArray(r.errors) && r.errors.length) {
      wrap.appendChild(el('div', { class: 'banner banner-warn', style: { marginBottom: '10px' } },
        r.errors.slice(0, 4).join(' ')));
    }
    if (!rows.length) {
      wrap.appendChild(el('div', { class: 'muted', style: { fontSize: '13px' } }, 'No accounts found yet.'));
      return wrap;
    }

    var table = el('table', { class: 'tbl' });
    table.appendChild(el('thead', null, el('tr', null,
      el('th', null, 'Code'), el('th', null, 'Account'),
      el('th', { class: 't-right' }, 'Debit'), el('th', { class: 't-right' }, 'Credit'))));
    var tbody = el('tbody');
    rows.slice(0, 60).forEach(function (row) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'muted' }, row.accountCode),
        el('td', null, row.accountName || '—'),
        el('td', { class: 't-right num' }, row.debit ? FA.money(row.debit) : ''),
        el('td', { class: 't-right num' }, row.credit ? FA.money(row.credit) : '')));
    });
    table.appendChild(tbody);

    var t = r.totals || {};
    var balanced = !!r.balanced;
    table.appendChild(el('tfoot', null, el('tr', null,
      el('td', null, el('strong', null, 'Total')),
      el('td', null, el('span', { class: 'badge ' + (balanced ? 'lime' : 'warn') }, balanced ? 'Balanced' : 'Out of balance')),
      el('td', { class: 't-right num' }, el('strong', null, FA.money(Number(t.debit) || 0))),
      el('td', { class: 't-right num' }, el('strong', null, FA.money(Number(t.credit) || 0))))));

    if (rows.length > 60) wrap.appendChild(el('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '6px' } }, 'Showing first 60 of ' + rows.length + ' accounts.'));
    wrap.appendChild(el('div', { style: { overflowX: 'auto' } }, table));
    if (!balanced) {
      wrap.appendChild(el('div', { class: 'section-help', style: { marginTop: '8px' } },
        'Difference of ' + FA.money(Math.abs(Number(r.difference) || 0)) + ' — adjust it so debits equal credits, then import.'));
    }
    return wrap;
  }

  function emptyState(FA, msg) {
    return FA.el('div', { class: 'empty' }, msg);
  }

  async function renderTab(card, FA) {
    var el = FA.el;
    var meta = tabMeta(activeTab);
    card.innerHTML = '';

    // Card header: a friendly hint on the left, Download CSV on the right.
    var csvSupported = activeTab === 'portfolio' || activeTab === 'ledger' || activeTab === 'trial-balance';
    card.appendChild(
      el('div', { class: 'card-pad spread', style: { gap: '16px', flexWrap: 'wrap', alignItems: 'center' } },
        el('div', { class: 'section-help' }, meta.help),
        csvSupported ? el('a', {
          class: 'btn btn-ghost btn-sm',
          href: exportHref(activeTab, FA),
          download: '',
          title: 'Download this report as a CSV spreadsheet',
        }, el('span', { class: 'ico', html: FA.icon('upload') }), 'Download CSV') : null));

    var body = el('div', { class: 'card-pad', style: { paddingTop: '0' } },
      el('div', { class: 'muted', style: { padding: '8px 0' } },
        el('span', { class: 'spinner' }), ' Totting up your books…'));
    card.appendChild(body);

    var content;
    if (activeTab === 'portfolio') content = await renderPortfolio(FA);
    else if (activeTab === 'ledger') content = await renderLedger(FA);
    else if (activeTab === 'pnl') content = await renderPnl(FA);
    else if (activeTab === 'balance-sheet') content = await renderBalanceSheet(FA);
    else if (activeTab === 'audit') content = await renderAudit(FA);
    else content = await renderTrialBalance(FA);

    body.innerHTML = '';
    body.appendChild(content);
  }

  // ---- Profit & loss ---------------------------------------------------------
  async function renderPnl(FA) {
    var el = FA.el;
    var r = await FA.api('/api/report/pnl' + FA.periodQuery());
    if (!r || r.error) return emptyState(FA, (r && r.error) || 'We could not load the P&L just now.');
    var rev = Array.isArray(r.revenue) ? r.revenue : [];
    var exp = Array.isArray(r.expenses) ? r.expenses : [];
    if (!rev.length && !exp.length) return emptyState(FA, 'No income or expenses booked yet for this period.');

    var table = el('table', { class: 'tbl' });
    var tbody = el('tbody');
    function section(title, rows, total) {
      tbody.appendChild(el('tr', { style: { background: 'var(--surface-soft)' } },
        el('td', { style: { fontWeight: '700' } }, title), el('td', { class: 't-right', style: { fontWeight: '700' } }, '')));
      rows.forEach(function (l) {
        tbody.appendChild(el('tr', null,
          el('td', { style: { paddingLeft: '24px' } }, (l.accountCode ? l.accountCode + ' · ' : '') + l.accountName),
          el('td', { class: 't-right num' }, FA.money(l.amount))));
      });
      tbody.appendChild(el('tr', null,
        el('td', { style: { paddingLeft: '24px', fontWeight: '600' } }, 'Total ' + title.toLowerCase()),
        el('td', { class: 't-right num', style: { fontWeight: '600' } }, FA.money(total))));
    }
    table.appendChild(el('thead', null, el('tr', null, el('th', null, 'Account'), el('th', { class: 't-right' }, 'EUR'))));
    table.appendChild(tbody);
    section('Revenue', rev, r.totalRevenue);
    section('Expenses', exp, r.totalExpenses);
    var profit = Number(r.netProfit) || 0;
    table.appendChild(el('tfoot', null, el('tr', null,
      el('td', null, el('strong', null, profit >= 0 ? 'Net profit' : 'Net loss')),
      el('td', { class: 't-right num' }, el('strong', { style: { color: profit >= 0 ? 'var(--lime-ink, #4d7c0f)' : 'var(--orange, #b9770a)' } }, FA.money(Math.abs(profit)))))));
    return el('div', { style: { overflowX: 'auto' } }, table);
  }

  // ---- Balance sheet ---------------------------------------------------------
  async function renderBalanceSheet(FA) {
    var el = FA.el;
    var r = await FA.api('/api/report/balance-sheet' + FA.periodQuery());
    if (!r || r.error) return emptyState(FA, (r && r.error) || 'We could not load the balance sheet just now.');
    var a = Array.isArray(r.assets) ? r.assets : [];
    var l = Array.isArray(r.liabilities) ? r.liabilities : [];
    var e = Array.isArray(r.equity) ? r.equity : [];
    if (!a.length && !l.length && !e.length) return emptyState(FA, 'Nothing on the balance sheet yet — post some entries first.');

    var table = el('table', { class: 'tbl' });
    var tbody = el('tbody');
    function section(title, rows, total) {
      tbody.appendChild(el('tr', { style: { background: 'var(--surface-soft)' } },
        el('td', { style: { fontWeight: '700' } }, title), el('td', { class: 't-right' }, '')));
      rows.forEach(function (x) {
        tbody.appendChild(el('tr', null,
          el('td', { style: { paddingLeft: '24px' } }, (x.accountCode && x.accountCode !== '—' ? x.accountCode + ' · ' : '') + x.accountName),
          el('td', { class: 't-right num' }, FA.money(x.amount))));
      });
      tbody.appendChild(el('tr', null,
        el('td', { style: { paddingLeft: '24px', fontWeight: '600' } }, 'Total ' + title.toLowerCase()),
        el('td', { class: 't-right num', style: { fontWeight: '600' } }, FA.money(total))));
    }
    table.appendChild(el('thead', null, el('tr', null, el('th', null, 'Account'), el('th', { class: 't-right' }, 'EUR'))));
    table.appendChild(tbody);
    section('Assets', a, r.totalAssets);
    section('Liabilities', l, r.totalLiabilities);
    section('Equity', e, r.totalEquity);
    var balanced = !!r.balanced;
    table.appendChild(el('tfoot', null, el('tr', null,
      el('td', null, el('strong', null, 'Assets = Liabilities + Equity'),
        el('span', { class: 'badge ' + (balanced ? 'lime' : 'warn'), style: { marginLeft: '8px' } }, balanced ? 'Balanced' : 'Out by ' + FA.money(Math.abs(Number(r.difference) || 0)))),
      el('td', { class: 't-right num' }, el('strong', null, FA.money(r.totalAssets) + '  =  ' + FA.money(Number(r.totalLiabilities) + Number(r.totalEquity)))))));
    return el('div', { style: { overflowX: 'auto' } }, table);
  }

  // ---- Portfolio -------------------------------------------------------------
  async function renderPortfolio(FA) {
    var el = FA.el;
    var r = await FA.api('/api/report/portfolio' + FA.periodQuery());
    if (!r || r.error) {
      return emptyState(FA, (r && r.error) ? r.error : 'We could not load the portfolio just now.');
    }
    var rows = Array.isArray(r.rows) ? r.rows : [];
    if (!rows.length) {
      return emptyState(FA, 'No holdings yet. Approve a "Bought shares" or "Loan advanced" transaction and it will appear here.');
    }

    var revalDate = rows[0] && rows[0].revalDate ? rows[0].revalDate : '';
    var table = el('table', { class: 'tbl' });
    table.appendChild(el('thead', null,
      el('tr', null,
        el('th', null, 'Investee'),
        el('th', null, 'Type'),
        el('th', null, 'Account'),
        el('th', { class: 't-right' }, 'Carrying value (cost)'),
        el('th', { class: 't-right', title: 'Re-valued to EUR at the period-end / closing FX rate' + (revalDate ? ' (' + revalDate + ')' : '') }, 'Revalued (EUR)'),
        el('th', { class: 't-right' }, 'FX movement'))));

    var tbody = el('tbody');
    rows.forEach(function (row) {
      var carry = Number(row.carryingValue) || 0;
      var reval = row.revaluedValue != null ? Number(row.revaluedValue) : carry;
      var delta = Math.round((reval - carry) * 100) / 100;
      // Fair-value remeasurement action (trap T7): only for equity holdings (030).
      var nameCell;
      if (row.controlCode && String(row.controlCode).indexOf('032') !== 0) {
        var revBtn = el('button', { class: 'btn btn-ghost btn-sm', style: { marginLeft: '8px', padding: '2px 8px', fontSize: '11px' },
          title: 'Remeasure this holding to fair value (IFRS 9 FVTPL) — books the movement to P&L for review' }, 'Revalue');
        revBtn.addEventListener('click', function () { revalueHolding(FA, row); });
        nameCell = el('td', null, row.investeeName || '—', revBtn);
      } else {
        nameCell = el('td', null, row.investeeName || '—');
      }
      tbody.appendChild(el('tr', null,
        nameCell,
        el('td', null, instrumentBadge(FA, row.instrument)),
        el('td', { class: 'muted' }, row.controlCode || '—'),
        el('td', { class: 't-right num' }, FA.money(row.carryingValue, row.currency)),
        el('td', { class: 't-right num', title: row.revalFxRate ? ('1 ' + (row.currency || 'EUR') + ' = ' + Number(row.revalFxRate).toLocaleString('en-IE', { maximumFractionDigits: 6 }) + ' EUR' + (row.revalDate ? ' on ' + row.revalDate : '')) : '' }, FA.money(reval, 'EUR')),
        el('td', { class: 't-right num', style: { color: delta >= 0 ? 'var(--lime-ink, #4d7c0f)' : 'var(--orange, #b9770a)' } }, (delta >= 0 ? '+' : '') + FA.money(delta, 'EUR'))));
    });
    table.appendChild(tbody);

    // Totals per parent control code, plus a grand total.
    var totals = Array.isArray(r.totals) ? r.totals : [];
    var tfoot = el('tfoot');
    var grand = 0;
    var grandReval = 0;
    rows.forEach(function (row) {
      grandReval += row.revaluedValue != null ? Number(row.revaluedValue) : (Number(row.carryingValue) || 0);
    });
    totals.forEach(function (t) {
      if (!t) return;
      var amt = Number(t.total) || 0;
      grand += amt;
      var revalAmt = 0;
      rows.forEach(function (row) {
        if ((row.controlCode || '') === (t.controlCode || '')) {
          revalAmt += row.revaluedValue != null ? Number(row.revaluedValue) : (Number(row.carryingValue) || 0);
        }
      });
      tfoot.appendChild(el('tr', null,
        el('td', { class: 'muted' }, 'Subtotal'),
        el('td', null, ''),
        el('td', { class: 'muted' }, t.controlCode || ''),
        el('td', { class: 't-right num' }, FA.money(amt)),
        el('td', { class: 't-right num' }, FA.money(revalAmt, 'EUR')),
        el('td', { class: 't-right num' }, FA.money(Math.round((revalAmt - amt) * 100) / 100, 'EUR'))));
    });
    var grandDelta = Math.round((grandReval - grand) * 100) / 100;
    tfoot.appendChild(el('tr', null,
      el('td', null, el('strong', null, 'Total invested')),
      el('td', null, ''),
      el('td', null, ''),
      el('td', { class: 't-right num' }, el('strong', null, FA.money(grand))),
      el('td', { class: 't-right num' }, el('strong', null, FA.money(grandReval, 'EUR'))),
      el('td', { class: 't-right num' }, el('strong', null, (grandDelta >= 0 ? '+' : '') + FA.money(grandDelta, 'EUR')))));
    table.appendChild(tfoot);

    return table;
  }

  function instrumentBadge(FA, instrument) {
    var isLoan = instrument === 'LOAN';
    return FA.el('span', { class: 'badge ' + (isLoan ? 'blue' : 'green') },
      isLoan ? 'Loan' : prettyInstrument(instrument));
  }

  // ---- Ledger ----------------------------------------------------------------
  async function renderLedger(FA) {
    var el = FA.el;
    var r = await FA.api('/api/report/ledger' + FA.periodQuery());
    if (!r || r.error) {
      return emptyState(FA, (r && r.error) ? r.error : 'We could not load the ledger just now.');
    }
    var lines = Array.isArray(r.lines) ? r.lines : [];
    if (!lines.length) {
      return emptyState(FA, 'Your ledger is empty. Approve a transaction and its entries will show here.');
    }

    // Group the lines per account (account code), each group sorted by date.
    var groups = {};
    var order = [];
    lines.forEach(function (ln) {
      var code = ln.accountCode || '—';
      if (!groups[code]) { groups[code] = { code: code, name: ln.accountName || code, lines: [] }; order.push(code); }
      groups[code].lines.push(ln);
    });
    order.sort();

    var hasFx = lines.some(function (ln) { return ln && ln.fxRate != null; });
    var colSpan = hasFx ? 5 : 4;
    var seenTxn = {}; // show one Reverse control per posted entry

    var table = el('table', { class: 'tbl' });
    var headCells = [
      el('th', null, 'Date'),
      el('th', null, 'Details'),
      el('th', { class: 't-right' }, 'Debit'),
      el('th', { class: 't-right' }, 'Credit'),
    ];
    if (hasFx) headCells.push(el('th', { class: 't-right' }, 'FX rate'));
    table.appendChild(el('thead', null, el('tr', null, headCells)));

    var tbody = el('tbody');
    order.forEach(function (code) {
      var g = groups[code];
      g.lines.sort(function (a, b) { return String(a.txnDate).localeCompare(String(b.txnDate)); });

      // Account header row.
      tbody.appendChild(el('tr', { style: { background: 'var(--surface-soft)' } },
        el('td', { colspan: String(colSpan), style: { fontWeight: '700' } }, code + ' · ' + g.name)));

      var sumDr = 0, sumCr = 0;
      g.lines.forEach(function (ln) {
        var amt = Number(ln.amount) || 0;
        var isDebit = amt >= 0;
        var abs = Math.abs(amt);
        if (isDebit) sumDr += abs; else sumCr += abs;

        // Details cell: text, a source-document link (doc↔entry trace), and — once
        // per posted investment entry — a Reverse control (corrections never delete).
        var detailText = ln.investeeName || ln.description || '—';
        var details = el('td', { class: 'muted' }, detailText);
        if (ln.documentId) {
          details.appendChild(el('a', {
            href: '/api/documents/' + encodeURIComponent(ln.documentId) + '/file',
            target: '_blank', rel: 'noopener',
            style: { marginLeft: '8px', fontSize: '11.5px' },
            title: 'Open the source document this entry came from' + (ln.docName ? ' (' + ln.docName + ')' : ''),
          }, '↗ source'));
        } else if (ln.statementId) {
          // A bank-statement-backed line: its evidence is the statement itself.
          details.appendChild(el('a', {
            href: '/api/bank/statements/' + encodeURIComponent(ln.statementId) + '/file',
            target: '_blank', rel: 'noopener',
            style: { marginLeft: '8px', fontSize: '11.5px' },
            title: 'Open the bank statement this entry came from',
          }, '↗ statement'));
        }
        var reversible = ln.txnId && ln.txnId !== 'gl' && ln.txnId !== 'opening'
          && ['BANK', 'ARAP', 'OPENING', 'REVERSAL'].indexOf(ln.eventType) < 0
          && !/^Reversal:/.test(ln.description || '');
        if (reversible && !seenTxn[ln.txnId]) {
          seenTxn[ln.txnId] = true;
          var rev = el('button', { class: 'btn btn-ghost btn-sm', style: { marginLeft: '10px', padding: '2px 8px', fontSize: '11.5px' },
            title: 'Reverse this posted entry with an equal-and-opposite entry' }, 'Reverse');
          rev.addEventListener('click', function () { reverseEntry(FA, ln.txnId, detailText); });
          details.appendChild(rev);
        }

        var cells = [
          el('td', { style: { paddingLeft: '24px' } }, FA.fmtDate(ln.txnDate)),
          details,
          el('td', { class: 't-right num' }, isDebit ? FA.money(abs) : ''),
          el('td', { class: 't-right num' }, !isDebit ? FA.money(abs) : ''),
        ];
        if (hasFx) cells.push(el('td', { class: 't-right num' }, ln.fxRate != null ? FA.num(ln.fxRate) : ''));
        tbody.appendChild(el('tr', null, cells));
      });

      // Subtotal row for the account (net movement).
      var subCells = [
        el('td', { style: { paddingLeft: '24px', fontWeight: '600' } }, 'Subtotal'),
        el('td', null, ''),
        el('td', { class: 't-right num', style: { fontWeight: '600' } }, sumDr ? FA.money(sumDr) : ''),
        el('td', { class: 't-right num', style: { fontWeight: '600' } }, sumCr ? FA.money(sumCr) : ''),
      ];
      if (hasFx) subCells.push(el('td', null, ''));
      tbody.appendChild(el('tr', { style: { borderBottom: '2px solid var(--hairline-light)' } }, subCells));
    });
    table.appendChild(tbody);

    return table;
  }

  // ---- Trial balance ---------------------------------------------------------
  async function renderTrialBalance(FA) {
    var el = FA.el;
    var r = await FA.api('/api/report/trial-balance' + FA.periodQuery());
    if (!r || r.error) {
      return emptyState(FA, (r && r.error) ? r.error : 'We could not load the trial balance just now.');
    }
    var rows = Array.isArray(r.rows) ? r.rows : [];
    if (!rows.length) {
      return emptyState(FA, 'Nothing to balance yet. Once you approve transactions, each account total appears here.');
    }

    var table = el('table', { class: 'tbl' });
    table.appendChild(el('thead', null,
      el('tr', null,
        el('th', null, 'Code'),
        el('th', null, 'Account'),
        el('th', { class: 't-right' }, 'Debit'),
        el('th', { class: 't-right' }, 'Credit'))));

    var tbody = el('tbody');
    var sumDr = 0, sumCr = 0;
    rows.forEach(function (row) {
      // Prefer explicit debit/credit; fall back to a single signed balance.
      var dr = row.debit, cr = row.credit;
      if (dr == null && cr == null) {
        var bal = Number(row.balance) || 0;
        dr = bal >= 0 ? bal : 0;
        cr = bal < 0 ? -bal : 0;
      }
      dr = Number(dr) || 0;
      cr = Number(cr) || 0;
      sumDr += dr;
      sumCr += cr;
      tbody.appendChild(el('tr', null,
        el('td', { class: 'muted' }, row.accountCode || '—'),
        el('td', null, row.accountName || '—'),
        el('td', { class: 't-right num' }, dr ? FA.money(dr) : ''),
        el('td', { class: 't-right num' }, cr ? FA.money(cr) : '')));
    });
    table.appendChild(tbody);

    var t = r.totals || {};
    var totalDr = Number(t.debit) || sumDr;
    var totalCr = Number(t.credit) || sumCr;
    var balanced = Math.abs(totalDr - totalCr) < 0.005;

    var tfoot = el('tfoot');
    tfoot.appendChild(el('tr', null,
      el('td', null, el('strong', null, 'Total')),
      el('td', null,
        el('span', { class: 'badge ' + (balanced ? 'lime' : 'warn') },
          balanced ? 'Balanced' : 'Out of balance')),
      el('td', { class: 't-right num' }, el('strong', null, FA.money(totalDr))),
      el('td', { class: 't-right num' }, el('strong', null, FA.money(totalCr)))));
    table.appendChild(tfoot);

    return table;
  }

  // Reverse a posted entry (asks for a reason, books an opposite entry, never deletes).
  async function reverseEntry(FA, txnId, label) {
    var ok = await FA.confirmAction('Reverse "' + (label || 'this entry') +
      '"? This books an equal-and-opposite posted entry. The original is kept for the audit trail — nothing is deleted.');
    if (!ok) return;
    var r = await FA.api('/api/drafts/' + encodeURIComponent(txnId) + '/reverse',
      { json: { reason: 'Reversed from ledger', actor: 'reviewer' } });
    if (r && r.error) { FA.toast(r.error, 'error'); return; }
    FA.toast('Entry reversed — an opposite entry was booked and logged.', 'success');
    FA.refreshChrome();
    FA.navigate('books'); // re-render; the Ledger tab stays active
  }

  // Trap T7: prompt for a fair value and file a remeasurement draft for review.
  async function revalueHolding(FA, row) {
    var carry = Number(row.carryingValue) || 0;
    var input = window.prompt(
      'Fair-value remeasurement (IFRS 9 FVTPL) — ' + (row.investeeName || row.controlCode) + '\n\n' +
      'Current carrying value: ' + FA.money(carry, 'EUR') + '\n' +
      'Enter the new fair value in EUR (the engine books the movement to P&L for your approval):',
      carry.toFixed(2));
    if (!input) return;
    var fv = Number(String(input).replace(/[^0-9.\-]/g, ''));
    if (!isFinite(fv)) { FA.toast('Please enter a numeric fair value.', 'error'); return; }
    var r = await FA.api('/api/investments/' + encodeURIComponent(row.controlCode) + '/revalue', { json: { fairValue: fv } });
    if (r && r.error) { FA.toast(r.error, 'error'); return; }
    var dir = r.direction === 'GAIN' ? 'gain' : 'loss';
    FA.toast('Remeasurement drafted (' + dir + ' ' + FA.money(Math.abs(r.movement), 'EUR') + ') — approve it in Review.', 'success');
    FA.refreshChrome();
  }

  // ---- Audit trail -----------------------------------------------------------
  var AUDIT_LABELS = {
    DRAFT_EDIT: 'Edited',
    DRAFT_POST: 'Posted',
    DRAFT_POST_BULK: 'Bulk posted',
    DRAFT_REJECT: 'Rejected',
    DRAFT_REVERSE: 'Reversed',
    PERIOD_LOCK: 'Period locked',
  };
  function auditBadgeClass(action) {
    if (action === 'DRAFT_REVERSE') return 'badge warn';
    if (action === 'DRAFT_REJECT') return 'badge';
    if (action === 'DRAFT_EDIT') return 'badge blue';
    return 'badge lime';
  }

  async function renderAudit(FA) {
    var el = FA.el;
    var r = await FA.api('/api/audit');
    if (!r || r.error) {
      return emptyState(FA, (r && r.error) ? r.error : 'We could not load the audit trail just now.');
    }
    var entries = Array.isArray(r.entries) ? r.entries : [];
    var integrity = r.integrity || { ok: true };

    var wrap = el('div', null);

    // Integrity banner: the chain is verified on every read.
    wrap.appendChild(el('div', {
      class: 'row',
      style: { gap: '10px', alignItems: 'center', marginBottom: '14px' },
    },
      el('span', { class: 'badge ' + (integrity.ok ? 'lime' : 'warn') },
        integrity.ok ? 'Tamper-evident chain verified' : 'Integrity check FAILED'),
      el('span', { class: 'muted', style: { fontSize: '12.5px' } },
        integrity.ok
          ? 'Every entry is hash-chained to the one before it; any change would break the chain.'
          : 'The log appears to have been altered at entry #' + (integrity.brokenAt + 1) + '.')));

    if (!entries.length) {
      wrap.appendChild(emptyState(FA, 'No activity yet. Edits, postings and reversals will appear here as you work.'));
      return wrap;
    }

    var table = el('table', { class: 'tbl' });
    table.appendChild(el('thead', null,
      el('tr', null,
        el('th', null, 'When'),
        el('th', null, 'Action'),
        el('th', null, 'Who'),
        el('th', null, 'Detail'))));
    var tbody = el('tbody');
    entries.forEach(function (e) {
      var when = e.at ? new Date(e.at).toLocaleString('en-IE') : '—';
      tbody.appendChild(el('tr', null,
        el('td', { class: 'muted', style: { whiteSpace: 'nowrap', fontSize: '12.5px' } }, when),
        el('td', null, el('span', { class: auditBadgeClass(e.action) }, AUDIT_LABELS[e.action] || e.action)),
        el('td', null, e.actor || 'system'),
        el('td', { style: { fontSize: '13px' } }, e.summary || '')));
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }
})();
