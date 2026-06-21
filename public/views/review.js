/* review view — "What the document said" vs "What we booked" approval cards.
   Reuses the proven legacy review logic (public_legacy/app.js §3), re-skinned
   to the A4 redesign classes. Defensive throughout: never throws, guards data. */
(function () {
  'use strict';

  // Friendly, non-technical event names (from legacy EVENT_LABELS).
  var EVENT_LABELS = {
    ACQUISITION: 'Bought shares',
    DISPOSAL: 'Sold shares',
    LOAN_ADVANCE: 'Loan advanced',
    LOAN_REPAYMENT: 'Loan repaid',
    DISTRIBUTION: 'Dividend / distribution received',
    INTEREST_ACCRUAL: 'Interest accrued',
    FX_REVAL: 'Currency revaluation',
    WRITE_OFF: 'Write-off',
    JOURNAL: 'Suggested journal entry',
  };
  function eventLabel(t) {
    return EVENT_LABELS[t] || (t ? String(t).replace(/_/g, ' ').toLowerCase() : 'Transaction');
  }

  // Build the drafts endpoint, appending the active period with the correct
  // separator (the path already carries ?status=PENDING).
  function draftsPath(FA) {
    var pq = FA.periodQuery(); // '' or '?period=YYYY-MM'
    var period = pq ? '&' + pq.slice(1) : '';
    return '/api/drafts?status=PENDING' + period;
  }

  // --- confidence chip (legacy accepts 0..1 or 0..100) -----------------------
  function confidenceChip(FA, confidence) {
    if (confidence == null || !isFinite(Number(confidence))) return null;
    var pct = Number(confidence);
    if (pct <= 1) pct = pct * 100;
    pct = Math.round(pct);
    var cls = pct >= 60 ? 'chip hi' : 'chip lo';
    return FA.el('span', { class: cls, title: 'How sure the AI was about reading this document.' },
      'AI confidence ' + pct + '%');
  }

  // --- "What the document said" figures (AI read) ----------------------------
  function buildSaidFigures(FA, src) {
    src = src || {};
    var rows = [];
    if (src.amount != null && isFinite(Number(src.amount))) rows.push(['Amount', FA.money(src.amount, src.currency)]);
    if (src.quantity != null && isFinite(Number(src.quantity))) rows.push(['Quantity', Number(src.quantity).toLocaleString('en-GB')]);
    if (src.fairValue != null && isFinite(Number(src.fairValue))) rows.push(['Fair value', FA.money(src.fairValue, src.currency)]);
    if (src.currency) rows.push(['Currency', String(src.currency)]);

    if (!rows.length) {
      return FA.el('p', { class: 'muted', style: { fontSize: '13.5px', margin: '4px 0 0' } },
        'No figures were read from this document.');
    }
    var wrap = FA.el('div', null);
    rows.forEach(function (r) {
      wrap.appendChild(FA.el('div', {
        class: 'spread',
        style: { padding: '8px 0', borderBottom: '1px solid var(--hairline-light)', fontSize: '14px' },
      },
        FA.el('span', { class: 'muted' }, r[0]),
        FA.el('span', { style: { fontWeight: '600' } }, r[1])));
    });
    return wrap;
  }

  // --- "What we booked" mini journal (positive = Debit, negative = Credit) ---
  function buildJournalTable(FA, lines) {
    lines = Array.isArray(lines) ? lines : [];
    if (!lines.length) {
      return FA.el('p', { class: 'muted', style: { fontSize: '13.5px', margin: '4px 0 0' } },
        'No entries were booked.');
    }
    var tbody = FA.el('tbody');
    var totalDr = 0, totalCr = 0;
    lines.forEach(function (ln) {
      var amt = Number(ln.amount) || 0;
      var isDebit = amt >= 0;
      var abs = Math.abs(amt);
      if (isDebit) totalDr += abs; else totalCr += abs;

      var acct = FA.el('td', null,
        FA.el('div', { style: { fontWeight: '600' } }, ln.accountName || ln.accountCode || 'Account'),
        ln.description ? FA.el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } }, ln.description) : null);

      tbody.appendChild(FA.el('tr', null,
        acct,
        isDebit
          ? FA.el('td', { class: 't-right num' }, FA.money(abs))
          : FA.el('td', { class: 't-right num muted' }, '—'),
        !isDebit
          ? FA.el('td', { class: 't-right num' }, FA.money(abs))
          : FA.el('td', { class: 't-right num muted' }, '—')));
    });

    return FA.el('table', { class: 'tbl', style: { fontSize: '13.5px' } },
      FA.el('thead', null,
        FA.el('tr', null,
          FA.el('th', null, 'Account'),
          FA.el('th', { class: 't-right' }, 'Debit'),
          FA.el('th', { class: 't-right' }, 'Credit'))),
      tbody,
      FA.el('tfoot', null,
        FA.el('tr', null,
          FA.el('td', { style: { fontWeight: '600', paddingTop: '11px' } }, 'Total'),
          FA.el('td', { class: 't-right num', style: { fontWeight: '600', paddingTop: '11px' } }, FA.money(totalDr)),
          FA.el('td', { class: 't-right num', style: { fontWeight: '600', paddingTop: '11px' } }, FA.money(totalCr)))));
  }

  // --- FX line: "Exchange rate used: 1 EUR = {rate} {ccy} (as at {date})" -----
  function buildFxLine(FA, engineFigures) {
    var ef = engineFigures || {};
    var rate = ef.fxRate;
    var currency = ef.originalCurrency || ef.currency;
    if (rate == null || !isFinite(Number(rate))) return null; // EUR / unknown — stay quiet
    var rateStr = Number(rate).toLocaleString('en-GB', { maximumFractionDigits: 6 });
    var dateBit = ef.fxRateDate ? ' (as at ' + FA.fmtDate(ef.fxRateDate) + ')' : '';
    return FA.el('div', {
      class: 'muted',
      style: { marginTop: '12px', fontSize: '12.5px' },
      title: 'The engine converted this using the bundled ECB rate for that date.',
    },
      'Exchange rate used: 1 EUR = ' + rateStr + ' ' + (currency || '') + dateBit);
  }

  // --- live source-document preview ------------------------------------------
  function buildDocPreview(FA, d) {
    var docId = d.documentId;
    var wrap = FA.el('div', { style: { padding: '0 24px 18px' } });
    if (!docId) {
      wrap.appendChild(FA.el('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'No preview available'));
      return wrap;
    }
    var url = '/api/documents/' + encodeURIComponent(docId) + '/file';
    var name = (d.docName || '').toLowerCase();
    var mime = (d.docMime || d.mime || '').toLowerCase();
    var isPdf = mime.indexOf('pdf') >= 0 || /\.pdf$/.test(name);
    var isImage = mime.indexOf('image/') === 0 || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name);

    var label = FA.el('div', {
      class: 'muted',
      style: { fontSize: '11.5px', letterSpacing: '.4px', textTransform: 'uppercase', fontWeight: '600', margin: '0 0 8px' },
    }, 'Source document' + (d.docName ? ' · ' + d.docName : ''));
    wrap.appendChild(label);

    if (isImage) {
      var img = FA.el('img', {
        src: url, alt: d.docName || 'Source document', loading: 'lazy',
        style: { maxWidth: '100%', maxHeight: '340px', borderRadius: '12px', border: '1px solid var(--hairline-light)' },
      });
      img.addEventListener('error', function () {
        img.remove();
        wrap.appendChild(FA.el('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'No preview available'));
      });
      wrap.appendChild(img);
    } else if (isPdf) {
      wrap.appendChild(FA.el('iframe', {
        src: url, title: d.docName || 'Source document', loading: 'lazy',
        style: { width: '100%', height: '340px', border: '1px solid var(--hairline-light)', borderRadius: '12px', background: '#fff' },
      }));
    } else {
      wrap.appendChild(FA.el('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'No preview available'));
    }
    return wrap;
  }

  // --- one draft card --------------------------------------------------------
  function buildDraftCard(FA, d, rerender) {
    var card = FA.el('div', { class: 'card', style: { overflow: 'hidden', marginBottom: '16px' } });

    // Header: friendly badge + investee + date, confidence chip on the right.
    var left = FA.el('div', null,
      FA.el('div', null, FA.el('span', { class: 'badge muted', style: { marginBottom: '10px' } }, eventLabel(d.eventType))),
      FA.el('h3', { class: 'section-title', style: { margin: '8px 0 0' } }, d.investeeName || 'Unnamed investee'),
      FA.el('p', { class: 'muted', style: { fontSize: '13px', margin: '4px 0 0' } },
        [FA.fmtDate(d.txnDate), d.docName ? 'from ' + d.docName : null].filter(Boolean).join('  •  ')));
    var chip = confidenceChip(FA, d.confidence);
    var head = FA.el('div', {
      class: 'spread',
      style: { alignItems: 'flex-start', padding: '22px 24px', borderBottom: '1px solid var(--hairline-light)' },
    }, left, chip);
    card.appendChild(head);

    // Optional needs-attention notice (legacy).
    if (d.rationale && /carry|attention|missing|needs/i.test(d.rationale)) {
      card.appendChild(FA.el('div', {
        class: 'banner banner-warn',
        style: { margin: '14px 24px 0' },
      }, d.rationale));
    }

    // Live source-document preview.
    card.appendChild(buildDocPreview(FA, d));

    // Two columns: said (AI read) vs booked (we calculated).
    var saidCol = FA.el('div', { style: { padding: '0 24px 22px', borderRight: '1px solid var(--hairline-light)' } },
      FA.el('div', { class: 'row', style: { marginBottom: '14px' } },
        FA.el('span', {
          class: 'muted',
          style: { fontSize: '11.5px', letterSpacing: '.4px', textTransform: 'uppercase', fontWeight: '600' },
        }, 'What the document said'),
        FA.el('span', { class: 'tag-airead', title: 'The AI read these figures straight off your document.' }, 'AI read')),
      buildSaidFigures(FA, d.sourceFigures));

    var bookedCol = FA.el('div', { style: { padding: '0 24px 22px' } },
      FA.el('div', { class: 'row', style: { marginBottom: '14px' } },
        FA.el('span', {
          class: 'muted',
          style: { fontSize: '11.5px', letterSpacing: '.4px', textTransform: 'uppercase', fontWeight: '600' },
        }, 'What we booked'),
        FA.el('span', { class: 'tag-calc', title: 'The engine calculated and balanced these entries — not the AI.' }, 'we calculated')),
      buildJournalTable(FA, d.lines));
    var fx = buildFxLine(FA, d.engineFigures);
    if (fx) bookedCol.appendChild(fx);

    card.appendChild(FA.el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr' } }, saidCol, bookedCol));

    // Tax flags (trap T8): advisory only — never auto-applied.
    if (Array.isArray(d.taxFlags) && d.taxFlags.length) {
      var flagWrap = FA.el('div', { style: { padding: '0 24px 18px' } },
        FA.el('div', { class: 'muted', style: { fontSize: '11.5px', letterSpacing: '.4px', textTransform: 'uppercase', fontWeight: '600', marginBottom: '8px' } }, 'Tax — please review'));
      d.taxFlags.forEach(function (f) {
        flagWrap.appendChild(FA.el('div', { class: 'banner', style: { background: '#fff7ed', border: '1px solid #fed7aa', color: '#9a3412', marginBottom: '6px', fontSize: '12.5px' } },
          FA.el('span', { style: { fontWeight: '600' } }, (f && f.label) || 'Tax flag'),
          FA.el('span', null, ' — ' + ((f && f.note) || ''))));
      });
      card.appendChild(flagWrap);
    }

    // Citation.
    if (d.citation) {
      card.appendChild(FA.el('div', {
        style: { padding: '0 24px 18px' },
      },
        FA.el('div', {
          class: 'muted',
          style: { fontSize: '11.5px', letterSpacing: '.4px', textTransform: 'uppercase', fontWeight: '600', marginBottom: '6px' },
        }, 'Where this came from'),
        FA.el('blockquote', {
          class: 'muted',
          style: { margin: '0', fontSize: '13px', fontStyle: 'italic', borderLeft: '3px solid var(--hairline-light)', paddingLeft: '12px' },
        }, d.citation)));
    }

    // Footer actions: Edit (reclassify) + Reject (ghost) + Approve (dark).
    var editBtn = FA.el('button', { class: 'btn btn-ghost', title: 'Change the account a line posts to before approving' }, 'Edit accounts');
    var rejectBtn = FA.el('button', { class: 'btn btn-ghost' }, 'Reject');
    var approveBtn = FA.el('button', { class: 'btn btn-dark', html: FA.icon('check') + '<span>Approve</span>' });

    function setBusy(busy) { editBtn.disabled = busy; rejectBtn.disabled = busy; approveBtn.disabled = busy; }

    approveBtn.addEventListener('click', function () { act(FA, d.id, 'approve', approveBtn, setBusy, rerender); });
    rejectBtn.addEventListener('click', function () { act(FA, d.id, 'reject', rejectBtn, setBusy, rerender); });
    editBtn.addEventListener('click', function () { openLineEditor(FA, card, d, rerender); });

    card.appendChild(FA.el('div', {
      class: 'row',
      style: { justifyContent: 'flex-end', gap: '12px', padding: '16px 24px', background: 'var(--surface-soft)' },
    }, editBtn, rejectBtn, approveBtn));

    return card;
  }

  // --- inline editor: reclassify the account on each booked line --------------
  // Amounts are kept exactly as the engine computed them (so the entry stays
  // balanced); only the account a line posts to can be changed, then saved via
  // /edit (which records a before/after audit entry).
  var chartCache = null;
  async function loadChart(FA) {
    if (chartCache) return chartCache;
    var r = await FA.api('/api/chart');
    chartCache = (r && !r.error && Array.isArray(r.accounts)) ? r.accounts : [];
    return chartCache;
  }

  async function openLineEditor(FA, card, d, rerender) {
    var accounts = await loadChart(FA);
    var lines = (Array.isArray(d.lines) ? d.lines : []).map(function (l) {
      return { accountCode: l.accountCode, accountName: l.accountName, amount: Number(l.amount) || 0, description: l.description };
    });

    var rows = FA.el('div', null);
    var selects = [];
    lines.forEach(function (ln, i) {
      var amt = Number(ln.amount) || 0;
      var sel = FA.el('select', { class: 'select', style: { minWidth: '260px' } });
      var hasMatch = false;
      accounts.forEach(function (a) {
        var opt = FA.el('option', { value: a.code }, a.code + ' · ' + (a.name || ''));
        if (a.code === ln.accountCode) { opt.selected = true; hasMatch = true; }
        sel.appendChild(opt);
      });
      if (!hasMatch) {
        var opt0 = FA.el('option', { value: ln.accountCode }, ln.accountCode + ' · ' + (ln.accountName || ''));
        opt0.selected = true;
        sel.insertBefore(opt0, sel.firstChild);
      }
      selects.push(sel);
      rows.appendChild(FA.el('div', { class: 'spread', style: { gap: '12px', padding: '8px 0', alignItems: 'center' } },
        sel,
        FA.el('span', { class: 'num muted', style: { fontSize: '13px' } },
          (amt >= 0 ? 'Dr ' : 'Cr ') + FA.money(Math.abs(amt)))));
    });

    var saveBtn = FA.el('button', { class: 'btn btn-dark btn-sm' }, 'Save changes');
    var cancelBtn = FA.el('button', { class: 'btn btn-ghost btn-sm' }, 'Cancel');
    var panel = FA.el('div', { class: 'card-pad', style: { borderTop: '1px solid var(--hairline-light)', background: 'var(--surface-soft)' } },
      FA.el('div', { class: 'muted', style: { fontSize: '11.5px', letterSpacing: '.4px', textTransform: 'uppercase', fontWeight: '600', marginBottom: '8px' } },
        'Reclassify accounts (amounts are kept so the entry stays balanced)'),
      rows,
      FA.el('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '10px', marginTop: '10px' } }, cancelBtn, saveBtn));
    card.appendChild(panel);

    cancelBtn.addEventListener('click', function () { panel.remove(); });
    saveBtn.addEventListener('click', async function () {
      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Saving…';
      var newLines = lines.map(function (ln, i) {
        var code = selects[i].value || ln.accountCode;
        var acct = accounts.filter(function (a) { return a.code === code; })[0];
        return { accountCode: code, accountName: acct ? acct.name : ln.accountName, amount: ln.amount, description: ln.description };
      });
      var r = await FA.api('/api/drafts/' + encodeURIComponent(d.id) + '/edit', { json: { lines: newLines, actor: 'reviewer' } });
      if (r && r.error) { saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save changes'; FA.toast(r.error, 'error'); return; }
      FA.toast('Saved — change recorded in the audit trail.', 'success');
      await rerender();
    });
  }

  async function act(FA, id, kind, btn, setBusy, rerender) {
    setBusy(true);
    var orig = btn.innerHTML;
    btn.textContent = kind === 'approve' ? 'Approving…' : 'Rejecting…';
    var r = await FA.api('/api/drafts/' + encodeURIComponent(id) + '/' + kind, { method: 'POST' });
    if (r && r.error) {
      btn.innerHTML = orig;
      setBusy(false);
      FA.toast(r.error, 'error');
      return;
    }
    FA.toast(kind === 'approve' ? 'Approved and added to your books.' : 'Rejected — left out of your books.',
      kind === 'approve' ? 'success' : 'info');
    FA.refreshChrome();
    await rerender();
  }

  // --- view ------------------------------------------------------------------
  function FAreg() {
    window.FA.registerView('review', {
      label: 'Review',
      async render(mount, FA) {
        async function rerender() {
          mount.innerHTML = '';
          var r = await FA.api(draftsPath(FA));
          var drafts = (r && !r.error && Array.isArray(r.drafts)) ? r.drafts : [];

          // Header.
          var header = FA.el('div', { class: 'spread', style: { marginBottom: '18px' } },
            FA.el('div', null,
              FA.el('h2', { class: 'screen-title' },
                'Review',
                drafts.length ? FA.el('span', { class: 'muted', style: { fontWeight: '400' } }, '  ' + drafts.length) : null),
              FA.el('p', { class: 'section-help', style: { maxWidth: '560px' } },
                'For each one, see what the document said and what we booked. Approve when it looks right.')));

          if (drafts.length) {
            var approveAll = FA.el('button', { class: 'btn btn-primary' }, 'Approve all');
            approveAll.addEventListener('click', async function () {
              approveAll.disabled = true;
              approveAll.textContent = 'Approving all…';
              var rr = await FA.api('/api/drafts/approve-all', { method: 'POST' });
              if (rr && rr.error) {
                approveAll.disabled = false;
                approveAll.textContent = 'Approve all';
                FA.toast(rr.error, 'error');
                return;
              }
              var n = (rr && Number(rr.approved)) || 0;
              var skipped = (rr && Number(rr.skipped)) || 0;
              FA.toast('Approved ' + n + ' transaction' + (n === 1 ? '' : 's') +
                (skipped ? ' · ' + skipped + ' low-confidence left for you to review per line' : '') + '.', skipped ? 'warn' : 'success');
              FA.refreshChrome();
              await rerender();
            });
            header.appendChild(approveAll);
          }
          mount.appendChild(header);

          // Error state (surface gently, then fall through to empty).
          if (r && r.error) {
            mount.appendChild(FA.el('div', { class: 'empty' }, r.error));
            return;
          }

          // Empty state — but point at bank transactions that still need a category.
          if (!drafts.length) {
            var bt = await FA.api('/api/bank/transactions?status=REVIEW');
            var bankReview = (bt && !bt.error && Array.isArray(bt.transactions)) ? bt.transactions.length : 0;
            if (bankReview) {
              var goBank = FA.el('button', { class: 'btn btn-dark btn-sm' }, 'Go to Bank statements');
              goBank.addEventListener('click', function () { FA.navigate('bank'); });
              mount.appendChild(FA.el('div', { class: 'card card-pad', style: { maxWidth: '620px' } },
                FA.el('div', { style: { fontWeight: '600', fontFamily: 'var(--font-display)', marginBottom: '4px' } },
                  bankReview + ' bank transaction' + (bankReview === 1 ? '' : 's') + ' need a category'),
                FA.el('p', { class: 'section-help', style: { margin: '2px 0 12px' } },
                  'No investment documents are waiting, but these bank lines need you to confirm where each one posts — use “Help me classify” there.'),
                goBank));
            } else {
              mount.appendChild(FA.el('div', { class: 'empty' }, "Nothing to review — you're all caught up."));
            }
            return;
          }

          var list = FA.el('div', { style: { maxWidth: '1000px' } });
          drafts.forEach(function (d) {
            try { list.appendChild(buildDraftCard(FA, d || {}, rerender)); } catch (e) { /* skip a bad draft */ }
          });
          mount.appendChild(list);
        }

        await rerender();
      },
    });
  }

  if (window.FA && window.FA.registerView) FAreg();
  else document.addEventListener('DOMContentLoaded', function () { if (window.FA && window.FA.registerView) FAreg(); });
})();
