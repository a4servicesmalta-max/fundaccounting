/* aging.js — Debtors & creditors (AR/AP aging) view.
   Endpoint: GET /api/aging?asOf=YYYY-MM-DD -> { receivables, payables }
   where side = { buckets:{current,d1_30,d31_60,d61_90,d90_plus}, byCounterparty:[{counterparty,total,buckets}], total }.
   Upload: POST /api/aging/upload (multipart files[]). */
(function () {
  'use strict';

  const BUCKETS = [
    { key: 'current', label: 'Current', color: '#428619', soft: 'rgba(66,134,25,.10)' },
    { key: 'd1_30', label: '1–30', color: '#007bc2', soft: 'rgba(0,123,194,.10)' },
    { key: 'd31_60', label: '31–60', color: '#9a6b00', soft: 'rgba(236,126,0,.10)' },
    { key: 'd61_90', label: '61–90', color: '#c25500', soft: 'rgba(236,126,0,.16)' },
    { key: 'd90_plus', label: '90+', warn: true, color: '#e23b4a', soft: 'rgba(226,59,74,.12)' },
  ];

  function ensureAgingStyles() {
    if (document.getElementById('fa-aging-styles')) return;
    const css = [
      '.fa-bucket-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px}',
      '.fa-bucket{border-radius:14px;padding:12px 14px;border:1px solid var(--hairline-light,#e2e2e7)}',
      '.fa-bucket-top{display:flex;align-items:center;gap:7px;margin-bottom:7px}',
      '.fa-bucket-dot{width:9px;height:9px;border-radius:9999px;flex:none}',
      '.fa-bucket-label{font-size:11.5px;letter-spacing:.3px;text-transform:uppercase;font-weight:600;color:var(--mute,#505a63)}',
      '.fa-bucket-val{font-size:17px;font-weight:600;font-family:var(--font-display)}',
      '@media(max-width:760px){.fa-bucket-strip{grid-template-columns:repeat(2,1fr)}}',
    ].join('');
    const s = document.createElement('style');
    s.id = 'fa-aging-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function bucketsOf(obj) {
    const b = (obj && obj.buckets) || {};
    return BUCKETS.map((bk) => Number(b[bk.key]) || 0);
  }

  function sideHasData(side) {
    if (!side || typeof side !== 'object') return false;
    if (Number(side.total)) return true;
    const bc = Array.isArray(side.byCounterparty) ? side.byCounterparty : [];
    return bc.length > 0;
  }

  function render(mount, FA) {
    const el = FA.el;
    ensureAgingStyles();

    // ---- local view state --------------------------------------------------
    const st = { asOf: todayIso(), side: 'receivables', data: null, loading: false, autoPicked: false, items: [] };

    // ---- header: title + "as at" date -------------------------------------
    const asOfInput = el('input', {
      class: 'input',
      type: 'date',
      value: st.asOf,
      title: 'Show what was outstanding as at this date',
      onchange: (e) => { st.asOf = e.target.value || todayIso(); load(); },
    });

    const header = el('div', { class: 'spread', style: { marginBottom: '18px' } },
      el('div', null,
        el('div', { class: 'section-title' }, 'Debtors & creditors'),
        el('div', { class: 'section-help' }, 'Amounts still outstanding, grouped by how long they’ve been due.')),
      el('label', { class: 'row' },
        el('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'As at'),
        asOfInput));

    // ---- upload zone -------------------------------------------------------
    const fileInput = el('input', {
      type: 'file', multiple: true, accept: '.pdf,.png,.jpg,.jpeg,.csv,.xlsx,.xls',
      style: { display: 'none' },
      onchange: (e) => { const f = e.target.files; if (f && f.length) upload(f); e.target.value = ''; },
    });
    const uploadSummary = el('div', { class: 'muted', style: { marginTop: '12px', fontSize: '13.5px', display: 'none' } });
    const dropzone = el('div', { class: 'dropzone' },
      el('div', { html: FA.icon('upload'), style: { width: '34px', height: '34px', margin: '0 auto 10px', color: 'var(--mute)' } }),
      el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, 'Drop invoices or bills here'),
      el('div', { class: 'muted', style: { fontSize: '13px', marginBottom: '14px' } }, 'We read each one and sort it into the right aging bucket.'),
      el('button', { class: 'btn btn-dark btn-sm', onclick: () => fileInput.click() }, 'Choose files'),
      fileInput,
      uploadSummary);

    function setUploadSummary(msg, kind) {
      uploadSummary.textContent = msg || '';
      uploadSummary.style.display = msg ? '' : 'none';
      uploadSummary.style.color = kind === 'error' ? 'var(--orange, #c0392b)' : 'var(--mute)';
    }

    // drag & drop
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      const f = e.dataTransfer && e.dataTransfer.files;
      if (f && f.length) upload(f);
    });

    async function upload(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      setUploadSummary(files.length === 1 ? 'Reading your invoice…' : 'Reading your ' + files.length + ' files…');
      const fd = new FormData();
      files.forEach((f) => fd.append('files[]', f));
      const r = await FA.api('/api/aging/upload', { method: 'POST', body: fd });
      if (!r || r.error) { setUploadSummary((r && r.error) || 'Sorry, that upload did not work.', 'error'); return; }
      const items = Array.isArray(r.items) ? r.items : [];
      const read = Number(r.read != null ? r.read : (r.processed != null ? r.processed : items.length)) || files.length;
      let recv = Number(r.receivables);
      let pay = Number(r.payables);
      if (!isFinite(recv) || !isFinite(pay)) {
        recv = items.filter((i) => i && i.kind === 'RECEIVABLE').length;
        pay = items.filter((i) => i && i.kind === 'PAYABLE').length;
      }
      const detail = [];
      if (isFinite(recv) && (recv || pay)) detail.push(recv + ' debtor' + (recv === 1 ? '' : 's'));
      if (isFinite(pay) && (recv || pay)) detail.push(pay + ' creditor' + (pay === 1 ? '' : 's'));
      setUploadSummary('Read ' + read + ' file' + (read === 1 ? '' : 's') + (detail.length ? ' — ' + detail.join(', ') + '.' : '.'));
      FA.toast('Invoices read and sorted into aging buckets.', 'success');
      load();
    }

    // ---- tabs --------------------------------------------------------------
    const tabRecv = el('button', { class: 'tab', onclick: () => setSide('receivables') }, 'Receivables (debtors)');
    const tabPay = el('button', { class: 'tab', onclick: () => setSide('payables') }, 'Payables (creditors)');
    const tabs = el('div', { class: 'tabs', style: { margin: '20px 0 16px' } }, tabRecv, tabPay);

    function setSide(side) {
      st.side = side;
      tabRecv.classList.toggle('active', side === 'receivables');
      tabPay.classList.toggle('active', side === 'payables');
      paint();
    }

    // ---- table area --------------------------------------------------------
    const tableArea = el('div');

    // Individual open invoices/bills for one counterparty (the drill-down).
    function buildDrill(counterparty, kind) {
      const items = (st.items || []).filter((i) =>
        i && i.kind === kind && i.status === 'OPEN' && (i.counterparty || '(unknown)') === counterparty);
      if (!items.length) {
        return el('div', { class: 'muted', style: { padding: '10px 16px', fontSize: '13px' } }, 'No open items to show.');
      }
      items.sort((a, b) => String(a.dueDate || a.issueDate || '').localeCompare(String(b.dueDate || b.issueDate || '')));
      const inner = el('table', { class: 'tbl', style: { margin: '0' } });
      inner.appendChild(el('thead', null, el('tr', null,
        el('th', null, 'Document'),
        el('th', null, 'Issued'),
        el('th', null, 'Due'),
        el('th', { class: 't-right' }, 'Amount'),
        el('th', null, ''))));
      const tb = el('tbody');
      items.forEach((it) => {
        const link = it.documentId
          ? el('a', { href: '/api/documents/' + encodeURIComponent(it.documentId) + '/file', target: '_blank', rel: 'noopener', class: 'link' }, 'Open')
          : el('span', { class: 'muted' }, '—');
        const editBtn = el('button', { class: 'btn btn-ghost btn-sm', title: 'Edit this invoice/bill' }, 'Edit');
        const rc = Array.isArray(it.taxFlags) && it.taxFlags.some((f) => f && f.code === 'REVERSE_CHARGE');
        const row = el('tr', null,
          el('td', null, it.docName || '(invoice)',
            rc ? el('span', { class: 'badge warn', style: { marginLeft: '8px', fontSize: '10px' }, title: 'Cross-border service — account for VAT under the reverse charge (confirm place of supply).' }, 'reverse-charge?') : null),
          el('td', { class: 'muted' }, it.issueDate || '—'),
          el('td', { class: 'muted' }, it.dueDate || '—'),
          el('td', { class: 'num t-right' }, FA.money(it.amount, it.currency)),
          el('td', null, el('span', { class: 'row', style: { gap: '8px' } }, link, editBtn)));
        editBtn.addEventListener('click', () => showItemEdit(it, row));
        tb.appendChild(row);
      });
      inner.appendChild(tb);
      return el('div', { style: { padding: '4px 8px 12px 24px' } }, inner);
    }

    // Replace an item row with an inline edit form (kind, counterparty, amount,
    // currency, issued, due). Saving posts the change and reloads the report.
    function showItemEdit(it, row) {
      const kindSel = el('select', { class: 'select', style: { height: '32px' } },
        el('option', { value: 'RECEIVABLE' }, 'Receivable'),
        el('option', { value: 'PAYABLE' }, 'Payable'));
      kindSel.value = it.kind || 'PAYABLE';
      const cp = el('input', { class: 'input', value: it.counterparty || '', placeholder: 'Counterparty', style: { height: '32px', width: '160px' } });
      const amt = el('input', { class: 'input', type: 'number', step: '0.01', value: String(it.amount != null ? it.amount : ''), style: { height: '32px', width: '110px' } });
      const cur = el('input', { class: 'input', value: it.currency || 'EUR', style: { height: '32px', width: '64px' } });
      const issue = el('input', { class: 'input', type: 'date', value: it.issueDate || '', style: { height: '32px' } });
      const due = el('input', { class: 'input', type: 'date', value: it.dueDate || '', style: { height: '32px' } });
      const save = el('button', { class: 'btn btn-primary btn-sm' }, 'Save');
      const cancel = el('button', { class: 'btn btn-ghost btn-sm' }, 'Cancel');

      cancel.addEventListener('click', () => load());
      save.addEventListener('click', async () => {
        save.disabled = true; save.textContent = 'Saving…';
        const r = await FA.api('/api/aging/items/' + encodeURIComponent(it.id), {
          json: { kind: kindSel.value, counterparty: cp.value, amount: Number(amt.value), currency: cur.value, issueDate: issue.value, dueDate: due.value },
        });
        if (!r || r.error) { save.disabled = false; save.textContent = 'Save'; FA.toast((r && r.error) || 'Could not save.', 'error'); return; }
        FA.toast('Invoice updated.', 'success');
        load();
      });

      row.innerHTML = '';
      const cell = el('td', { colspan: '5' },
        el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center', padding: '4px 0' } },
          kindSel, cp, amt, cur,
          el('span', { class: 'muted', style: { fontSize: '12px' } }, 'Issued'), issue,
          el('span', { class: 'muted', style: { fontSize: '12px' } }, 'Due'), due,
          save, cancel));
      row.appendChild(cell);
    }

    // Colourful at-a-glance strip of the five aging buckets (visual only).
    function buildBucketStrip(side) {
      const vals = bucketsOf(side);
      return el('div', { class: 'fa-bucket-strip' },
        BUCKETS.map((b, i) => el('div', {
          class: 'fa-bucket',
          style: { background: b.soft, borderColor: b.color + '33' },
        },
          el('div', { class: 'fa-bucket-top' },
            el('span', { class: 'fa-bucket-dot', style: { background: b.color } }),
            el('span', { class: 'fa-bucket-label' }, b.label)),
          el('div', { class: 'fa-bucket-val num', style: { color: b.color } }, FA.money(vals[i] || 0)))));
    }

    function buildTable(side) {
      const rows = Array.isArray(side.byCounterparty) ? side.byCounterparty : [];

      const head = el('tr', null,
        el('th', null, 'Counterparty'),
        ...BUCKETS.map((b) => el('th', { class: 't-right' + (b.warn ? ' aging-warn-col' : ''), style: b.warn ? { color: 'var(--orange, #b9770a)' } : null }, b.label)),
        el('th', { class: 't-right' }, 'Total'));

      const kind = st.side === 'payables' ? 'PAYABLE' : 'RECEIVABLE';
      const totalCols = BUCKETS.length + 2; // counterparty + buckets + total

      const body = el('tbody');
      rows.forEach((row) => {
        const vals = bucketsOf(row);
        const total = Number(row.total) || vals.reduce((a, b) => a + b, 0);

        // Detail row (hidden until the counterparty is clicked).
        const detail = el('tr', { style: { display: 'none' } },
          el('td', { colspan: String(totalCols), style: { padding: '0 0 0 0', background: 'var(--surface-soft)' } },
            buildDrill(row.counterparty, kind)));

        const head = el('tr', { style: { cursor: 'pointer' }, title: 'Click to see the individual invoices/bills' },
          el('td', null,
            el('span', { style: { display: 'inline-block', width: '14px', color: 'var(--mute)' } }, '▸'),
            ' ', row.counterparty || '—'),
          ...vals.map((v, i) => el('td', {
            class: 'num t-right' + (BUCKETS[i].warn ? ' aging-warn-col' : ''),
            style: BUCKETS[i].warn ? { background: 'rgba(245, 158, 11, .08)' } : null,
          }, v ? FA.money(v) : '—')),
          el('td', { class: 'num t-right', style: { fontWeight: '700' } }, FA.money(total)));

        head.addEventListener('click', () => {
          const open = detail.style.display !== 'none';
          detail.style.display = open ? 'none' : '';
          const caret = head.querySelector('span');
          if (caret) caret.textContent = open ? '▸' : '▾';
        });

        body.appendChild(head);
        body.appendChild(detail);
      });

      const totVals = bucketsOf(side);
      const grand = Number(side.total) || totVals.reduce((a, b) => a + b, 0);
      const foot = el('tr', { style: { background: 'var(--surface-soft)' } },
        el('td', { style: { fontWeight: '700' } }, 'Total'),
        ...totVals.map((v, i) => el('td', {
          class: 'num t-right',
          style: Object.assign({ fontWeight: '700' }, BUCKETS[i].warn ? { background: 'rgba(245, 158, 11, .12)', color: 'var(--orange, #b9770a)' } : {}),
        }, FA.money(v))),
        el('td', { class: 'num t-right', style: { fontWeight: '700' } }, FA.money(grand)));

      const table = el('table', { class: 'tbl' },
        el('thead', null, head),
        body,
        el('tfoot', null, foot));

      return el('div', null, buildBucketStrip(side), el('div', { class: 'card card-pad' }, table));
    }

    function paint() {
      tableArea.innerHTML = '';
      if (st.loading) {
        tableArea.appendChild(el('div', { class: 'row', style: { justifyContent: 'center', padding: '40px' } },
          el('span', { class: 'spinner' }), el('span', { class: 'muted' }, 'Totting up who owes what…')));
        return;
      }
      const data = st.data || {};
      const recv = data.receivables || {};
      const pay = data.payables || {};
      const hasRecv = sideHasData(recv);
      const hasPay = sideHasData(pay);

      if (!hasRecv && !hasPay) {
        tableArea.appendChild(el('div', { class: 'empty' }, 'No invoices or bills yet — upload some above.'));
        return;
      }

      const side = st.side === 'payables' ? pay : recv;
      const hasSide = st.side === 'payables' ? hasPay : hasRecv;
      if (!hasSide) {
        tableArea.appendChild(el('div', { class: 'empty' },
          st.side === 'payables' ? 'Nothing owed to suppliers right now.' : 'No customers owe the fund right now.'));
        return;
      }
      tableArea.appendChild(buildTable(side));
    }

    async function load() {
      st.loading = true;
      paint();
      const [r, itemsRes] = await Promise.all([
        FA.api('/api/aging?asOf=' + encodeURIComponent(st.asOf)),
        FA.api('/api/aging/items'),
      ]);
      st.items = (itemsRes && !itemsRes.error && Array.isArray(itemsRes.items)) ? itemsRes.items : [];
      st.loading = false;
      if (!r || r.error) {
        st.data = null;
        tableArea.innerHTML = '';
        tableArea.appendChild(el('div', { class: 'empty' }, (r && r.error) || 'Could not load the aging report.'));
        return;
      }
      st.data = r;
      // Land the user on whichever side actually has data (once, before they tab).
      if (!st.autoPicked) {
        st.autoPicked = true;
        if (!sideHasData(r.receivables) && sideHasData(r.payables)) { setSide('payables'); return; }
      }
      paint();
    }

    // ---- assemble ----------------------------------------------------------
    mount.appendChild(header);
    mount.appendChild(el('div', { class: 'card card-pad', style: { marginBottom: '4px' } }, dropzone));
    mount.appendChild(tabs);
    mount.appendChild(tableArea);

    setSide('receivables');
    load();
  }

  FA.registerView('aging', { label: 'Aging', render: render });
})();
