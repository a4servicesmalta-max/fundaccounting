// AR/AP exact-date FX capture. A foreign-currency invoice/bill is translated to EUR
// at the ECB spot rate on its transaction date (IAS 21) — the SAME source the
// investment events and bank settlements use — instead of the bundled static table.
// The rate is resolved once at intake and stored on the item; reports then convert
// deterministically from the captured rate.

import { getDailyRateToEur } from '../fx/daily';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve the EUR-per-unit rate for an AR/AP item from the ECB daily rate on its
 * transaction date (issue date preferred, else due date, else today). EUR is 1:1.
 * Returns {fxRate: null} when no rate could be resolved (caller falls back to bundled).
 */
export async function resolveArApFxRate(
  currency: string,
  issueDate: string | null,
  dueDate: string | null,
): Promise<{ fxRate: number | null; fxRateDate: string | null }> {
  const ccy = (currency || 'EUR').toUpperCase();
  if (ccy === 'EUR') return { fxRate: 1, fxRateDate: null };
  const date = issueDate || dueDate || todayISO();
  const r = await getDailyRateToEur(ccy, date); // EUR per 1 unit of `currency`
  if (r.rate && Number.isFinite(r.rate) && r.rate > 0) {
    return { fxRate: r.rate, fxRateDate: r.rateDate || date };
  }
  return { fxRate: null, fxRateDate: null };
}
