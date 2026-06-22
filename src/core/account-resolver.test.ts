// The suggested-journal and bank-posting paths used to ensureAccount() any code
// the AI proposed — minting arbitrary new chart accounts (e.g. a mangled
// "240-plm-fund-sp-ka-z-ograniczon-odpowiedzialno-ci" receivable) that polluted
// the trial balance. Postings must resolve into the STANDARD chart instead, only
// ever keeping the deliberate per-investee investment/loan sub-accounts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToStandardAccount, matchStandardByName } from './account-resolver';

test('a known standard code is used as-is', () => {
  assert.equal(resolveToStandardAccount('6100', 'whatever').code, '6100');
  assert.equal(resolveToStandardAccount('1010', 'Bank').code, '1010');
});

test('an unknown code maps to the closest standard account by name', () => {
  assert.equal(resolveToStandardAccount('7777', 'Legal and professional fees').code, '6100');
  assert.equal(resolveToStandardAccount('8100', 'Office supplies').code, '6200');
  assert.equal(resolveToStandardAccount('9100', 'Loan interest income').code, '510');
  assert.equal(resolveToStandardAccount('4500', 'Dividend received').code, '4000');
});

test('a mangled receivable account maps to standard Accounts receivable (1100)', () => {
  assert.equal(resolveToStandardAccount('240-plm-fund-sp-ka', 'Receivable — PLM Fund').code, '1100');
});

test('a per-investee investment/loan sub-account is KEPT (deliberate fund sub-ledger)', () => {
  assert.equal(resolveToStandardAccount('030-gamivo', 'Gamivo S.A.').code, '030-gamivo');
  assert.equal(resolveToStandardAccount('032-climax', 'Climax Sp. z o.o.').code, '032-climax');
});

test('an unmappable account falls to 9999 suspense, never a new code', () => {
  assert.equal(resolveToStandardAccount('7200', 'Some bespoke thing the model invented').code, '9999');
  assert.equal(resolveToStandardAccount('', '').code, '9999');
});

test('matchStandardByName covers the common categories', () => {
  assert.equal(matchStandardByName('rent')?.code, '6000');
  assert.equal(matchStandardByName('bank charges')?.code, '6300');
  assert.equal(matchStandardByName('salaries and wages')?.code, '6500');
  assert.equal(matchStandardByName('accounts payable')?.code, '2010');
  assert.equal(matchStandardByName('foreign exchange loss')?.code, '6800');
  assert.equal(matchStandardByName('nonsense xyz'), undefined);
});
