// The deterministic sheet-answerer matches each question row to the gathered evidence
// and appends a reference + file name(s) + status; unmatched rows are flagged for
// review. Round-trips through xlsx and parses csv.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetBufferToRows, rowsToXlsxBuffer, answerSheetRows, ANSWER_HEADERS } from './answer-sheet';
import type { EvidenceItem } from '../evidence/evidence';

const evidence: EvidenceItem[] = [
  { kind: 'document', id: 'd1', fileName: 'SPA-gamivo.pdf', storedPath: 'x', classification: 'EVENT', linkedTo: 'ACQUISITION 030-gamivo 2025-03-10 €5000', period: '2025-03' },
  { kind: 'document', id: 'd2', fileName: 'loan-ormco.pdf', storedPath: 'x', classification: 'EVENT', linkedTo: 'LOAN_ADVANCE 032-ormco 2025-04 £50000', period: '2025-04' },
];

const last = (row: string[]) => row[row.length - 1];

test('answers matched rows, flags the rest, appends answer headers', () => {
  const rows = [
    ['#', 'Item requested'],
    ['1', 'Share purchase agreement for Gamivo'],
    ['2', 'Loan agreement for Ormco'],
    ['3', 'Board minutes for the dividend'],
  ];
  const r = answerSheetRows(rows, evidence);
  assert.deepEqual(r.rows[0], ['#', 'Item requested', ...ANSWER_HEADERS]);
  assert.equal(last(r.rows[1]), 'Provided');
  assert.match(r.rows[1].join(' '), /SPA-gamivo\.pdf/);
  assert.equal(last(r.rows[2]), 'Provided');
  assert.match(r.rows[2].join(' '), /loan-ormco\.pdf/);
  assert.match(last(r.rows[3]), /needs review/i);
  assert.equal(r.answered, 2);
  assert.equal(r.needsReview, 1);
});

test('blank rows pass through unchanged', () => {
  const rows = [['Item'], [''], ['Gamivo SPA']];
  const r = answerSheetRows(rows, evidence);
  assert.deepEqual(r.rows[1], ['']); // blank untouched
  assert.equal(last(r.rows[2]), 'Provided');
});

test('round-trips through an xlsx buffer', () => {
  const out = answerSheetRows([['Item'], ['Gamivo SPA']], evidence);
  const back = sheetBufferToRows(rowsToXlsxBuffer(out.rows));
  assert.match(back[0].join(','), /Evidence reference/);
  assert.equal(last(back[1]), 'Provided');
});

test('parses a CSV buffer into rows', () => {
  const rows = sheetBufferToRows(Buffer.from('Item\nGamivo SPA\nUnknown thing\n'));
  assert.deepEqual(rows[0], ['Item']);
  assert.equal(rows.length, 3);
});
