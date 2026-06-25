// Loans section (CONTRACT §12(d)).
//
// Aggregates a loans report from two POSTED sources in the store:
//  (1) POSTED investment drafts (`getDb().drafts`) with eventType
//      'LOAN_ADVANCE' (advance) / 'LOAN_REPAYMENT' (repayment). These are loans
//      the fund GRANTED to investees. party = investeeName, amount =
//      engineFigures.functionalAmount, date = txnDate.
//  (2) POSTED bank transactions (`getDb().bankTransactions`, status 'POSTED')
//      whose postToCode starts with '032' (loans granted) or '2300'
//      (borrowings). party from the description; amount = abs(amount); the
//      ADVANCE/REPAYMENT classification follows the signed bank amount and the
//      direction (see below).
//
// Grouped by (party, direction, currency); outstanding = advanced − repaid.
// Pure-ish: reads the store, computes deterministically (no AI figures).

import { getDb } from '../db/store';
import type { DraftRecord } from '../db/store';
import { cleanPartyName, partyKey } from './party';

export type LoanDirection = 'GRANTED' | 'BORROWED';
export type LoanEventType = 'ADVANCE' | 'REPAYMENT';

export interface LoanEvent {
  date: string;
  type: LoanEventType;
  amount: number;
  source: string;
  // Evidence link: the source document (investment draft) or bank statement this
  // event came from, so the loan history can open the underlying evidence.
  documentId?: string | null;
  statementId?: string | null;
}

export interface LoanRow {
  party: string;
  direction: LoanDirection;
  currency: string;
  advanced: number;
  repaid: number;
  outstanding: number; // advanced − repaid
  lastEventDate: string | null;
  events: LoanEvent[];
}

export interface LoansReport {
  loans: LoanRow[];
  totals: { granted: number; borrowed: number; outstanding: number };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

interface GroupAccumulator {
  party: string;
  direction: LoanDirection;
  currency: string;
  advanced: number;
  repaid: number;
  events: LoanEvent[];
}

function groupKey(party: string, direction: LoanDirection, currency: string): string {
  return `${partyKey(party)}|${direction}|${currency}`;
}

/** Build the loans report by aggregating POSTED drafts + POSTED bank transactions. */
export function loansReport(): LoansReport {
  const db = getDb();
  const groups = new Map<string, GroupAccumulator>();

  function bump(
    party: string,
    direction: LoanDirection,
    currency: string,
    type: LoanEventType,
    amount: number,
    date: string,
    source: string,
    evidence?: { documentId?: string | null; statementId?: string | null },
  ): void {
    const display = cleanPartyName(party);
    const key = groupKey(display, direction, currency);
    let g = groups.get(key);
    if (!g) {
      g = { party: display, direction, currency, advanced: 0, repaid: 0, events: [] };
      groups.set(key, g);
    } else if (display.length > g.party.length) {
      g.party = display; // keep the most descriptive name form for the group
    }
    const amt = round2(Math.abs(amount));
    if (type === 'ADVANCE') g.advanced += amt;
    else g.repaid += amt;
    g.events.push({ date, type, amount: amt, source, documentId: evidence?.documentId ?? null, statementId: evidence?.statementId ?? null });
  }

  // (1) POSTED investment drafts — loans GRANTED to investees.
  const drafts: DraftRecord[] = db.drafts ?? [];
  for (const d of drafts) {
    if (d.status !== 'POSTED') continue;
    if (d.eventType !== 'LOAN_ADVANCE' && d.eventType !== 'LOAN_REPAYMENT') continue;
    const party = (d.investeeName || '').trim() || 'Unknown';
    const currency = d.engineFigures?.currency || d.currency || 'EUR';
    const amount = d.engineFigures?.functionalAmount ?? 0;
    const type: LoanEventType = d.eventType === 'LOAN_ADVANCE' ? 'ADVANCE' : 'REPAYMENT';
    bump(party, 'GRANTED', currency, type, amount, d.txnDate, 'investment-draft', { documentId: d.documentId ?? null });
  }

  // (2) POSTED bank transactions — loans granted (032*) or borrowings (2300*).
  const bankTxns: any[] = db.bankTransactions ?? [];
  for (const t of bankTxns) {
    if (t?.status !== 'POSTED') continue;
    const code: string = typeof t.postToCode === 'string' ? t.postToCode : '';
    const isGranted = code.startsWith('032');
    const isBorrowed = code.startsWith('2300');
    if (!isGranted && !isBorrowed) continue;

    const party = (typeof t.description === 'string' && t.description.trim()) || 'Unknown';
    const currency = t.currency || 'EUR';
    const signed: number = typeof t.amount === 'number' ? t.amount : 0;
    const moneyIn = signed > 0;

    // For a 032 loan-granted account: money OUT (negative) = advance to the
    // borrower; money IN (positive) = repayment received.
    // For a 2300 borrowing: money IN = drawdown/advance the fund received;
    // money OUT = repayment the fund made.
    let type: LoanEventType;
    if (isGranted) {
      type = moneyIn ? 'REPAYMENT' : 'ADVANCE';
    } else {
      type = moneyIn ? 'ADVANCE' : 'REPAYMENT';
    }
    const direction: LoanDirection = isGranted ? 'GRANTED' : 'BORROWED';
    bump(party, direction, currency, type, signed, t.date, 'bank-transaction', { statementId: t.statementId ?? null, documentId: t.matchedDocumentId ?? null });
  }

  const loans: LoanRow[] = [...groups.values()]
    .map((g) => {
      const advanced = round2(g.advanced);
      const repaid = round2(g.repaid);
      const events = [...g.events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const lastEventDate = events.length
        ? events.reduce<string | null>((max, e) => (max === null || e.date > max ? e.date : max), null)
        : null;
      return {
        party: g.party,
        direction: g.direction,
        currency: g.currency,
        advanced,
        repaid,
        outstanding: round2(advanced - repaid),
        lastEventDate,
        events,
      };
    })
    .sort((a, b) =>
      a.party === b.party ? a.direction.localeCompare(b.direction) : a.party.localeCompare(b.party),
    );

  let granted = 0;
  let borrowed = 0;
  for (const row of loans) {
    if (row.direction === 'GRANTED') granted += row.outstanding;
    else borrowed += row.outstanding;
  }
  granted = round2(granted);
  borrowed = round2(borrowed);

  return {
    loans,
    totals: { granted, borrowed, outstanding: round2(granted - borrowed) },
  };
}
