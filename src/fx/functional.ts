// Convert a foreign amount to EUR from a daily "EUR per 1 unit" rate (what
// getDailyRateToEur returns), and report the rate in the project's CANONICAL
// convention — foreign-per-EUR — so engineFigures.fxRate means the same thing
// everywhere (the typed-event path via composeDraft, the ECB rate table, and the
// suggested-journal path). Invariant for callers/readers:
//   functionalAmount === originalAmount / fxRate.
// PURE.

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface FunctionalConversion {
  functionalAmount: number; // EUR
  fxRate: number; // foreign units per 1 EUR (0 when the rate is unusable)
}

/** @param originalAmount amount in the foreign currency
 *  @param eurPerUnit EUR per 1 foreign unit (e.g. 0.24095 for PLN) */
export function functionalFromEurPerUnit(originalAmount: number, eurPerUnit: number): FunctionalConversion {
  if (!eurPerUnit || eurPerUnit <= 0) return { functionalAmount: 0, fxRate: 0 };
  return {
    functionalAmount: round2(originalAmount * eurPerUnit),
    fxRate: 1 / eurPerUnit, // EUR-per-unit -> foreign-per-EUR (canonical)
  };
}
