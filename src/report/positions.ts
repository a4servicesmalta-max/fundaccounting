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

export interface DisposalCarryingAssessment {
  /** Reviewer-facing note, or null when nothing needs saying. */
  note: string | null;
  /** True when the released carrying cost can't be verified, so the draft must be
   *  held below the bulk-approve bar for a human to confirm. */
  forceReview: boolean;
}

/**
 * Decide whether a disposal's released carrying cost is trustworthy or needs review.
 *
 * The dangerous case: a disposal states a sold quantity but the holding's unit count
 * isn't on the books (`unitsHeld === 0` — typical of an imported opening balance).
 * disposalCarryingCost then can't proportion and releases the FULL carrying, so a
 * partial sale would overstate the cost of sale. We can't tell partial from full, so
 * we flag it AND force review. A partial sale with KNOWN units is correctly
 * proportioned (informational note only); a full sale or a quantity-less disposal is
 * the normal path.
 */
export function assessDisposalCarrying(
  eventType: 'DISPOSAL' | 'WRITE_OFF',
  qtySold: number | null | undefined,
  unitsHeld: number,
  fullCarrying: number,
  releasedCarrying: number,
): DisposalCarryingAssessment {
  if (fullCarrying === 0) {
    return { note: 'Carrying cost is 0/unknown for this position — please review before posting.', forceReview: false };
  }
  const sold = Number(qtySold);
  if (eventType === 'DISPOSAL' && Number.isFinite(sold) && sold > 0) {
    if (unitsHeld > 0 && sold < unitsHeld) {
      return {
        note: `Partial disposal: ${sold} of ${unitsHeld} units — released ${releasedCarrying} of ${fullCarrying} carrying cost. Please review.`,
        forceReview: false,
      };
    }
    if (unitsHeld === 0) {
      return {
        note: `Sold ${sold} units, but this holding's unit count isn't recorded (e.g. an imported opening balance), so the FULL carrying cost of ${fullCarrying} was released. If this was a partial sale the cost of sale is overstated — confirm the units held and adjust before posting.`,
        forceReview: true,
      };
    }
  }
  return { note: null, forceReview: false };
}

/** Net balance per account code across all POSTED lines (positive = debit). */
export function postedBalancesByAccount(): Map<string, number> {
  const map = new Map<string, number>();
  for (const ln of listPostedLines()) {
    map.set(ln.accountCode, round2((map.get(ln.accountCode) ?? 0) + ln.amount));
  }
  return map;
}
