// Regression: an empty file and a non-accounting note (a shopping list) each
// produced a PENDING draft "journal" — the AI correctly said there was nothing to
// book (rationale: "the source file is empty" / "a personal shopping list") and
// returned a €0 entry with two zero lines to suspense, but the pipeline queued it
// for approval anyway. A degenerate suggestion (no real amount, or entirely in the
// 9999 suspense account) must be filed as UNKNOWN, never queued as a journal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDegenerateSuggestion } from './process';

test('a zero-amount suggestion (empty file / shopping list) is degenerate', () => {
  assert.equal(isDegenerateSuggestion([{ accountCode: '9999', amount: 0 }, { accountCode: '9999', amount: 0 }], 0), true);
});

test('an all-suspense suggestion books nothing real and is degenerate', () => {
  assert.equal(isDegenerateSuggestion([{ accountCode: '9999', amount: 5000 }, { accountCode: '9999', amount: -5000 }], 5000), true);
});

test('an empty line set is degenerate', () => {
  assert.equal(isDegenerateSuggestion([], 0), true);
});

test('a real balanced entry is NOT degenerate', () => {
  assert.equal(isDegenerateSuggestion([{ accountCode: '1010', amount: 5000 }, { accountCode: '4000', amount: -5000 }], 5000), false);
});
