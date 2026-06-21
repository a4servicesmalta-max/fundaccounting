// GL-vs-bank reconciliation (CONTRACT: trap T10 — items on the statement but not
// in the posted ledger must be SURFACED as reconciling items, not silently
// assumed reconciled). Ties each account's statement closing balance to the
// balance the books reflect, and lists what explains any difference.

export interface ReconTxn {
  id: string;
  date: string;
  description: string;
  amount: number; // signed
  status: 'AUTO' | 'REVIEW' | 'POSTED' | 'REJECTED';
  postToCode: string | null;
  dateFlag?: unknown | null;
}

export interface ReconStatement {
  openingBalance: number | null;
  closingBalance: number | null;
  periodEnd?: string | null;
}

export interface ReconcilingItem {
  txnId: string;
  date: string;
  description: string;
  amount: number;
  reason: 'HELD_IMPOSSIBLE_DATE' | 'REJECTED' | 'UNCATEGORISED';
  note: string;
}

export interface Reconciliation {
  statementOpening: number;
  statementClosing: number;
  glBalance: number; // opening + posted movements (what the books reflect)
  difference: number; // statementClosing − glBalance (explained by held/rejected items)
  reconciled: boolean; // difference within a cent
  reconcilingItems: ReconcilingItem[];
  uncategorised: ReconcilingItem[]; // in the GL but still in suspense / unconfirmed
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function isHeld(t: ReconTxn): boolean {
  return !!t.dateFlag;
}
function isExcludedFromGl(t: ReconTxn): boolean {
  return t.status === 'REJECTED' || isHeld(t);
}
function isSuspense(t: ReconTxn): boolean {
  const code = t.postToCode || '';
  return code === '' || code === '9999' || t.status === 'REVIEW';
}

/** Reconcile one bank account. `statements` may hold several periods; the opening
 *  is taken from the earliest and the closing from the latest. */
export function reconcileAccount(txns: ReconTxn[], statements: ReconStatement[]): Reconciliation {
  const stmts = [...statements].filter(Boolean);
  stmts.sort((a, b) => String(a.periodEnd || '').localeCompare(String(b.periodEnd || '')));
  const statementOpening = stmts.length ? Number(stmts[0].openingBalance) || 0 : 0;
  const statementClosing = stmts.length ? Number(stmts[stmts.length - 1].closingBalance) || 0 : 0;

  // GL reflects every transaction that is NOT excluded (rejected / held for a bad date).
  const postedMovement = round2(
    txns.filter((t) => !isExcludedFromGl(t)).reduce((s, t) => s + (Number(t.amount) || 0), 0),
  );
  const glBalance = round2(statementOpening + postedMovement);
  const difference = round2(statementClosing - glBalance);

  const reconcilingItems: ReconcilingItem[] = txns
    .filter(isExcludedFromGl)
    .map((t) => ({
      txnId: t.id,
      date: t.date,
      description: t.description,
      amount: round2(Number(t.amount) || 0),
      reason: isHeld(t) ? ('HELD_IMPOSSIBLE_DATE' as const) : ('REJECTED' as const),
      note: isHeld(t)
        ? 'On the statement but held out of the books until its impossible date is corrected.'
        : 'On the statement but excluded from the books (rejected).',
    }));

  // Informational: posted but still in suspense / unconfirmed — needs a home.
  const uncategorised: ReconcilingItem[] = txns
    .filter((t) => !isExcludedFromGl(t) && isSuspense(t))
    .map((t) => ({
      txnId: t.id,
      date: t.date,
      description: t.description,
      amount: round2(Number(t.amount) || 0),
      reason: 'UNCATEGORISED' as const,
      note: 'Posted to the bank account but not yet classified to a final account (sits in suspense).',
    }));

  return {
    statementOpening,
    statementClosing,
    glBalance,
    difference,
    reconciled: Math.abs(difference) < 0.01,
    reconcilingItems,
    uncategorised,
  };
}
