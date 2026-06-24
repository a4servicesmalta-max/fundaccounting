// Audit Requests — drop an auditor's request in any form (a pasted email, an Excel
// sheet, several files) and the app prepares the matching evidence. This module owns
// the request records, the deterministic evidence-gathering (by entity/date/amount/
// keyword against the evidence index), and the helpers the routes use. The AI step
// that ANSWERS an Excel sheet from the evidence lives behind the same gate as intake
// and is added separately; everything here is deterministic.

import * as crypto from 'crypto';
import { getDb, persist } from '../db/store';
import { collectEvidenceForPeriod, type EvidenceItem } from '../evidence/evidence';

export interface AuditRequestAttachment {
  id: string;
  fileName: string;
  storedPath: string | null;
  mime: string;
  isSheet: boolean; // xlsx / xls / csv — a sheet the auditor wants answered
}

export interface AuditRequestRecord {
  id: string;
  title: string;
  emailText: string | null; // pasted email / free-text request
  attachments: AuditRequestAttachment[];
  period: string | null; // optional scope (YYYY-MM or YYYY)
  status: 'OPEN' | 'PREPARED' | 'ANSWERED';
  createdAt: string;
  answeredSheets: { attachmentId: string; storedPath: string; fileName: string }[];
}

function reqs(): AuditRequestRecord[] {
  const db = getDb();
  if (!Array.isArray(db.auditRequests)) db.auditRequests = [];
  return db.auditRequests as AuditRequestRecord[];
}

export function isSheetName(fileName: string): boolean {
  return /\.(xlsx|xlsm|xls|csv)$/i.test(fileName || '');
}

export function insertAuditRequest(input: {
  title?: string;
  emailText?: string | null;
  attachments?: AuditRequestAttachment[];
  period?: string | null;
}): AuditRequestRecord {
  const r: AuditRequestRecord = {
    id: crypto.randomUUID(),
    title: (input.title || '').trim() || 'Audit request',
    emailText: input.emailText ?? null,
    attachments: input.attachments ?? [],
    period: input.period ?? null,
    status: 'OPEN',
    createdAt: new Date().toISOString(),
    answeredSheets: [],
  };
  reqs().push(r);
  persist();
  return r;
}

export function listAuditRequests(): AuditRequestRecord[] {
  return [...reqs()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export function getAuditRequest(id: string): AuditRequestRecord | null {
  return reqs().find((r) => r.id === id) ?? null;
}

export function updateAuditRequest(id: string, patch: Partial<AuditRequestRecord>): AuditRequestRecord | null {
  const r = reqs().find((x) => x.id === id);
  if (!r) return null;
  Object.assign(r, patch);
  persist();
  return r;
}

// Words that carry no matching signal — request boilerplate, generic accounting nouns
// and file extensions — dropped before keyword matching.
const STOP = new Set([
  'the', 'and', 'for', 'all', 'any', 'please', 'provide', 'provided', 'request', 'requested', 'evidence',
  'supporting', 'documents', 'document', 'audit', 'auditor', 'dear', 'regards', 'kindly', 'attached',
  'sheet', 'sheets', 'excel', 'copy', 'copies', 'your', 'our', 'from', 'with', 'that', 'this', 'will',
  'have', 'been', 'are', 'was', 'were', 'per', 'also', 'thanks', 'thank', 'you', 'send', 'everything',
  'list', 'listing', 'schedule', 'samples', 'sample', 'selection', 'selected', 'breakdown', 'details',
  'detail', 'information', 'info', 'related', 'relating', 'respect', 'year', 'period', 'ended', 'ending',
  'month', 'financial', 'statements', 'statement', 'books', 'records', 'record', 'balance', 'balances',
  // file extensions
  'pdf', 'xlsx', 'xlsm', 'xls', 'csv', 'txt', 'docx', 'doc', 'png', 'jpg', 'jpeg', 'zip',
]);

/** Meaningful match terms from free text: split on punctuation; lowercased, deduped,
 *  stopwords removed. Shared by request gathering and sheet-row answering. */
export function termsFromText(text: string): string[] {
  const tokens = (text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const out = new Set<string>();
  for (const t of tokens) {
    if (STOP.has(t)) continue;
    out.add(t);
  }
  return [...out];
}

/** Match terms from the request text + attachment names (entities, years, references). */
export function extractTerms(req: Pick<AuditRequestRecord, 'emailText' | 'attachments'>): string[] {
  return termsFromText(`${req.emailText || ''} ${(req.attachments || []).map((a) => a.fileName).join(' ')}`);
}

/**
 * Deterministically gather the evidence that satisfies a request: the evidence index
 * for the request's period (or the whole book), filtered to items that match any of
 * the request's terms (entity name, year/period, amount, reference) in their file name
 * or what they support. If nothing specific matches (vague request, or a named item
 * with no evidence on file), fall back to the whole in-scope set — an evidence pack
 * should never come back empty when there is evidence to send.
 */
export function gatherEvidenceForRequest(req: AuditRequestRecord): EvidenceItem[] {
  const all = collectEvidenceForPeriod(req.period || '');
  const terms = extractTerms(req);
  if (!terms.length) return all;
  const matched = all.filter((it) => {
    const hay = `${it.fileName} ${it.linkedTo} ${it.classification} ${it.period}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
  return matched.length ? matched : all;
}
