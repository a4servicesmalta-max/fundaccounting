// THCP's books are kept in the Polish/continental statutory chart of accounts
// (source workbook "THCP MT 'acc. books_2024_12"). Its numbering convention is
// NOT the app's internal chart: 4xx = costs (expense), 75x = financial revenue,
// 240 = receivables (asset), 64x = accrued expenses and 840 = provisions (both
// liabilities), 5xx = liabilities, 8xx = capital (equity). A leading-digit
// heuristic tuned to the app chart misclassifies all of these, corrupting the
// balance sheet and P&L even though the trial balance still ties.
//
// This module is the authoritative type+name overlay for those statutory codes.
// It is seeded into the chart registry and consulted by resolveAccountType so the
// portal reproduces the workbook faithfully. Codes shared with the app chart
// (030/032 investment controls) are intentionally omitted — the app definitions
// already cover them.

import type { Account } from './chart';

/** The THCP statutory accounts, with their correct names and structural types. */
export const STATUTORY_CHART: Account[] = [
  // Assets
  { code: '032-1', name: 'Accrued interest on loans granted', type: 'ASSET' },
  { code: '240', name: 'Other receivables', type: 'ASSET' },
  { code: '240-OD', name: 'Other receivables — general', type: 'ASSET' },
  { code: '240-GCM', name: 'Receivables — Gamivo.com Limited', type: 'ASSET' },
  { code: '240-JPL1', name: 'Receivables — Jupi Park Lodz1 sp. z o.o.', type: 'ASSET' },
  { code: '240-IP', name: 'Interim dividend payment', type: 'ASSET' },
  { code: '240-CL', name: 'Receivables — Climax Investment Limited', type: 'ASSET' },
  { code: '240-WP2', name: 'Receivables — WP2 Investments sp. z o.o.', type: 'ASSET' },
  { code: '130', name: 'Cash at bank', type: 'ASSET' },
  { code: '140', name: 'Funds in transfer', type: 'ASSET' },
  { code: '101', name: 'Cash (PLN)', type: 'ASSET' },
  { code: '105', name: 'Accrued loan interest receivable', type: 'ASSET' },
  // Liabilities
  { code: '500', name: 'Short-term liabilities', type: 'LIABILITY' },
  { code: '501', name: 'Accruals', type: 'LIABILITY' },
  { code: '840', name: 'Provisions and deferred income', type: 'LIABILITY' },
  { code: '64-AE', name: 'Accrued expenses — THCP', type: 'LIABILITY' },
  { code: '64-AE-O', name: 'Accrued expenses — other', type: 'LIABILITY' },
  // Equity
  { code: '801', name: 'Share capital', type: 'EQUITY' },
  { code: '802', name: 'Supplementary capital', type: 'EQUITY' },
  { code: '860', name: 'Accounting profit/(loss)', type: 'EQUITY' },
  // Revenue
  { code: '750-1', name: 'Revenues from sales of shares', type: 'REVENUE' },
  { code: '750-2', name: 'Dividends', type: 'REVENUE' },
  { code: '750-3', name: 'Interest income', type: 'REVENUE' },
  { code: 'EXCH-P', name: 'Other financial profit (FX gains)', type: 'REVENUE' },
  // Expense
  { code: '751', name: 'Cost of shares disposal', type: 'EXPENSE' },
  { code: 'EXCH-L', name: 'Other financial loss (FX losses)', type: 'EXPENSE' },
  { code: 'W-O', name: 'Write-offs', type: 'EXPENSE' },
  { code: '402', name: 'Legal & professional fees', type: 'EXPENSE' },
  { code: '402-THCP', name: 'Expenses — Tar Heel Capital Pathfinder sp. z o.o.', type: 'EXPENSE' },
  { code: '402-RS', name: 'Expenses — Red Sky sp. z o.o.', type: 'EXPENSE' },
  { code: '403', name: 'Taxes', type: 'EXPENSE' },
  { code: '409', name: 'Other costs', type: 'EXPENSE' },
];

// Longest-prefix family lookup: a sub-account like '240-OD' or '402-THCP' inherits
// its family's type, and '750-1' wins over a hypothetical '750'. Keys are sorted
// longest-first so the most specific family matches.
const TYPE_KEYS = STATUTORY_CHART.map((a) => a.code).sort((a, b) => b.length - a.length);
const TYPE_BY_CODE = new Map(STATUTORY_CHART.map((a) => [a.code, a.type] as const));

/** The statutory type for a code (exact, then longest matching family), or undefined
 *  if the code is not part of the statutory chart. */
export function statutoryType(code: string): Account['type'] | undefined {
  const c = String(code || '').trim();
  if (!c) return undefined;
  const exact = TYPE_BY_CODE.get(c);
  if (exact) return exact;
  for (const key of TYPE_KEYS) {
    if (c === key || c.startsWith(key + '-')) return TYPE_BY_CODE.get(key);
  }
  return undefined;
}
