// Reports (CONTRACT §8): portfolio, ledger, trial balance, and CSV export.
// All figures come from POSTED journal lines — never from the AI.

import { accountName, getRegisteredChart, type AccountType } from '../core/chart';
import { inferAccountType } from '../core/chart-store';
import { assertControlInvariant } from '../core/invariant';
import { listDrafts, listPostedLines, getFxRate, type DraftRecord, type PostedLineRow } from '../db/store';
import { loadRates } from '../fx/rates';
import { listTransactions, listAccounts } from '../bank/bank-store';
import { listItems } from '../arap/arap-store';
import { unitsHeldFor } from './positions';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// --- Bank + AR/AP general-ledger lines --------------------------------------
// The trial balance and ledger must reflect EVERYTHING, not just investment
// drafts. Each bank transaction and each invoice/bill becomes a balanced
// double-entry (in EUR), so debtors, creditors, bank movements and expenses all
// appear and the books still balance.

/** Best-effort EUR-per-unit rate for `currency` on `date`: the cached ECB daily
 *  rate first, else the bundled rate (inverted), else 1. Synchronous. */
function eurRate(currency: string, date: string): number {
  const cur = (currency || 'EUR').toUpperCase();
  if (cur === 'EUR') return 1;
  const cached = getFxRate(`${cur}:${date}`);
  if (cached && isFinite(cached) && cached > 0) return cached;
  const pts = loadRates()
    .filter((p) => p.currency === cur)
    .sort((a, b) => a.rateDate.getTime() - b.rateDate.getTime());
  if (!pts.length) return 1;
  const target = Date.parse(`${date}T00:00:00Z`);
  let chosen = pts[0];
  for (const p of pts) {
    if (!Number.isNaN(target) && p.rateDate.getTime() <= target) chosen = p;
    else if (!Number.isNaN(target)) break;
  }
  return chosen.rate ? 1 / chosen.rate : 1;
}

export function toEur(amount: number, currency: string, date: string): number {
  return round2(amount * eurRate(currency, date));
}

/** Convert an AR/AP item to EUR. Prefers the exact-date ECB rate captured at intake
 *  (EUR per 1 unit, IAS 21 spot on the transaction date — the same source investments
 *  and bank settlements use); falls back to the bundled-table conversion only for
 *  legacy items recorded before rate capture. */
export function arapItemToEur(item: {
  amount: number;
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  fxRate?: number | null;
}): number {
  if (typeof item.fxRate === 'number' && Number.isFinite(item.fxRate) && item.fxRate > 0) {
    return round2(item.amount * item.fxRate);
  }
  return toEur(item.amount, item.currency, item.issueDate || item.dueDate || '');
}

function glLine(
  code: string,
  amount: number,
  period: string,
  txnDate: string,
  description: string,
  eventType: string,
  source?: { txnId?: string; documentId?: string | null; docName?: string | null },
): PostedLineRow {
  return {
    accountCode: code,
    accountName: accountName(code),
    amount: round2(amount),
    description,
    txnId: source?.txnId || 'gl',
    txnDate,
    period,
    eventType,
    investeeName: '',
    fxRate: null,
    fxRateDate: null,
    documentId: source?.documentId ?? null,
    docName: source?.docName ?? null,
  };
}

