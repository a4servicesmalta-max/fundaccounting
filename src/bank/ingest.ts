// Ingest an extracted bank statement into the store (CONTRACT §12(b)).
//
// Pipeline per call:
//   1. find-or-create the BankAccount by (bankName, accountRef) — splits banks.
//   2. month-level dedup: skip incoming transactions whose YYYY-MM is already
//      present for this account (collect into skippedMonths); plus a txn-level
//      guard (skip an incoming txn whose date+amount+description already exists).
//   3. footing (engine math): round2(opening + Σ ALL extracted amounts − closing);
//      footingOk when |diff| < 0.01.
//   4. continuity: opening balance ≈ the most recent prior running balance for
//      this account (±0.01) when prior data exists, else true.
//   5. for each NEWLY-inserted txn: categorize → postTo + status (AUTO if
//      confidence ≥ 0.75 else REVIEW); match against OPEN arapItems → set
//      matchedDocumentId and mark that ArApItem PAID + paidByTxnId.
//   6. persist the BankStatement record.

import * as crypto from 'crypto';
import { getDb, persist } from '../db/store';
import {
  findOrCreateAccount,
  monthsPresentForAccount,
  type BankStatement,
  type BankTransaction,
} from './bank-store';
import { categorizeTransaction } from './categorize';
import { matchTransaction } from './match';
import { applySettlement } from './settle';
import { checkDate } from '../core/date-validate';
import { findNetZeroPairs } from './net-zero';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// --- Input shape (mirrors extractBankStatement's `statement`) ---------------

export interface ExtractedBankTransaction {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // signed: + in / − out
  balance?: number | null; // running balance if shown
}

export interface ExtractedBankStatement {
  bankName: string;
  accountRef: string;
  currency: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  openingBalance: number;
  closingBalance: number;
  transactions: ExtractedBankTransaction[];
  // Optional metadata threaded through by the route layer.
  fileName?: string;
  storedPath?: string | null;
}

export interface IngestResult {
  bankAccountId: string;
  statementId: string;
  added: number;
  skippedMonths: string[];
  footingOk: boolean;
  footingDiff: number;
  continuityOk: boolean;
}

/** Minimal shape of an OPEN AR/AP item we touch (kept local to avoid a hard
 *  dependency on the ARAP module during isolated typecheck). */
interface ArApLike {
  id: string;
  documentId: string | null;
  amount: number;
  status: 'OPEN' | 'PAID';
  paidByTxnId: string | null;
}

function monthOf(date: string): string {
  return (date || '').slice(0, 7);
}

