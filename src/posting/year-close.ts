// Year-end close (calendar fiscal year). Closing a financial year posts an audited
// CLOSING JOURNAL dated 31 Dec that zeroes every P&L account into Retained earnings
// (brought forward), then locks all twelve months so nothing else posts into the
// closed year. The next year's reports build on the closing balance automatically
// (the ledger is cumulative), and the current-year P&L resets because the closing
// entry offsets the prior year's income and expense.
//
// This module owns the PURE shape of the closing journal; the orchestration that
// reads balances, posts the draft, locks the year and writes the audit entry lives
// in post.ts (closeYear / reopenYear).

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export const RETAINED_EARNINGS_CODE = '3100';

export interface ClosingJournalLine {
  accountCode: string;
  amount: number; // +debit / -credit
}

export interface ClosingJournal {
  lines: ClosingJournalLine[];
  /** Net result moved to retained earnings: > 0 profit, < 0 loss. */
  netResult: number;
}

/** The twelve YYYY-MM periods of a calendar financial year. */
export function financialYearMonths(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

/** The closing date (31 Dec) and period (YYYY-12) of a calendar financial year. */
export function financialYearEnd(year: number): { date: string; period: string } {
  return { date: `${year}-12-31`, period: `${year}-12` };
}

/**
 * Build a balanced closing journal from the year's P&L account balances (debit-
 * positive: revenue carries a negative balance, expense a positive one). Each P&L
 * account is zeroed by posting the opposite of its balance, and the net is taken to
 * Retained earnings so the entry balances. netResult is the year's profit (credit to
 * retained earnings) — positive for a profit, negative for a loss. Returns an empty
 * journal when there is no P&L activity.
 */
export function buildClosingJournal(
  plBalances: Map<string, number>,
  retainedEarningsCode: string = RETAINED_EARNINGS_CODE,
): ClosingJournal {
  const lines: ClosingJournalLine[] = [];
  let zeroSum = 0;
  for (const [code, bal] of plBalances) {
    const amt = round2(-bal);
    if (Math.abs(amt) < 0.005) continue;
    lines.push({ accountCode: code, amount: amt });
    zeroSum = round2(zeroSum + amt);
  }
  // zeroSum = Σ(−P&L balances) = revenue − expenses = the net result (profit > 0).
  if (Math.abs(zeroSum) >= 0.005) {
    lines.push({ accountCode: retainedEarningsCode, amount: round2(-zeroSum) });
  }
  return { lines, netResult: zeroSum };
}
