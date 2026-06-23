// Regression: the structured extractors (bank/arap/suggest-journal/detect-bundle)
// had no retry, so a single transient Anthropic API error (500 / 429 / overload /
// network blip) dropped the document to UNKNOWN — a bank statement vanished on one
// 500. withRetry retries transient errors with backoff (like extractIntent does)
// and rethrows non-transient ones immediately.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, isTransient } from './retry';

const noSleep = async () => {};

test('isTransient: 500/429/529/network are transient; 400/401 are not', () => {
  assert.equal(isTransient({ status: 500 }), true);
  assert.equal(isTransient({ status: 429 }), true);
  assert.equal(isTransient({ status: 529 }), true);
  assert.equal(isTransient({ message: 'fetch failed' }), true);
  assert.equal(isTransient({ message: 'Internal server error', status: 500 }), true);
  assert.equal(isTransient({ status: 400 }), false);
  assert.equal(isTransient({ status: 401 }), false);
});

test('withRetry succeeds after transient failures', async () => {
  let n = 0;
  const r = await withRetry(async () => { n++; if (n < 3) throw { status: 500, message: 'Internal server error' }; return 'ok'; }, { sleep: noSleep });
  assert.equal(r, 'ok');
  assert.equal(n, 3);
});

const err = (status: number, msg: string) => Object.assign(new Error(msg), { status });

test('withRetry rethrows a non-transient error immediately (no retry)', async () => {
  let n = 0;
  await assert.rejects(
    withRetry(async () => { n++; throw err(400, 'bad request'); }, { sleep: noSleep }),
    /bad request/,
  );
  assert.equal(n, 1); // tried once, did not retry
});

test('withRetry gives up after maxAttempts and throws the last transient error', async () => {
  let n = 0;
  await assert.rejects(
    withRetry(async () => { n++; throw err(503, 'overloaded'); }, { sleep: noSleep, maxAttempts: 3 }),
    /overloaded/,
  );
  assert.equal(n, 3);
});
