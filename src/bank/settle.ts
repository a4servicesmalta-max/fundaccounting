// Settle bank transactions against AR/AP items (CONTRACT §12(b) extension).
//
// When a bank line matches an OPEN invoice/bill, the accounting is determined:
//   - a RECEIVABLE (debtor invoice) receipt  → post the bank line to 1100
//     (Accounts receivable), which REVERSES/clears the debtor that was raised
//     when the invoice was filed.
//   - a PAYABLE (supplier bill) payment      → post to 2010 (Accounts payable),
//     clearing the creditor.
// In both cases the AR/AP item is marked PAID and linked to the bank line.

import { getDb, persist } from '../db/store';
import { accountName } from '../core/chart';
import { matchTransaction } from './match';
import type { BankTransaction } from './bank-store';
import type { ArApItem } from '../arap/arap-store';

/** The control account a matched bank line posts to, by AR/AP direction. */
export function settleCodeFor(kind: ArApItem['kind']): string {
  return kind === 'RECEIVABLE' ? '1100' : '2010';
}

/** Apply a confirmed match in place: post the bank line to the AR/AP control
 *  (settling the debtor/creditor) and mark the item PAID + linked. */
export function applySettlement(txn: BankTransaction, item: ArApItem): void {
  const code = settleCodeFor(item.kind);
  txn.postToCode = code;
  txn.postToName = accountName(code);
  txn.postConfidence = 0.99;
  // A definitive match is auto-categorised (out of suspense/review).
  if (txn.status === 'REVIEW') txn.status = 'AUTO';
  txn.matchedDocumentId = item.documentId ?? txn.matchedDocumentId ?? null;
  item.status = 'PAID';
  item.paidByTxnId = txn.id;
}

/**
 * Sweep every not-yet-matched bank line against every OPEN AR/AP item and settle
 * the matches. Runs regardless of upload order (so an invoice filed AFTER its
 * bank statement still gets reconciled). Returns how many lines were settled.
 */
export function rematchAll(): { matched: number } {
  const db = getDb();
  const candidates = (db.bankTransactions as BankTransaction[]).filter(
    (t) => !t.matchedDocumentId && t.status !== 'POSTED' && t.status !== 'REJECTED',
  );
  let matched = 0;
  for (const txn of candidates) {
    const open = (db.arapItems as ArApItem[]).filter((i) => i.status === 'OPEN');
    if (!open.length) break;
    const hit = matchTransaction({ amount: txn.amount, date: txn.date, description: txn.description }, open);
    if (hit) {
      applySettlement(txn, hit);
      matched += 1;
    }
  }
  if (matched) persist();
  return { matched };
}
