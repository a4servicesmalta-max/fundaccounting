// Resolve any account a posting wants to use onto the STANDARD chart of accounts,
// rather than minting a new chart entry for whatever the AI / bank categoriser
// proposed (which polluted the trial balance with arbitrary, often mangled,
// accounts). The only non-standard accounts allowed are the deliberate per-investee
// investment/loan sub-accounts (030-<investee> / 032-<investee>) that the fund
// sub-ledger needs for per-holding carrying values. Everything else maps to the
// closest standard account by code, then by name, and finally to 9999 suspense.
// PURE — no registry mutation.

import { CHART, type Account } from './chart';

const STANDARD = new Map<string, Account>(CHART.map((a) => [a.code, a]));
const SUSPENSE: Account = STANDARD.get('9999') ?? { code: '9999', name: 'Suspense — to review', type: 'ASSET' };

// Name → standard code. Ordered: more specific rules first.
const NAME_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/receivab|debtor/i, '1100'],
  [/payab|creditor|supplier/i, '2010'],
  [/loan\s*interest|interest\s*income/i, '510'],
  [/interest\s*expens|loan\s*interest\s*paid/i, '6400'],
  [/dividend|investment\s*income|distribution/i, '4000'],
  [/gain\s*on\s*disposal|realis\w*\s*gain/i, '750-1'],
  [/impair|write[\s-]?off|write[\s-]?down/i, '610'],
  [/fair[\s-]?value/i, '710'],
  [/foreign\s*exchange|\bfx\b|exchange\s*(gain|loss)/i, '6800'],
  [/borrowing|loan\s*payable/i, '2300'],
  [/share\s*capital|capital\s*contributed/i, '3000'],
  [/retained\s*earning|reserves/i, '3100'],
  [/\brent\b|lease/i, '6000'],
  [/legal|professional|audit|account(an|ing)|notar/i, '6100'],
  [/office|admin|supplies|stationery|software|subscription/i, '6200'],
  [/bank\s*charge|\bfee\b|\bfees\b|commission/i, '6300'],
  [/salar|payroll|\bwage|personnel/i, '6500'],
  [/broker/i, '601'],
  [/\bbank\b|\bcash\b|current\s*account/i, '1010'],
  [/other\s*income/i, '4010'],
];

/** Map an account name to a standard account, or undefined if nothing fits. */
export function matchStandardByName(name?: string): Account | undefined {
  const n = (name || '').trim();
  if (!n) return undefined;
  for (const [re, code] of NAME_RULES) {
    if (re.test(n)) return STANDARD.get(code);
  }
  return undefined;
}

/** A deliberate per-investee investment (030-) or loan (032-) sub-account. */
export function isInvestmentSubAccount(code: string): boolean {
  return /^03[02]-.+/.test(String(code || ''));
}

/** Resolve a proposed (code, name) to a standard chart account. Never mints an
 *  arbitrary account: a known standard code is used as-is; a per-investee
 *  investment/loan sub-account is kept; otherwise we map by name (then by the raw
 *  code text) to the closest standard account, falling back to 9999 suspense. */
export function resolveToStandardAccount(code?: string, name?: string): Account {
  const c = String(code || '').trim();
  if (c && STANDARD.has(c)) return STANDARD.get(c)!;
  if (isInvestmentSubAccount(c)) {
    return { code: c, name: (name || '').trim() || c, type: 'ASSET' };
  }
  return matchStandardByName(name) || matchStandardByName(c) || SUSPENSE;
}
