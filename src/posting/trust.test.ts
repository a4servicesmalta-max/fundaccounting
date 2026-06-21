import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.AUTOPILOT_DB = path.join(
  os.tmpdir(),
  `thcp-trust-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
);

function makeDraft(id: string, period: string) {
  return {
    id,
    documentId: 'doc1',
    investeeName: 'Gamivo',
    instrument: 'SHARES' as const,
    eventType: 'ACQUISITION' as const,
    controlCode: '030-gamivo',
    currency: 'EUR',
    txnDate: `${period}-10`,
    period,
    status: 'PENDING' as const,
    sourceFigures: { amount: 1000, quantity: null, fairValue: null, currency: 'EUR' },
    engineFigures: {
      functionalAmount: 1000, currency: 'EUR' as const, lineCount: 2,
      fxRate: null, fxRateDate: null, originalCurrency: 'EUR', originalAmount: 1000,
    },
    lines: [
      { accountCode: '030-gamivo', accountName: 'Investment — Gamivo', amount: 1000, description: 'Buy' },
      { accountCode: '1010', accountName: 'Bank', amount: -1000, description: 'Buy' },
    ],
    confidence: 0.9,
    citation: null,
    rationale: null,
    docName: 'gamivo.pdf',
    createdAt: 'x',
    postedAt: null,
  };
}

test('trust/audit layer', { concurrency: false }, async (t) => {
  const store = await import('../db/store');
  const { approveDraft, editDraft, reverseDraft } = await import('./post');

  store.initDb();

  await t.test('editing a pending draft records a hash-chained audit entry', () => {
    store.insertDraft(makeDraft('d1', '2021-06') as any);
    const updated = editDraft('d1', { confidence: 0.5, rationale: 'manual override' }, 'alice');
    assert.equal(updated?.confidence, 0.5);
    assert.ok(updated?.editedAt, 'editedAt set');
    const trail = store.listAudit({ entity: 'draft', entityId: 'd1' });
    assert.equal(trail.length, 1);
    assert.equal(trail[0].action, 'DRAFT_EDIT');
    assert.equal(trail[0].actor, 'alice');
    assert.ok(store.verifyAudit().ok, 'chain intact');
  });

  await t.test('editing rejects lines that do not balance', () => {
    assert.throws(
      () => editDraft('d1', { lines: [{ accountCode: '1010', accountName: 'Bank', amount: 5, description: 'x' }] }, 'alice'),
      /do not balance/,
    );
  });

  await t.test('posting records maker-checker and audit', () => {
    const posted = approveDraft('d1', 'bob');
    assert.equal(posted?.status, 'POSTED');
    assert.equal(posted?.postedBy, 'bob');
    const trail = store.listAudit({ entity: 'draft', entityId: 'd1' });
    assert.equal(trail[0].action, 'DRAFT_POST'); // newest first
    assert.equal(trail[0].actor, 'bob');
  });

  await t.test('posted entries cannot be edited — must reverse', () => {
    assert.throws(() => editDraft('d1', { confidence: 0.1 }), /must be reversed/);
  });

  await t.test('reversal books an equal-and-opposite posted entry and cross-links', () => {
    const reversal = reverseDraft('d1', 'wrong investee', 'carol');
    assert.equal(reversal.status, 'POSTED');
    assert.equal(reversal.reversesDraftId, 'd1');
    // Lines negated.
    const inv = reversal.lines.find((l) => l.accountCode === '030-gamivo');
    assert.equal(inv?.amount, -1000);
    // Original now points at its reversal.
    const original = store.getDraft('d1');
    assert.equal(original?.reversedByDraftId, reversal.id);
    // Net ledger effect of the pair is zero on 030-gamivo.
    const lines = store.listPostedLines().filter((l) => l.accountCode === '030-gamivo');
    const net = lines.reduce((s, l) => s + l.amount, 0);
    assert.ok(Math.abs(net) < 0.01, 'reversal nets the original to zero');
  });

  await t.test('an entry cannot be reversed twice', () => {
    assert.throws(() => reverseDraft('d1', 'again', 'carol'), /already been reversed/);
  });

  await t.test('locking a period blocks posting into it', () => {
    store.insertDraft(makeDraft('d2', '2021-05') as any);
    store.lockPeriod('2021-05');
    assert.ok(store.isPeriodLocked('2021-05'));
    assert.throws(() => approveDraft('d2'), /locked/);
    // Unlock and it posts.
    store.unlockPeriod('2021-05');
    const posted = approveDraft('d2');
    assert.equal(posted?.status, 'POSTED');
  });

  await t.test('tampering with the audit log is detectable', () => {
    const db = store.getDb();
    assert.ok(db.auditLog.length > 0);
    db.auditLog[0].summary = 'TAMPERED';
    const check = store.verifyAudit();
    assert.equal(check.ok, false);
    assert.equal(check.brokenAt, 0);
  });
});
