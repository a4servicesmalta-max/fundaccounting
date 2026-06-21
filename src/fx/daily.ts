// Daily FX module: converts a non-EUR amount to EUR using the per-day rate.
//
// Convention: rate = EUR per 1 unit of the foreign currency, so `eur = amount * rate`.
// EUR itself short-circuits to rate 1.
//
// Resolution order (never throws):
//   1. EUR              -> { rate: 1, source: 'eur' }
//   2. persistent cache -> { source: 'cache' }       (key "CCY:YYYY-MM-DD")
//   3. live fetch       -> { source: 'live' }         (ECB via frankfurter.app), then cached
//   4. bundled fallback -> { source: 'fallback' }     (loadRates(), foreign-per-EUR, inverted)
//   5. nothing matched  -> { rate: 0, source: 'none' }
//
// Source: ECB via frankfurter.app historical endpoint, e.g.
//   https://api.frankfurter.app/2021-12-31?from=PLN&to=EUR
//   -> {"amount":1,"base":"PLN","date":"2021-12-31","rates":{"EUR":0.2176}}
// frankfurter returns the nearest prior business day in `date`; we use that as rateDate.

import { getFxRate, setFxRate } from '../db/store';
import { loadRates } from './rates';

export interface DailyRate {
  rate: number;
  rateDate: string;
  source: 'eur' | 'cache' | 'live' | 'fallback' | 'none';
}

interface FetchResult {
  rate: number;
  rateDate: string;
}

interface Deps {
  fetchRate?: (ccy: string, date: string) => Promise<FetchResult | null>;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Live ECB fetch via frankfurter.app. Returns null on any error / no network. */
async function fetchRateLive(ccy: string, date: string): Promise<FetchResult | null> {
  try {
    const url = `https://api.frankfurter.app/${date}?from=${encodeURIComponent(ccy)}&to=EUR`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { date?: string; rates?: Record<string, number> };
    const rate = body?.rates?.EUR;
    if (typeof rate !== 'number' || !Number.isFinite(rate)) return null;
    // frankfurter returns the nearest prior business day in `date`.
    const rateDate = typeof body.date === 'string' && body.date ? body.date : date;
    return { rate, rateDate };
  } catch {
    return null;
  }
}

/**
 * Offline fallback using the bundled annual rates (foreign-per-EUR). Picks the
 * point whose currency matches and whose date is nearest the requested date
 * (most recent on or before, else the closest available), then inverts so the
 * returned rate is EUR per 1 unit. Returns null when no point matches.
 */
function fallbackRate(ccy: string, date: string): FetchResult | null {
  let points;
  try {
    points = loadRates().filter((p) => p.currency === ccy.toUpperCase());
  } catch {
    return null;
  }
  if (points.length === 0) return null;

  const target = new Date(date).getTime();
  // Prefer the most recent point on or before the target date.
  const onOrBefore = points
    .filter((p) => p.rateDate.getTime() <= target)
    .sort((a, b) => b.rateDate.getTime() - a.rateDate.getTime());
  // Otherwise fall back to the point nearest the target date overall.
  const byNearest = [...points].sort(
    (a, b) => Math.abs(a.rateDate.getTime() - target) - Math.abs(b.rateDate.getTime() - target),
  );
  const point = onOrBefore[0] ?? byNearest[0];
  if (!point || point.rate === 0 || !Number.isFinite(point.rate)) return null;

  const rate = 1 / point.rate; // foreign-per-EUR -> EUR-per-foreign
  const rateDate = point.rateDate.toISOString().slice(0, 10);
  return { rate, rateDate };
}

/**
 * Resolve the daily rate (EUR per 1 unit of `currency`) for `date` (YYYY-MM-DD).
 * Never throws. EUR short-circuits to rate 1. Cache hit returns immediately;
 * a miss fetches live and caches it; on fetch failure it falls back to the
 * bundled annual rates (inverted); if even that fails it returns rate 0.
 */
export async function getDailyRateToEur(
  currency: string,
  date: string,
  deps?: Deps,
): Promise<DailyRate> {
  const ccy = (currency || '').toUpperCase();

  if (ccy === 'EUR') {
    return { rate: 1, rateDate: date, source: 'eur' };
  }

  const key = `${ccy}:${date}`;

  const cached = getFxRate(key);
  if (typeof cached === 'number') {
    return { rate: cached, rateDate: date, source: 'cache' };
  }

  const fetchRate = deps?.fetchRate ?? fetchRateLive;
  let live: FetchResult | null = null;
  try {
    live = await fetchRate(ccy, date);
  } catch {
    live = null;
  }
  if (live && Number.isFinite(live.rate)) {
    setFxRate(key, live.rate);
    return { rate: live.rate, rateDate: live.rateDate || date, source: 'live' };
  }

  const fb = fallbackRate(ccy, date);
  if (fb) {
    return { rate: fb.rate, rateDate: fb.rateDate, source: 'fallback' };
  }

  return { rate: 0, rateDate: date, source: 'none' };
}

/**
 * Convert `amount` of `currency` to EUR on `date` (YYYY-MM-DD). eur = amount * rate,
 * rounded to 2 decimals. Mirrors getDailyRateToEur's resolution and never throws.
 */
export async function convertToEur(
  amount: number,
  currency: string,
  date: string,
  deps?: Deps,
): Promise<{ eur: number; rate: number; rateDate: string; source: string }> {
  const r = await getDailyRateToEur(currency, date, deps);
  return {
    eur: round2(amount * r.rate),
    rate: r.rate,
    rateDate: r.rateDate,
    source: r.source,
  };
}
