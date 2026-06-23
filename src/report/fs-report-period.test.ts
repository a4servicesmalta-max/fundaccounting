// Regression: the FS report header ("Annual Report and Financial Statements · YYYY")
// and the income-statement period label took the year from new Date() whenever no
// explicit period was passed (the default cumulative "to date" view). So a book whose
// posted data is entirely FY2025 rendered statements headed 2026 simply because that
// was the wall-clock year — a financial statement dated to "now" instead of its
// reporting period is materially misleading. The reporting period must derive from the
// BOOKS: the latest posted period, else the books opening date, else (empty book) today.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveReportingPeriod } from './fs-report';

test('explicit period drives the year and label', () => {
  const r = deriveReportingPeriod('2025-03', '2025-06', '2025-01-01');
  assert.equal(r.year, '2025');
  assert.match(r.label, /March 2025/);
});

test('no explicit period: derive from the latest posted period, NOT the wall clock', () => {
  const r = deriveReportingPeriod(undefined, '2025-03', '2025-03-01');
  assert.equal(r.year, '2025'); // must be the books' year, never the current year
  assert.match(r.label, /March 2025/);
});

test('no explicit period and no postings: fall back to the books opening date year', () => {
  const r = deriveReportingPeriod(undefined, null, '2024-12-31');
  assert.equal(r.year, '2024');
});

test('empty book (nothing posted, no opening date): falls back to a 4-digit year', () => {
  const r = deriveReportingPeriod(undefined, null, null);
  assert.match(r.year, /^\d{4}$/);
});

test('latest posted period wins over an earlier opening date', () => {
  const r = deriveReportingPeriod(undefined, '2025-12', '2025-01-01');
  assert.equal(r.year, '2025');
  assert.match(r.label, /December 2025/);
});
