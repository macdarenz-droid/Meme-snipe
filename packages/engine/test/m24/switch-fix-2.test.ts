// Card SWITCH-FIX-2 SW-32 (RT1-a): the retention job in bounded steps. The same rows go as with M24's whole-table
// `deleteExpired` (both clocks), no step deletes more than its batch, and each batch is found along an index or the
// primary key, never by scanning the table (migration 0003). The time per step at day-366 sizes is measured by
// scripts/measure-retention.ts (DECISIONS "SWITCH-FIX" SW-32).
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { createBarStore } from '../../src/m08/bar-store.ts';
import { openDb, type Db } from '../../src/m24/db.ts';
import { MIGRATIONS, prepareDatabase } from '../../src/m24/migrate.ts';
import { deleteExpired, expiryJob } from '../../src/m24/retention.ts';
import { recorderRetention } from '../../src/recorder-main/retention.ts';
import { fakeClock, tempDir } from '../helpers.ts';

const DAY = 86_400_000;
const dir = tempDir('sw32');
let k = 0;
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulidOf = (n: number): string => [...n.toString(32)].map((c) => CROCK[parseInt(c, 32)]).join('').padStart(26, '0');
const POOL = 'Pump'.padEnd(43, '1');

async function migrated(): Promise<{ db: Db; wall: number }> {
  const path = join(dir, `r${k++}.db`);
  const clock = fakeClock(Date.UTC(2026, 0, 1));
  const db = openDb({ create: true, path, clock });
  assert.equal((await prepareDatabase(db, { clock, backupPath: `${path}.bak` })).ok, true);
  return { db, wall: Number(db.reader().get("SELECT unixepoch('now') * 1000 AS t")?.t) };
}

