// NH-0: match a posted investment entry to its bank-statement cash leg so the
// movement isn't double-counted. A share purchase posts Dr 030 / Cr 1010 (or a
// loan advance Dr 032 / Cr 1010); if the same payment also appears on an imported
// bank statement, the statement line would independently move 1010 again — the
// cash and the asset would each be counted twice. So when a bank line corresponds
// to an investment entry's cash leg, we mark it matched and EXCLUDE it from the GL
// (report.ts honours `matchedInvestmentDraftId`); it still shows in the bank view
// for reconciliation, flagged as settled.

import { getDb, persist, listDrafts } from '../db/store';
import type { BankTransaction } from './bank-store';

// Investment events whose cash leg hits the bank (and so could double-count a
// statement line). FX_REVAL / INTEREST_ACCRUAL have no cash movement.
const CASH_EVENTS = new Set([
  'ACQUISITION', 'DISPOSAL', 'LOAN_ADVANCE', 'LOAN_REPAYMENT', 'DISTRIBUTION', 'WRITE_OFF',
]);
// Events whose cash is an INFLOW (money received). The rest are outflows.
const INFLOW_EVENTS = new Set(['DISPOSAL', 'LOAN_REPAYMENT', 'DISTRIBUTION']);

function daysApart(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Infinity;
  return Math.abs(ta - tb) / 86400000;
}

/** Sweep posted investment entries against bank lines and match each entry to the
 *  statement line that is its cash leg (same currency, magnitude, direction, near
 *  date). Idempotent. Returns how many lines were matched/excluded. */
export function rematchInvestments(windowDays = 7): { matched: number } {
  const db = getDb();
  const txns = db.bankTransactions as BankTransaction[];
  const accCcy = new Map<string, string>(
    (db.bankAccounts as { id: string; currency?: string }[]).map((a) => [a.id, (a.currency || 'EUR').toUpperCase()]),
  );
  const drafts = listDrafts('POSTED').filter(
    (d) => CASH_EVENTS.has(d.eventType) && d.controlCode,
  );

  let matched = 0;
  for (const d of drafts) {
    const origAmt = Math.abs(Number(d.engineFigures?.originalAmount) || 0);
    if (!origAmt) continue;
    const origCcy = (d.engineFigures?.originalCurrency || d.currency || 'EUR').toUpperCase();
    const isInflow = INFLOW_EVENTS.has(d.eventType);

    const hit = txns.find((t) => {
      if (t.matchedInvestmentDraftId) return false; // already matched (this or another draft)
      if (t.status === 'REJECTED' || t.dateFlag) return false;
      if ((accCcy.get(t.bankAccountId) || 'EUR') !== origCcy) return false; // compare in native ccy
      const amt = Number(t.amount) || 0;
      if (Math.abs(Math.abs(amt) - origAmt) > 0.01) return false; // same magnitude
      if (isInflow ? amt <= 0 : amt >= 0) return false; // direction must match the event
      if (daysApart(t.date, d.txnDate) > windowDays) return false;
      return true;
    });

    if (hit) {
      hit.matchedInvestmentDraftId = d.id;
      hit.postToName = `Settled against investment — ${d.investeeName || d.controlCode}`;
      hit.postConfidence = 0.99;
      if (hit.status === 'REVIEW') hit.status = 'AUTO';
      matched += 1;
    }
  }
  if (matched) persist();
  return { matched };
}
