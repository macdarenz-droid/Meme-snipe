// A-M08-03 bar_1m persistence and OHLC aggregation (card Z09), on an M24 test database; the bars are SYNTHETIC.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { Lamports, SignedLamports, UnixMs } from '@bot/types';
import { createBarStore, HOLD_MS } from '../../src/m08/bar-store.ts';
import { renderSpot, type Bar } from '../../src/m08/bars.ts';
import { openDb, type Db } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { fakeClock, tempDir } from '../helpers.ts';
import { pubkey } from '../m24/samples.ts';

const dir = tempDir('bar-store');
let n = 0;
async function migrated(): Promise<Db> {
  const path = join(dir, `b${n++}.db`);
  const db = openDb({ create: true, path, clock: fakeClock() });
  assert.equal((await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` })).ok, true);
  return db;
}
const POOL = pubkey(1);
const T0 = Date.UTC(2026, 9, 16, 1, 0, 0);
const p = (x: number): string => renderSpot(BigInt(x) * 10n ** 21n);              // x / 1,000 SOL
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({
  poolId: POOL, startMs: (T0 + i * 60_000) as UnixMs, durationMs: 60_000, open: p(o), high: p(h), low: p(l), close: p(c),
  depthLamportsClose: 1_000n as Lamports, depthChangeBps: 0, netQuoteFlowLamports: 0n as SignedLamports, snapshots: 60, missing: 0,
});

describe('A-M08-03 (SYNTHETIC bars)', () => {
  it('60 consecutive 1m bars: the 1h aggregate is the first open, the last close and the max/min of all', async () => {
    const db = await migrated();
    const s = createBarStore(db);
    const bars = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i, 200 + (i === 17 ? 500 : i), 50 - (i === 33 ? 40 : 0), 101 + i));
    s.add(bars);
    assert.deepEqual(s.flush(T0 as UnixMs), { written: 60, dropped: [] });
    const r = s.ohlc(db.reader(), POOL, '1h', T0 as UnixMs, (T0 + 3_600_000) as UnixMs);
    assert.deepEqual(r, { t: [T0], o: [0.1], h: [0.7], l: [0.01], c: [0.16], gaps: [] });
    const m = s.ohlc(db.reader(), POOL, '1m', T0 as UnixMs, (T0 + 120_000) as UnixMs);
    assert.deepEqual(m.t, [T0, T0 + 60_000]);
    const five = s.ohlc(db.reader(), POOL, '5m', T0 as UnixMs, (T0 + 3_600_000) as UnixMs);
    assert.equal(five.t.length, 12);
    assert.equal(five.o[1], 0.105);
    const day = s.ohlc(db.reader(), POOL, '1d', (T0 - 3_600_000) as UnixMs, (T0 + 3_600_000) as UnixMs);
    assert.equal(day.t.length, 1);
    assert.deepEqual(day.gaps, [{ fromMs: T0 - 3_600_000, toMs: T0, reason: 'no_bar' }]);
    db.close();
  });

  it('missing minutes and M07 coverage gaps are listed; 15 s bars are refused', async () => {
    const db = await migrated();
    const s = createBarStore(db);
    s.add([bar(0, 1, 1, 1, 1), bar(3, 1, 1, 1, 1)]);
    s.flush(T0 as UnixMs);
    const r = s.ohlc(db.reader(), POOL, '1m', T0 as UnixMs, (T0 + 300_000) as UnixMs, [{ fromMs: T0 + 60_000, toMs: T0 + 90_000, reason: 'backpressure' }, { fromMs: 0, toMs: 1, reason: 'outside' }]);
    assert.deepEqual(r.gaps, [
      { fromMs: T0 + 60_000, toMs: T0 + 90_000, reason: 'backpressure' },
      { fromMs: T0 + 60_000, toMs: T0 + 180_000, reason: 'no_bar' },
      { fromMs: T0 + 240_000, toMs: T0 + 300_000, reason: 'no_bar' },
    ]);
    assert.throws(() => s.add([{ ...bar(0, 1, 1, 1, 1), durationMs: 15_000 }]));
    assert.throws(() => s.ohlc(db.reader(), POOL, '1m', T0 as UnixMs, T0 as UnixMs));
    db.close();
  });

  it('a write failure keeps the bars up to 10 minutes and retries, then drops them as gaps', async () => {
    const db = await migrated();
    let fail = true;
    const flaky: Db = { ...db, withTx: (fn) => { if (fail) throw Object.assign(new Error('disk'), { code: 'SQLITE_FULL' }); return db.withTx(fn); } };
    const logged: string[] = [];
    const s = createBarStore(flaky, { log: { event: (_l, code, f) => { logged.push(`${code}:${String(f.error_code)}`); } } });
    s.add([bar(0, 1, 1, 1, 1)]);
    assert.deepEqual(s.flush(T0 as UnixMs), { written: 0, dropped: [] });
    s.add([bar(1, 2, 2, 2, 2)]);
    assert.deepEqual(s.flush((T0 + HOLD_MS - 1) as UnixMs), { written: 0, dropped: [] });
    assert.equal(s.held(), 2);
    const r = s.flush((T0 + HOLD_MS) as UnixMs);
    assert.deepEqual(r.dropped, [{ poolId: POOL, fromMs: T0, toMs: T0 + 60_000, reason: 'write_failed' }]);
    assert.deepEqual(logged.slice(0, 1), ['m08.bar_1m_write_failed:SQLITE_FULL']);
    fail = false;
    assert.deepEqual(s.flush((T0 + HOLD_MS + 60_000) as UnixMs), { written: 1, dropped: [] });
    assert.equal(s.flush(T0 as UnixMs).written, 0);
    db.close();
  });

  it('the daily purge deletes rows older than the retention; retention must be 7-365 days', async () => {
    const db = await migrated();
    const s = createBarStore(db, { retentionDays: 7 });
    s.add([bar(0, 1, 1, 1, 1), bar(1, 1, 1, 1, 1)]);
    s.flush(T0 as UnixMs);
    assert.equal(s.purge((T0 + 7 * 86_400_000 + 60_000) as UnixMs), 1);
    assert.equal(s.ohlc(db.reader(), POOL, '1m', T0 as UnixMs, (T0 + 120_000) as UnixMs).t.length, 1);
    assert.throws(() => createBarStore(db, { retentionDays: 6 }));
    db.close();
  });
});
