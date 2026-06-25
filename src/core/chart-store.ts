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
import { statutoryType } from './statutory-chart';
import { getDb, persist } from '../db/store';

/** Best-effort account type from the leading digit of a code. Handles both the
 *  app's chart (1 asset · 2 liability · 3 equity · 4 revenue · 6 expense) and the
 *  fund/continental codes that arrive via an imported trial balance (0 = investment
 *  controls 030/032 → asset · 5 = liabilities/accruals · 7 = revenue · 8 = capital/
 *  reserves → equity). Crucially, an UNRECOGNISED code defaults to ASSET (balance
 *  sheet), NOT expense — a wrong default of EXPENSE silently pollutes the P&L. */
export function inferAccountType(code: string): AccountType {
  // THCP statutory codes (continental convention) are classified explicitly first
  // — their leading digit lies under the app's heuristic (e.g. 4xx = cost not
  // revenue, 75x = revenue not asset, 240 = receivable not liability).
  const statutory = statutoryType(code);
  if (statutory) return statutory;
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

/** The authoritative account-type resolver used by the reports. Precedence:
 *  1. an exact entry in the chart registry (built-in app + statutory + custom),
 *  2. the THCP statutory overlay (covers sub-accounts like 240-OD, 402-THCP),
 *  3. the registry entry for the parent code (e.g. 030-gamivo → 030),
 *  4. the leading-digit fallback (inferAccountType).
 *  This single function keeps the balance sheet / P&L classification consistent
 *  across the app chart and the imported statutory chart. */
export function resolveAccountType(code: string): AccountType {
  const c = String(code || '').trim();
  const chart = getRegisteredChart();
  const exact = chart.find((a) => a.code === c);
  if (exact) return exact.type;
  const statutory = statutoryType(c);
  if (statutory) return statutory;
  const parent = chart.find((a) => a.code === c.split('-')[0]);
  if (parent) return parent.type;
  return inferAccountType(c);
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
    // Self-heal a poisoned type. A known statutory code is authoritative — correct
    // it outright (e.g. an imported 750-1 stored as ASSET → REVENUE, a 402 stored as
    // REVENUE → EXPENSE, a 240 stored as LIABILITY → ASSET). Otherwise keep the older,
    // narrower safety net: demote a balance-sheet code wrongly stored as a P&L type.
    const statutory = statutoryType(a.code);
    if (statutory && a.type !== statutory) {
      a.type = statutory;
      changed = true;
    } else if (!statutory) {
      const inferred = inferAccountType(a.code);
      const inferredIsBalanceSheet = inferred === 'ASSET' || inferred === 'LIABILITY' || inferred === 'EQUITY';
      const storedIsPl = a.type === 'EXPENSE' || a.type === 'REVENUE';
      if (storedIsPl && inferredIsBalanceSheet) {
        a.type = inferred;
        changed = true;
      }
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
    type: type || resolveAccountType(trimmedCode),
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
