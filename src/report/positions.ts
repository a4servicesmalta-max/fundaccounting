// Shared positions helper (owned by the INTEGRATION layer; used by process.ts + report.ts).
// Computes carrying values by summing POSTED journal lines per account code.

import { listPostedLines } from '../db/store';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Carrying value of a single control sub-account (e.g. '030-gamivo') from POSTED lines.
 * Sum is in functional EUR; positive = debit balance = asset carrying value.
 */
export function carryingValueFor(controlCode: string): number {
  let sum = 0;
  for (const ln of listPostedLines()) {
    if (ln.accountCode === controlCode) sum += ln.amount;
  }
  return round2(sum);
}

/** Net balance per account code across all POSTED lines (positive = debit). */
export function postedBalancesByAccount(): Map<string, number> {
  const map = new Map<string, number>();
  for (const ln of listPostedLines()) {
    map.set(ln.accountCode, round2((map.get(ln.accountCode) ?? 0) + ln.amount));
  }
  return map;
}
