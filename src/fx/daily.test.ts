import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

// Isolate the persistent cache: point the store at a throwaway temp DB BEFORE
// importing the store/module, so cache writes never touch real data. The unique
// suffix keeps parallel test processes from sharing one file.
const TMP_DB = path.join(
  os.tmpdir(),
  `thcp-fx-daily-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
);
process.env.AUTOPILOT_DB = TMP_DB;

// NOTE: import store/daily dynamically *after* setting AUTOPILOT_DB. store.ts
// resolves its DB file path at module-eval time, and static ESM imports are
// hoisted above the assignment above — so a static import would bind the store
// to the real data file instead of this throwaway one.
type Daily = typeof import('./daily');
let initDb: typeof import('../db/store')['initDb'];
let getDailyRateToEur: Daily['getDailyRateToEur'];
let convertToEur: Daily['convertToEur'];

// Subtests share one in-memory store + persistent cache, so run them strictly
// in sequence (the default runner schedules siblings concurrently) and start
// from a clean slate for deterministic cache behaviour.
test('daily FX module', { concurrency: false }, async (t) => {
  ({ initDb } = await import('../db/store'));
  ({ getDailyRateToEur, convertToEur } = await import('./daily'));
  fs.rmSync(TMP_DB, { force: true });
  initDb();
  t.after(() => {
    try {
      fs.rmSync(TMP_DB, { force: true });
    } catch {
      /* ignore */
    }
  });

  await t.test('EUR short-circuits to rate 1, source eur', async () => {
    const r = await getDailyRateToEur('EUR', '2021-12-31');
    assert.equal(r.rate, 1);
    assert.equal(r.source, 'eur');
    assert.equal(r.rateDate, '2021-12-31');

    const c = await convertToEur(123.45, 'EUR', '2021-12-31');
    assert.equal(c.eur, 123.45);
    assert.equal(c.rate, 1);
    assert.equal(c.source, 'eur');
  });

  await t.test('stubbed PLN rate resolves live and exposes frankfurter rateDate', async () => {
    const fetchRate = async () => ({ rate: 0.22, rateDate: '2021-12-31' });
    const r = await getDailyRateToEur('PLN', '2021-12-29', { fetchRate });
    assert.equal(r.rate, 0.22);
    assert.equal(r.source, 'live');
    // frankfurter returns the nearest prior business day in `date`.
    assert.equal(r.rateDate, '2021-12-31');
  });

  await t.test('convertToEur multiplies amount by the daily rate, 100 PLN @ 0.22 -> 22 EUR', async () => {
    const fetchRate = async () => ({ rate: 0.22, rateDate: '2021-12-31' });
    const c = await convertToEur(100, 'PLN', '2021-12-28', { fetchRate });
    assert.equal(c.eur, 22);
    assert.equal(c.rate, 0.22);
    assert.equal(c.source, 'live');
  });

  await t.test('a cache hit is used on the second call (stub called once)', async () => {
    let calls = 0;
    const fetchRate = async () => {
      calls++;
      return { rate: 0.25, rateDate: '2022-01-03' };
    };
    const date = '2022-01-04';

    const first = await getDailyRateToEur('USD', date, { fetchRate });
    assert.equal(first.source, 'live');
    assert.equal(first.rate, 0.25);

    const second = await getDailyRateToEur('USD', date, { fetchRate });
    assert.equal(second.source, 'cache');
    assert.equal(second.rate, 0.25);

    assert.equal(calls, 1); // second call served from cache, no re-fetch
  });

  await t.test('offline (fetchRate returns null) falls back to bundled rates inverted', async () => {
    const fetchRate = async () => null;
    // loadRates seeds PLN 4.28 foreign-per-EUR -> 1/4.28 = ~0.2336 eur-per-pln.
    const r = await getDailyRateToEur('PLN', '2024-12-31', { fetchRate });
    assert.equal(r.source, 'fallback');
    assert.ok(Math.abs(r.rate - 1 / 4.28) < 1e-9);

    const c = await convertToEur(100, 'PLN', '2024-12-31', { fetchRate });
    assert.equal(c.source, 'fallback');
    // 100 * (1/4.28) = 23.3644... -> 23.36
    assert.equal(c.eur, 23.36);
  });

  await t.test('no live rate and no fallback match -> rate 0, source none', async () => {
    const fetchRate = async () => null;
    const r = await getDailyRateToEur('JPY', '2024-12-31', { fetchRate });
    assert.equal(r.rate, 0);
    assert.equal(r.source, 'none');

    const c = await convertToEur(1000, 'JPY', '2024-12-31', { fetchRate });
    assert.equal(c.eur, 0);
    assert.equal(c.source, 'none');
  });
});
