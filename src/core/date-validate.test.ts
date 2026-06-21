import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDate } from './date-validate';

test('checkDate — trap T2 impossible dates', async (t) => {
  await t.test('flags 2021-09-31 (September has 30 days) and suggests 30-Sep', () => {
    const r = checkDate('2021-09-31');
    assert.equal(r.ok, false);
    assert.equal(r.impossible, true);
    assert.equal(r.suggestion, '2021-09-30');
  });

  await t.test('flags 2021-02-30 and suggests 28-Feb (non-leap)', () => {
    const r = checkDate('2021-02-30');
    assert.equal(r.impossible, true);
    assert.equal(r.suggestion, '2021-02-28');
  });

  await t.test('accepts a leap day in a leap year', () => {
    assert.equal(checkDate('2020-02-29').ok, true);
  });

  await t.test('flags 2021-02-29 (not a leap year) → 28', () => {
    const r = checkDate('2021-02-29');
    assert.equal(r.impossible, true);
    assert.equal(r.suggestion, '2021-02-28');
  });

  await t.test('accepts ordinary valid dates', () => {
    assert.equal(checkDate('2021-09-30').ok, true);
    assert.equal(checkDate('2021-12-31').ok, true);
  });

  await t.test('flags month 13', () => {
    assert.equal(checkDate('2021-13-01').impossible, true);
  });

  await t.test('non-ISO input is not-ok but not flagged impossible', () => {
    assert.equal(checkDate('14 June 2021').ok, false);
    assert.equal(checkDate('14 June 2021').impossible, false);
    assert.equal(checkDate('').ok, false);
  });
});
