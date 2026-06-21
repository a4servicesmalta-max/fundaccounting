import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBankDescriptions,
  buildClassifyPrompt,
  type StructuredCaller,
  type ClassifyInput,
} from './classify-bank';

const input: ClassifyInput = {
  descriptions: ['Czynsz biuro styczeń', 'Faktura sprzedaż klient ABC'],
  chart: [
    { code: '6200', name: 'Office rent' },
    { code: '4000', name: 'Sales revenue' },
    { code: '1000', name: 'Bank' },
  ],
};

const validJson = JSON.stringify({
  suggestions: [
    {
      pattern: 'Czynsz biuro',
      accountCode: '6200',
      accountName: 'Office rent',
      isNewAccount: false,
      confidence: 0.95,
      rationale: 'Polish "czynsz biuro" means office rent.',
    },
    {
      pattern: 'Faktura sprzedaż',
      accountCode: '4000',
      accountName: 'Sales revenue',
      isNewAccount: false,
      confidence: 0.9,
      rationale: 'Sales invoice income.',
    },
  ],
});

test('valid model response → parsed suggestions (codes, isNewAccount preserved)', async () => {
  const call: StructuredCaller = async () => ({ text: validJson, modelUsed: 'claude-opus-4-8' });
  const res = await classifyBankDescriptions(input, { call });
  assert.equal(res.ok, true);
  assert.ok(res.suggestions);
  assert.equal(res.suggestions!.length, 2);
  assert.equal(res.suggestions![0].accountCode, '6200');
  assert.equal(res.suggestions![0].isNewAccount, false);
  assert.equal(res.suggestions![1].accountCode, '4000');
  assert.equal(res.modelUsed, 'claude-opus-4-8');
});

test('new-account proposal is carried through (isNewAccount true, new 6xxx code)', async () => {
  const json = JSON.stringify({
    suggestions: [
      {
        pattern: 'Opłaty bankowe',
        accountCode: '6800',
        accountName: 'Bank charges',
        isNewAccount: true,
        confidence: 0.8,
        rationale: 'No matching account; bank fees are an expense.',
      },
    ],
  });
  const call: StructuredCaller = async () => ({ text: json });
  const res = await classifyBankDescriptions(input, { call });
  assert.equal(res.ok, true);
  assert.equal(res.suggestions![0].isNewAccount, true);
  assert.equal(res.suggestions![0].accountCode, '6800');
});

test('missing rationale still parses (defaults to empty string)', async () => {
  const json = JSON.stringify({
    suggestions: [{ pattern: 'Czynsz', accountCode: '6200' }],
  });
  const call: StructuredCaller = async () => ({ text: json });
  const res = await classifyBankDescriptions(input, { call });
  assert.equal(res.ok, true);
  assert.equal(res.suggestions![0].rationale, '');
  assert.equal(res.suggestions![0].accountName, '');
  assert.equal(res.suggestions![0].isNewAccount, false);
  assert.equal(res.suggestions![0].confidence, 0);
});

test('response wrapped in ```json fences still parses', async () => {
  const call: StructuredCaller = async () => ({ text: '```json\n' + validJson + '\n```' });
  const res = await classifyBankDescriptions(input, { call });
  assert.equal(res.ok, true);
  assert.equal(res.suggestions!.length, 2);
});

test('malformed (non-JSON) response → { ok:false }', async () => {
  const call: StructuredCaller = async () => ({ text: 'I cannot classify these.' });
  const res = await classifyBankDescriptions(input, { call });
  assert.equal(res.ok, false);
  assert.equal(res.suggestions, undefined);
  assert.ok(res.error);
});

test('schema-invalid JSON (missing accountCode) → { ok:false }', async () => {
  const call: StructuredCaller = async () => ({
    text: JSON.stringify({ suggestions: [{ pattern: 'X' }] }),
  });
  const res = await classifyBankDescriptions(input, { call });
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('never throws — caller error becomes { ok:false }', async () => {
  const call: StructuredCaller = async () => {
    throw new Error('network down');
  };
  const res = await classifyBankDescriptions(input, { call });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'network down');
});

test('request carries the built system+user prompt', async () => {
  const box: { v: { system: string; user: string } | null } = { v: null };
  const call: StructuredCaller = async (args) => {
    box.v = args;
    return { text: validJson };
  };
  await classifyBankDescriptions(input, { call });
  const built = buildClassifyPrompt(input);
  const captured = box.v;
  assert.ok(captured);
  assert.equal(captured!.system, built.system);
  assert.equal(captured!.user, built.user);
  // prompt frames the classification task + numbering hints + never-invent rule
  assert.match(captured!.system, /bookkeeping assistant/);
  assert.match(captured!.system, /6xxx = expenses/);
  assert.match(captured!.system, /Never invent transaction amounts/);
  assert.match(captured!.user, /Czynsz biuro/);
});
