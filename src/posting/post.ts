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
  lockPeriod,
  unlockPeriod,
  listLockedPeriods,
  getSettings,
  type DraftRecord,
} from '../db/store';
import { rematchInvestments } from '../bank/investment-settle';
import { accountName } from '../core/chart';
import { financialYearPlBalances } from '../report/report';
import { buildClosingJournal, financialYearMonths, financialYearEnd } from './year-close';

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
  // NH-0: now that the investment's Dr 030/032 + Cr 1010 are live, exclude any
  // bank-statement line that is the same cash movement, so it isn't counted twice.
  rematchInvestments();
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
    rematchInvestments(); // NH-0: exclude bank cash legs of the just-posted investments
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

// --- Period close / reopen (audited control actions) -------------------------

/** Close (lock) a period and record it on the immutable audit trail. Locking an
 *  already-locked period is a no-op (no duplicate audit entry). Returns the locked set. */
export function closePeriod(period: string, actor = 'system'): string[] {
  if (isPeriodLocked(period)) return listLockedPeriods();
  lockPeriod(period);
  appendAudit({
    action: 'PERIOD_LOCK',
    entity: 'period',
    entityId: period,
    actor,
    summary: `Closed (locked) period ${period}`,
    after: { locked: true },
  });
  return listLockedPeriods();
}

/** Reopen (unlock) a period and record it on the audit trail — reopening a closed
 *  period is privileged and must be tamper-evident. No-op if it wasn't locked. */
export function reopenPeriod(period: string, actor = 'system'): string[] {
  if (!isPeriodLocked(period)) return listLockedPeriods();
  unlockPeriod(period);
  appendAudit({
    action: 'PERIOD_UNLOCK',
    entity: 'period',
    entityId: period,
    actor,
    summary: `Reopened (unlocked) period ${period}`,
    after: { locked: false },
  });
  return listLockedPeriods();
}

// --- Year-end close (calendar fiscal year) -----------------------------------

export interface CloseYearResult {
  year: number;
  netResult: number; // > 0 profit, < 0 loss
  closingDraftId: string | null;
  locked: string[];
}

/** True when every month of the calendar year is locked (i.e. the year is closed). */
export function isYearClosed(year: number): boolean {
  return financialYearMonths(year).every((m) => isPeriodLocked(m));
}

/**
 * Close a calendar financial year: post an audited closing journal dated 31 Dec that
 * zeroes the year's P&L into Retained earnings (3100), then lock all twelve months so
 * nothing else posts into the closed year. Idempotent guard: throws if already closed.
 */
export function closeYear(year: number, actor = 'system'): CloseYearResult {
  if (isYearClosed(year)) {
    throw new Error(`Financial year ${year} is already closed.`);
  }
  const { date: closeDate, period: closePeriod } = financialYearEnd(year);
  const journal = buildClosingJournal(financialYearPlBalances(year));

  let closingDraftId: string | null = null;
  if (journal.lines.length) {
    const now = new Date().toISOString();
    const draft: DraftRecord = {
      id: '', // store assigns a fresh id
      documentId: null,
      investeeName: `Year-end close ${year}`,
      instrument: 'SHARES',
      eventType: 'YEAR_CLOSE',
      controlCode: '3100',
      currency: 'EUR',
      txnDate: closeDate,
      period: closePeriod,
      status: 'POSTED',
      sourceFigures: { amount: 0, quantity: null, fairValue: null, currency: 'EUR' },
      engineFigures: {
        functionalAmount: journal.netResult, currency: 'EUR', lineCount: journal.lines.length,
        fxRate: null, fxRateDate: null, originalCurrency: 'EUR', originalAmount: 0,
      },
      lines: journal.lines.map((l) => ({
        accountCode: l.accountCode,
        accountName: accountName(l.accountCode),
        amount: l.amount,
        description: `Year-end close ${year}`,
      })),
      confidence: 1,
      citation: null,
      rationale: `Closing journal for financial year ${year}: P&L taken to retained earnings.`,
      docName: null,
      createdAt: now,
      postedAt: now,
      postedBy: actor,
    };
    insertDraft(draft);
    closingDraftId = draft.id;
  }

  for (const m of financialYearMonths(year)) lockPeriod(m);
  appendAudit({
    action: 'YEAR_CLOSE',
    entity: 'year',
    entityId: String(year),
    actor,
    summary: `Closed financial year ${year} — net ${journal.netResult >= 0 ? 'profit' : 'loss'} ${Math.abs(journal.netResult)} to retained earnings`,
    after: { netResult: journal.netResult, closingDraftId },
  });
  return { year, netResult: journal.netResult, closingDraftId, locked: listLockedPeriods() };
}

/**
 * Reopen a closed financial year: unlock its twelve months and REVERSE the closing
 * journal (an audited equal-and-opposite entry; the original is never deleted), so the
 * year's P&L is restored and retained earnings unwound. Throws if the year isn't closed.
 */
export function reopenYear(year: number, actor = 'system'): { year: number; reversedIds: string[]; locked: string[] } {
  const months = financialYearMonths(year);
  if (!months.some((m) => isPeriodLocked(m))) {
    throw new Error(`Financial year ${year} is not closed.`);
  }
  for (const m of months) unlockPeriod(m); // unlock first so the reversal can post
  const closes = listDrafts('POSTED').filter(
    (d) => d.eventType === 'YEAR_CLOSE' && d.period === `${year}-12` && !d.reversedByDraftId,
  );
  const reversedIds: string[] = [];
  for (const d of closes) reversedIds.push(reverseDraft(d.id, `Reopened financial year ${year}`, actor).id);
  appendAudit({
    action: 'YEAR_REOPEN',
    entity: 'year',
    entityId: String(year),
    actor,
    summary: `Reopened financial year ${year}`,
    after: { reversedIds },
  });
  return { year, reversedIds, locked: listLockedPeriods() };
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
