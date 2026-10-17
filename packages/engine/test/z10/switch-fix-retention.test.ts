// Card SWITCH-FIX SW-1(b): the recorder's database stays bounded. 90 simulated days (compressed time: one step a
// simulated day) through the recorder's own retention code (src/recorder-main/retention.ts), at the rates the soak
// measured for the recorder's growers (6 h soak at about 30 pools, scaled to 60 and then cut to a tenth so the test runs
// in seconds; DECISIONS "SWITCH-FIX" gives the full-size numbers). SQLite's append-only triggers also compare with
// SQLite's own wall clock, so the simulated days end at the real now: every day is in the past for both clocks.
import { strict as assert } from 'node:assert';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { createBarStore } from '../../src/m08/bar-store.ts';
import { openDb } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { recorderRetention } from '../../src/recorder-main/retention.ts';
import { tempDir } from '../helpers.ts';

const DAY = 86_400_000;
/** A tenth of the 60-pool rates (rows a simulated day). */
const RATE = { bars: 6 * 1_440, poolRollups: 13_000, aggregateRollups: 2_840, candidateEvents: 145 };
const POOLS = Array.from({ length: 6 }, (_, i) => `Pump${"ABCDEF"[i]}`.padEnd(43, "1"));
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID = (n: number): string => [...n.toString(32)].map((c) => CROCKFORD[parseInt(c, 32)]).join('').padStart(26, '0');

describe('SW-1(b): the recorder database over 90 simulated days', () => {
  it('bar_1m stops at 90 days, pool rollups at 7, the outbox at 7; 1-year tables keep every row of their year; the file stops growing', async () => {
    const days = 100;
    const start = Math.floor((Date.now() - (days + 1) * DAY) / DAY) * DAY;
    let now = start;
    const clock = { kind: 'sim' as const, nowMs: () => now as UnixMs };
    const dir = tempDir('sw1b');
    const path = join(dir, 'bot.db');
    const db = openDb({ path, clock, create: true });
    const prep = await prepareDatabase(db, { clock, backupPath: join(dir, 'pre.bak') });
    assert.ok(prep.ok);
    const barStore = createBarStore(db, { retentionDays: 90 });
    let expired = 0;
    const retention = recorderRetention({ db, clock, barStore, rollupSink: { expired: (n) => { expired += n; } } });
    const sizes: number[] = [];
    let seq = 0;
    for (let d = 0; d < days; d++) {
      const t0 = start + d * DAY;
      now = t0 + DAY - 1;
      db.withTx((tx) => {
        for (let i = 0; i < RATE.bars; i++) {
          const pool = POOLS[i % POOLS.length] as string;
          const minute = t0 + Math.floor(i / POOLS.length) * 60_000;
          tx.run('INSERT INTO "bar_1m" ("pool_id", "minute", "open", "high", "low", "close", "close_depth_lamports", "snapshots", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            pool, minute, '0.000000123', '0.000000125', '0.000000120', '0.000000124', 300_000_000_000, 60, minute);
        }
        for (let i = 0; i < RATE.poolRollups; i++) tx.run('INSERT INTO "metric_rollup_1m" ("metric", "labels_hash", "minute", "scope", "count", "sum", "p50", "p95", "p99", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          'poll_batch_latency_ms', i % 200, t0 + Math.floor(i / 200) * 60_000, 'pool', 60, 1234.5, 20, 40, 60, t0 + Math.floor(i / 200) * 60_000);
        for (let i = 0; i < RATE.aggregateRollups; i++) tx.run('INSERT INTO "metric_rollup_1m" ("metric", "labels_hash", "minute", "scope", "count", "sum", "p50", "p95", "p99", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          'rpc_latency_ms', i % 2, t0 + Math.floor(i / 2) * 60_000, 'aggregate', 60, 1234.5, 20, 40, 60, t0 + Math.floor(i / 2) * 60_000);
        for (let i = 0; i < RATE.candidateEvents; i++) {
          const at = t0 + i * 500_000;
          tx.run('INSERT INTO "candidate_event" ("event_id", "candidate_id", "pool_id", "mint", "from_state", "to_state", "reason", "at", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ULID(++seq), ULID(seq), POOLS[0], POOLS[1], 'discovered', 'screening', 'prefilter_pass', at, at);
          db.outbox.append(tx, 'universe.candidate_state', { n: seq });
        }
      });
      retention.drainOutbox();
      retention.run();
      sizes.push(statSync(path).size + (() => { try { return statSync(`${path}-wal`).size; } catch { return 0; } })());
    }
    const count = (sql: string): number => Number((db.reader().get(sql) as { n: bigint }).n);
    // bar_1m: 90 days of rows, never more (logic 5 of A-M08-03).
    assert.ok(count('SELECT count(*) AS n FROM "bar_1m"') <= 91 * RATE.bars);
    assert.ok(count('SELECT count(*) AS n FROM "bar_1m"') >= 89 * RATE.bars);
    // Pool rollups: 7 days; aggregate rollups and candidate events: a year, so all 100 days are still there.
    assert.ok(count(`SELECT count(*) AS n FROM "metric_rollup_1m" WHERE "scope" = 'pool'`) <= 8 * RATE.poolRollups);
    assert.equal(count(`SELECT count(*) AS n FROM "metric_rollup_1m" WHERE "scope" = 'aggregate'`), days * RATE.aggregateRollups);
    assert.equal(count('SELECT count(*) AS n FROM "candidate_event"'), days * RATE.candidateEvents);
    assert.ok(expired >= (days - 8) * RATE.poolRollups, 'the rollup sink was told');
    // The outbox: every row published (no consumer in the recorder), and only the last 7 days kept.
    assert.equal(count('SELECT count(*) AS n FROM "outbox" WHERE "published_at" IS NULL'), 0);
    assert.ok(count('SELECT count(*) AS n FROM "outbox"') <= 8 * RATE.candidateEvents);
    // The file: once bar_1m is at its horizon (day 90 on), the only growth left is the 1-year tables' (about 0.3 MB a
    // simulated day at these rates); before the fix every day added the whole day's rows.
    const late = (sizes[days - 1] as number) - (sizes[91] as number);
    const early = (sizes[30] as number) - (sizes[22] as number);
    assert.ok(late < early / 3, `growth days 91-99 ${late} B, days 22-30 ${early} B`);
    db.close();
  }, 300_000);
});
