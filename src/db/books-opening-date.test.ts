// Period-aware intake: the books opening date marks the cut-off below which a
// document is prior-period (already in the brought-forward opening balance) and
// must NOT be re-booked. This tests the resolution logic deterministically.
//
// Self-isolating: fresh temp DB before importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(
  os.tmpdir(),
  `thcp-opendate-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
);

import {
  getBooksOpeningDate, setBooksOpeningDate, setOpeningBalance, clearOpeningBalance, getDb, persist,
} from './store';

function resetSettings(): void {
  const db = getDb();
  db.settings = { currentPeriod: null, lockedPeriods: [] };
  clearOpeningBalance();
  persist();
}

test('explicit booksOpeningDate is returned as-is', () => {
  resetSettings();
  setBooksOpeningDate('2021-12-31');
  assert.equal(getBooksOpeningDate(), '2021-12-31');
});

test('an invalid explicit date is rejected (stored as null)', () => {
  resetSettings();
  setBooksOpeningDate('2021-13-99');
  assert.equal(getBooksOpeningDate(), null);
});

test('with no explicit date, derives the day before the opening period', () => {
  resetSettings();
  setOpeningBalance({ period: '2022-01', importedAt: new Date('2022-01-01').toISOString(), lines: [] });
  // First open period 2022-01 → opening balances are as-at 2021-12-31.
  assert.equal(getBooksOpeningDate(), '2021-12-31');
});

test('derivation handles mid-year opening periods', () => {
  resetSettings();
  setOpeningBalance({ period: '2023-07', importedAt: new Date('2023-07-01').toISOString(), lines: [] });
  assert.equal(getBooksOpeningDate(), '2023-06-30');
});

test('explicit date wins over the derivable opening period', () => {
  resetSettings();
  setOpeningBalance({ period: '2025-04', importedAt: new Date('2025-04-01').toISOString(), lines: [] });
  setBooksOpeningDate('2021-12-31');
  assert.equal(getBooksOpeningDate(), '2021-12-31');
});

test('no opening balance and no explicit date → null (no cut-off, nothing filtered)', () => {
  resetSettings();
  assert.equal(getBooksOpeningDate(), null);
});

test('the cut-off comparison classifies dates correctly', () => {
  resetSettings();
  setBooksOpeningDate('2021-12-31');
  const cut = getBooksOpeningDate()!;
  // On/before the cut-off = prior-period; after = current-period.
  assert.ok('2021-04-23' <= cut, 'a 2021 SPA is prior-period');
  assert.ok('2021-12-31' <= cut, 'the cut-off date itself is prior-period');
  assert.ok(!('2022-01-05' <= cut), 'an early-2022 entry is current-period');
});
