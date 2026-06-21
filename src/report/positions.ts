// Shared positions helper (owned by the INTEGRATION layer; used by process.ts + report.ts).
// Computes carrying values by summing POSTED journal lines per account code.

import { listPostedLines, listDrafts } from '../db/store';

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

/**
 * Units currently held for a control sub-account, from POSTED investment drafts:
 * acquisitions add units, disposals/write-offs remove them. Returns 0 when no
 * draft carried a share quantity (units simply weren't transcribed).
 */
export function unitsHeldFor(controlCode: string): number {
  let units = 0;
  for (const d of listDrafts('POSTED')) {
    if (d.controlCode !== controlCode) continue;
    const q = Number(d.sourceFigures?.quantity);
    if (!Number.isFinite(q) || q === 0) continue;
    if (d.eventType === 'DISPOSAL' || d.eventType === 'WRITE_OFF') units -= Math.abs(q);
    else if (d.eventType === 'ACQUISITION') units += Math.abs(q);
  }
  return round2(units);
}

/**
 * Carrying cost to release on a DISPOSAL of `qtySold` units of `controlCode`.
 *
 * A partial disposal must remove only the PROPORTIONATE carrying amount of the
 * units sold (IFRS — cost flows out on carrying amount, pro-rata), NOT the whole
 * position. When the units sold and the units held are both known and the sale
 * is partial, return totalCarrying × qtySold / unitsHeld. Otherwise fall back to
 * the full carrying value (a full disposal, or units not transcribed — the
 * latter is flagged for review upstream). The result is clamped to the carrying
 * value so a disposal can never release more than the position holds.
 */
export function disposalCarryingCost(controlCode: string, qtySold: number | null | undefined): number {
  const totalCarrying = carryingValueFor(controlCode);
  const sold = Number(qtySold);
  const held = unitsHeldFor(controlCode);
  // Proportionate only when we genuinely know both quantities and it's a partial
  // sale. Unknown quantity, nil holding, or a full/over sale → full carrying.
  if (Number.isFinite(sold) && sold > 0 && held > 0 && sold < held) {
    const proportion = sold / held;
    const out = round2(totalCarrying * proportion);
    // Never release more than the carrying value (defensive).
    return Math.abs(out) > Math.abs(totalCarrying) ? totalCarrying : out;
  }
  return totalCarrying;
}

/** Net balance per account code across all POSTED lines (positive = debit). */
export function postedBalancesByAccount(): Map<string, number> {
  const map = new Map<string, number>();
  for (const ln of listPostedLines()) {
    map.set(ln.accountCode, round2((map.get(ln.accountCode) ?? 0) + ln.amount));
  }
  return map;
}
