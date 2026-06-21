// Financial-statements report — a printable, branded statutory pack assembled
// from the deterministic report engine. Modelled on a formal annual-report
// template (cover · contents · general information · directors' responsibilities
// · income statement · statement of financial position · notes). Every figure is
// engine-computed from the posted ledger; nothing is authored here.

import {
  trialBalance,
  profitAndLoss,
  balanceSheet,
  portfolio,
  type StatementLine,
} from './report';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function periodLabel(period?: string): string {
  if (!period || period === 'all' || !/^\d{4}-\d{2}$/.test(period)) return 'the period ended to date';
  const [y, m] = period.split('-');
  return `the period ended ${MONTHS[Number(m) - 1]} ${y}`;
}

function yearOf(period?: string): string {
  if (period && /^\d{4}-\d{2}$/.test(period)) return period.slice(0, 4);
  return String(new Date().getUTCFullYear());
}

function money(n: number): string {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '(' : '') + '€' + s + (v < 0 ? ')' : '');
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

function lineRows(lines: StatementLine[], cls = ''): string {
  return lines
    .map(
      (l) =>
        `<tr class="${cls}"><td class="acc">${l.accountCode && l.accountCode !== '—' ? esc(l.accountCode) + ' · ' : ''}${esc(l.accountName)}</td><td class="num">${money(l.amount)}</td></tr>`,
    )
    .join('');
}

export interface FsCompanyInfo {
  entity: string;
  registration?: string;
  registeredOffice?: string;
  directors?: string[];
  functionalCurrency?: string;
}

const DEFAULT_COMPANY: FsCompanyInfo = {
  entity: 'Tar Heel Capital Pathfinder MT Limited',
  registration: '—',
  registeredOffice: '—',
  directors: [],
  functionalCurrency: 'EUR',
};