/** Two GL lines per bank transaction: Bank (1010) vs the categorised account. */
function bankLedgerLines(): PostedLineRow[] {
  const accCcy = new Map(listAccounts().map((a) => [a.id, a.currency || 'EUR']));
  const out: PostedLineRow[] = [];
  for (const t of listTransactions()) {
    if (t.status === 'REJECTED') continue;
    if (t.dateFlag) continue; // trap T2: held for review until the impossible date is fixed
    if (t.matchedInvestmentDraftId) continue; // NH-0: cash leg already booked by the investment entry
    const ccy = (accCcy.get(t.bankAccountId) as string) || 'EUR';
    const desc = t.description || 'Bank transaction';
    // A split line posts the bank movement against several accounts; the bank
    // side equals the sum of the (EUR-converted) allocations so the entry ties.
    const src = { txnId: t.id, documentId: t.matchedDocumentId ?? null, docName: null };
    if (Array.isArray(t.splits) && t.splits.length) {
      const eurs = t.splits.map((s) => toEur(s.amount, ccy, t.date));
      const total = round2(eurs.reduce((a, b) => a + b, 0));
      out.push(glLine('1010', total, t.period, t.date, desc, 'BANK', src));
      t.splits.forEach((s, i) => out.push(glLine(s.accountCode, -eurs[i], t.period, t.date, desc, 'BANK', src)));
      continue;
    }
    const eur = toEur(t.amount, ccy, t.date);
    if (!eur) continue;
    const code = t.postToCode || '9999';
    out.push(glLine('1010', eur, t.period, t.date, desc, 'BANK', src));
    out.push(glLine(code, -eur, t.period, t.date, desc, 'BANK', src));
  }
  return out;
}

/** Two GL lines per invoice/bill: the control account vs income/expense. */
function arapLedgerLines(): PostedLineRow[] {
  const out: PostedLineRow[] = [];
  for (const it of listItems()) {
    const date = it.issueDate || it.dueDate || '';
    const period = date.slice(0, 7);
    const eur = arapItemToEur(it);
    if (!eur) continue;
    const src = { txnId: it.id, documentId: it.documentId ?? null, docName: it.docName ?? null };
    if (it.kind === 'RECEIVABLE') {
      const desc = `Invoice — ${it.counterparty || ''}`.trim();
      out.push(glLine('1100', eur, period, date, desc, 'ARAP', src)); // Dr debtors
      out.push(glLine('4010', -eur, period, date, desc, 'ARAP', src)); // Cr other income
    } else {
      const desc = `Bill — ${it.counterparty || ''}`.trim();
      out.push(glLine('6200', eur, period, date, desc, 'ARAP', src)); // Dr office & administration (default)
      out.push(glLine('2010', -eur, period, date, desc, 'ARAP', src)); // Cr creditors
    }
  }
  return out;
}

/** Bank + AR/AP GL lines, optionally restricted to one period. */
function extraLedgerLinesIn(period?: string): PostedLineRow[] {
  const all = [...bankLedgerLines(), ...arapLedgerLines()];
  const p = period && period !== 'all' ? period : undefined;
  return p ? all.filter((l) => l.period === p) : all;
}

// --- Portfolio ---------------------------------------------------------------

export interface PortfolioRow {
  investeeName: string;
  instrument: DraftRecord['instrument'];
  controlCode: string;
  currency: string;
  carryingValue: number;
  /** Re-valued to EUR at the period-end / closing FX rate (vs cost). */
  revaluedValue: number;
  revalFxRate: number;
  revalDate: string;
}

