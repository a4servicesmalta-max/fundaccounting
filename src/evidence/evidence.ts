// Evidence linking + period evidence packs.
//
// Every posted entry, bank transaction and invoice/bill already carries a link to the
// source document it came from (documentId / matchedDocumentId). This module surfaces
// those links per period and assembles a downloadable evidence pack (a ZIP of every
// supporting file for a month or financial year, plus a manifest of what each file
// supports). Pure selection logic here; the byte-reading/zipping happens in the route.

import { listPostedLines, listDocuments, getDocument } from '../db/store';
import { listItems } from '../arap/arap-store';
import { listTransactions, listStatements } from '../bank/bank-store';

export interface EvidenceItem {
  kind: 'document' | 'bank-statement';
  id: string; // documentId or statementId
  fileName: string;
  storedPath: string | null;
  classification: string;
  linkedTo: string; // human description of the entry/transaction it supports
  period: string; // YYYY-MM
}

export interface EvidenceIndex {
  period: string;
  items: EvidenceItem[];
  entriesTotal: number; // value-bearing entries in the period
  entriesWithEvidence: number;
  entriesMissingEvidence: number;
  missing: { ref: string; date: string; description: string }[];
}

/** A period filter is a month (YYYY-MM), a whole calendar year (YYYY), or empty/"all"
 *  meaning the whole book. */
function inPeriod(p: string | undefined | null, filter: string): boolean {
  if (!filter || filter === 'all') return true; // whole book
  if (!p) return false;
  if (/^\d{4}$/.test(filter)) return p.startsWith(`${filter}-`);
  return p === filter;
}

/** Gather every supporting document/statement whose entry falls in the period (or the
 *  whole book when period is omitted), deduped. */
export function collectEvidenceForPeriod(period = ''): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  const seen = new Set<string>();
  const add = (it: EvidenceItem) => {
    const k = `${it.kind}:${it.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(it);
  };

  // 1. Posted investment-event lines with a source document.
  for (const ln of listPostedLines()) {
    if (!inPeriod(ln.period, period) || !ln.documentId) continue;
    const doc = getDocument(ln.documentId);
    if (!doc) continue;
    add({ kind: 'document', id: doc.id, fileName: doc.fileName, storedPath: doc.storedPath, classification: doc.classification, linkedTo: `${ln.eventType} ${ln.accountCode} ${ln.txnDate} €${Math.abs(ln.amount)}`, period: ln.period });
  }
  // 2. Invoices/bills (by issue/due date) with a source document.
  for (const it of listItems()) {
    const p = (it.issueDate || it.dueDate || '').slice(0, 7);
    if (!inPeriod(p, period) || !it.documentId) continue;
    const doc = getDocument(it.documentId);
    if (!doc) continue;
    add({ kind: 'document', id: doc.id, fileName: doc.fileName, storedPath: doc.storedPath, classification: doc.classification, linkedTo: `${it.kind} ${it.counterparty} ${it.currency} ${it.amount}`, period: p });
  }
  // 3. Bank transactions with a matched settlement document.
  for (const t of listTransactions()) {
    if (!inPeriod(t.period, period) || !t.matchedDocumentId) continue;
    const doc = getDocument(t.matchedDocumentId);
    if (!doc) continue;
    add({ kind: 'document', id: doc.id, fileName: doc.fileName, storedPath: doc.storedPath, classification: doc.classification, linkedTo: `Bank ${t.date} ${t.description || ''}`.trim(), period: t.period });
  }
  // 4. Bank statement files covering the period.
  for (const s of listStatements()) {
    const months = Array.isArray(s.monthsCovered) ? s.monthsCovered : [];
    if (!s.storedPath || !months.some((m) => inPeriod(m, period))) continue;
    add({ kind: 'bank-statement', id: s.id, fileName: s.fileName, storedPath: s.storedPath, classification: 'BANK', linkedTo: `Bank statement ${s.periodStart}..${s.periodEnd}`, period: months.find((m) => inPeriod(m, period)) || period });
  }
  // 5. Standalone supporting evidence (registry extracts etc.) filed in the period.
  for (const doc of listDocuments()) {
    if (doc.classification !== 'EVIDENCE' || !doc.storedPath) continue;
    const p = (doc.createdAt || '').slice(0, 7);
    if (!inPeriod(p, period)) continue;
    add({ kind: 'document', id: doc.id, fileName: doc.fileName, storedPath: doc.storedPath, classification: 'EVIDENCE', linkedTo: doc.relatedInvestee ? `Ownership evidence — ${doc.relatedInvestee}` : 'Supporting evidence', period: p });
  }
  return out;
}

/** Evidence index for a period: the linked items + which value-bearing entries are
 *  still MISSING a supporting document (so gaps are visible, not silent). */
export function evidenceIndexForPeriod(period = ''): EvidenceIndex {
  const items = collectEvidenceForPeriod(period);
  // Value-bearing entries in the period, by transaction, and whether each has a doc.
  const byTxn = new Map<string, { hasDoc: boolean; date: string; description: string; ref: string }>();
  for (const ln of listPostedLines()) {
    if (!inPeriod(ln.period, period)) continue;
    if (ln.eventType === 'OPENING' || ln.eventType === 'YEAR_CLOSE') continue; // not document-backed
    const e = byTxn.get(ln.txnId) || { hasDoc: false, date: ln.txnDate, description: `${ln.eventType} ${ln.accountCode}`, ref: ln.txnId };
    if (ln.documentId) e.hasDoc = true;
    byTxn.set(ln.txnId, e);
  }
  for (const it of listItems()) {
    const p = (it.issueDate || it.dueDate || '').slice(0, 7);
    if (!inPeriod(p, period)) continue;
    byTxn.set(`arap:${it.id}`, { hasDoc: !!it.documentId, date: it.issueDate || it.dueDate || '', description: `${it.kind} ${it.counterparty}`, ref: it.id });
  }
  const entries = [...byTxn.values()];
  const missing = entries.filter((e) => !e.hasDoc).map((e) => ({ ref: e.ref, date: e.date, description: e.description }));
  return {
    period,
    items,
    entriesTotal: entries.length,
    entriesWithEvidence: entries.filter((e) => e.hasDoc).length,
    entriesMissingEvidence: missing.length,
    missing,
  };
}

/** CSV manifest describing each file in an evidence pack. */
export function evidenceManifestCsv(items: EvidenceItem[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = [['File', 'Type', 'Period', 'Evidence for'].join(',')];
  for (const it of items) rows.push([esc(it.fileName), esc(it.classification), esc(it.period), esc(it.linkedTo)].join(','));
  return rows.join('\n');
}
