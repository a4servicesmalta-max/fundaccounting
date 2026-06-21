import type { Instrument } from './types';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

export interface Account {
  code: string;
  name: string;
  type: AccountType;
}

export const CHART: Account[] = [
  // Investment sub-ledger (control accounts)
  { code: '030', name: 'Investments in shares (control)', type: 'ASSET' },
  { code: '032', name: 'Loans granted (control)', type: 'ASSET' },
  // Bank & working-capital
  { code: '1010', name: 'Bank', type: 'ASSET' },
  { code: '105', name: 'Accrued loan interest receivable', type: 'ASSET' },
  { code: '1100', name: 'Accounts receivable (debtors)', type: 'ASSET' },
  { code: '2010', name: 'Accounts payable (creditors)', type: 'LIABILITY' },
  { code: '2300', name: 'Loans payable (borrowings)', type: 'LIABILITY' },
  // Equity
  { code: '3000', name: 'Share capital', type: 'EQUITY' },
  { code: '3100', name: 'Retained earnings', type: 'EQUITY' },
  // Income
  { code: '4000', name: 'Investment income', type: 'REVENUE' },
  { code: '4010', name: 'Other income', type: 'REVENUE' },
  { code: '500', name: 'Gain on disposal of shares', type: 'REVENUE' },
  { code: '510', name: 'Loan interest income', type: 'REVENUE' },
  { code: '710', name: 'Fair-value movement on investments', type: 'REVENUE' },
  // Operating expenses (bank-line categorisation targets)
  { code: '6000', name: 'Rent', type: 'EXPENSE' },
  { code: '6100', name: 'Legal & professional fees', type: 'EXPENSE' },
  { code: '6200', name: 'Office & administration', type: 'EXPENSE' },
  { code: '6300', name: 'Bank charges', type: 'EXPENSE' },
  { code: '6400', name: 'Interest expense', type: 'EXPENSE' },
  { code: '6500', name: 'Salaries & wages', type: 'EXPENSE' },
  { code: '601', name: 'Brokerage fees', type: 'EXPENSE' },
  { code: '610', name: 'Impairment loss on investments', type: 'EXPENSE' },
  { code: '6800', name: 'Foreign exchange gain/loss', type: 'EXPENSE' },
  { code: '6850', name: 'Investment write-offs', type: 'EXPENSE' },
  // Catch-all for low-confidence / unrecognised lines (forces user review)
  // Suspense is a temporary balance-sheet clearing account — unclassified items
  // sit here until coded; it must NEVER appear in the income statement.
  { code: '9999', name: 'Suspense — to review', type: 'ASSET' },
];

/** Per-investee control sub-accounts roll up to the parent control code. */
export function controlCodeFor(instrument: Instrument): '030' | '032' {
  return instrument === 'SHARES' ? '030' : '032';
}

// --- Dynamic registry --------------------------------------------------------
// The chart is not fixed: accounts an imported trial balance, a bank
// categorisation, or the AI suggests are added here so they appear in every
// dropdown and report with a friendly name. Seeded from the built-in CHART;
// custom additions are persisted by chart-store and re-hydrated on boot.

const registry = new Map<string, Account>(CHART.map((a) => [a.code, a]));

/** Add or replace an account in the in-memory registry. */
export function registerAccount(account: Account): void {
  if (account && account.code) registry.set(account.code, { ...account });
}

/** The full chart: built-in accounts plus everything registered since. */
export function getRegisteredChart(): Account[] {
  return [...registry.values()];
}

/** True if a code already exists in the registry (exact match). */
export function isKnownAccount(code: string): boolean {
  return registry.has(code);
}

/** Reset the registry back to the built-in CHART (used by "Start over"). */
export function resetRegistry(): void {
  registry.clear();
  for (const a of CHART) registry.set(a.code, a);
}

/** Look up a code in the registry; falls back to the code itself.
 * Per-investee sub-accounts ('030-gamivo') resolve to their parent control name. */
export function accountName(code: string): string {
  const exact = registry.get(code);
  if (exact) return exact.name;
  const parent = code.split('-')[0];
  const parentAccount = registry.get(parent);
  if (parentAccount) return parentAccount.name;
  return code;
}