/** Last calendar day of a YYYY-MM period (for revaluation), else today. */
function periodEndDate(period?: string): string {
  if (period && /^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split('-').map(Number);
    const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${period}-${String(day).padStart(2, '0')}`;
  }
  return new Date().toISOString().slice(0, 10);
}

/** Net cost in the holding's own currency (acquisitions less disposals/write-offs). */
/**
 * Foreign-currency cost base for the CURRENTLY-held position — used to retranslate
 * the holding at closing FX in the portfolio revaluation column.
 *
 * Each draft's `originalAmount` means a DIFFERENT thing per event (cost / proceeds /
 * advance / repayment), so it can't be summed with a blanket ± sign. Instead:
 *   - EQUITY (030): average cost. Total acquired cost scaled by the fraction of units
 *     STILL HELD (mirrors disposalCarryingCost — cost flows out pro-rata by units). A
 *     DISPOSAL's originalAmount is PROCEEDS, so it must never be subtracted from cost.
 *   - LOAN (032): principal = advances NET OF repayments (in original currency).
 *   - WRITE_OFF: nil.
 *   - FV_REMEAS: ignored (adjusts carrying value, not the cost base).
 */
export function originalCostFor(controlCode: string): { amount: number; currency: string } {
  let currency = 'EUR';
  let acqCost = 0; // equity: total acquired original cost (foreign)
  let acqUnits = 0; // equity: total acquired units
  let principal = 0; // loans: advances - repayments (foreign)
  let writtenOff = false;
  for (const d of listDrafts('POSTED')) {
    if (d.controlCode !== controlCode) continue;
    if (d.eventType === 'FV_REMEAS') continue;
    const orig = Number(d.engineFigures?.originalAmount) || 0;
    switch (d.eventType) {
      case 'ACQUISITION':
        acqCost += orig;
        acqUnits += Math.abs(Number(d.sourceFigures?.quantity) || 0);
        currency = d.engineFigures?.originalCurrency || d.currency || currency;
        break;
      case 'LOAN_ADVANCE':
        principal += orig;
        currency = d.engineFigures?.originalCurrency || d.currency || currency;
        break;
      case 'LOAN_REPAYMENT':
        principal -= orig;
        break;
      case 'WRITE_OFF':
        writtenOff = true;
        break;
      default:
        // DISPOSAL (proceeds, not cost) and all other events leave the cost base to
        // be derived from units still held / principal net of repayments.
        break;
    }
  }
  if (writtenOff) return { amount: 0, currency };
  if (/^032/.test(controlCode)) return { amount: round2(principal), currency };
  if (acqUnits > 0) {
    const held = Math.max(0, Math.min(unitsHeldFor(controlCode), acqUnits));
    return { amount: round2((acqCost * held) / acqUnits), currency };
  }
  return { amount: round2(acqCost), currency };
}

export interface PortfolioTotal {
  controlCode: string; // parent control ('030' / '032')
  total: number;
}

export interface PortfolioReport {
  rows: PortfolioRow[];
  totals: PortfolioTotal[];
  warnings?: string[];
}

function parentControl(controlCode: string): string {
  return controlCode.split('-')[0];
}

/** Normalize a period filter: undefined / 'all' / '' mean "no filter". */
function normPeriod(period?: string): string | undefined {
  return period && period !== 'all' ? period : undefined;
}

/** Posted lines kept for a portfolio "as at end of period": period <= selected.
 *  No filter = all posted lines (cumulative). */
function postedLinesAsAt(period?: string): PostedLineRow[] {
  const p = normPeriod(period);
  const all = listPostedLines();
  if (!p) return all;
  return all.filter((ln) => ln.period && ln.period <= p);
}

/** Posted lines whose draft period exactly matches (for ledger / trial balance). */
function postedLinesIn(period?: string): PostedLineRow[] {
  const p = normPeriod(period);
  const all = listPostedLines();
  if (!p) return all;
  return all.filter((ln) => ln.period === p);
}

/** Carrying value of one control sub-account from a given set of posted lines. */
function carryingFromLines(lines: PostedLineRow[], controlCode: string): number {
  let sum = 0;
  for (const ln of lines) if (ln.accountCode === controlCode) sum += ln.amount;
  return round2(sum);
}

/** Net balance per account code from a given set of posted lines. */
function balancesFromLines(lines: PostedLineRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const ln of lines) {
    map.set(ln.accountCode, round2((map.get(ln.accountCode) ?? 0) + ln.amount));
  }
  return map;
}

export function portfolio(period?: string): PortfolioReport {
  // Positions as at end of the selected period (period <= selected); no filter = cumulative.
  const posted = postedLinesAsAt(period);

  // One row per investment control sub-account that carries a balance in the
  // ledger — this includes IMPORTED OPENING BALANCES (030-x / 032-x) and posted
  // drafts, so the portfolio reflects holdings as soon as the books exist, not
  // only after an investment document is approved. Investee names come from any
  // posted draft, else the chart registry (set on opening-balance import).
  const draftMeta = new Map<string, { investeeName: string; instrument: DraftRecord['instrument']; currency: string }>();
  for (const d of listDrafts('POSTED')) {
    if (!draftMeta.has(d.controlCode)) {
      draftMeta.set(d.controlCode, { investeeName: d.investeeName, instrument: d.instrument, currency: d.currency });
    }
  }
  // An investment holding sub-account: 030-<x> (equity) or 032-<x> (loan), but
  // NOT 032-1-<x> (loan interest, which belongs in the P&L/TB, not holdings).
  const isHoldingCode = (code: string): boolean =>
    (/^030-/.test(code) || /^032-/.test(code)) && !/^032-1/.test(code);

  const seen = new Set<string>();
  for (const ln of posted) {
    if (isHoldingCode(ln.accountCode)) seen.add(ln.accountCode);
  }

  const revalDate = periodEndDate(period);
  const rows: PortfolioRow[] = [];
  for (const controlCode of seen) {
    const carryingValue = carryingFromLines(posted, controlCode);
    if (Math.abs(carryingValue) < 0.01) continue; // skip fully-disposed / nil positions
    const meta = draftMeta.get(controlCode);
    const instrument: DraftRecord['instrument'] = meta?.instrument ?? (/^032/.test(controlCode) ? 'LOAN' : 'SHARES');
    const investeeName = meta?.investeeName || accountName(controlCode) || controlCode;
    // Revalue at closing FX. Holdings booked in a foreign currency (from drafts)
    // carry an original cost we retranslate; opening/EUR-carried holdings revalue
    // at par (already in EUR).
    const cost = originalCostFor(controlCode);
    let revaluedValue = carryingValue;
    let revalFxRate = 1;
    if (cost.amount !== 0 && (cost.currency || 'EUR').toUpperCase() !== 'EUR') {
      revalFxRate = eurRate(cost.currency, revalDate);
      revaluedValue = round2(cost.amount * revalFxRate);
    }
    rows.push({
      investeeName,
      instrument,
      controlCode,
      currency: meta?.currency || 'EUR',
      carryingValue,
      revaluedValue,
      revalFxRate,
      revalDate,
    });
  }
  rows.sort((a, b) => a.controlCode.localeCompare(b.controlCode));

  // Totals + defensive invariant check per parent control account.
  const balances = balancesFromLines(posted);
  const warnings: string[] = [];
  const totalsMap = new Map<string, number>();

  for (const row of rows) {
    const parent = parentControl(row.controlCode);
    totalsMap.set(parent, round2((totalsMap.get(parent) ?? 0) + row.carryingValue));
  }

  for (const [parent, total] of totalsMap) {
    // GL balance of the parent control = sum of sub-account ledger balances.
    const glBalance = round2(
      [...balances.entries()]
        .filter(([code]) => parentControl(code) === parent && isHoldingCode(code))
        .reduce((s, [, v]) => s + v, 0),
    );
    const positions: Record<string, number> = {};
    for (const row of rows) {
      if (parentControl(row.controlCode) === parent) positions[row.controlCode] = row.carryingValue;
    }
    try {
      assertControlInvariant(glBalance, positions);
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
    void total;
  }

  const totals: PortfolioTotal[] = [...totalsMap.entries()].map(([controlCode, total]) => ({
    controlCode,
    total,
  }));
  totals.sort((a, b) => a.controlCode.localeCompare(b.controlCode));

  const report: PortfolioReport = { rows, totals };
  if (warnings.length) report.warnings = warnings;
  return report;
}

export interface AllocationHolding {
  name: string;
  kind: string; // 'LOAN' | 'EQUITY'
  value: number; // carrying amount
  revalued: number | null; // closing-FX / fair value, or null when not revalued
}

export interface AllocationSlice {
  name: string;
  value: number;
  pct: number;
}

/**
 * Portfolio allocation (each holding as a % of NAV). The NAV the dashboard reports
 * carries EQUITY at valuation (revalued) and LOANS at carrying amount — the two are
 * deliberately kept on different bases. The allocation numerator must use the SAME
 * basis as that NAV denominator, otherwise the percentages don't sum to 100: a loan
 * whose foreign carrying value has a populated `revalued` figure would be counted at
 * the revalued amount over a NAV that only held it at carrying. So: loans use carrying
 * (`value`), equity uses revalued-or-carrying.
 */
export function navAllocation(holdings: AllocationHolding[], nav: number): AllocationSlice[] {
  return holdings.map((h) => {
    const v = h.kind === 'LOAN' ? h.value : h.revalued != null ? h.revalued : h.value;
    return { name: h.name, value: v, pct: nav ? Math.round((v / nav) * 1000) / 10 : 0 };
  });
}

// --- Ledger ------------------------------------------------------------------

export function ledger(period?: string): { lines: PostedLineRow[] } {
  const lines = [...postedLinesIn(period), ...extraLedgerLinesIn(period)];
  lines.sort((a, b) => String(a.txnDate).localeCompare(String(b.txnDate)));
  return { lines };
}

// --- Trial balance -----------------------------------------------------------

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface TrialBalanceReport {
  rows: TrialBalanceRow[];
  totals: { debit: number; credit: number };
}

/** Per-investee investment/loan sub-accounts (030-gamivo / 032-climax) roll up to
 *  their standard control parent (030 / 032) so the trial balance presents clean
 *  standard chart accounts; the per-holding detail stays in Portfolio/Ledger. */
export function rollupForTrialBalance(code: string): string {
  return /^03[02]-/.test(code) ? code.split('-')[0] : code;
}

export function trialBalance(period?: string): TrialBalanceReport {
  const raw = balancesFromLines([...postedLinesIn(period), ...extraLedgerLinesIn(period)]);
  // Aggregate per-investee sub-accounts under their standard parent control account.
  const balances = new Map<string, number>();
  for (const [code, bal] of raw) {
    const key = rollupForTrialBalance(code);
    balances.set(key, round2((balances.get(key) ?? 0) + bal));
  }
  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const [accountCode, balance] of balances) {
    const debit = balance > 0 ? round2(balance) : 0;
    const credit = balance < 0 ? round2(-balance) : 0;
    totalDebit = round2(totalDebit + debit);
    totalCredit = round2(totalCredit + credit);
    rows.push({
      accountCode,
      accountName: accountName(accountCode),
      debit,
      credit,
      balance: round2(balance),
    });
  }
  rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  return { rows, totals: { debit: totalDebit, credit: totalCredit } };
}

// --- Management accounts: P&L and Balance Sheet ------------------------------

/** Resolve an account's type from the chart (or infer from its code). */
function typeOf(code: string): AccountType {
  const chart = getRegisteredChart();
  const exact = chart.find((a) => a.code === code);
  if (exact) return exact.type;
  const parent = chart.find((a) => a.code === code.split('-')[0]);
  if (parent) return parent.type;
  return inferAccountType(code);
}

/** Bank + AR/AP GL lines cumulative up to and including the period (for the BS). */
function extraLedgerLinesAsAt(period?: string): PostedLineRow[] {
  const all = [...bankLedgerLines(), ...arapLedgerLines()];
  const p = normPeriod(period);
  return p ? all.filter((l) => l.period && l.period <= p) : all;
}

export interface StatementLine { accountCode: string; accountName: string; amount: number; }
export interface ProfitAndLoss {
  revenue: StatementLine[];
  expenses: StatementLine[];
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
}

/** Profit & loss for the period: revenue (credit) less expenses (debit). */
export function profitAndLoss(period?: string): ProfitAndLoss {
  const balances = balancesFromLines([...postedLinesIn(period), ...extraLedgerLinesIn(period)]);
  const revenue: StatementLine[] = [];
  const expenses: StatementLine[] = [];
  let totalRevenue = 0;
  let totalExpenses = 0;
  for (const [code, bal] of balances) {
    const t = typeOf(code);
    if (t === 'REVENUE') {
      const amount = round2(-bal); // revenue carries a credit (negative) balance
      if (amount === 0) continue;
      revenue.push({ accountCode: code, accountName: accountName(code), amount });
      totalRevenue = round2(totalRevenue + amount);
    } else if (t === 'EXPENSE') {
      const amount = round2(bal); // expense carries a debit (positive) balance
      if (amount === 0) continue;
      expenses.push({ accountCode: code, accountName: accountName(code), amount });
      totalExpenses = round2(totalExpenses + amount);
    }
  }
  revenue.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  expenses.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  return { revenue, expenses, totalRevenue, totalExpenses, netProfit: round2(totalRevenue - totalExpenses) };
}

export interface BalanceSheet {
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  retainedEarnings: number;
  balanced: boolean;
  difference: number;
}

/** Balance sheet as at the period end: assets = liabilities + equity (incl. the
 *  current cumulative profit as retained earnings). */
export function balanceSheet(period?: string): BalanceSheet {
  const lines = [...postedLinesAsAt(period), ...extraLedgerLinesAsAt(period)];
  const raw = balancesFromLines(lines);
  // Roll per-investee investment/loan sub-accounts up to their standard control
  // parent (030/032) so the balance sheet presents clean standard accounts.
  const balances = new Map<string, number>();
  for (const [code, bal] of raw) {
    const key = rollupForTrialBalance(code);
    balances.set(key, round2((balances.get(key) ?? 0) + bal));
  }
  const assets: StatementLine[] = [];
  const liabilities: StatementLine[] = [];
  const equity: StatementLine[] = [];
  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;
  let cumRevenue = 0;
  let cumExpense = 0;
  for (const [code, bal] of balances) {
    const t = typeOf(code);
    if (t === 'ASSET') {
      const amount = round2(bal);
      if (amount !== 0) { assets.push({ accountCode: code, accountName: accountName(code), amount }); totalAssets = round2(totalAssets + amount); }
    } else if (t === 'LIABILITY') {
      const amount = round2(-bal);
      if (amount !== 0) { liabilities.push({ accountCode: code, accountName: accountName(code), amount }); totalLiabilities = round2(totalLiabilities + amount); }
    } else if (t === 'EQUITY') {
      const amount = round2(-bal);
      if (amount !== 0) { equity.push({ accountCode: code, accountName: accountName(code), amount }); totalEquity = round2(totalEquity + amount); }
    } else if (t === 'REVENUE') {
      cumRevenue = round2(cumRevenue + -bal);
    } else if (t === 'EXPENSE') {
      cumExpense = round2(cumExpense + bal);
    }
  }
  const retainedEarnings = round2(cumRevenue - cumExpense);
  if (retainedEarnings !== 0) {
    equity.push({ accountCode: '—', accountName: 'Retained earnings (current period)', amount: retainedEarnings });
    totalEquity = round2(totalEquity + retainedEarnings);
  }
  assets.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  liabilities.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  const difference = round2(totalAssets - (totalLiabilities + totalEquity));
  return { assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, retainedEarnings, balanced: Math.abs(difference) < 0.01, difference };
}

// --- CSV export --------------------------------------------------------------

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

export function exportCsv(type: 'portfolio' | 'ledger' | 'trial-balance', period?: string): string {
  if (type === 'portfolio') {
    const p = portfolio(period);
    return toCsv(
      ['Investee', 'Instrument', 'Control code', 'Currency', 'Carrying value (EUR)'],
      p.rows.map((r) => [r.investeeName, r.instrument, r.controlCode, r.currency, r.carryingValue]),
    );
  }
  if (type === 'ledger') {
    const l = ledger(period);
    return toCsv(
      ['Date', 'Event', 'Investee', 'Account code', 'Account name', 'Amount (EUR)', 'FX rate', 'FX rate date', 'Description'],
      l.lines.map((ln) => [
        ln.txnDate,
        ln.eventType,
        ln.investeeName,
        ln.accountCode,
        ln.accountName,
        ln.amount,
        ln.fxRate ?? '',
        ln.fxRateDate ?? '',
        ln.description,
      ]),
    );
  }
  // trial-balance
  const tb = trialBalance(period);
  const rows = tb.rows.map((r) => [r.accountCode, r.accountName, r.debit, r.credit]);
  rows.push(['', 'TOTAL', tb.totals.debit, tb.totals.credit]);
  return toCsv(['Account code', 'Account name', 'Debit (EUR)', 'Credit (EUR)'], rows);
}
