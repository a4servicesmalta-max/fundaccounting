import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractArAp,
  buildArApPrompt,
  type StructuredCaller,
  type ExtractArApInput,
} from './extract-arap';

const input: ExtractArApInput = {
  fileName: 'supplier-bill.pdf',
  content: { kind: 'text', text: 'INVOICE from Acme Legal Ltd\nAmount due: EUR 1500\nDue 2025-02-28' },
};

const validReceivable = JSON.stringify({
  kind: 'RECEIVABLE',
  counterparty: 'Gamivo Ltd',
  amount: 5000,
  currency: 'EUR',
  issueDate: '2025-01-10',
  dueDate: '2025-02-10',
});

const validPayable = JSON.stringify({
  kind: 'PAYABLE',
  counterparty: 'Acme Legal Ltd',
  amount: 1500,
  currency: 'EUR',
  issueDate: null,
  dueDate: '2025-02-28',
});

test('valid RECEIVABLE response → parsed typed item', async () => {
  const call: StructuredCaller = async () => ({ text: validReceivable, modelUsed: 'claude-opus-4-8' });
  const res = await extractArAp(input, { call });
  assert.equal(res.ok, true);
  assert.ok(res.item);
  assert.equal(res.item!.kind, 'RECEIVABLE');
  assert.equal(res.item!.counterparty, 'Gamivo Ltd');
  assert.equal(res.item!.amount, 5000);
  assert.equal(res.item!.dueDate, '2025-02-10');
  assert.equal(res.modelUsed, 'claude-opus-4-8');
});

test('valid PAYABLE response with null issueDate → parsed', async () => {
  const call: StructuredCaller = async () => ({ text: validPayable });
  const res = await extractArAp(input, { call });
  assert.equal(res.ok, true);
  assert.equal(res.item!.kind, 'PAYABLE');
  assert.equal(res.item!.issueDate, null);
  assert.equal(res.item!.dueDate, '2025-02-28');
});

test('response wrapped in ```json fences still parses', async () => {
  const call: StructuredCaller = async () => ({ text: '```json\n' + validPayable + '\n```' });
  const res = await extractArAp(input, { call });
  assert.equal(res.ok, true);
  assert.equal(res.item!.counterparty, 'Acme Legal Ltd');
});

test('malformed (non-JSON) response → { ok:false }', async () => {
  const call: StructuredCaller = async () => ({ text: 'This is not an invoice.' });
  const res = await extractArAp(input, { call });
  assert.equal(res.ok, false);
  assert.equal(res.item, undefined);
  assert.ok(res.error);
});

test('invalid kind value → { ok:false }', async () => {
  const call: StructuredCaller = async () => ({
    text: JSON.stringify({
      kind: 'UNKNOWN',
      counterparty: 'X',
      amount: 1,
      currency: 'EUR',
      issueDate: null,
      dueDate: null,
    }),
  });
  const res = await extractArAp(input, { call });
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('never throws — caller error becomes { ok:false }', async () => {
  const call: StructuredCaller = async () => {
    throw new Error('timeout');
  };
  const res = await extractArAp(input, { call });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'timeout');
});

test('request carries the built system+user prompt and content', async () => {
  const box: { v: { system: string; user: string; content: unknown } | null } = { v: null };
  const call: StructuredCaller = async (args) => {
    box.v = args;
    return { text: validPayable };
  };
  await extractArAp(input, { call });
  const built = buildArApPrompt(input);
  const captured = box.v;
  assert.ok(captured);
  assert.equal(captured.system, built.system);
  assert.equal(captured.user, built.user);
  assert.deepEqual(captured.content, input.content);
  // prompt instructs transcribe-only + RECEIVABLE/PAYABLE direction from the FUND's POV
  assert.match(captured.system, /Transcribe ONLY/);
  assert.match(captured.system, /RECEIVABLE = an invoice the FUND ISSUED/);
  assert.match(captured.system, /PAYABLE = a bill or supplier invoice the FUND RECEIVED/);
  assert.match(captured.user, /supplier-bill\.pdf/);
});
