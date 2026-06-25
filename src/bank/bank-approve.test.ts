// "Approve all high-confidence" only posts AUTO lines categorised to a real account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHighConfidenceBankTxn } from './bank-store';

const t = (over: Record<string, unknown>) => ({ status: 'AUTO', postToCode: '6100', dateFlag: null, ...over }) as any;

test('high-confidence: AUTO + a real account code', () => {
  assert.equal(isHighConfidenceBankTxn(t({})), true);
  assert.equal(isHighConfidenceBankTxn(t({ postToCode: '1010' })), true);
});

test('NOT high-confidence: review, suspense (9999), unset, date-flagged, or already posted', () => {
  assert.equal(isHighConfidenceBankTxn(t({ status: 'REVIEW' })), false);
  assert.equal(isHighConfidenceBankTxn(t({ postToCode: '9999' })), false);
  assert.equal(isHighConfidenceBankTxn(t({ postToCode: '' })), false);
  assert.equal(isHighConfidenceBankTxn(t({ postToCode: null })), false);
  assert.equal(isHighConfidenceBankTxn(t({ dateFlag: { raw: '2021-09-31', reason: 'x', suggestion: null } })), false);
  assert.equal(isHighConfidenceBankTxn(t({ status: 'POSTED' })), false);
});
