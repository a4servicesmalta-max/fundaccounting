// Aging debtors/creditors report (CONTRACT §12(c)). PURE.
//
// Buckets OPEN AR/AP items by `dueDate` vs an `asOf` date:
//   - not yet due (dueDate >= asOf, or no dueDate)  -> current
//   - else by days overdue:
//       1..30   -> d1_30
//       31..60  -> d31_60
//       61..90  -> d61_90
//       91+     -> d90_plus
// PAID items are excluded. Receivables and payables are reported separately.

import { listItems } from './arap-store';
import type { ArApItem } from './arap-store';

export interface AgingBuckets {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
}

export interface AgingCounterparty {
  counterparty: string;
  total: number;
  buckets: AgingBuckets;
}

export interface AgingSide {
  buckets: AgingBuckets;
  byCounterparty: AgingCounterparty[];
  total: number;
}

export interface AgingReport {
  receivables: AgingSide;
  payables: AgingSide;
}

function emptyBuckets(): AgingBuckets {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
}

/** Days between two YYYY-MM-DD dates (b - a), at UTC midnight. */
function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((tb - ta) / 86_400_000);
}

/** Which bucket an item falls into, given the as-of date. */
function bucketFor(item: ArApItem, asOf: string): keyof AgingBuckets {
  // No due date -> treat as not yet due (current).
  if (!item.dueDate) return 'current';
  const overdue = daysBetween(item.dueDate, asOf); // positive = past due
  if (overdue <= 0) return 'current'; // not yet due (incl. due today)
  if (overdue <= 30) return 'd1_30';
  if (overdue <= 60) return 'd31_60';
  if (overdue <= 90) return 'd61_90';
  return 'd90_plus';
}

function buildSide(items: ArApItem[], asOf: string): AgingSide {
  const buckets = emptyBuckets();
  const byName = new Map<string, AgingCounterparty>();
  let total = 0;

  for (const item of items) {
    if (item.status !== 'OPEN') continue; // OPEN only
    const amt = item.amount;
    const bucket = bucketFor(item, asOf);

    buckets[bucket] += amt;
    total += amt;

    const name = item.counterparty || '(unknown)';
    let cp = byName.get(name);
    if (!cp) {
      cp = { counterparty: name, total: 0, buckets: emptyBuckets() };
      byName.set(name, cp);
    }
    cp.buckets[bucket] += amt;
    cp.total += amt;
  }

  const byCounterparty = [...byName.values()].sort((a, b) =>
    a.counterparty.localeCompare(b.counterparty),
  );

  return { buckets, byCounterparty, total };
}

/**
 * Produce the aging report as at `asOf` (YYYY-MM-DD). Reads OPEN AR/AP items
 * from the store and splits them into receivables and payables.
 */
export function agingReport(asOf: string): AgingReport {
  const receivables = buildSide(listItems('RECEIVABLE'), asOf);
  const payables = buildSide(listItems('PAYABLE'), asOf);
  return { receivables, payables };
}
