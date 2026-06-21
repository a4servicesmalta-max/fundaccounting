/* overview view — Fund Autopilot dashboard home.
   GET /api/overview -> { kpis, holdings[], allocation[], recentDocuments[], navSeries[] }
   Owns ONLY this file. Never throws; guards every shape. */
(function () {
  'use strict';
  if (!window.FA || !FA.registerView) return;

  // -- small helpers ----------------------------------------------------------
  function initials(name) {
    var s = String(name || '').trim();
    if (!s) return '··';
    var parts = s.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  function asArray(v) { return Array.isArray(v) ? v : []; }
  function n(v) { var x = Number(v); return isFinite(x) ? x : 0; }

  // -- hero --------------------------------------------------------------------
  function buildHero(FA, kpis) {
    var drafts = n(kpis.draftsToReview);
    var docs = n(kpis.documentsProcessed);
    var posted = n(kpis.postedEntries);

    var badge = FA.el('div', { class: 'fa-hero-badge' },
      FA.el('span', { class: 'fa-hero-dot' }),
      'Autopilot is on');

    var headline = FA.el('h2', { class: 'fa-hero-title' }, 'Your books, on autopilot');

    var line = FA.el('p', { class: 'fa-hero-copy' },
      'Autopilot read ' + docs + ' document' + (docs === 1 ? '' : 's') +
      ', drafted entries and reconciled your bank feeds. All that’s left is a quick approval.');

    var reviewBtn = FA.el('button', {
      class: 'btn fa-hero-btn-light',
      onclick: function () { FA.navigate('review'); },
    }, 'Review ' + drafts + ' draft' + (drafts === 1 ? '' : 's'),
      FA.el('span', { class: 'fa-ico-arrow', html: FA.icon('arrow') }));

    var bankBtn = FA.el('button', {
      class: 'btn fa-hero-btn-outline',
      onclick: function () { FA.navigate('bank'); },
    }, 'See bank feeds');

    var content = FA.el('div', { class: 'fa-hero-content' },
      badge, headline, line,
      FA.el('div', { class: 'fa-hero-actions' }, reviewBtn, bankBtn));

    // optional background video — fails silently if asset is missing
    var video = FA.el('video', {
      class: 'fa-hero-video',
      src: 'assets/autopilot-hero.mp4',
      autoplay: 'autoplay', muted: 'muted', loop: 'loop', playsinline: 'playsinline',
      preload: 'auto',
    });
    video.muted = true; // ensure autoplay on browsers that gate on the property
    video.addEventListener('error', function () { video.style.display = 'none'; });

    void posted; // not surfaced in hero copy; kept honest above
    return FA.el('div', { class: 'fa-hero' },
      video,
      FA.el('div', { class: 'fa-hero-overlay' }),
      content);
  }

  // -- KPI row -----------------------------------------------------------------
  function kpiTile(FA, opts) {
    var kids = [];
    if (opts.head) kids.push(opts.head);
    kids.push(FA.el('div', { class: 'kpi-num num' }, opts.value));
    kids.push(FA.el('div', { class: 'kpi-label' }, opts.label));
    return FA.el('div', { class: 'kpi' + (opts.primary ? ' kpi-primary' : '') }, kids);
  }

  function buildKpis(FA, kpis) {
    var docHead = FA.el('div', { class: 'kpi-delta' }, 'This month');
    // NAV at fair value when revaluation is available; show the FX/FV movement.
    var hasFv = kpis.portfolioFairValue != null && isFinite(Number(kpis.portfolioFairValue));
    var navValue = hasFv ? n(kpis.portfolioFairValue) : n(kpis.netAssetValue);
    var mv = n(kpis.fairValueMovement);
    // NAV is shown with its two components kept distinct: equity (at valuation)
    // and loans granted — never a single blended number.
    var navHead = FA.el('div', { class: 'kpi-delta', title: 'Equity investments at valuation, plus loans granted (kept separate)' },
      'Equity ' + FA.money(n(kpis.equityValuation)) + ' · Loans ' + FA.money(n(kpis.loansValue)));
    var draftHead = FA.el('div', { class: 'kpi-delta' },
      FA.el('span', { class: 'fa-dot-ink' }), 'Awaiting you');
    var postedHead = FA.el('div', { class: 'kpi-delta' },
      FA.el('span', { class: 'badge lime' }, '✓ Balanced'));

    return FA.el('div', { class: 'grid-4' },
      kpiTile(FA, { head: docHead, value: FA.num ? String(n(kpis.documentsProcessed)) : n(kpis.documentsProcessed), label: 'Documents processed' }),
      kpiTile(FA, { head: navHead, value: FA.money(navValue), label: hasFv ? 'Net asset value (fair value)' : 'Net asset value', primary: true }),
      kpiTile(FA, { head: draftHead, value: String(n(kpis.draftsToReview)), label: 'Drafts to review' }),
      kpiTile(FA, { head: postedHead, value: String(n(kpis.postedEntries)), label: 'Posted entries' }));
  }

  // Secondary stat strip. Equity investments (at valuation) and loans granted are
  // kept SEPARATE — they are different instruments and are never lumped together.
  function buildSecondaryStats(FA, kpis) {
    var items = [
      { label: 'Equity (at valuation)', value: FA.money(n(kpis.equityValuation)) },
      { label: 'Loans granted', value: FA.money(n(kpis.loansValue)) },
      { label: 'Cash (EUR)', value: FA.money(n(kpis.cashEur)) },
      { label: 'Net profit / (loss)', value: FA.money(n(kpis.netProfit)) },
    ];
    return FA.el('div', { class: 'fa-substats' },
      items.map(function (it) {
        return FA.el('div', { class: 'fa-substat' },
          FA.el('div', { class: 'fa-substat-label' }, it.label),
          FA.el('div', { class: 'fa-substat-val num' }, it.value));
      }));
  }

  // -- NAV chart (inline SVG area + line) --------------------------------------
  function buildChart(FA, navSeries) {
    var series = asArray(navSeries).filter(function (p) { return p && isFinite(Number(p.value)); });

    var header = FA.el('div', { class: 'spread', style: { marginBottom: '20px' } },
      FA.el('div', null,
        FA.el('h3', { class: 'section-title' }, 'Net asset value'),
        FA.el('div', { class: 'section-help', style: { marginTop: '2px' } }, 'Tracked from every posted entry')));

    if (series.length < 2) {
      return FA.el('div', { class: 'card card-pad fa-chart-card' },
        header,
        FA.el('div', { class: 'empty' }, 'Not enough history yet — post a few entries and your NAV trend will appear here.'));
    }

    // geometry
    var W = 640, H = 240, padL = 6, padR = 6, padT = 10, padB = 22;
    var iw = W - padL - padR;
    var ih = H - padT - padB;
    var vals = series.map(function (p) { return Number(p.value); });
    var maxV = Math.max.apply(null, vals);
    var top = maxV <= 0 ? 1 : maxV * 1.08; // headroom; y-axis 0..top
    var stepX = series.length > 1 ? iw / (series.length - 1) : 0;
    var x = function (i) { return padL + i * stepX; };
    var y = function (v) { return padT + ih - (n(v) / top) * ih; };

    var linePts = series.map(function (p, i) { return x(i) + ',' + y(p.value); });
    var linePath = 'M ' + linePts.join(' L ');
    var areaPath = 'M ' + x(0) + ',' + (padT + ih) +
      ' L ' + linePts.join(' L ') +
      ' L ' + x(series.length - 1) + ',' + (padT + ih) + ' Z';

    // 5 horizontal gridlines
    var grid = '';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (ih / 4) * g;
      grid += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy +
        '" stroke="#f1f1f3" stroke-width="1"/>';
    }
    var lastX = x(series.length - 1), lastY = y(vals[vals.length - 1]);

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" width="100%" height="240" ' +
      'style="display:block;overflow:visible" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="navfill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#494fdf" stop-opacity="0.30"/>' +
      '<stop offset="100%" stop-color="#494fdf" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      grid +
      '<path d="' + areaPath + '" fill="url(#navfill)"/>' +
      '<path d="' + linePath + '" fill="none" stroke="#494fdf" stroke-width="2.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + lastX + '" cy="' + lastY + '" r="4.5" fill="#494fdf" stroke="#fff" stroke-width="2"/>' +
      '</svg>';

    // y-axis labels (top -> 0)
    var yLabels = [];
    for (var k = 0; k <= 4; k++) {
      var frac = 1 - k / 4;
      yLabels.push(FA.el('span', null, kFmt(top * frac)));
    }
    var yaxis = FA.el('div', { class: 'fa-chart-yaxis' }, yLabels);

    // x-axis labels (thin them out if many)
    var labels = series.map(function (p) { return shortPeriod(FA, p.period); });
    var maxTicks = 7;
    var keep = labels.length <= maxTicks ? labels : labels.map(function (lbl, i) {
      var stepEvery = Math.ceil((labels.length - 1) / (maxTicks - 1));
      return (i === 0 || i === labels.length - 1 || i % stepEvery === 0) ? lbl : '';
    });
    var xaxis = FA.el('div', { class: 'fa-chart-xaxis' },
      keep.map(function (lbl) { return FA.el('span', null, lbl || ' '); }));

    var plot = FA.el('div', { class: 'fa-chart-plot' },
      FA.el('div', { class: 'fa-chart-svg', html: svg }),
      xaxis);

    return FA.el('div', { class: 'card card-pad fa-chart-card' },
      header,
      FA.el('div', { class: 'fa-chart-area' }, yaxis, plot));
  }

  function kFmt(v) {
    v = n(v);
    if (v >= 1000) return Math.round(v / 1000) + 'k';
    return String(Math.round(v));
  }
  function shortPeriod(FA, period) {
    if (!period) return '';
    if (/^\d{4}-\d{2}$/.test(period)) {
      var lbl = FA.monthLabel(period); // "April 2025"
      var parts = lbl.split(' ');
      return parts[0].slice(0, 3) + ' ' + (parts[1] || '').slice(2);
    }
    return String(period);
  }

  // -- Holdings rail -----------------------------------------------------------
  function holdingRow(FA, h) {
    var kind = String(h.kind || '').toUpperCase();
    var avClass = kind === 'LOAN' ? 'avatar blue' : 'avatar green';
    return FA.el('div', { class: 'fa-hold-row' },
      FA.el('div', { class: avClass }, initials(h.name)),
      FA.el('div', { class: 'fa-hold-main' },
        FA.el('div', { class: 'fa-hold-name' }, h.name || 'Unnamed'),
        h.sub ? FA.el('div', { class: 'fa-hold-sub' }, h.sub) : null),
      FA.el('div', { class: 'fa-hold-val num',
        title: (h.revalued != null && isFinite(Number(h.revalued)))
          ? 'Revalued to EUR at closing FX: ' + FA.money(n(h.revalued), 'EUR')
          : '' }, FA.money(n(h.value), h.currency || 'EUR')));
  }

  function buildHoldings(FA, holdings) {
    var list = asArray(holdings);
    var header = FA.el('div', { class: 'spread', style: { marginBottom: '16px' } },
      FA.el('h3', { class: 'fa-rail-title' }, 'Holdings'),
      FA.el('button', {
        class: 'fa-rail-link',
        onclick: function () { FA.navigate('books'); },
      }, 'View all', FA.el('span', { class: 'fa-ico-arrow-sm', html: FA.icon('arrow') })));

    if (!list.length) {
      return FA.el('div', { class: 'card card-pad' }, header,
        FA.el('div', { class: 'empty' }, 'No holdings yet.'));
    }

    var equity = list.filter(function (h) { return String(h.kind || '').toUpperCase() === 'EQUITY'; });
    var loans = list.filter(function (h) { return String(h.kind || '').toUpperCase() === 'LOAN'; });
    var other = list.filter(function (h) {
      var k = String(h.kind || '').toUpperCase();
      return k !== 'EQUITY' && k !== 'LOAN';
    });

    var body = [];
    if (equity.length) {
      body.push(FA.el('div', { class: 'fa-rail-section' }, 'EQUITY'));
      body.push.apply(body, equity.map(function (h) { return holdingRow(FA, h); }));
    }
    if (loans.length) {
      body.push(FA.el('div', { class: 'fa-rail-section', style: { marginTop: '18px' } }, 'LOANS GRANTED'));
      body.push.apply(body, loans.map(function (h) { return holdingRow(FA, h); }));
    }
    if (other.length) {
      body.push(FA.el('div', { class: 'fa-rail-section', style: { marginTop: '18px' } }, 'OTHER'));
      body.push.apply(body, other.map(function (h) { return holdingRow(FA, h); }));
    }

    return FA.el('div', { class: 'card card-pad' }, header, body);
  }

  // -- Allocation card ---------------------------------------------------------
  function buildAllocation(FA, allocation) {
    var list = asArray(allocation).filter(function (a) { return a && a.name != null; });
    var header = FA.el('h3', { class: 'fa-rail-title', style: { marginBottom: '16px' } }, 'Allocation');

    if (!list.length) {
      return FA.el('div', { class: 'card card-pad' }, header,
        FA.el('div', { class: 'empty' }, 'Allocation appears once you hold positions.'));
    }

    var colors = ['var(--primary)', 'var(--lime)', '#000'];
    // normalise pct: use provided pct, else derive from value share
    var total = list.reduce(function (s, a) { return s + n(a.value); }, 0);
    var pcts = list.map(function (a) {
      if (a.pct != null && isFinite(Number(a.pct))) return n(a.pct);
      return total > 0 ? (n(a.value) / total) * 100 : 0;
    });

    var segs = list.map(function (a, i) {
      var w = Math.max(0, pcts[i]);
      var radius = list.length === 1 ? '8px'
        : i === 0 ? '8px 2px 2px 8px'
        : i === list.length - 1 ? '2px 8px 8px 2px'
        : '2px';
      return FA.el('div', {
        class: 'fa-alloc-seg',
        title: (a.name || '') + ' · ' + FA.pct(w),
        style: { flex: w + ' 0 0', background: colors[i % colors.length], borderRadius: radius },
      });
    });
    var bar = FA.el('div', { class: 'fa-alloc-bar' }, segs);

    var legend = FA.el('div', { class: 'fa-alloc-legend' },
      list.map(function (a, i) {
        return FA.el('div', { class: 'fa-alloc-legrow' },
          FA.el('span', { class: 'fa-alloc-swatch', style: { background: colors[i % colors.length] } }),
          FA.el('span', { class: 'fa-alloc-name' }, a.name),
          FA.el('span', { class: 'fa-alloc-pct num' }, FA.pct(pcts[i])));
      }));

    return FA.el('div', { class: 'card card-pad' }, header, bar, legend);
  }

  // -- Recent documents table --------------------------------------------------
  function statusBadge(FA, status) {
    var s = String(status || '').toUpperCase();
    if (s === 'POSTED') return FA.el('span', { class: 'badge lime' }, '✓ Posted');
    if (s === 'PENDING') return FA.el('span', { class: 'badge dark' },
      FA.el('span', { class: 'fa-ico-clock', html: FA.icon('clock') }), 'Pending');
    return FA.el('span', { class: 'badge muted' }, status || '—');
  }

  function buildRecent(FA, docs) {
    var list = asArray(docs);
    var header = FA.el('div', { class: 'spread', style: { padding: '22px 24px 14px' } },
      FA.el('h3', { class: 'section-title' }, 'Recent documents'),
      FA.el('button', {
        class: 'btn btn-dark btn-sm',
        onclick: function () { FA.navigate('documents'); },
      }, FA.el('span', { class: 'fa-ico-plus', html: FA.icon('plus') }), 'Add documents'));

    if (!list.length) {
      return FA.el('div', { class: 'card', style: { overflow: 'hidden' } }, header,
        FA.el('div', { class: 'empty' }, 'No documents yet — add your first to get autopilot started.'));
    }

    var rows = list.map(function (d) {
      return FA.el('tr', null,
        FA.el('td', null, d.docName || '—'),
        FA.el('td', { class: 'muted' }, d.investee || '—'),
        FA.el('td', { class: 'muted' }, FA.fmtDate(d.date)),
        FA.el('td', null, statusBadge(FA, d.status)),
        FA.el('td', { class: 't-right num' }, d.amount != null ? FA.money(n(d.amount)) : '—'));
    });

    var table = FA.el('table', { class: 'tbl' },
      FA.el('thead', null,
        FA.el('tr', null,
          FA.el('th', null, 'Document'),
          FA.el('th', null, 'Investee'),
          FA.el('th', null, 'Date'),
          FA.el('th', null, 'Status'),
          FA.el('th', { class: 't-right' }, 'Amount'))),
      FA.el('tbody', null, rows));

    return FA.el('div', { class: 'card', style: { overflow: 'hidden' } }, header,
      FA.el('div', { style: { overflowX: 'auto' } }, table));
  }

  // -- scoped styles (injected once) ------------------------------------------
  function ensureStyles() {
    if (document.getElementById('fa-overview-styles')) return;
    var css = [
      '.fa-hero{position:relative;border-radius:22px;background:#000;overflow:hidden;min-height:208px;display:flex}',
      '.fa-hero-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.92}',
      '.fa-hero-overlay{position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.9) 0%,rgba(0,0,0,.6) 42%,rgba(0,0,0,.12) 100%)}',
      '.fa-hero-content{position:relative;z-index:2;padding:30px 34px;display:flex;flex-direction:column;justify-content:center;gap:12px;min-height:208px}',
      '.fa-hero-badge{display:inline-flex;align-items:center;gap:8px;width:max-content;background:rgba(255,255,255,.1);backdrop-filter:blur(4px);color:#fff;font-size:12px;font-weight:600;padding:5px 12px;border-radius:9999px}',
      '.fa-hero-dot{width:7px;height:7px;border-radius:9999px;background:var(--lime);box-shadow:0 0 0 3px rgba(199,239,62,.25)}',
      '.fa-hero-title{font-family:var(--font-display);font-weight:600;font-size:28px;line-height:1.12;letter-spacing:-.6px;color:#fff;max-width:560px;margin:0}',
      '.fa-hero-copy{font-size:14px;color:rgba(255,255,255,.8);max-width:520px;line-height:1.5;margin:0}',
      '.fa-hero-actions{display:flex;gap:10px;margin-top:6px;flex-wrap:wrap}',
      '.fa-hero-btn-light{background:#fff;color:#000;border:0}',
      '.fa-hero-btn-light:hover{opacity:.9}',
      '.fa-hero-btn-outline{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3)}',
      '.fa-hero-btn-outline:hover{background:rgba(255,255,255,.1)}',
      '.fa-hero-btn-light .fa-ico-arrow svg{width:16px;height:16px;display:block}',
      '.fa-ico-arrow,.fa-ico-arrow-sm,.fa-ico-plus,.fa-ico-clock{display:inline-flex;align-items:center}',
      '.fa-dot-ink{width:8px;height:8px;border-radius:9999px;background:var(--ink);display:inline-block}',
      '.fa-chart-card{display:flex;flex-direction:column}',
      '.fa-chart-area{display:flex;gap:14px;flex:1}',
      '.fa-chart-yaxis{display:flex;flex-direction:column;justify-content:space-between;padding-bottom:24px;font-size:11px;color:var(--stone);text-align:right;width:34px;flex:none}',
      '.fa-chart-plot{flex:1;min-width:0;display:flex;flex-direction:column}',
      '.fa-chart-svg{height:240px;width:100%}',
      '.fa-chart-xaxis{display:flex;justify-content:space-between;margin-top:10px;font-size:11.5px;color:var(--stone);gap:4px}',
      '.fa-chart-xaxis span{flex:1;text-align:center;white-space:nowrap;overflow:hidden}',
      '.fa-chart-xaxis span:first-child{text-align:left}.fa-chart-xaxis span:last-child{text-align:right}',
      '.fa-rail-title{font-family:var(--font-display);font-size:17px;font-weight:600;margin:0}',
      '.fa-rail-link{display:inline-flex;align-items:center;gap:3px;font-size:12.5px;font-weight:600;color:var(--link);background:transparent;border:0;padding:0}',
      '.fa-rail-link .fa-ico-arrow-sm svg{width:13px;height:13px;display:block}',
      '.fa-rail-section{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--stone);font-weight:600;margin-bottom:10px}',
      '.fa-hold-row{display:flex;align-items:center;gap:12px;padding:8px 0}',
      '.fa-hold-main{flex:1;min-width:0}',
      '.fa-hold-name{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.fa-hold-sub{font-size:12px;color:var(--stone);margin-top:1px}',
      '.fa-hold-val{font-size:14px;font-weight:600;text-align:right;flex:none}',
      '.fa-alloc-bar{display:flex;gap:3px;margin-bottom:14px;height:88px}',
      '.fa-alloc-seg{min-width:3px}',
      '.fa-alloc-legend{display:flex;flex-direction:column;gap:9px}',
      '.fa-alloc-legrow{display:flex;align-items:center;gap:9px}',
      '.fa-alloc-swatch{width:9px;height:9px;border-radius:3px;flex:none}',
      '.fa-alloc-name{flex:1;font-size:13px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.fa-alloc-pct{font-size:13px;font-weight:600}',
      '.fa-ico-clock svg{width:13px;height:13px}',
      '.fa-ico-plus svg{width:15px;height:15px}',
      '.fa-substats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0 4px}',
      '.fa-substat{background:var(--surface-soft,#f7f7f9);border:1px solid var(--hairline-light,#ececef);border-radius:14px;padding:14px 16px}',
      '.fa-substat-label{font-size:11.5px;letter-spacing:.3px;text-transform:uppercase;color:var(--stone);font-weight:600;margin-bottom:6px}',
      '.fa-substat-val{font-size:18px;font-weight:600;font-family:var(--font-display)}',
      '@media(max-width:760px){.fa-substats{grid-template-columns:repeat(2,1fr)}}',
    ].join('');
    var s = document.createElement('style');
    s.id = 'fa-overview-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // -- render ------------------------------------------------------------------
  FA.registerView('overview', {
    label: 'Overview',
    async render(mount, FA) {
      ensureStyles();
      try {
        var data = await FA.api('/api/overview' + (FA.periodQuery ? FA.periodQuery() : ''));
        if (!data || data.error) {
          mount.appendChild(FA.el('div', { class: 'empty' },
            (data && data.error) || 'We couldn’t load your overview just now. Please try again.'));
          return;
        }
        var kpis = data.kpis || {};

        mount.appendChild(buildHero(FA, kpis));
        mount.appendChild(buildKpis(FA, kpis));
        mount.appendChild(buildSecondaryStats(FA, kpis));
        mount.appendChild(FA.el('div', { class: 'grid-2' },
          buildChart(FA, data.navSeries),
          FA.el('div', { class: 'right-rail', style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
            buildHoldings(FA, data.holdings),
            buildAllocation(FA, data.allocation))));
        mount.appendChild(buildRecent(FA, data.recentDocuments));
      } catch (e) {
        mount.appendChild(FA.el('div', { class: 'empty' }, 'Something went wrong loading your overview.'));
      }
    },
  });
})();
