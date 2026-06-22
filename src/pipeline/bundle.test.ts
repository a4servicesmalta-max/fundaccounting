// A single uploaded PDF can bundle several different documents (a bank statement,
// an invoice, an SPA scanned into one file). validateBundleSegments is the safety
// gate that decides whether a file is really a bundle worth splitting — it must
// never over-split a single document into garbage page ranges.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBundleSegments } from './bundle';

test('two valid non-overlapping segments are accepted and sorted', () => {
  const segs = validateBundleSegments(
    [
      { category: 'invoice', title: 'INV-1', pageStart: 4, pageEnd: 5 },
      { category: 'bank_statement', title: 'Santander', pageStart: 1, pageEnd: 3 },
    ],
    5,
  );
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map((s) => [s.pageStart, s.pageEnd]), [[1, 3], [4, 5]]);
});

test('a single segment is NOT a bundle (returns empty — process whole)', () => {
  assert.equal(validateBundleSegments([{ category: 'spa', title: 'SPA', pageStart: 1, pageEnd: 8 }], 8).length, 0);
});

test('overlapping segments are dropped; if fewer than 2 remain it is not a bundle', () => {
  const segs = validateBundleSegments(
    [
      { category: 'a', title: 'A', pageStart: 1, pageEnd: 4 },
      { category: 'b', title: 'B', pageStart: 3, pageEnd: 6 }, // overlaps 1-4
    ],
    6,
  );
  assert.equal(segs.length, 0);
});

test('out-of-bounds or inverted page ranges are rejected', () => {
  const segs = validateBundleSegments(
    [
      { category: 'a', title: 'A', pageStart: 1, pageEnd: 2 },
      { category: 'b', title: 'B', pageStart: 3, pageEnd: 99 }, // beyond pageCount
      { category: 'c', title: 'C', pageStart: 6, pageEnd: 4 }, // inverted
    ],
    4,
  );
  // only page 1-2 is valid -> fewer than 2 -> not a bundle
  assert.equal(segs.length, 0);
});

test('three clean segments across the page count are all kept', () => {
  const segs = validateBundleSegments(
    [
      { category: 'bank_statement', title: 'BS', pageStart: 1, pageEnd: 1 },
      { category: 'invoice', title: 'INV', pageStart: 2, pageEnd: 2 },
      { category: 'agreement', title: 'SPA', pageStart: 3, pageEnd: 3 },
    ],
    3,
  );
  assert.equal(segs.length, 3);
});

test('garbage / empty input is not a bundle', () => {
  assert.equal(validateBundleSegments([], 5).length, 0);
  assert.equal(validateBundleSegments(undefined, 5).length, 0);
});
