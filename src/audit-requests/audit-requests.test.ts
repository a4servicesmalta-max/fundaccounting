// Audit requests: store CRUD, term extraction from the email/attachments, and the
// deterministic evidence gather (match the index by entity/year/keyword; everything in
// scope when the request names nothing specific).
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-ar-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist, insertDocument, insertDraft, type DraftRecord, type DocumentRecord } from '../db/store';
import { insertAuditRequest, listAuditRequests, getAuditRequest, extractTerms, gatherEvidenceForRequest, isSheetName } from './audit-requests';

function reset(): void {
  const db = getDb();
  db.drafts.length = 0;
  db.documents.length = 0;
  db.auditRequests = [];
  persist();
}

function doc(id: string, fileName: string): void {
  insertDocument({ id, fileName, folderPath: '', mime: 'application/pdf', storedPath: `data/uploads/${id}.pdf`, classification: 'EVENT', note: null, createdAt: '2025-03-01T00:00:00Z' } as DocumentRecord);
}
function draftFor(id: string, documentId: string, investee: string, control: string): void {
  insertDraft({
    id, documentId, investeeName: investee, instrument: 'SHARES', eventType: 'ACQUISITION', controlCode: control,
    currency: 'EUR', txnDate: '2025-03-10', period: '2025-03', status: 'POSTED',
    sourceFigures: { amount: 5000, quantity: null, fairValue: null, currency: 'EUR' },
    engineFigures: { functionalAmount: 5000, currency: 'EUR', lineCount: 2, fxRate: null, fxRateDate: null, originalCurrency: 'EUR', originalAmount: 5000 },
    lines: [{ accountCode: control, accountName: 'inv', amount: 5000, description: '' }, { accountCode: '1010', accountName: 'Bank', amount: -5000, description: '' }],
    confidence: 1, citation: null, rationale: null, docName: null, createdAt: '2025-03-10T00:00:00Z', postedAt: '2025-03-10T00:00:00Z',
  } as DraftRecord);
}

test('isSheetName recognises spreadsheets', () => {
  assert.equal(isSheetName('PBC list.xlsx'), true);
  assert.equal(isSheetName('data.csv'), true);
  assert.equal(isSheetName('contract.pdf'), false);
});

test('CRUD: create, list (newest first), get', () => {
  reset();
  const a = insertAuditRequest({ title: 'Q1 PBC', emailText: 'Please provide evidence for Gamivo.' });
  const b = insertAuditRequest({ title: 'Loans', emailText: 'All loan agreements.' });
  const list = listAuditRequests();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.id); // newest first
  assert.equal(getAuditRequest(a.id)!.title, 'Q1 PBC');
  assert.equal(getAuditRequest('nope'), null);
});

test('extractTerms keeps entities/years, drops stopwords', () => {
  const terms = extractTerms({ emailText: 'Please provide all supporting evidence for Gamivo in 2025.', attachments: [{ id: 'x', fileName: 'Borealis-confirmation.pdf', storedPath: null, mime: '', isSheet: false }] });
  assert.ok(terms.includes('gamivo'));
  assert.ok(terms.includes('2025'));
  assert.ok(terms.includes('borealis-confirmation') || terms.includes('borealis'));
  assert.ok(!terms.includes('please') && !terms.includes('evidence') && !terms.includes('all'));
});

test('gather filters the evidence index by the request terms; no terms = everything', () => {
  reset();
  doc('d1', 'SPA-gamivo.pdf'); draftFor('acq1', 'd1', 'Gamivo', '030-gamivo');
  doc('d2', 'SPA-borealis.pdf'); draftFor('acq2', 'd2', 'Borealis', '030-borealis');

  // Request names Gamivo only -> just that evidence.
  const g = insertAuditRequest({ title: 'r', emailText: 'Evidence for Gamivo please.' });
  const got = gatherEvidenceForRequest(g).map((e) => e.id).sort();
  assert.deepEqual(got, ['d1']);

  // A request with no specific terms -> the whole in-scope evidence set.
  const all = insertAuditRequest({ title: 'r2', emailText: 'Please send everything.' });
  assert.deepEqual(gatherEvidenceForRequest(all).map((e) => e.id).sort(), ['d1', 'd2']);
});
