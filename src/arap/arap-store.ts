// AR/AP section store (CONTRACT §12(c)).
// Owns the `getDb().arapItems` collection. The `ArApItem` type is the shared
// AR/AP record shape (CONTRACT §12 shared types) and is EXPORTED from here so
// other sections (e.g. BANK's match.ts) import it from this module.

import * as crypto from 'crypto';
import { getDb, persist } from '../db/store';

// --- Shared record type (CONTRACT §12) --------------------------------------

export interface ArApItem {
  id: string;
  documentId: string | null;
  kind: 'RECEIVABLE' | 'PAYABLE';
  counterparty: string;
  amount: number;
  currency: string;
  issueDate: string | null; // YYYY-MM-DD
  dueDate: string | null; // YYYY-MM-DD
  status: 'OPEN' | 'PAID';
  paidByTxnId: string | null;
  docName: string | null;
  createdAt: string;
}

// --- CRUD over getDb().arapItems --------------------------------------------

/** Insert a new AR/AP item. Generates an id and createdAt if absent, then persists. */
export function insertItem(item: Partial<ArApItem> & Pick<ArApItem, 'kind' | 'counterparty' | 'amount' | 'currency'>): ArApItem {
  const record: ArApItem = {
    id: item.id ?? crypto.randomUUID(),
    documentId: item.documentId ?? null,
    kind: item.kind,
    counterparty: item.counterparty,
    amount: item.amount,
    currency: item.currency,
    issueDate: item.issueDate ?? null,
    dueDate: item.dueDate ?? null,
    status: item.status ?? 'OPEN',
    paidByTxnId: item.paidByTxnId ?? null,
    docName: item.docName ?? null,
    createdAt: item.createdAt ?? new Date().toISOString(),
  };
  getDb().arapItems.push(record);
  persist();
  return record;
}

function norm(s: string): string {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Find an existing item that looks like the same invoice/bill (same direction,
 *  counterparty, amount and currency, and the same issue or due date). Used to
 *  avoid filing a duplicate when the same document is uploaded twice. */
export function findDuplicate(
  candidate: Pick<ArApItem, 'kind' | 'counterparty' | 'amount' | 'currency' | 'issueDate' | 'dueDate'>,
): ArApItem | null {
  const items = getDb().arapItems as ArApItem[];
  for (const i of items) {
    if (i.kind !== candidate.kind) continue;
    if (norm(i.counterparty) !== norm(candidate.counterparty)) continue;
    if (Math.abs(Math.abs(i.amount) - Math.abs(candidate.amount)) >= 0.01) continue;
    if (norm(i.currency) !== norm(candidate.currency)) continue;
    const sameIssue = candidate.issueDate && i.issueDate === candidate.issueDate;
    const sameDue = candidate.dueDate && i.dueDate === candidate.dueDate;
    if (sameIssue || sameDue) return i;
  }
  return null;
}

/** List AR/AP items, optionally filtered by kind. */
export function listItems(kind?: ArApItem['kind']): ArApItem[] {
  const items = getDb().arapItems as ArApItem[];
  if (!kind) return [...items];
  return items.filter((i) => i.kind === kind);
}

/** Fetch a single AR/AP item by id, or null. */
export function getItem(id: string): ArApItem | null {
  const items = getDb().arapItems as ArApItem[];
  return items.find((i) => i.id === id) ?? null;
}

/** Manually edit an item's fields (counterparty, amount, currency, dates, kind,
 *  status). Only the supplied, valid fields are changed; then persist. */
export function updateItem(
  id: string,
  patch: Partial<Pick<ArApItem, 'kind' | 'counterparty' | 'amount' | 'currency' | 'issueDate' | 'dueDate' | 'status'>>,
): ArApItem | null {
  const item = (getDb().arapItems as ArApItem[]).find((i) => i.id === id);
  if (!item) return null;
  if (patch.kind === 'RECEIVABLE' || patch.kind === 'PAYABLE') item.kind = patch.kind;
  if (typeof patch.counterparty === 'string') item.counterparty = patch.counterparty;
  if (patch.amount != null && isFinite(Number(patch.amount))) item.amount = Number(patch.amount);
  if (typeof patch.currency === 'string' && patch.currency) item.currency = patch.currency;
  if (patch.issueDate !== undefined) item.issueDate = patch.issueDate || null;
  if (patch.dueDate !== undefined) item.dueDate = patch.dueDate || null;
  if (patch.status === 'OPEN' || patch.status === 'PAID') item.status = patch.status;
  persist();
  return item;
}

/** Mark an item PAID, recording the bank transaction that settled it. */
export function markPaid(id: string, txnId: string): ArApItem | null {
  const items = getDb().arapItems as ArApItem[];
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  item.status = 'PAID';
  item.paidByTxnId = txnId;
  persist();
  return item;
}
