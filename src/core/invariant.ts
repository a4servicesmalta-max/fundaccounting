import type { PositionMap } from './rollforward';

export function sumPositions(positions: PositionMap): number {
  const total = Object.values(positions).reduce((s, v) => s + v, 0);
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

/**
 * Enforce: GL control-account balance == Σ active sub-ledger positions.
 * Tolerance is half a cent to absorb rounding. Throws (blocking) on drift.
 */
export function assertControlInvariant(glBalance: number, positions: PositionMap): void {
  const expected = sumPositions(positions);
  if (Math.abs(glBalance - expected) > 0.005) {
    throw new Error(
      `control-account invariant violated: GL balance ${glBalance} != Σ positions ${expected} (drift ${(glBalance - expected).toFixed(4)})`
    );
  }
}
