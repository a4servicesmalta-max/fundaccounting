/* Loans view — loans by party with expandable event history.
   Endpoint: GET /api/loans -> { loans:[{party,direction,currency,advanced,repaid,outstanding,lastEventDate,events:[{date,type,amount,source}]}], totals:{granted,borrowed,outstanding} }
   Owns ONLY this file. Never throws; guards missing data. */
(function () {
  'use strict';
  if (!window.FA || typeof FA.registerView !== 'function') return;

  // GRANTED -> "Lent out" (blue), BORROWED -> "Borrowed" (violet/cobalt).
  function directionBadge(dir) {
    if (dir === 'GRANTED') return FA.el('span', { class: 'badge blue' }, 'Lent out');
    if (dir === 'BORROWED') {
      return FA.el('span', {
        class: 'badge',
        style: { background: '#eef0ff', color: 'var(--primary)' },
      }, 'Borrowed');
    }
    return FA.el('span', { class: 'badge muted' }, dir || '—');
  }

  function eventTypeBadge(type) {
    if (type === 'ADVANCE') return FA.el('span', { class: 'badge blue' }, 'Advance');
    if (type === 'REPAYMENT') return FA.el('span', { class: 'badge green' }, 'Repayment');
    return FA.el('span', { class: 'badge muted' }, type || '—');
  }

  // Inline sub-row showing the full event history for one loan.
  function buildEventHistory(events, currency) {
    const rows = events
      .slice()
      .sort((a, b) => String(a && a.date || '').localeCompare(String(b && b.date || '')))
      .map((ev) => ev || {})
      .map((ev) => FA.el('tr', null,
        FA.el('td', null, FA.fmtDate(ev.date)),
        FA.el('td', null, eventTypeBadge(ev.type)),
        FA.el('td', { class: 't-right num' }, FA.money(ev.amount, currency)),
        FA.el('td', { class: 'muted' }, ev.source || '—')));

    return FA.el('div', { style: { padding: '6px 8px 10px' } },
      FA.el('div', { class: 'muted', style: { fontSize: '12px', fontWeight: '600', margin: '2px 8px 8px' } }, 'Full history'),
      FA.el('table', { class: 'tbl' },
        FA.el('thead', null,
          FA.el('tr', null,
            FA.el('th', null, 'Date'),
            FA.el('th', null, 'What happened'),
            FA.el('th', { class: 't-right' }, 'Amount'),
            FA.el('th', null, 'Source'))),
        FA.el('tbody', null, rows)));
  }

  function loanRow(loan) {
    loan = loan || {};
    const cur = loan.currency || 'EUR';
    const events = Array.isArray(loan.events) ? loan.events : [];
    const hasEvents = events.length > 0;

    const caret = FA.el('span', {
      style: { display: 'inline-block', width: '14px', color: 'var(--mute)', transition: 'transform .15s ease' },
    }, hasEvents ? '▸' : '');

    const mainTr = FA.el('tr', hasEvents ? { style: { cursor: 'pointer' } } : null,
      FA.el('td', null,
        FA.el('span', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
          caret,
          FA.el('span', { style: { fontWeight: '600' } }, loan.party || '—'))),
      FA.el('td', null, directionBadge(loan.direction)),
      FA.el('td', { class: 't-right num' }, FA.money(loan.advanced, cur)),
      FA.el('td', { class: 't-right num' }, FA.money(loan.repaid, cur)),
      FA.el('td', { class: 't-right num', style: { fontWeight: '700' } }, FA.money(loan.outstanding, cur)),
      FA.el('td', { class: 'muted' }, loan.lastEventDate ? FA.fmtDate(loan.lastEventDate) : '—'));

    const out = [mainTr];

    if (hasEvents) {
      const detailTr = FA.el('tr', null,
        FA.el('td', { colspan: '6', style: { background: 'var(--surface-soft)', padding: '0 8px' } },
          buildEventHistory(events, cur)));
      detailTr.style.display = 'none';

      mainTr.addEventListener('click', () => {
        const open = detailTr.style.display === 'none';
        detailTr.style.display = open ? '' : 'none';
        caret.textContent = open ? '▾' : '▸';
      });
      out.push(detailTr);
    }
    return out;
  }

  function totalsFooter(totals, loans) {
    totals = totals || {};
    // Outstanding is the headline figure — bold.
    const grandOut = Number(totals.outstanding);
    const grandAdv = Number(totals.granted) + Number(totals.borrowed);
    return FA.el('tfoot', null,
      FA.el('tr', { style: { background: 'var(--surface-soft)', fontWeight: '700' } },
        FA.el('td', null, 'Total'),
        FA.el('td', null, ''),
        FA.el('td', { class: 't-right num' }, isFinite(grandAdv) ? FA.money(grandAdv) : ''),
        FA.el('td', { class: 't-right num' }, ''),
        FA.el('td', { class: 't-right num' }, isFinite(grandOut) ? FA.money(grandOut) : ''),
        FA.el('td', null, '')));
  }

  function render(mount, FA) {
    mount.appendChild(FA.el('div', null,
      FA.el('h1', { class: 'section-title' }, 'Loans'),
      FA.el('p', { class: 'section-help' },
        'Every loan by party — advanced, repaid and still outstanding. Click a row to see the full history.')));

    const card = FA.el('div', { class: 'card', style: { marginTop: '18px', overflow: 'hidden' } });
    mount.appendChild(card);
    card.appendChild(FA.el('div', { class: 'empty' },
      FA.el('span', { class: 'spinner' }), ' Gathering your loans…'));

    return FA.api('/api/loans').then((r) => {
      card.innerHTML = '';

      if (!r || r.error) {
        card.appendChild(FA.el('div', { class: 'empty' },
          (r && r.error) || 'We could not load your loans just now.'));
        return;
      }

      const loans = Array.isArray(r.loans) ? r.loans : [];

      if (!loans.length) {
        card.appendChild(FA.el('div', { class: 'empty' },
          "No loans yet — they'll appear as you book loan advances and repayments, or categorise bank lines to a loan account."));
        return;
      }

      const bodyRows = [];
      loans.forEach((loan) => { loanRow(loan).forEach((tr) => bodyRows.push(tr)); });

      card.appendChild(FA.el('table', { class: 'tbl' },
        FA.el('thead', null,
          FA.el('tr', null,
            FA.el('th', null, 'Party'),
            FA.el('th', null, 'Direction'),
            FA.el('th', { class: 't-right' }, 'Advanced'),
            FA.el('th', { class: 't-right' }, 'Repaid'),
            FA.el('th', { class: 't-right' }, 'Outstanding'),
            FA.el('th', null, 'Last activity'))),
        FA.el('tbody', null, bodyRows),
        totalsFooter(r.totals, loans)));
    }).catch(() => {
      card.innerHTML = '';
      card.appendChild(FA.el('div', { class: 'empty' }, 'We could not load your loans just now.'));
    });
  }

  FA.registerView('loans', { label: 'Loans', render: render });
})();