export function buildFsReportHtml(period?: string, entityOrInfo?: string | FsCompanyInfo): string {
  const info: FsCompanyInfo =
    typeof entityOrInfo === 'string'
      ? { ...DEFAULT_COMPANY, entity: entityOrInfo }
      : { ...DEFAULT_COMPANY, ...(entityOrInfo || {}) };
  const entity = info.entity;

  const pl = profitAndLoss(period);
  const bs = balanceSheet(period);
  const tb = trialBalance(period);
  const pf = portfolio(period);
  const lbl = periodLabel(period);
  const yr = yearOf(period);
  const ccy = info.functionalCurrency || 'EUR';
  const profitWord = pl.netProfit >= 0 ? 'Profit for the financial period' : 'Loss for the financial period';

  // Investments note: equity (030) vs loans (032) by investee, with revaluation.
  const equityRows = pf.rows.filter((r) => !r.controlCode.startsWith('032'));
  const loanRows = pf.rows.filter((r) => r.controlCode.startsWith('032'));
  const investNote = (rows: typeof pf.rows): string =>
    rows.length
      ? rows
          .map(
            (r) =>
              `<tr><td class="acc">${esc(r.investeeName || r.controlCode)}</td><td class="num">${money(r.carryingValue)}</td><td class="num">${money(r.revaluedValue != null ? r.revaluedValue : r.carryingValue)}</td></tr>`,
          )
          .join('')
      : '<tr><td class="acc">None</td><td class="num">€0.00</td><td class="num">€0.00</td></tr>';
  const equityCost = equityRows.reduce((s, r) => s + (r.carryingValue || 0), 0);
  const equityFv = equityRows.reduce((s, r) => s + (r.revaluedValue != null ? r.revaluedValue : r.carryingValue || 0), 0);
  const loanCost = loanRows.reduce((s, r) => s + (r.carryingValue || 0), 0);
  const loanFv = loanRows.reduce((s, r) => s + (r.revaluedValue != null ? r.revaluedValue : r.carryingValue || 0), 0);

  const directorsList = (info.directors && info.directors.length ? info.directors : ['—']).map((d) => `<div>${esc(d)}</div>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Financial Statements — ${esc(entity)}</title>
<style>
  :root{--ink:#16202c;--mute:#5b6675;--line:#d8dee6;--primary:#1f2b5b;--accent:#494fdf;--lime:#c7ef3e;--paper:#fff}
  *{box-sizing:border-box}
  html,body{margin:0;background:#eef0f3}
  body{font-family:Georgia,'Times New Roman',serif;color:var(--ink);font-size:12.5px;line-height:1.5}
  .page{position:relative;background:var(--paper);width:210mm;min-height:297mm;margin:14px auto;padding:26mm 22mm 24mm;box-shadow:0 4px 22px rgba(0,0,0,.10)}
  .rhead{position:absolute;top:12mm;left:22mm;right:22mm;display:flex;justify-content:space-between;font-size:9.5px;color:var(--mute);border-bottom:1px solid var(--line);padding-bottom:5px;font-family:Arial,Helvetica,sans-serif}
  .pnum{position:absolute;bottom:12mm;left:0;right:0;text-align:center;font-size:10px;color:var(--mute);font-family:Arial,Helvetica,sans-serif}
  h1,h2,h3{font-family:Georgia,'Times New Roman',serif;color:var(--primary);font-weight:700}
  h2.sec{font-size:19px;margin:0 0 4px;padding-bottom:8px;border-bottom:2px solid var(--primary)}
  .sub{color:var(--mute);font-size:11px;margin:0 0 20px;font-family:Arial,Helvetica,sans-serif}
  p{margin:0 0 11px;text-align:justify}
  table{width:100%;border-collapse:collapse;font-size:12px}
  td,th{padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top}
  th{text-align:left;font-family:Arial,Helvetica,sans-serif;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--mute);border-bottom:1.5px solid var(--primary)}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;font-family:Arial,Helvetica,sans-serif}
  td.acc{padding-left:14px}
  tr.section td{font-weight:700;background:#f6f8fb;padding-top:10px;color:var(--primary)}
  tr.total td{font-weight:700;border-top:1px solid var(--ink)}
  tr.grand td{font-weight:800;border-top:2px solid var(--primary);border-bottom:3px double var(--primary);font-size:12.5px}
  .badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 9px;border-radius:9999px;background:var(--lime);color:#365314;margin-left:8px;font-family:Arial,Helvetica,sans-serif}
  .badge.warn{background:#fde68a;color:#92400e}
  .info-grid{display:grid;grid-template-columns:170px 1fr;gap:9px 16px;font-size:12px;margin-top:8px}
  .info-grid .k{color:var(--mute);font-family:Arial,Helvetica,sans-serif}
  .toc{list-style:none;padding:0;margin:14px 0 0}
  .toc li{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dotted var(--line)}
  .toc .pg{color:var(--mute)}
  /* Cover */
  .cover{display:flex;flex-direction:column;min-height:245mm;text-align:center;justify-content:center}
  .cover .brandbar{position:absolute;top:0;left:0;right:0;height:8mm;background:linear-gradient(90deg,var(--primary),var(--accent))}
  .cover img{height:46px;margin:0 auto 46px;object-fit:contain}
  .cover .ent{font-size:30px;color:var(--primary);letter-spacing:-.4px;margin:0 0 10px;font-weight:700}
  .cover .ttl{font-size:17px;color:var(--ink);margin:6px 0;letter-spacing:1px}
  .cover .rule{height:3px;width:80px;background:var(--lime);margin:26px auto;border-radius:2px}
  .cover .period{font-size:14px;color:var(--mute);font-family:Arial,Helvetica,sans-serif}
  .cover .foot{position:absolute;bottom:20mm;left:0;right:0;color:var(--mute);font-size:10px;font-family:Arial,Helvetica,sans-serif}
  .toolbar{position:fixed;top:12px;right:12px;z-index:10}
  .toolbar button{font:inherit;font-family:Arial,sans-serif;background:var(--primary);color:#fff;border:0;border-radius:8px;padding:9px 15px;cursor:pointer;font-weight:600}
  @media print{html,body{background:#fff}.page{box-shadow:none;margin:0;width:auto;min-height:auto;padding:20mm 18mm}.noprint{display:none}.page+.page{page-break-before:always}}
</style></head><body>
<div class="toolbar noprint"><button onclick="window.print()">Print / Save as PDF</button></div>

<!-- COVER -->
<section class="page cover">
  <div class="brandbar"></div>
  <img src="/assets/a4-logo.png" alt="A4" onerror="this.style.display='none'">
  <div class="ent">${esc(entity)}</div>
  <div class="ttl">ANNUAL REPORT AND</div>
  <div class="ttl">FINANCIAL STATEMENTS</div>
  <div class="rule"></div>
  <div class="period">For ${esc(lbl)}</div>
  <div class="foot">Prepared with Fund Autopilot — an A4 product. Figures are engine-computed from the posted ledger and presented in ${esc(ccy)}.</div>
</section>

<!-- CONTENTS -->
<section class="page">
  <div class="rhead"><span>${esc(entity)}</span><span>Annual Report and Financial Statements · ${esc(yr)}</span></div>
  <h2 class="sec">Contents</h2>
  <ul class="toc">
    <li><span>General Information</span><span class="pg">1</span></li>
    <li><span>Directors' Responsibilities</span><span class="pg">2</span></li>
    <li><span>Statement of Comprehensive Income</span><span class="pg">3</span></li>
    <li><span>Statement of Financial Position</span><span class="pg">4</span></li>
    <li><span>Notes to the Financial Statements</span><span class="pg">5</span></li>
    <li><span>Appendix — Trial Balance</span><span class="pg">7</span></li>
  </ul>
  <div class="pnum">— i —</div>
</section>

<!-- GENERAL INFORMATION -->
<section class="page">
  <div class="rhead"><span>${esc(entity)}</span><span>Annual Report and Financial Statements · ${esc(yr)}</span></div>
  <h2 class="sec">General Information</h2>
  <p class="sub">For ${esc(lbl)}</p>
  <div class="info-grid">
    <div class="k">Entity</div><div>${esc(entity)}</div>
    <div class="k">Registration number</div><div>${esc(info.registration || '—')}</div>
    <div class="k">Registered office</div><div>${esc(info.registeredOffice || '—')}</div>
    <div class="k">Directors</div><div>${directorsList}</div>
    <div class="k">Functional currency</div><div>${esc(ccy)}</div>
    <div class="k">Nature of business</div><div>Closed-ended investment holding (private equity / venture capital)</div>
    <div class="k">Basis of preparation</div><div>Prepared under the historical cost convention as modified by the revaluation of investments measured at fair value through profit or loss (IFRS 9).</div>
  </div>
  <div class="pnum">— 1 —</div>
</section>

<!-- DIRECTORS' RESPONSIBILITIES -->
<section class="page">
  <div class="rhead"><span>${esc(entity)}</span><span>Annual Report and Financial Statements · ${esc(yr)}</span></div>
  <h2 class="sec">Directors' Responsibilities</h2>
  <p class="sub">For ${esc(lbl)}</p>
  <p>The directors are responsible for preparing financial statements that give a true and fair view of the state of affairs of the company and of its profit or loss for the period. In preparing these financial statements the directors are required to:</p>
  <p>· select suitable accounting policies and apply them consistently;<br>· make judgements and estimates that are reasonable and prudent;<br>· state whether applicable accounting standards have been followed; and<br>· prepare the financial statements on a going-concern basis unless it is inappropriate to presume that the company will continue in business.</p>
  <p>The directors are responsible for keeping proper accounting records that disclose with reasonable accuracy at any time the financial position of the company and enable them to ensure that the financial statements comply with applicable law. They are also responsible for safeguarding the assets of the company and hence for taking reasonable steps for the prevention and detection of fraud and other irregularities.</p>
  <p class="sub" style="margin-top:24px">These financial statements were prepared on a deterministic basis from the company's posted accounting records. Every figure traces to an approved, balanced journal entry; an immutable audit trail records each posting, edit and reversal.</p>
  <div class="pnum">— 2 —</div>
</section>

<!-- INCOME STATEMENT -->
<section class="page">
  <div class="rhead"><span>${esc(entity)}</span><span>Annual Report and Financial Statements · ${esc(yr)}</span></div>
  <h2 class="sec">Statement of Comprehensive Income</h2>
  <p class="sub">For ${esc(lbl)} · in ${esc(ccy)}</p>
  <table>
    <tr><th>Account</th><th class="num">${esc(yr)}</th></tr>
    <tr class="section"><td>Income</td><td class="num"></td></tr>
    ${lineRows(pl.revenue) || '<tr><td class="acc">No income recognised</td><td class="num">€0.00</td></tr>'}
    <tr class="total"><td class="acc">Total income</td><td class="num">${money(pl.totalRevenue)}</td></tr>
    <tr class="section"><td>Expenditure</td><td class="num"></td></tr>
    ${lineRows(pl.expenses) || '<tr><td class="acc">No expenditure recognised</td><td class="num">€0.00</td></tr>'}
    <tr class="total"><td class="acc">Total expenditure</td><td class="num">${money(pl.totalExpenses)}</td></tr>
    <tr class="grand"><td>${profitWord}</td><td class="num">${money(pl.netProfit)}</td></tr>
  </table>
  <p class="sub" style="margin-top:18px">The notes on the following pages form part of these financial statements.</p>
  <div class="pnum">— 3 —</div>
</section>

<!-- FINANCIAL POSITION -->
<section class="page">
  <div class="rhead"><span>${esc(entity)}</span><span>Annual Report and Financial Statements · ${esc(yr)}</span></div>
  <h2 class="sec">Statement of Financial Position</h2>
  <p class="sub">As at the end of ${esc(lbl)} · in ${esc(ccy)}</p>
  <table>
    <tr><th>Account</th><th class="num">${esc(yr)}</th></tr>
    <tr class="section"><td>Assets</td><td class="num"></td></tr>
    ${lineRows(bs.assets) || '<tr><td class="acc">None</td><td class="num">€0.00</td></tr>'}
    <tr class="total"><td class="acc">Total assets</td><td class="num">${money(bs.totalAssets)}</td></tr>
    <tr class="section"><td>Liabilities</td><td class="num"></td></tr>
    ${lineRows(bs.liabilities) || '<tr><td class="acc">None</td><td class="num">€0.00</td></tr>'}
    <tr class="total"><td class="acc">Total liabilities</td><td class="num">${money(bs.totalLiabilities)}</td></tr>
    <tr class="section"><td>Equity</td><td class="num"></td></tr>
    ${lineRows(bs.equity) || '<tr><td class="acc">None</td><td class="num">€0.00</td></tr>'}
    <tr class="total"><td class="acc">Total equity</td><td class="num">${money(bs.totalEquity)}</td></tr>
    <tr class="grand"><td>Total liabilities and equity${bs.balanced ? '<span class="badge">Balanced</span>' : '<span class="badge warn">Out of balance</span>'}</td><td class="num">${money(bs.totalLiabilities + bs.totalEquity)}</td></tr>
  </table>
  <div class="pnum">— 4 —</div>
</section>

<!-- NOTES -->
<section class="page">
  <div class="rhead"><span>${esc(entity)}</span><span>Annual Report and Financial Statements · ${esc(yr)}</span></div>
  <h2 class="sec">Notes to the Financial Statements</h2>
  <p class="sub">For ${esc(lbl)}</p>
  <h3 style="font-size:13px;margin:6px 0 4px">1. General information</h3>
  <p>${esc(entity)} is a closed-ended investment holding company. These financial statements present the company's results and financial position for ${esc(lbl)} and are presented in ${esc(ccy)}.</p>
  <h3 style="font-size:13px;margin:14px 0 4px">2. Significant accounting policies</h3>
  <p><b>Basis of preparation.</b> The financial statements are prepared under the historical cost convention, as modified for investments measured at fair value through profit or loss, on a going-concern basis.</p>
  <p><b>Investments.</b> Equity investments are classified as financial assets at fair value through profit or loss (IFRS 9 FVTPL). They are recognised at cost on acquisition and remeasured to fair value at each reporting date, with movements taken to profit or loss. Loans advanced to investees are carried at amortised cost; interest is accrued over the loan term.</p>
  <p><b>Foreign currency.</b> Transactions in foreign currency are translated to ${esc(ccy)} at the rate ruling on the transaction (settlement) date. Monetary items are retranslated at the closing rate, with differences taken to profit or loss.</p>
  <p><b>Revenue.</b> Realised gains on disposal of investments are recognised on completion. Dividend income is recognised when the right to receive payment is established. Interest income is recognised on an accruals basis.</p>
  <h3 style="font-size:13px;margin:14px 0 4px">3. Investments in equity (account 030)</h3>
  <table>
    <tr><th>Investee</th><th class="num">Cost</th><th class="num">Fair value</th></tr>
    ${investNote(equityRows)}
    <tr class="total"><td class="acc">Total equity investments</td><td class="num">${money(equityCost)}</td><td class="num">${money(equityFv)}</td></tr>
  </table>
  <div class="pnum">— 5 —</div>
</section>

<section class="page">
  <div class="rhead"><span>${esc(entity)}</span><span>Annual Report and Financial Statements · ${esc(yr)}</span></div>
  <h3 style="font-size:13px;margin:0 0 4px">4. Loans granted to investees (account 032)</h3>
  <table>
    <tr><th>Borrower</th><th class="num">Principal</th><th class="num">Carrying value</th></tr>
    ${investNote(loanRows)}
    <tr class="total"><td class="acc">Total loans granted</td><td class="num">${money(loanCost)}</td><td class="num">${money(loanFv)}</td></tr>
  </table>
  <p class="sub" style="margin-top:16px">Carrying values are stated in ${esc(ccy)}; the fair-value column reflects retranslation of foreign-currency holdings at the period-end rate.</p>
  <h3 style="font-size:13px;margin:18px 0 4px">5. Audit trail and controls</h3>
  <p>The company maintains an immutable, hash-chained audit trail. Each posting, edit and reversal is recorded with its actor and timestamp; periods may be locked to prevent further change once closed. No figure in these statements is estimated by a language model — all amounts are computed by deterministic engine code from approved journal entries.</p>
  <div class="pnum">— 6 —</div>
</section>

<!-- APPENDIX: TRIAL BALANCE -->
<section class="page">
  <div class="rhead"><span>${esc(entity)}</span><span>Annual Report and Financial Statements · ${esc(yr)}</span></div>
  <h2 class="sec">Appendix — Trial Balance</h2>
  <p class="sub">For ${esc(lbl)} · in ${esc(ccy)}</p>
  <table>
    <tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr>
    ${tb.rows.map((r) => `<tr><td class="acc">${esc(r.accountCode)} · ${esc(r.accountName)}</td><td class="num">${r.debit ? money(r.debit) : ''}</td><td class="num">${r.credit ? money(r.credit) : ''}</td></tr>`).join('')}
    <tr class="grand"><td>Total${Math.abs(tb.totals.debit - tb.totals.credit) < 0.01 ? '<span class="badge">Dr = Cr</span>' : '<span class="badge warn">Out of balance</span>'}</td><td class="num">${money(tb.totals.debit)}</td><td class="num">${money(tb.totals.credit)}</td></tr>
  </table>
  <div class="pnum">— 7 —</div>
</section>

</body></html>`;
}
