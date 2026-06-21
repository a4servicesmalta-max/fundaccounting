// Posting (CONTRACT §8). Approving a draft finalizes its already-balanced lines.
// Every state change (approve, edit, reverse) writes an immutable audit entry,
// and no posting/editing into a locked period is allowed.

import {
  getDraft,
  listDrafts,
  setDraftStatus,
  patchDraft,
  insertDraft,
  appendAudit,
  isPeriodLocked,
  getSettings,
  type DraftRecord,
} from '../db/store';

/** Throw if the draft's period is closed (locked). */
function assertPeriodOpen(period: string | null | undefined, what: string): void {
  if (isPeriodLocked(period)) {
    throw new Error(`Period ${period} is locked. ${what} into a closed period is not allowed.`);
  }
}

/** PENDING → POSTED. Returns the updated draft, or null if not found/posted. */
export function approveDraft(id: string, actor = 'system'): DraftRecord | null {
  const draft = getDraft(id);
  if (!draft) return null;
  if (draft.status !== 'PENDING') return draft; // idempotent-ish: only PENDING posts
  assertPeriodOpen(draft.period, 'Posting');
  const now = new Date().toISOString();
  setDraftStatus(id, 'POSTED', now);
  patchDraft(id, { postedBy: actor });
  appendAudit({
    action: 'DRAFT_POST',
    entity: 'draft',
    entityId: id,
    actor,
    summary: `Posted ${draft.eventType} for ${draft.investeeName} (${draft.controlCode})`,
    after: { status: 'POSTED', postedAt: now },
  });
  return getDraft(id);
}

/** Confidence below which a draft must NOT be bulk-approved (needs per-line review). */
export const BULK_APPROVE_MIN_CONFIDENCE = 0.6;

/** Approve every PENDING draft that meets the confidence bar; leave low-confidence
 *  ones for per-line review. Skips drafts whose period is locked. Returns how many
 *  posted and how many were held back. */
export function approveAll(actor = 'system'): { approved: number; skipped: number } {
  const pending = listDrafts('PENDING');
  const now = new Date().toISOString();
  let approved = 0;
  let skipped = 0;
  for (const d of pending) {
    const conf = d.confidence == null ? 1 : Number(d.confidence);
    if (conf < BULK_APPROVE_MIN_CONFIDENCE || isPeriodLocked(d.period)) {
      skipped += 1;
      continue;
    }
    setDraftStatus(d.id, 'POSTED', now);
    patchDraft(d.id, { postedBy: actor });
    approved += 1;
  }
  if (approved > 0) {
    appendAudit({
      action: 'DRAFT_POST_BULK',
      entity: 'draft',
      entityId: 'bulk',
      actor,
      summary: `Bulk-approved ${approved} draft(s); ${skipped} held for review`,
      after: { approved, skipped },
    });
  }
  return { approved, skipped };
}

/** PENDING → REJECTED. Returns true if a draft was found. */
export function rejectDraft(id: string, actor = 'system'): boolean {
  const draft = getDraft(id);
  if (!draft) return false;
  setDraftStatus(id, 'REJECTED');
  appendAudit({
    action: 'DRAFT_REJECT',
    entity: 'draft',
    entityId: id,
    actor,
    summary: `Rejected ${draft.eventType} for ${draft.investeeName}`,
  });
  return true;
}

// --- Inline edit (PENDING drafts only) --------------------------------------

/** Fields a reviewer may correct on a still-PENDING draft before posting. */
const EDITABLE_FIELDS: (keyof DraftRecord)[] = [
  'investeeName',
  'controlCode',
  'currency',
  'txnDate',
  'period',
  'confidence',
  'rationale',
  'eventType',
  'lines',
];

function linesBalance(lines: DraftRecord['lines']): boolean {
  const sum = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  return Math.abs(sum) < 0.01;
}

/** Edit a PENDING draft in place, recording a before/after audit entry.
 *  Throws if the draft is missing, already posted, in a locked period, or if the
 *  edited lines do not balance. Posted entries cannot be edited — reverse them. */
export function editDraft(
  id: string,
  patch: Partial<DraftRecord>,
  actor = 'system',
): DraftRecord | null {
  const draft = getDraft(id);
  if (!draft) return null;
  if (draft.status !== 'PENDING') {
    throw new Error('Only pending drafts can be edited. Posted entries must be reversed.');
  }
  assertPeriodOpen(draft.period, 'Editing');

  const clean: Partial<DraftRecord> = {};
  for (const f of EDITABLE_FIELDS) {
    if (patch[f] !== undefined) (clean as Record<string, unknown>)[f] = patch[f];
  }
  if (clean.lines && !linesBalance(clean.lines)) {
    throw new Error('Edited journal lines do not balance (debits must equal credits).');
  }
  if (clean.period) assertPeriodOpen(clean.period, 'Editing');

  const before: Partial<DraftRecord> = {};
  for (const f of Object.keys(clean) as (keyof DraftRecord)[]) {
    (before as Record<string, unknown>)[f] = draft[f];
  }
  const now = new Date().toISOString();
  clean.editedAt = now;
  const updated = patchDraft(id, clean);
  appendAudit({
    action: 'DRAFT_EDIT',
    entity: 'draft',
    entityId: id,
    actor,
    summary: `Edited draft for ${draft.investeeName} (${Object.keys(clean).filter((k) => k !== 'editedAt').join(', ')})`,
    before,
    after: clean,
  });
  return updated;
}

// --- Reversal (POSTED entries; correction never deletes) ---------------------

/** Pick an open period to book a reversal into: the original period if still
 *  open, else the current period if open. Throws if neither is available. */
function reversalPeriod(originalPeriod: string): string {
  if (!isPeriodLocked(originalPeriod)) return originalPeriod;
  const current = getSettings().currentPeriod;
  if (current && !isPeriodLocked(current)) return current;
  throw new Error(
    `Cannot book a reversal: original period ${originalPeriod} is locked and no open current period is set.`,
  );
}

/** Reverse a POSTED draft by booking an equal-and-opposite POSTED entry. The
 *  original is never deleted; both entries cross-link. Returns the reversal. */
export function reverseDraft(id: string, reason: string, actor = 'system'): DraftRecord {
  const original = getDraft(id);
  if (!original) throw new Error('Draft not found.');
  if (original.status !== 'POSTED') throw new Error('Only posted entries can be reversed.');
  if (original.reversedByDraftId) throw new Error('This entry has already been reversed.');

  const period = reversalPeriod(original.period);
  const now = new Date().toISOString();
  const reversalLines = original.lines.map((l) => ({
    accountCode: l.accountCode,
    accountName: l.accountName,
    amount: -1 * (Number(l.amount) || 0),
    description: `Reversal: ${l.description}`,
  }));

  const reversal: DraftRecord = {
    ...original,
    id: '', // store assigns a fresh id
    status: 'POSTED',
    lines: reversalLines,
    period,
    txnDate: period === original.period ? original.txnDate : `${period}-01`,
    rationale: `Reversal of ${original.id}. Reason: ${reason}`,
    createdAt: now,
    postedAt: now,
    editedAt: null,
    postedBy: actor,
    reversesDraftId: original.id,
    reversedByDraftId: null,
  };
  insertDraft(reversal);
  patchDraft(original.id, { reversedByDraftId: reversal.id });

  appendAudit({
    action: 'DRAFT_REVERSE',
    entity: 'draft',
    entityId: original.id,
    actor,
    summary: `Reversed ${original.eventType} for ${original.investeeName} (${original.controlCode}) into ${period}. Reason: ${reason}`,
    after: { reversalId: reversal.id, period },
  });
  return reversal;
}
