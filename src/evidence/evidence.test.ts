// Evidence collector: every entry/transaction/invoice in a period contributes its
// source document to the evidence pack (deduped), and entries with no document are
// surfaced as gaps. Period filter accepts a month or a whole year.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-evi-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist, insertDocument, insertDraft, type DraftRecord, type DocumentRecord } from '../db/store';
import { insertItem } from '../arap/arap-store';
import { collectEvidenceForPeriod, evidenceIndexForPeriod, evidenceManifestCsv } from './evidence';

function reset(): void {
  const db = getDb();
  db.drafts.length = 0;
  db.documents.length = 0;
  db.arapItems.length = 0;
  persist();
}

function doc(id: string, fileName: string, classification: DocumentRecord['classification'], createdAt = '2025-03-01T00:00:00Z'): void {
  insertDocument({ id, fileName, folderPath: '', mime: 'application/pdf', storedPath: `data/uploads/${id}.pdf`, classification, note: null, createdAt } as DocumentRecord);
}

function postedDraft(id: string, documentId: string | null, period: string): void {
  insertDraft({
    id, documentId, investeeName: 'Gamivo', instrument: 'SHARES', eventType: 'ACQUISITION', controlCode: '030-gamivo',
    currency: 'EUR', txnDate: `${period}-10`, period, status: 'POSTED',
    sourceFigures: { amount: 5000, quantity: null, fairValue: null, currency: 'EUR' },
    engineFigures: { functionalAmount: 5000, currency: 'EUR', lineCount: 2, fxRate: null, fxRateDate: null, originalCurrency: 'EUR', originalAmount: 5000 },
    lines: [{ accountCode: '030-gamivo', accountName: 'inv', amount: 5000, description: '' }, { accountCode: '1010', accountName: 'Bank', amount: -5000, description: '' }],
    confidence: 1, citation: null, rationale: null, docName: null, createdAt: '2025-03-10T00:00:00Z', postedAt: '2025-03-10T00:00:00Z',
  } as DraftRecord);
}

test('collects linked documents for the period and dedupes', () => {
  reset();
  doc('d1', 'spa-gamivo.pdf', 'EVENT');
  doc('d2', 'invoice-usd.pdf', 'ARAP');
  doc('d3', 'old-2024.pdf', 'EVENT', '2024-11-01T00:00:00Z');
  postedDraft('acq1', 'd1', '2025-03');
  postedDraft('acq2', 'd1', '2025-03'); // same doc -> deduped
  postedDraft('acq3', 'd3', '2024-11'); // different period -> excluded for 2025-03
  insertItem({ documentId: 'd2', kind: 'RECEIVABLE', counterparty: 'Borealis', amount: 10000, currency: 'USD', issueDate: '2025-03-05', dueDate: '2025-04-05', status: 'OPEN' });

  const items = collectEvidenceForPeriod('2025-03');
  const ids = items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['d1', 'd2']); // d1 once (deduped), d2; d3 is in 2024
  // A whole-year filter picks up the 2024 doc too.
  assert.deepEqual(collectEvidenceForPeriod('2024').map((i) => i.id), ['d3']);
});

test('surfaces entries that are MISSING a document', () => {
  reset();
  doc('d1', 'spa.pdf', 'EVENT');
  postedDraft('withdoc', 'd1', '2025-03');
  postedDraft('nodoc', null, '2025-03'); // no evidence linked
  const idx = evidenceIndexForPeriod('2025-03');
  assert.equal(idx.entriesTotal, 2);
  assert.equal(idx.entriesWithEvidence, 1);
  assert.equal(idx.entriesMissingEvidence, 1);
  assert.equal(idx.missing[0].ref, 'nodoc');
});

test('manifest lists each file and what it supports', () => {
  reset();
  doc('d1', 'spa, gamivo.pdf', 'EVENT'); // comma forces CSV quoting
  postedDraft('acq1', 'd1', '2025-03');
  const csv = evidenceManifestCsv(collectEvidenceForPeriod('2025-03'));
  assert.match(csv.split('\n')[0], /^File,Type,Period,Evidence for$/);
  assert.match(csv, /"spa, gamivo\.pdf"/); // quoted because it has a comma
  assert.match(csv, /ACQUISITION 030-gamivo/);
});
