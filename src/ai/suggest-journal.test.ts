import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestJournal,
  buildSuggestJournalPrompt,
  type StructuredCaller,
  type SuggestJournalInput,
} from './suggest-journal';

const input: SuggestJournalInput = {
  fileName: 'share-purchase-agreement.pdf',
  content: { kind: 'text', text: 'Share purchase agreement: the Fund acquires 5,000 EUR of shares in NewCo.' },
  chart: [
    { code: '030', name: 'Investments in shares' },
    { code: '032', name: 'Loans granted' },
    { code: '1010', name: 'Bank' },
  ],
};

const sharePurchaseJson = JSON.stringify({
  description: 'Share purchase agreement — Fund acquires shares in NewCo',
  date: '2026-03-15',
  currency: 'EUR',
  lines: [
    { accountCode: '030', accountName: 'Investments', amount: 5000 },
    { accountCode: '1010', accountName: 'Bank', amount: -5000 },
  ],
  confidence: 0.8,
  rationale: 'Dr investment, Cr bank for the cash paid.',
});

test('share-purchase JSON → ok, 2 lines, signed amounts preserved', async () => {
  const call: StructuredCaller = async () => ({ text: sharePurchaseJson, modelUsed: 'claude-opus-4-8' });
  const res = await suggestJournal(input, { call });
  assert.equal(res.ok, true);
  assert.ok(res.suggestion);
  assert.equal(res.suggestion!.lines.length, 2);
  assert.equal(res.suggestion!.currency, 'EUR');
  assert.equal(res.suggestion!.lines[0].accountCode, '030');
  assert.equal(res.suggestion!.lines[0].amount, 5000);
  assert.equal(res.suggestion!.lines[1].accountCode, '1010');
  assert.equal(res.suggestion!.lines[1].amount, -5000);
  // balanced: signed amounts sum to zero
  assert.equal(res.suggestion!.lines.reduce((s, l) => s + l.amount, 0), 0);
  assert.equal(res.suggestion!.confidence, 0.8);
  assert.equal(res.modelUsed, 'claude-opus-4-8');
});

test('missing rationale/description/accountName still parse (defaults)', async () => {
  const json = JSON.stringify({
    currency: 'USD',
    lines: [
      { accountCode: '030', amount: 1200 },
      { accountCode: '1010', amount: -1200 },
    ],
  });
  const call: StructuredCaller = async () => ({ text: json });
  const res = await suggestJournal(input, { call });
  assert.equal(res.ok, true);
  assert.equal(res.suggestion!.description, '');
  assert.equal(res.suggestion!.rationale, '');
  assert.equal(res.suggestion!.date, '');
  assert.equal(res.suggestion!.confidence, 0.5);
  assert.equal(res.suggestion!.lines[0].accountName, '');
  assert.equal(res.suggestion!.lines[0].accountCode, '030');
});

test('new-account suggestion (code not in chart) parses with its name', async () => {
  const json = JSON.stringify({
    description: 'Loan agreement — Fund grants a loan to PortfolioCo',
    date: '2026-04-01',
    currency: 'GBP',
    lines: [
      { accountCode: '032', accountName: 'Loans granted', amount: 10000 },
      { accountCode: '1015', accountName: 'GBP bank account', amount: -10000 },
    ],
    confidence: 0.7,
    rationale: 'Proposed a new 1xxx bank sub-account not present in the chart.',
  });
  const call: StructuredCaller = async () => ({ text: json });
  const res = await suggestJournal(input, { call });
  assert.equal(res.ok, true);
  assert.equal(res.suggestion!.lines[1].accountCode, '1015');
  assert.equal(res.suggestion!.lines[1].accountName, 'GBP bank account');
});

test('malformed (non-JSON) response → { ok:false }', async () => {
  const call: StructuredCaller = async () => ({ text: 'I cannot propose a journal for this.' });
  const res = await suggestJournal(input, { call });
  assert.equal(res.ok, false);
  assert.equal(res.suggestion, undefined);
  assert.ok(res.error);
});

test('never throws — caller error becomes { ok:false }', async () => {
  const call: StructuredCaller = async () => {
    throw new Error('network down');
  };
  const res = await suggestJournal(input, { call });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'network down');
});

test('request carries the built system+user prompt + content', async () => {
  const box: { v: { system: string; user: string; content: unknown } | null } = { v: null };
  const call: StructuredCaller = async (args) => {
    box.v = args;
    return { text: sharePurchaseJson };
  };
  await suggestJournal(input, { call });
  const built = buildSuggestJournalPrompt(input);
  const captured = box.v;
  assert.ok(captured);
  assert.equal(captured!.system, built.system);
  assert.equal(captured!.user, built.user);
  assert.deepEqual(captured!.content, input.content);
  // system frames signed double-entry + balancing rule
  assert.match(captured!.system, /DEBIT/);
  assert.match(captured!.system, /CREDIT/);
  assert.match(captured!.system, /sum to zero/);
  // user carries the file name
  assert.match(captured!.user, /share-purchase-agreement\.pdf/);
});
