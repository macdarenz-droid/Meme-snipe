// Card SWITCH-FIX-2 SW-32: how long the recorder's daily retention holds its loop, at day-N sizes (default 366). Two
// databases made by the migration runner with the same rows: one with migrations 0001-0002 (no retention indexes),
// run with the whole-table deletes the recorder used before (M24 deleteExpired per table, then BarStore.purge); one
// with every migration, run as the recorder now does (recorderRetention: one bounded step a loop tick). Prints each
// step's time. Run it on one CPU (`taskset -c 0`), local only: no network.
// Rows: the 60-pool rates measured in DECISIONS "SWITCH-FIX" SW-1a, a day each: bars 86,400 (kept 14 days, the
// recorder's bars.bar_1m_retention_days), pool rollups 293,799 (7 days, in 204 series a day), aggregate rollups 35,263
// (366 days, 25 series), candidate events 5,811 (1 year), outbox 5,811 (7 days, published). One day more than each
// horizon is written, so the run deletes about one day of each, as the daily run does. The days end at SQLite's wall
// clock (the append-only triggers compare with it too).
//   taskset -c 0 node --no-warnings packages/engine/scripts/measure-retention.ts [days] [scale] [dir] [batchRows]
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnixMs } from '@bot/types';
import { createBarStore } from '../src/m08/bar-store.ts';
import { openDb, type Db } from '../src/m24/db.ts';
import { MIGRATIONS, prepareDatabase } from '../src/m24/migrate.ts';
import { deleteExpired, retentionTables } from '../src/m24/retention.ts';
import { recorderRetention } from '../src/recorder-main/retention.ts';

const DAYS = Number(process.argv[2] ?? 366);
const SCALE = Number(process.argv[3] ?? 1);
const ROOT = process.argv[4] ?? tmpdir();
const BATCH = process.argv[5] === undefined ? undefined : Number(process.argv[5]);
const DAY = 86_400_000;
const MIN = 60_000;
const BAR_DAYS = 14;
const RATE = { bars: 86_400, poolRollups: 293_799, aggRollups: 35_263, events: 5_811 };
const POOL_SERIES = 204;
const AGG_SERIES = 25;
const B58 = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const pool = (i: number): string => `Pump${B58[i % 56]}${B58[Math.floor(i / 56) % 56]}${B58[Math.floor(i / 3136) % 56]}`.padEnd(43, '1');
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulidOf = (n: number): string => [...n.toString(32)].map((c) => CROCK[parseInt(c, 32)]).join('').padStart(26, '0');
const n = (x: number): number => Math.max(1, Math.round(x * SCALE));

let now = 0;
const clock = { kind: 'sim' as const, nowMs: () => now as UnixMs };