export function ingestStatement(extracted: ExtractedBankStatement): IngestResult {
  const db = getDb();

  // 1. Find-or-create the account (splits bank-by-bank).
  const account = findOrCreateAccount(
    extracted.bankName,
    extracted.accountRef,
    extracted.currency,
  );

  const txns = Array.isArray(extracted.transactions) ? extracted.transactions : [];

  // 2a. Month-level dedup: which incoming months are already present?
  const present = new Set(monthsPresentForAccount(account.id));
  const incomingMonths = [...new Set(txns.map((t) => monthOf(t.date)).filter(Boolean))].sort();
  const skippedMonths = incomingMonths.filter((m) => present.has(m));
  const skipSet = new Set(skippedMonths);

  // 2b. Txn-level guard: an exact date+amount+description already booked.
  const existingForAccount = (db.bankTransactions as BankTransaction[]).filter(
    (t) => t.bankAccountId === account.id,
  );
  const seenKey = new Set(
    existingForAccount.map((t) => `${t.date}|${t.amount}|${t.description}`),
  );

  // 3. Footing over ALL extracted amounts (not just the newly-added ones).
  const sumAll = round2(txns.reduce((acc, t) => acc + (Number(t.amount) || 0), 0));
  const footingDiff = round2(extracted.openingBalance + sumAll - extracted.closingBalance);
  const footingOk = Math.abs(footingDiff) < 0.01;

  // 4. Continuity: opening vs the most recent prior running balance.
  let continuityOk = true;
  if (existingForAccount.length > 0) {
    // The prior txn with the latest date that carries a running balance.
    const withBalance = existingForAccount
      .filter((t) => t.balance !== null && t.balance !== undefined)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (withBalance.length > 0) {
      const priorBalance = withBalance[withBalance.length - 1].balance as number;
      continuityOk = Math.abs(round2(extracted.openingBalance - priorBalance)) < 0.01;
    }
  }

  // 5. Insert the statement record first so we can reference its id.
  const statement: BankStatement = {
    id: crypto.randomUUID(),
    bankAccountId: account.id,
    fileName: extracted.fileName ?? '',
    storedPath: extracted.storedPath ?? null,
    periodStart: extracted.periodStart,
    periodEnd: extracted.periodEnd,
    openingBalance: extracted.openingBalance,
    closingBalance: extracted.closingBalance,
    footingOk,
    footingDiff,
    monthsCovered: incomingMonths,
    createdAt: new Date().toISOString(),
  };
  (db.bankStatements as BankStatement[]).push(statement);

  // 6. Insert the surviving transactions, categorise + match each.
  let added = 0;
  const openItems = (db.arapItems as ArApLike[]).filter((i) => i.status === 'OPEN');

  for (const t of txns) {
    // Trap T2: an impossible calendar date (e.g. 2021-09-31) must not be silently
    // rolled into the next month. Flag it and leave the period unset for review.
    const dchk = checkDate(t.date);
    const dateFlag = dchk.impossible
      ? { raw: t.date, reason: dchk.reason || 'Impossible date.', suggestion: dchk.suggestion }
      : null;
    const month = dateFlag ? '' : monthOf(t.date);
    if (!dateFlag && skipSet.has(month)) continue; // skipped whole month

    const key = `${t.date}|${t.amount}|${t.description}`;
    if (seenKey.has(key)) continue; // txn-level duplicate
    seenKey.add(key);

    const cat = categorizeTransaction({ description: t.description, amount: t.amount });
    // A flagged impossible date always needs a human (it cannot be posted as-is).
    const status: BankTransaction['status'] = dateFlag ? 'REVIEW' : cat.confidence >= 0.75 ? 'AUTO' : 'REVIEW';

    const txn: BankTransaction = {
      id: crypto.randomUUID(),
      bankAccountId: account.id,
      statementId: statement.id,
      date: t.date,
      period: month,
      description: t.description,
      amount: t.amount,
      balance: t.balance ?? null,
      postToCode: cat.code,
      postToName: cat.name,
      postConfidence: cat.confidence,
      status,
      matchedDocumentId: null,
      createdAt: new Date().toISOString(),
      dateFlag,
    };

    // Match against OPEN AR/AP items; on a hit, link + mark the item PAID.
    const matched = matchTransaction(
      { amount: t.amount, date: t.date, description: t.description },
      openItems as any,
    );
    if (matched) {
      // A definitive match settles the AR/AP: post the bank line to the debtors
      // (1100) / creditors (2010) control, reversing the item, and mark it PAID.
      applySettlement(txn, matched as any);
    }

    (db.bankTransactions as BankTransaction[]).push(txn);
    added++;
  }

  // Trap T13: match charge↔reversal/refund pairs on this account and book both
  // legs to the SAME account so they net to zero (no double-count in P&L).
  const acctTxns = (db.bankTransactions as BankTransaction[]).filter(
    (x) => x.bankAccountId === account.id && x.status !== 'REJECTED' && !x.dateFlag,
  );
  const pairs = findNetZeroPairs(
    acctTxns.map((x) => ({ id: x.id, date: x.date, amount: x.amount, description: x.description })),
  );
  for (const p of pairs) {
    const charge = acctTxns.find((x) => x.id === p.chargeId);
    const refund = acctTxns.find((x) => x.id === p.refundId);
    if (!charge || !refund) continue;
    // Both legs share the charge's account so they cancel; if uncategorised, use
    // a neutral "other receivables / recoverable" code so suspense stays clean.
    const code = charge.postToCode && charge.postToCode !== '9999' ? charge.postToCode : '240';
    const name = charge.postToName && charge.postToCode !== '9999' ? charge.postToName : 'Other receivables';
    for (const leg of [charge, refund]) {
      leg.postToCode = code;
      leg.postToName = name;
      leg.postConfidence = 0.99;
      leg.status = 'AUTO';
    }
    charge.netZeroPair = { id: p.key + ':' + p.chargeId, role: 'CHARGE', counterpartyTxnId: refund.id };
    refund.netZeroPair = { id: p.key + ':' + p.chargeId, role: 'REFUND', counterpartyTxnId: charge.id };
  }

  persist();

  return {
    bankAccountId: account.id,
    statementId: statement.id,
    added,
    skippedMonths,
    footingOk,
    footingDiff,
    continuityOk,
  };
}
