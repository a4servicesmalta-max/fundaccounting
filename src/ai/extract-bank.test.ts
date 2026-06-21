import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBankStatement,
  buildBankPrompt,
  type StructuredCaller,
  type ExtractBankInput,
} from './extract-bank';

const input: ExtractBankInput = {
  fileName: 'jan-statement.pdf',
  content: { kind: 'text', text: 'Opening 1000.00\n02/01 Salary +2000\n05/01 Rent -800\nClosing 2200.00' },
};

const validJson = JSON.stringify({
  bankName: 'Bank of Valletta',
  accountRef: 'MT84BVAL000000000',
  currency: 'EUR',
  periodStart: '2025-01-01',
  periodEnd: '2025-01-31',
  openingBalance: 1000,
  closingBalance: 2200,
  transactions: [
    { date: '2025-01-02', description: 'Salary', amount: 2000, balance: 3000 },
    { date: '2025-01-05', description: 'Rent', amount: -800, balance: 2200 },
  ],
});

test('single-statement response is accepted and wrapped into statements[] (signed amounts preserved)', async () => {
  const call: StructuredCaller = async () => ({ text: validJson, modelUsed: 'claude-opus-4-8' });
  const res = await extractBankStatement(input, { call });
  assert.equal(res.ok, true);
  assert.ok(res.statements);
  assert.equal(res.statements!.length, 1);
  assert.equal(res.statements![0].bankName, 'Bank of Valletta');
  assert.equal(res.statements![0].openingBalance, 1000);
  assert.equal(res.statements![0].closingBalance, 2200);
  assert.equal(res.statements![0].transactions.length, 2);
  assert.equal(res.statements![0].transactions[0].amount, 2000); // money in positive
  assert.equal(res.statements![0].transactions[1].amount, -800); // money out negative
  assert.equal(res.modelUsed, 'claude-opus-4-8');
});

test('multi-account response → one entry per account', async () => {
  const multi = JSON.stringify({
    statements: [
      { bankName: 'Santander', accountRef: 'PL-EUR-1', currency: 'EUR', periodStart: '2021-01-01', periodEnd: '2021-12-31', openingBalance: 0, closingBalance: 25, transactions: [{ date: '2021-06-01', description: 'Inflow', amount: 25, balance: 25 }] },
      { bankName: 'Santander', accountRef: 'PL-PLN-1', currency: 'PLN', periodStart: '2021-01-01', periodEnd: '2021-12-31', openingBalance: 100, closingBalance: 130, transactions: [{ date: '2021-06-01', description: 'Wpłata', amount: 30, balance: 130 }] },
    ],
  });
  const call: StructuredCaller = async () => ({ text: multi });
  const res = await extractBankStatement(input, { call });
  assert.equal(res.ok, true);
  assert.equal(res.statements!.length, 2);
  assert.equal(res.statements![0].currency, 'EUR');
  assert.equal(res.statements![1].currency, 'PLN');
});

test('valid response wrapped in ```json fences still parses', async () => {
  const call: StructuredCaller = async () => ({ text: '```json\n' + validJson + '\n```' });
  const res = await extractBankStatement(input, { call });
  assert.equal(res.ok, true);
  assert.equal(res.statements![0].accountRef, 'MT84BVAL000000000');
});

test('malformed (non-JSON) response → { ok:false }', async () => {
  const call: StructuredCaller = async () => ({ text: 'I could not read this statement.' });
  const res = await extractBankStatement(input, { call });
  assert.equal(res.ok, false);
  assert.equal(res.statements, undefined);
  assert.ok(res.error);
});

test('schema-invalid JSON (missing required fields) → { ok:false }', async () => {
  const call: StructuredCaller = async () => ({ text: JSON.stringify({ bankName: 'X' }) });
  const res = await extractBankStatement(input, { call });
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('empty model text → { ok:false }', async () => {
  const call: StructuredCaller = async () => ({ text: '' });
  const res = await extractBankStatement(input, { call });
  assert.equal(res.ok, false);
});

test('never throws — caller error becomes { ok:false }', async () => {
  const call: StructuredCaller = async () => {
    throw new Error('network down');
  };
  const res = await extractBankStatement(input, { call });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'network down');
});

test('request carries the built system+user prompt and content', async () => {
  const box: { v: { system: string; user: string; content: unknown } | null } = { v: null };
  const call: StructuredCaller = async (args) => {
    box.v = args;
    return { text: validJson };
  };
  await extractBankStatement(input, { call });
  const built = buildBankPrompt(input);
  const captured = box.v;
  assert.ok(captured);
  assert.equal(captured.system, built.system);
  assert.equal(captured.user, built.user);
  assert.deepEqual(captured.content, input.content);
  // prompt instructs transcribe-only + signed amounts (never compute)
  assert.match(captured.system, /Transcribe ONLY/);
  assert.match(captured.system, /POSITIVE/);
  assert.match(captured.system, /NEGATIVE/);
  assert.match(captured.user, /jan-statement\.pdf/);
});
