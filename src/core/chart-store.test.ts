import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
// Self-isolate the store so running this file directly never touches real data.
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-chartstore-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
import { ensureAccount, inferAccountType, listFullChart } from './chart-store';
import { accountName, isKnownAccount } from './chart';

test('inferAccountType maps the leading digit to a type', () => {
  assert.equal(inferAccountType('1010'), 'ASSET');
  assert.equal(inferAccountType('2300'), 'LIABILITY');
  assert.equal(inferAccountType('3000'), 'EQUITY');
  assert.equal(inferAccountType('4000'), 'REVENUE');
  assert.equal(inferAccountType('6600'), 'EXPENSE');
});

test('ensureAccount creates an unknown account and names it everywhere', () => {
  assert.equal(isKnownAccount('6600'), false);
  const a = ensureAccount('6600', 'Marketing & advertising');
  assert.equal(a.code, '6600');
  assert.equal(a.name, 'Marketing & advertising');
  assert.equal(a.type, 'EXPENSE');
  assert.equal(isKnownAccount('6600'), true);
  assert.equal(accountName('6600'), 'Marketing & advertising');
  assert.ok(listFullChart().some((x) => x.code === '6600'));
});

test('ensureAccount is idempotent and never duplicates a built-in', () => {
  const before = listFullChart().length;
  const a = ensureAccount('1010'); // already built-in (Bank)
  assert.equal(a.name, 'Bank');
  assert.equal(listFullChart().length, before);
});

test('a code with no name falls back to the code itself', () => {
  const a = ensureAccount('7777');
  assert.equal(a.name, '7777');
});

test('inferAccountType: balance-sheet codes never default to EXPENSE (P&L hygiene)', () => {
  assert.equal(inferAccountType('030-gamivo'), 'ASSET');   // investment control
  assert.equal(inferAccountType('032-rv'), 'ASSET');        // loan control
  assert.equal(inferAccountType('032-1-thcp'), 'ASSET');    // accrued interest
  assert.equal(inferAccountType('801'), 'EQUITY');          // share capital
  assert.equal(inferAccountType('802'), 'EQUITY');          // supplementary capital
  assert.equal(inferAccountType('860'), 'EQUITY');          // accumulated P&L b/f
  assert.equal(inferAccountType('501'), 'LIABILITY');       // accruals
  assert.equal(inferAccountType('6300'), 'EXPENSE');        // genuine expense unchanged
  assert.equal(inferAccountType('SENTRYC'), 'ASSET');       // no digit → balance sheet, not expense
});
