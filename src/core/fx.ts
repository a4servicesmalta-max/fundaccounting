export interface RatePoint {
  currency: string;
  rateDate: Date;
  rate: number; // foreign units per 1 EUR
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Most recent RatePoint for `currency` with rateDate <= `date`, or null. */
function findRatePointForDate(rates: RatePoint[], currency: string, date: Date): RatePoint | null {
  const eligible = rates
    .filter((r) => r.currency === currency && r.rateDate.getTime() <= date.getTime())
    .sort((a, b) => b.rateDate.getTime() - a.rateDate.getTime());
  return eligible.length > 0 ? eligible[0] : null;
}

/** Most recent rate for `currency` with rateDate <= `date`, or null. */
export function findRateForDate(rates: RatePoint[], currency: string, date: Date): number | null {
  const point = findRatePointForDate(rates, currency, date);
  return point !== null ? point.rate : null;
}

/** ISO yyyy-mm-dd of a Date (UTC date components). */
function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Convert a foreign amount to functional EUR. EUR is 1:1. Throws if no rate. */
export function convertToFunctional(
  amount: number,
  currency: string,
  date: Date,
  rates: RatePoint[]
): number {
  if (currency === 'EUR') return round2(amount);
  const rate = findRateForDate(rates, currency, date);
  if (rate === null || rate === 0) {
    throw new Error(`no FX rate for ${currency} on or before ${date.toISOString()}`);
  }
  return round2(amount / rate);
}

/**
 * Convert a foreign amount to functional EUR, also returning the exact rate used.
 * Same math as `convertToFunctional` (EUR 1:1, else amount/rate, round 2dp; throws if no rate).
 * For EUR: rate and rateDate are null. Otherwise rate = foreign units per 1 EUR and
 * rateDate = ISO yyyy-mm-dd of the RatePoint actually selected by the date lookup.
 */
export function convertWithRate(
  amount: number,
  currency: string,
  date: Date,
  rates: RatePoint[]
): { amount: number; rate: number | null; rateDate: string | null } {
  if (currency === 'EUR') return { amount: round2(amount), rate: null, rateDate: null };
  const point = findRatePointForDate(rates, currency, date);
  if (point === null || point.rate === 0) {
    throw new Error(`no FX rate for ${currency} on or before ${date.toISOString()}`);
  }
  return { amount: round2(amount / point.rate), rate: point.rate, rateDate: toIsoDate(point.rateDate) };
}
