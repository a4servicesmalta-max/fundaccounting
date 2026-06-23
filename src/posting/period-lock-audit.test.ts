// Regression: closing or reopening an accounting period is a privileged control
// action, but it wrote NO audit entry — only post/edit/reverse/reject did. The audit
// trail is the tamper-evidence mechanism, so reopening a closed period (e.g. to slip
// in a backdated entry) left no record of the reopen. closePeriod/reopenPeriod now
// append immutable, hash-chained audit entries; re-locking an already-locked period
// is a no-op with no duplicate entry.
//
// Self-isolating: point AUTOPILOT_DB at a fresh temp file BEFORE importing the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.AUTOPILOT_DB = path.join(os.tmpdir(), `thcp-lockaudit-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

import { getDb, persist, isPeriodLocked, listAudit, verifyAudit } from '../db/store';
import { closePeriod, reopenPeriod } from './post';

function reset(): void {
  getDb().auditLog = [];
  if (getDb().settings) getDb().settings.lockedPeriods = [];
  persist();
}

test('closing a period writes a hash-chained PERIOD_LOCK audit entry', () => {
  reset();
  closePeriod('2025-03', 'cfo');
  assert.equal(isPeriodLocked('2025-03'), true);
  const entries = listAudit({ entity: 'period', entityId: '2025-03' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'PERIOD_LOCK');
  assert.equal(entries[0].actor, 'cfo');
  assert.equal(verifyAudit().ok, true);
});

test('reopening a period writes a PERIOD_UNLOCK entry and keeps integrity', () => {
  reset();
  closePeriod('2025-03', 'cfo');
  reopenPeriod('2025-03', 'admin');
  assert.equal(isPeriodLocked('2025-03'), false);
  const actions = listAudit({ entity: 'period', entityId: '2025-03' }).map((e) => e.action).sort();
  assert.deepEqual(actions, ['PERIOD_LOCK', 'PERIOD_UNLOCK']);
  assert.equal(verifyAudit().ok, true);
});

test('re-locking an already-locked period is a no-op with no duplicate audit entry', () => {
  reset();
  closePeriod('2025-03', 'cfo');
  closePeriod('2025-03', 'cfo'); // already locked
  assert.equal(listAudit({ entity: 'period', entityId: '2025-03' }).length, 1);
  // reopening a period that isn't locked is likewise a no-op (no spurious entry)
  reset();
  reopenPeriod('2025-09', 'admin');
  assert.equal(listAudit({ entity: 'period', entityId: '2025-09' }).length, 0);
});