async function build(label: string, migrations: typeof MIGRATIONS): Promise<{ db: Db; path: string; dir: string }> {
  const dir = mkdtempSync(join(ROOT, `sw32-${label}-`));
  const path = join(dir, 'bot.db');
  now = Date.UTC(2026, 0, 1);
  const db = openDb({ path, clock, create: true });
  const ok = await prepareDatabase(db, { clock, backupPath: join(dir, 'pre.bak'), migrations });
  if (!ok.ok) throw new Error(ok.error.code);
  const wall = Number((db.reader().get(`SELECT unixepoch('now') * 1000 AS t`) as { t: bigint }).t);
  const end = Math.floor(wall / DAY) * DAY;                                // today 00:00 UTC by SQLite's clock
  const span = DAYS + 1;                                                    // one day past the longest horizon
  let seq = 0;
  for (let d = 0; d < span; d++) {
    const t0 = end - (span - d) * DAY;
    const left = span - d;                                                  // days before today
    now = t0 + DAY - 1;
    db.withTx((tx) => {
      if (left <= BAR_DAYS + 1) {
        const k = n(RATE.bars);
        for (let i = 0; i < k; i++) {
          const minute = t0 + Math.floor((i * DAY) / k / MIN) * MIN;
          tx.run('INSERT INTO "bar_1m" ("pool_id", "minute", "open", "high", "low", "close", "close_depth_lamports", "snapshots", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            pool(i % 60 + d * 7), minute, '0.000000123', '0.000000125', '0.000000120', '0.000000124', 300_000_000_000 + i, 60, minute + MIN);
        }
      }
      if (left <= 7 + 1) {
        const k = Math.min(n(RATE.poolRollups), POOL_SERIES * 1_440);       // one row a series a minute at most
        for (let i = 0; i < k; i++) {
          const series = (i % POOL_SERIES) + d * 68;                          // a third of the pools change each day
          const minute = t0 + Math.floor(i / POOL_SERIES) * MIN;
          tx.run('INSERT INTO "metric_rollup_1m" ("metric", "labels_hash", "minute", "scope", "count", "sum", "p50", "p95", "p99", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            'poll_batch_latency_ms', BigInt(series) * 7_919n - 4_611_686_018_427_387_904n, minute, 'pool', 60, 1234.5 + i, 20, 40, 60, minute + MIN);
        }
      }
      const ka = n(RATE.aggRollups);
      for (let i = 0; i < ka; i++) {
        const minute = t0 + Math.floor((i * DAY) / ka / MIN) * MIN;
        tx.run('INSERT INTO "metric_rollup_1m" ("metric", "labels_hash", "minute", "scope", "count", "sum", "p50", "p95", "p99", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          `rpc_m${i % AGG_SERIES}`, BigInt(i % AGG_SERIES) * 104_729n, minute, 'aggregate', 60, 1234.5 + i, 20, 40, 60, minute + MIN);
      }
      const ke = n(RATE.events);
      for (let i = 0; i < ke; i++) {
        const at = t0 + Math.floor((i * DAY) / ke);
        seq++;
        tx.run('INSERT INTO "candidate_event" ("event_id", "candidate_id", "pool_id", "mint", "from_state", "to_state", "reason", "at", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ulidOf(seq), ulidOf(seq), pool(i % 60), pool((i + 1) % 60), 'discovered', 'screening', 'prefilter_pass', at, at + 100);
        if (left <= 7 + 1) tx.run('INSERT INTO "outbox" ("topic", "payload_json", "created_at", "published_at") VALUES (?, ?, ?, ?)', 'universe.candidate_state', `{"n":${seq}}`, at, at + MIN);
      }
    });
  }
  now = wall;
  return { db, path, dir };
}

const ms = (f: () => void): number => { const s = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - s) / 1e6; };
const count = (db: Db, sql: string): number => Number((db.reader().get(sql) as { n: bigint }).n);
const sizes = (db: Db): string => `candidate_event ${count(db, 'SELECT count(*) AS n FROM candidate_event')}, metric_rollup_1m ${count(db, 'SELECT count(*) AS n FROM metric_rollup_1m')}, bar_1m ${count(db, 'SELECT count(*) AS n FROM bar_1m')}, outbox ${count(db, 'SELECT count(*) AS n FROM outbox')}`;

console.log(`day ${DAYS} sizes at scale ${SCALE}`);
{
  const { db, path, dir } = await build('before', MIGRATIONS.slice(0, 2));
  console.log(`before (0001-0002, whole-table deletes): ${sizes(db)}; file ${(statSync(path).size / 1e9).toFixed(2)} GB`);
  const steps: string[] = [];
  for (const t of retentionTables()) {
    let k = 0;
    const took = ms(() => { k = deleteExpired(db, t, clock); });
    if (took >= 1 || k > 0) steps.push(`${t} ${took.toFixed(1)} ms (${k} rows)`);
  }
  const barStore = createBarStore(db, { retentionDays: BAR_DAYS });
  let bars = 0;
  steps.push(`bar_1m purge ${ms(() => { bars = barStore.purge(now as UnixMs); }).toFixed(1)} ms (${bars} rows)`);
  console.log(`  ${steps.join('; ')}`);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
{
  const { db, path, dir } = await build('after', MIGRATIONS);
  console.log(`after (every migration, bounded steps): ${sizes(db)}; file ${(statSync(path).size / 1e9).toFixed(2)} GB`);
  const r = recorderRetention({ db, clock, barStore: createBarStore(db, { retentionDays: BAR_DAYS }), rollupSink: { expired: () => undefined }, ...(BATCH === undefined ? {} : { batchRows: BATCH }) });
  r.start();
  const times: number[] = [];
  const worst: Record<string, number> = {};
  let last = null as ReturnType<typeof r.step>;
  for (;;) {
    let s = null as ReturnType<typeof r.step>;
    const t = ms(() => { s = r.step(); });
    times.push(t);
    const cur = s as ReturnType<typeof r.step>;
    // Which job the step was on: the table whose total moved (bar_1m for the bars), or the previous one.
    const moved = Object.keys(cur?.byTable ?? {}).find((k) => (cur?.byTable[k] ?? 0) !== (last?.byTable[k] ?? 0)) ?? ((cur?.bars ?? 0) !== (last?.bars ?? 0) ? 'bar_1m' : 'other');
    worst[moved] = Math.max(worst[moved] ?? 0, t);
    last = cur;
    if (cur === null || cur.done) break;
  }
  console.log(`  slowest step by table: ${Object.entries(worst).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', ')}`);
  const sorted = [...times].sort((a, b) => a - b);
  console.log(`  ${times.length} steps; max ${(sorted.at(-1) as number).toFixed(1)} ms, p99 ${(sorted[Math.floor(sorted.length * 0.99)] as number).toFixed(1)} ms, median ${(sorted[Math.floor(sorted.length / 2)] as number).toFixed(1)} ms, total ${times.reduce((a, b) => a + b, 0).toFixed(0)} ms; deleted ${JSON.stringify(last?.byTable)}, bars ${last?.bars}`);
  const drain = ms(() => r.drainOutbox());
  console.log(`  outbox drain (its hourly prune of published rows over 7 days) ${drain.toFixed(1)} ms; left ${sizes(db)}`);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
