import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrialBalanceCsv, parseAmount } from './opening';

test('parses a headered debit/credit trial balance that balances', () => {
  const csv = [
    'Code,Account,Debit,Credit',
    '1010,Bank,10000,',
    '030,Investments,5000,',
    '2300,Loan payable,,3000',
    '3000,Share capital,,12000',
  ].join('\n');
  const r = parseTrialBalanceCsv(csv);
  assert.equal(r.rows.length, 4);
  assert.equal(r.totals.debit, 15000);
  assert.equal(r.totals.credit, 15000);
  assert.equal(r.balanced, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.rows[0].accountCode, '1010');
  assert.equal(r.rows[0].debit, 10000);
});

test('detects an out-of-balance trial balance', () => {
  const csv = 'Code,Name,Debit,Credit\n1010,Bank,10000,\n3000,Capital,,9000';
  const r = parseTrialBalanceCsv(csv);
  assert.equal(r.balanced, false);
  assert.equal(r.difference, 1000);
});

test('supports a single signed balance column', () => {
  const csv = 'Account code,Account name,Balance\n1010,Bank,10000\n3000,Share capital,-10000';
  const r = parseTrialBalanceCsv(csv);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].debit, 10000);
  assert.equal(r.rows[0].credit, 0);
  assert.equal(r.rows[1].debit, 0);
  assert.equal(r.rows[1].credit, 10000);
  assert.equal(r.balanced, true);
});

test('handles currency symbols, thousands separators and parentheses', () => {
  assert.equal(parseAmount('€1,234.50'), 1234.5);
  assert.equal(parseAmount('(2,000)'), -2000);
  assert.equal(parseAmount('1.234,56'), 1234.56); // european decimal comma
  assert.equal(parseAmount(''), 0);
  assert.ok(Number.isNaN(parseAmount('abc')));

  const csv = 'Code,Name,Debit,Credit\n1010,Bank,"€10,000.00",\n3000,Capital,,"€10,000.00"';
  const r = parseTrialBalanceCsv(csv);
  assert.equal(r.totals.debit, 10000);
  assert.equal(r.balanced, true);
});

test('skips blank lines and a totals row, flags rows missing a code', () => {
  const csv = [
    'Code,Name,Debit,Credit',
    '1010,Bank,10000,',
    '',
    ',Orphan line,500,', // no code -> error, skipped
    '3000,Capital,,10000',
    'Total,,10000,10000', // totals row -> ignored
  ].join('\n');
  const r = parseTrialBalanceCsv(csv);
  assert.equal(r.rows.length, 2);
  assert.equal(r.totals.debit, 10000);
  assert.equal(r.balanced, true);
  assert.equal(r.errors.length, 1);
});

test('works with no header row (positional columns)', () => {
  const csv = '1010,Bank,10000,\n3000,Capital,,10000';
  const r = parseTrialBalanceCsv(csv);
  assert.equal(r.rows.length, 2);
  assert.equal(r.balanced, true);
});

test('empty input is reported, not crashed', () => {
  const r = parseTrialBalanceCsv('   ');
  assert.equal(r.rows.length, 0);
  assert.equal(r.balanced, false);
  assert.ok(r.errors.length >= 1);
});
