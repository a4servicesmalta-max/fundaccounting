// Net-zero pair detection (CONTRACT: trap T13 — a charge that is later reversed/
// refunded for the identical amount must NET TO ZERO, not be booked as two
// separate movements that double-count in P&L). Example: PKO deducts PCC tax
// −2,730 PLN then refunds +2,730 PLN. The two legs are matched and posted to the
// SAME account so they cancel in both the account and the income statement.

export interface NetZeroTxn {
  id: string;
  date: string; // YYYY-MM-DD
  amount: number; // signed: + in / − out
  description: string;
}

export interface NetZeroPair {
  chargeId: string; // the original (typically the negative leg)
  refundId: string; // the reversing leg (opposite sign, same magnitude)
  amount: number; // the magnitude that nets to zero
  key: string; // why they were paired (shared keyword)
}

// Words that signal a reversal/refund/tax movement, diacritics stripped.
const PAIR_HINTS = [
  'pcc', 'refund', 'reversal', 'reverse', 'correction', 'zwrot', 'podatek',
  'tax', 'storno', 'adjustment', 'chargeback', 'reimbursement',
];

function norm(s: string): string {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l') // ł
    .toLowerCase();
}

function sharedHint(a: string, b: string): string | null {
  const na = norm(a);
  const nb = norm(b);
  for (const h of PAIR_HINTS) {
    if (na.includes(h) || nb.includes(h)) return h;
  }
  return null;
}

function daysApart(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Infinity;
  return Math.abs(ta - tb) / 86400000;
}

/** Find opposite-sign transactions of equal magnitude, close in time, that look
 *  like a charge-and-reversal pair. Each transaction is used at most once.
 *  windowDays defaults to 31 (a deduction and its refund can straddle a month). */
export function findNetZeroPairs(txns: NetZeroTxn[], windowDays = 31): NetZeroPair[] {
  const pairs: NetZeroPair[] = [];
  const used = new Set<string>();
  // Stable order: by date then id, so pairing is deterministic.
  const sorted = [...txns].sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (used.has(a.id)) continue;
    const amtA = Number(a.amount) || 0;
    if (amtA === 0) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (used.has(b.id)) continue;
      const amtB = Number(b.amount) || 0;
      // Opposite signs, equal magnitude (to the cent).
      if (Math.sign(amtA) === Math.sign(amtB)) continue;
      if (Math.abs(amtA + amtB) >= 0.01) continue;
      if (daysApart(a.date, b.date) > windowDays) continue;
      const hint = sharedHint(a.description, b.description);
      if (!hint) continue;
      // a is the charge (negative leg) when amtA < 0, else b is.
      const charge = amtA < 0 ? a : b;
      const refund = amtA < 0 ? b : a;
      pairs.push({ chargeId: charge.id, refundId: refund.id, amount: Math.abs(amtA), key: hint });
      used.add(a.id);
      used.add(b.id);
      break;
    }
  }
  return pairs;
}
