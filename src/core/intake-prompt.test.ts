import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIntakePrompt } from './intake-prompt';

const ctx = {
  fileName: '20220810_SPA_GAMIVO.pdf',
  folderPath: 'SHARES/DISPOSAL/GAMIVO S.A',
  investees: [
    { name: 'Gamivo S.A.', aliases: ['Hulda S.A.', '030-GC'] },
    { name: 'Booste S.A.', aliases: [] },
  ],
  documentText: 'Share Purchase Agreement ... 100 shares ... EUR 9000',
};

test('system prompt forbids computing figures', () => {
  const { system } = buildIntakePrompt(ctx);
  assert.match(system, /never/i);
  assert.match(system, /compute|derive/i);
});

test('user prompt includes file name, folder path, and roster', () => {
  const { user } = buildIntakePrompt(ctx);
  assert.match(user, /20220810_SPA_GAMIVO\.pdf/);
  assert.match(user, /SHARES\/DISPOSAL\/GAMIVO/);
  assert.match(user, /Gamivo S\.A\./);
  assert.match(user, /Hulda S\.A\./); // alias surfaced
});

test('user prompt embeds document text when provided', () => {
  const { user } = buildIntakePrompt(ctx);
  assert.match(user, /100 shares/);
});

test('user prompt notes a PDF attachment when no text is provided', () => {
  const { user } = buildIntakePrompt({ ...ctx, documentText: undefined });
  assert.match(user, /attached as a PDF/i);
});

test('empty roster renders without throwing', () => {
  const { user } = buildIntakePrompt({ ...ctx, investees: [] });
  assert.match(user, /none provided/i);
});
