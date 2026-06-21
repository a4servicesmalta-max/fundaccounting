// Match a bank transaction to an OPEN AR/AP item (CONTRACT §12(b)). PURE: callers
// pass the candidate open items in; this returns the best match or null.
//
// A match requires ALL of:
//   - amounts equal in magnitude (within 0.01),
//   - dates within 30 days (item.dueDate or issueDate vs txn.date),
//   - the counterparty name fuzzy-matches the description (case-insensitive
//     token overlap).
// Among qualifying items, the one with the highest token overlap (tie-broken by
// closest date) wins.

// Imported from the ARAP section, which owns the type. During an isolated
// typecheck (before that sibling exists) this import may not resolve — that is
// expected and resolves at integration; tests use inline ArApItem-shaped fixtures.
import type { ArApItem } from '../arap/arap-store';

export interface MatchTxn {
  amount: number;
  date: string; // YYYY-MM-DD
  description: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function tokens(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3); // drop noise words / short tokens
}

/** Count of distinct counterparty tokens that appear in the description tokens. */
function tokenOverlap(counterparty: string, description: string): number {
  const cp = new Set(tokens(counterparty));
  if (cp.size === 0) return 0;
  const desc = new Set(tokens(description));
  let n = 0;
  for (const t of cp) if (desc.has(t)) n++;
  return n;
}

function itemDate(item: ArApItem): string | null {
  return item.dueDate ?? item.issueDate ?? null;
}

function daysApart(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.POSITIVE_INFINITY;
  return Math.abs(ta - tb) / DAY_MS;
}

export function matchTransaction(txn: MatchTxn, openItems: ArApItem[]): ArApItem | null {
  let best: ArApItem | null = null;
  let bestOverlap = 0;
  let bestDays = Number.POSITIVE_INFINITY;

  for (const item of openItems) {
    if (item.status !== 'OPEN') continue;

    // Amount: equal in magnitude within a cent.
    if (Math.abs(Math.abs(item.amount) - Math.abs(txn.amount)) >= 0.01) continue;

    // Date: within 30 days.
    const idate = itemDate(item);
    if (!idate) continue;
    const days = daysApart(idate, txn.date);
    if (days > 30) continue;

    // Counterparty fuzzy-matches the description.
    const overlap = tokenOverlap(item.counterparty, txn.description);
    if (overlap < 1) continue;

    // Best = most token overlap, tie-broken by closest date.
    if (overlap > bestOverlap || (overlap === bestOverlap && days < bestDays)) {
      best = item;
      bestOverlap = overlap;
      bestDays = days;
    }
  }

  return best;
}