/** Rows on both sides of each horizon, in several key series; some old by the engine clock only (created after `wall - 2 days`). */
function fill(db: Db, wall: number): void {
  let seq = 0;
  db.withTx((tx) => {
    for (const ageDays of [400, 380, 367, 365, 30, 8, 6, 1]) {
      for (let i = 0; i < 7; i++) {
        const at = wall - ageDays * DAY + i * 60_000;
        seq++;
        tx.run('INSERT INTO "candidate_event" ("event_id", "candidate_id", "pool_id", "mint", "from_state", "to_state", "reason", "at", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ulidOf(seq), ulidOf(seq), POOL, POOL, 'discovered', 'screening', 'r', at, at + 100);
        for (const [scope, metric, series] of [['pool', 'poll_ms', 5], ['aggregate', 'rpc_ms', 3]] as const) {
          for (let s = 0; s < series; s++) {
            tx.run('INSERT INTO "metric_rollup_1m" ("metric", "labels_hash", "minute", "scope", "count", "sum", "p50", "p95", "p99", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              metric, BigInt(s) * 1_000_003n - 9_000_000_000_000_000_000n, at, scope, 1, 1, null, null, null, at + 60_000);
          }
        }
      }
    }
  });
}
const left = (db: Db): string[] => [
  ...db.reader().all('SELECT "event_id" FROM "candidate_event" ORDER BY 1').map((r) => `e:${String(r.event_id)}`),
  ...db.reader().all('SELECT "metric", "labels_hash", "minute" FROM "metric_rollup_1m" ORDER BY 1, 2, 3').map((r) => `m:${String(r.metric)}:${String(r.labels_hash)}:${String(r.minute)}`),
];

describe('SW-32: retention in bounded steps', () => {
  it('expiryJob deletes the same rows as deleteExpired, at most its batch a step, by both clocks (fails before: no expiryJob)', async () => {
    for (const engineAhead of [0, 3 * DAY]) {
      const a = await migrated();
      const b = await migrated();
      fill(a.db, a.wall);
      fill(b.db, a.wall);
      const clock = fakeClock(a.wall + engineAhead);
      for (const t of ['candidate_event', 'metric_rollup_1m'] as const) {
        const whole = deleteExpired(a.db, t, clock);
        let expired = 0;
        const job = expiryJob(b.db, t, clock, [{ expired: (n) => { expired += n; } }], { rows: 4, series: 2 });
        let total = 0, steps = 0;
        for (;;) {
          const s = job.step();
          assert.ok(s.deleted <= 4, `${t}: ${s.deleted} rows in one step`);
          total += s.deleted;
          if (s.done) break;
          assert.ok(++steps < 1_000);
        }
        assert.equal(total, whole, t);
        assert.equal(expired, whole, `${t}: the observer is told`);
        assert.ok(whole > 4, `${t}: the test needs several steps`);
        assert.deepEqual(job.step(), { deleted: 0, done: true });
      }
      assert.deepEqual(left(b.db), left(a.db));
      a.db.close();
      b.db.close();
    }
  });

  it('each batch is found along an index or the primary key, never a scan of the table (fails before: no migration 0003)', async () => {
    const { db } = await migrated();
    assert.ok(MIGRATIONS.some((m) => m.version === 3 && m.name === 'retention_indexes'));
    const plan = (sql: string, ...p: unknown[]): string => db.reader().all(`EXPLAIN QUERY PLAN ${sql}`, ...(p as never[])).map((r) => String(r.detail)).join(' | ');
    const ev = plan(`SELECT rowid FROM "candidate_event" WHERE "created_at" <= ? AND "created_at" <= unixepoch('now') * 1000 - ? LIMIT ?`, 1, 1, 1);
    assert.match(ev, /USING (COVERING )?INDEX candidate_event_created_at/);
    const bars = plan('SELECT rowid FROM "bar_1m" WHERE "minute" < ? LIMIT ?', 1, 1);
    assert.match(bars, /USING (COVERING )?INDEX bar_1m_minute/);
    const seek = plan('SELECT "metric", "labels_hash", "scope" AS "v" FROM "metric_rollup_1m" WHERE "metric" = ? AND "labels_hash" > ? ORDER BY "labels_hash" LIMIT 1', 'm', 1n);
    assert.match(seek, /SEARCH metric_rollup_1m USING PRIMARY KEY \(metric=\? AND labels_hash>\?\)/);
    const nextMetric = plan('SELECT "metric", "labels_hash", "scope" AS "v" FROM "metric_rollup_1m" WHERE "metric" > ? ORDER BY "metric", "labels_hash" LIMIT 1', 'm');
    assert.match(nextMetric, /SEARCH metric_rollup_1m USING PRIMARY KEY \(metric>\?\)/);
    const series = plan(`SELECT "metric", "labels_hash", "minute" FROM "metric_rollup_1m" WHERE "metric" = ? AND "labels_hash" = ? AND "minute" <= ? AND "scope" = ? AND "created_at" <= ? LIMIT ?`, 'm', 1n, 1, 'pool', 1, 1);
    assert.match(series, /SEARCH metric_rollup_1m USING PRIMARY KEY \(metric=\? AND labels_hash=\? AND minute<\?\)/);
    for (const p of [ev, bars, seek, nextMetric, series]) assert.doesNotMatch(p, /\bSCAN\b/);
    db.close();
  });

  it('the recorder\'s pass: one bounded step at a time, tables then bars; start() during a pass carries it on', async () => {
    const { db, wall } = await migrated();
    fill(db, wall);
    const barStore = createBarStore(db, { retentionDays: 14 });
    db.withTx((tx) => {
      for (let i = 0; i < 11; i++) {
        const minute = wall - 20 * DAY + i * 60_000;
        tx.run('INSERT INTO "bar_1m" ("pool_id", "minute", "open", "high", "low", "close", "close_depth_lamports", "snapshots", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          POOL, minute, '1', '1', '1', '1', 1, 1, minute);
      }
    });
    const clock = fakeClock(wall);
    const r = recorderRetention({ db, clock, barStore, rollupSink: { expired: () => undefined }, batchRows: 3 });
    assert.equal(r.step(), null, 'no pass running');
    r.start();
    let prev = 0, steps = 0, last;
    for (;;) {
      last = r.step();
      assert.ok(last !== null);
      const cur = last.rows + last.bars;
      assert.ok(cur >= prev && cur - prev <= 3, 'at most one batch a step, and the totals carry on');
      prev = cur;
      if (steps === 2) r.start();
      if (last.done) break;
      assert.ok(++steps < 1_000);
    }
    assert.equal(last.bars, 11);
    assert.equal(Number(db.reader().get('SELECT count(*) AS n FROM "bar_1m"')?.n), 0);
    assert.ok((last.byTable.candidate_event ?? 0) > 0 && (last.byTable.metric_rollup_1m ?? 0) > 0);
    assert.equal(r.step(), null, 'the pass is over');
    assert.deepEqual(r.run(), { rows: 0, bars: 0, byTable: {} });
    db.close();
  });
});
