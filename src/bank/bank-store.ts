// Bank section store (CONTRACT §12(b)). CRUD over the shared in-memory store's
// bank collections (getDb().bankAccounts / bankStatements / bankTransactions),
// flushing to disk via persist(). All money is signed: + = money IN, − = money OUT.

import * as crypto from 'crypto';
import { getDb, persist } from '../db/store';

// --- Shared record types (CONTRACT §12) -------------------------------------

export interface BankAccount {
  id: string;
  bankName: string;
  accountRef: string;
  currency: string;
  createdAt: string;
}

export interface BankStatement {
  id: string;
  bankAccountId: string;
  fileName: string;
  storedPath: string | null;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  openingBalance: number;
  closingBalance: number;
  footingOk: boolean;
  footingDiff: number;
  monthsCovered: string[]; // YYYY-MM
  createdAt: string;
}

export interface BankTransaction {
  id: string;
  bankAccountId: string;
  statementId: string;
  date: string; // YYYY-MM-DD
  period: string; // YYYY-MM
  description: string;
  amount: number; // signed: + in / − out
  balance: number | null; // running balance if known
  postToCode: string | null;
  postToName: string | null;
  postConfidence: number | null;
  // When a single line is split across accounts (e.g. principal + interest), the
  // allocations live here and replace the single postToCode for the ledger.
  splits?: { accountCode: string; accountName: string; amount: number }[];
  status: 'AUTO' | 'REVIEW' | 'POSTED' | 'REJECTED';
  matchedDocumentId: string | null;
  createdAt: string;
  // Trap T2: set when the statement carried an impossible calendar date (e.g.
  // 2021-09-31). The raw value is kept for the reviewer; the period is left
  // unset so it never silently lands in the wrong month.
  dateFlag?: { raw: string; reason: string; suggestion: string | null } | null;
  // Trap T13: when a charge and its reversal/refund are matched as a net-zero
  // pair, both legs carry the same id and post to the same account so they cancel
  // (no double-count in P&L). 'CHARGE' is the original, 'REFUND' the reversal.
  netZeroPair?: { id: string; role: 'CHARGE' | 'REFUND'; counterpartyTxnId: string } | null;
  // NH-0: when this bank line is the cash leg of a posted investment entry
  // (share buy/sale, loan advance/repayment, distribution), it is matched to that
  // draft and EXCLUDED from the GL — the investment entry already books both Dr
  // 030/032 and Cr/Dr 1010, so letting the bank line post too would double-count
  // the cash and the asset.
  matchedInvestmentDraftId?: string | null;
}

// --- Accounts ---------------------------------------------------------------

/**
 * Find a bank account by (bankName, accountRef), matched case-insensitively and
 * trimmed; create it if none exists. Returns the account.
 */
export function findOrCreateAccount(
  bankName: string,
  accountRef: string,
  currency: string,
): BankAccount {
  const db = getDb();
  const wantName = (bankName || '').trim().toLowerCase();
  const wantRef = (accountRef || '').trim().toLowerCase();
  const existing = (db.bankAccounts as BankAccount[]).find(
    (a) =>
      (a.bankName || '').trim().toLowerCase() === wantName &&
      (a.accountRef || '').trim().toLowerCase() === wantRef,
  );
  if (existing) return existing;
  const account: BankAccount = {
    id: crypto.randomUUID(),
    bankName: (bankName || '').trim(),
    accountRef: (accountRef || '').trim(),
    currency: currency || 'EUR',
    createdAt: new Date().toISOString(),
  };
  (db.bankAccounts as BankAccount[]).push(account);
  persist();
  return account;
}

export function listAccounts(): BankAccount[] {
  return [...(getDb().bankAccounts as BankAccount[])];
}

// --- Statements -------------------------------------------------------------

export function insertStatement(s: BankStatement): BankStatement {
  if (!s.id) s.id = crypto.randomUUID();
  (getDb().bankStatements as BankStatement[]).push(s);
  persist();
  return s;
}

export function listStatements(accountId?: string): BankStatement[] {
  const all = getDb().bankStatements as BankStatement[];
  return all.filter((s) => (accountId ? s.bankAccountId === accountId : true));
}

// --- Transactions -----------------------------------------------------------

export function insertTransaction(t: BankTransaction): BankTransaction {
  if (!t.id) t.id = crypto.randomUUID();
  (getDb().bankTransactions as BankTransaction[]).push(t);
  persist();
  return t;
}

export function listTransactions(filter?: {
  accountId?: string;
  period?: string;
  status?: BankTransaction['status'];
}): BankTransaction[] {
  const all = getDb().bankTransactions as BankTransaction[];
  return all.filter((t) => {
    if (filter?.accountId && t.bankAccountId !== filter.accountId) return false;
    if (filter?.period && t.period !== filter.period) return false;
    if (filter?.status && t.status !== filter.status) return false;
    return true;
  });
}

export function getTransaction(id: string): BankTransaction | null {
  return (getDb().bankTransactions as BankTransaction[]).find((t) => t.id === id) ?? null;
}

/** Set the account a transaction is posted to (looks up the friendly name). */
export function setTransactionPostTo(id: string, code: string, name: string): void {
  const t = getTransaction(id);
  if (!t) return;
  t.postToCode = code;
  t.postToName = name;
  persist();
}

export function setTransactionStatus(id: string, status: BankTransaction['status']): void {
  const t = getTransaction(id);
  if (!t) return;
  t.status = status;
  persist();
}

/** Trap T2: correct a flagged impossible date. Sets the date + period and clears
 *  the flag so the line can post. Returns false if the new date is itself bad. */
export function fixTransactionDate(id: string, newDate: string): boolean {
  const t = getTransaction(id);
  if (!t) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return false;
  t.date = newDate;
  t.period = newDate.slice(0, 7);
  t.dateFlag = null;
  persist();
  return true;
}

/** Split a transaction across multiple accounts (replaces the single posting). */
export function setTransactionSplits(
  id: string,
  splits: { accountCode: string; accountName: string; amount: number }[],
): void {
  const t = getTransaction(id);
  if (!t) return;
  t.splits = splits;
  t.postToCode = 'SPLIT';
  t.postToName = `Split across ${splits.length} accounts`;
  t.status = 'POSTED';
  persist();
}

/** Distinct YYYY-MM months already present for a bank account (for dedup). */
export function monthsPresentForAccount(accountId: string): string[] {
  const seen = new Set<string>();
  for (const t of getDb().bankTransactions as BankTransaction[]) {
    if (t.bankAccountId === accountId && t.period) seen.add(t.period);
  }
  return [...seen].sort();
}
