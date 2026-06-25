// Financial-statements line structure — reproduces THCP's workbook groupings
// (source: BS-2024 / P&L_2024 sheets) so the printable FS pack mirrors the client's
// own statements rather than a flat type-grouped list.
//
// This is a PRESENTATION layer over the deterministic report engine: it buckets the
// already-typed balanceSheet()/profitAndLoss() balances into named statement lines.
// Each line absorbs both the THCP statutory code and the equivalent app-chart code
// so a book mixing the two charts still maps. Grand totals tie by construction
// (regrouping the same balances never changes their sum). Note: the workbook
// presents "Deferred income" (840) inside the Equity block even though it is a
// liability — we follow that presentation; the total of equity+liabilities is
// unaffected.

import { balanceSheet, profitAndLoss, type StatementLine } from './report';

export type RowKind = 'header' | 'line' | 'subtotal' | 'total';
export interface StatementRow {
  id: string;
  label: string;
  amount: number | null; // null for pure header rows
  kind: RowKind;
  indent?: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const matches = (code: string, ...res: RegExp[]) => res.some((re) => re.test(code));

/** Sum the balanceSheet/profitAndLoss lines whose code satisfies the predicate. */
function sumWhere(lines: StatementLine[], pred: (code: string) => boolean): number {
  return r2(lines.filter((l) => pred(l.accountCode)).reduce((s, l) => s + l.amount, 0));
}

// --- Statement of financial position ----------------------------------------

export function financialPositionRows(period?: string): StatementRow[] {
  const bs = balanceSheet(period);
  const A = bs.assets;
  const L = bs.liabilities;
  const E = bs.equity;

  const investments = sumWhere(A, (c) => matches(c, /^030(-|$)/));
  const loans = sumWhere(A, (c) => matches(c, /^032(-|$)/) && !/^032-1/.test(c));
  const accruedInterest = sumWhere(A, (c) => matches(c, /^032-1/, /^105$/));
  const tradeReceivables = sumWhere(A, (c) => matches(c, /^240/, /^1100$/, /^105[0-9]$/) && c !== '1010' && c !== '1011');
  const cash = sumWhere(A, (c) => matches(c, /^130/, /^101$/, /^140$/, /^1010$/, /^1011$/, /^B($|[-\d])/i));
  const knownAsset = (c: string) =>
    matches(c, /^030(-|$)/) || (matches(c, /^032(-|$)/)) || matches(c, /^240/, /^1100$/, /^130/, /^101$/, /^140$/, /^1010$/, /^1011$/, /^105$/, /^B($|[-\d])/i);
  const otherAssets = sumWhere(A, (c) => !knownAsset(c));

  const shareCapital = sumWhere(E, (c) => matches(c, /^801$/, /^3000$/));
  const supplementary = sumWhere(E, (c) => matches(c, /^802$/));
  // Deferred income (840) is presented inside the equity block per the workbook.
  const deferredIncome = sumWhere(L, (c) => matches(c, /^840/));
  const accumulated = sumWhere(E, (c) => matches(c, /^860$/, /^3100$/) || c === '—' || c === '-');
  const knownEquity = (c: string) => matches(c, /^801$/, /^3000$/, /^802$/, /^860$/, /^3100$/) || c === '—' || c === '-';
  const otherEquity = sumWhere(E, (c) => !knownEquity(c));

  const shortTerm = sumWhere(L, (c) => matches(c, /^500$/, /^2010$/, /^2300$/));
  const accruals = sumWhere(L, (c) => matches(c, /^501$/, /^64-AE/));
  const knownLiab = (c: string) => matches(c, /^840/, /^500$/, /^2010$/, /^2300$/, /^501$/, /^64-AE/);
  const otherLiab = sumWhere(L, (c) => !knownLiab(c));

  const totalNonCurrent = r2(investments + loans + accruedInterest);
  const totalCurrentAssets = r2(tradeReceivables + cash + otherAssets);
  const totalAssets = r2(totalNonCurrent + totalCurrentAssets);
  const totalEquity = r2(shareCapital + supplementary + deferredIncome + accumulated + otherEquity);
  const totalLiabilities = r2(shortTerm + accruals + otherLiab);
  const totalEqLiab = r2(totalEquity + totalLiabilities);

  const rows: StatementRow[] = [];
  const push = (id: string, label: string, amount: number | null, kind: RowKind, indent = false) => {
    if (kind === 'line' && (amount === null || amount === 0)) return; // omit empty detail lines
    rows.push({ id, label, amount, kind, indent });
  };

  push('h-nca', 'Non-current assets', null, 'header');
  push('investments', 'Investments in shares', investments, 'line', true);
  push('loans', 'Loans granted', loans, 'line', true);
  push('accrued-interest', 'Accrued interest on loans', accruedInterest, 'line', true);
  push('total-non-current', 'Total non-current assets', totalNonCurrent, 'subtotal');
  push('h-ca', 'Current assets', null, 'header');
  push('trade-receivables', 'Trade and other receivables', tradeReceivables, 'line', true);
  push('cash', 'Cash at bank and in hand', cash, 'line', true);
  push('other-assets', 'Other assets', otherAssets, 'line', true);
  push('total-current-assets', 'Total current assets', totalCurrentAssets, 'subtotal');
  push('total-assets', 'Total assets', totalAssets, 'total');
  push('h-equity', 'Equity', null, 'header');
  push('share-capital', 'Share capital', shareCapital, 'line', true);
  push('supplementary-capital', 'Supplementary capital', supplementary, 'line', true);
  push('deferred-income', 'Deferred income', deferredIncome, 'line', true);
  push('accumulated-pl', 'Accumulated profit/(loss)', accumulated, 'line', true);
  push('other-equity', 'Other equity', otherEquity, 'line', true);
  push('total-equity', 'Total equity', totalEquity, 'subtotal');
  push('h-cl', 'Current liabilities', null, 'header');
  push('short-term-liabilities', 'Short-term liabilities', shortTerm, 'line', true);
  push('accruals', 'Accruals', accruals, 'line', true);
  push('other-liabilities', 'Other liabilities', otherLiab, 'line', true);
  push('total-current-liabilities', 'Total current liabilities', totalLiabilities, 'subtotal');
  push('total-eq-liab', 'Total equity and liabilities', totalEqLiab, 'total');
  return rows;
}

// --- Income statement -------------------------------------------------------

export function incomeStatementRows(period?: string): StatementRow[] {
  const pl = profitAndLoss(period);
  const R = pl.revenue;
  const X = pl.expenses;

  const gainOnDisposal = sumWhere(R, (c) => matches(c, /^750-1$/, /^500$/));
  const dividends = sumWhere(R, (c) => matches(c, /^750-2$/, /^4000$/, /^4010$/));
  const fxGain = sumWhere(R, (c) => matches(c, /^EXCH-P$/i));
  const interestIncome = sumWhere(R, (c) => matches(c, /^750-3$/, /^510$/));
  const fvMovement = sumWhere(R, (c) => matches(c, /^710$/));
  const knownRev = (c: string) => matches(c, /^750-1$/, /^500$/, /^750-2$/, /^4000$/, /^4010$/, /^EXCH-P$/i, /^750-3$/, /^510$/, /^710$/);
  const otherIncome = sumWhere(R, (c) => !knownRev(c));

  const lossOnDisposal = sumWhere(X, (c) => matches(c, /^751$/));
  const operating = sumWhere(X, (c) => matches(c, /^402/, /^403$/, /^409$/, /^6000$/, /^6100$/, /^6200$/, /^6300$/, /^6500$/, /^601$/));
  const writeOff = sumWhere(X, (c) => matches(c, /^W-O$/i, /^610$/, /^6850$/));
  const fxLoss = sumWhere(X, (c) => matches(c, /^EXCH-L$/i, /^6800$/));
  const interestExpense = sumWhere(X, (c) => matches(c, /^6400$/));
  const knownExp = (c: string) => matches(c, /^751$/, /^402/, /^403$/, /^409$/, /^6000$/, /^6100$/, /^6200$/, /^6300$/, /^6500$/, /^601$/, /^W-O$/i, /^610$/, /^6850$/, /^EXCH-L$/i, /^6800$/, /^6400$/);
  const otherExpense = sumWhere(X, (c) => !knownExp(c));

  const operatingRevenue = gainOnDisposal;
  const operatingExpenses = r2(lossOnDisposal + operating);
  const operatingResult = r2(operatingRevenue - operatingExpenses);
  const financialIncome = r2(dividends + fxGain + interestIncome + fvMovement + otherIncome);
  const financialExpenses = r2(writeOff + fxLoss + interestExpense + otherExpense);
  const profitBeforeTax = r2(operatingResult + financialIncome - financialExpenses);
  const netProfit = r2(pl.totalRevenue - pl.totalExpenses);

  const rows: StatementRow[] = [];
  const push = (id: string, label: string, amount: number | null, kind: RowKind, indent = false) => {
    if (kind === 'line' && (amount === null || amount === 0)) return;
    rows.push({ id, label, amount, kind, indent });
  };

  push('h-rev', 'Operating revenue', null, 'header');
  push('gain-on-disposal', 'Gain on disposal of shares', operatingRevenue, 'line', true);
  push('total-operating-revenue', 'Total operating revenue', r2(operatingRevenue), 'subtotal');
  push('h-opex', 'Operating expenses', null, 'header');
  push('loss-on-disposal', 'Loss / cost on disposal of shares', lossOnDisposal, 'line', true);
  push('operating-expenses', 'Administrative & other operating expenses', operating, 'line', true);
  push('total-operating-expenses', 'Total operating expenses', operatingExpenses, 'subtotal');
  push('operating-result', 'Profit/(loss) on operating activities', operatingResult, 'subtotal');
  push('h-finrev', 'Financial income', null, 'header');
  push('dividends', 'Dividends', dividends, 'line', true);
  push('fx-gain', 'Profit on currency exchange', fxGain, 'line', true);
  push('interest-income', 'Interest income', interestIncome, 'line', true);
  push('fv-movement', 'Fair-value movement on investments', fvMovement, 'line', true);
  push('other-income', 'Other income', otherIncome, 'line', true);
  push('total-financial-income', 'Total financial income', financialIncome, 'subtotal');
  push('h-finexp', 'Financial expenses', null, 'header');
  push('write-off', 'Write-offs / impairment', writeOff, 'line', true);
  push('fx-loss', 'Loss on currency exchange', fxLoss, 'line', true);
  push('interest-expense', 'Interest expense', interestExpense, 'line', true);
  push('other-expense', 'Other expenses', otherExpense, 'line', true);
  push('total-financial-expenses', 'Total financial expenses', financialExpenses, 'subtotal');
  push('profit-before-tax', 'Profit/(loss) before tax', profitBeforeTax, 'total');
  push('net-profit', 'Net profit/(loss) for the period', netProfit, 'total');
  return rows;
}
