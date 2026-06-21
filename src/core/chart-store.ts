// Dynamic chart of accounts: the seam between the in-memory account registry
// (core/chart.ts) and the JSON store. `ensureAccount` is called wherever an
// account code is used that might be new — an imported trial balance, a bank
// categorisation, an AI suggestion — and creates it on the spot so it shows up,
// named, in every dropdown and report instead of being rejected.

import {
  type Account,
  type AccountType,
  registerAccount,
  getRegisteredChart,
  isKnownAccount,
} from './chart';
import { getDb, persist } from '../db/store';

/** Best-effort account type from the leading digit of a code. Handles both the
 *  app's chart (1 asset · 2 liability · 3 equity · 4 revenue · 6 expense) and the
 *  fund/continental codes that arrive via an imported trial balance (0 = investment
 *  controls 030/032 → asset · 5 = liabilities/accruals · 7 = revenue · 8 = capital/
 *  reserves → equity). Crucially, an UNRECOGNISED code defaults to ASSET (balance
 *  sheet), NOT expense — a wrong default of EXPENSE silently pollutes the P&L. */
export function inferAccountType(code: string): AccountType {
  const head = code.replace(/[^0-9]/g, '').charAt(0);
  switch (head) {
    case '0': // investment controls 030/032, accrued interest 032-1
    case '1': // cash, bank, receivables
      return 'ASSET';
    case '2':
      return 'LIABILITY';
    case '3': // share capital / reserves (app)
    case '8': // capital / supplementary capital / accumulated P&L (continental)
      return 'EQUITY';
    case '4': // investment income / other income
      return 'REVENUE';
    case '5': // short-term liabilities / accruals (continental)
      return 'LIABILITY';
    case '6': // operating expenses
      return 'EXPENSE';
    default: // 7, 9, suspense, no digit → balance sheet, never the income statement
      return 'ASSET';
  }
}

/** Load persisted custom accounts into the registry. Call once after initDb().
 *  Self-heals types poisoned by an older import: a balance-sheet code (e.g. an
 *  imported 030/032/801/802/860) that was stored as a P&L type (EXPENSE/REVENUE)
 *  is corrected to its structural type so it can never pollute the income
 *  statement. A genuine income/expense account is never demoted. */
export function hydrateChartFromStore(): void {
  const db: any = getDb();
  if (!Array.isArray(db.chartAccounts)) return;
  let changed = false;
  for (const a of db.chartAccounts) {
    if (!a || !a.code) continue;
    const inferred = inferAccountType(a.code);
    const inferredIsBalanceSheet = inferred === 'ASSET' || inferred === 'LIABILITY' || inferred === 'EQUITY';
    const storedIsPl = a.type === 'EXPENSE' || a.type === 'REVENUE';
    if (storedIsPl && inferredIsBalanceSheet) {
      a.type = inferred;
      changed = true;
    }
    registerAccount(a);
  }
  if (changed) persist();
}

/**
 * Ensure an account exists. If the code is unknown it is created (registered +
 * persisted) with the given name, or a sensible default. Returns the account.
 */
export function ensureAccount(code: string, name?: string, type?: AccountType): Account {
  const trimmedCode = String(code || '').trim();
  if (!trimmedCode) {
    return { code: '9999', name: 'Suspense — to review', type: 'EXPENSE' };
  }
  if (isKnownAccount(trimmedCode)) {
    return getRegisteredChart().find((a) => a.code === trimmedCode)!;
  }
  const account: Account = {
    code: trimmedCode,
    name: name && name.trim() ? name.trim() : trimmedCode,
    type: type || inferAccountType(trimmedCode),
  };
  registerAccount(account);

  const db: any = getDb();
  if (!Array.isArray(db.chartAccounts)) db.chartAccounts = [];
  db.chartAccounts.push(account);
  persist();
  return account;
}

/** The full chart (built-in + custom), sorted by code. */
export function listFullChart(): Account[] {
  return getRegisteredChart()
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code));
}
