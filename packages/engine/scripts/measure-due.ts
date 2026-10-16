// Card Z10, ruling Z09-23: the cost of M05's `due` query (m05/store.ts DUE_SQL) on a candidate table of realistic size,
// with and without the partial index on `cooldown_until` (migration 0002). Two databases made by the migration runner
// (B-M24-02): one with migration 0001 only (no index), one with every migration. Same rows in both; no ANALYZE (the
// engine never runs it). Prints the query plan and the median and p95 of 50 runs. Local only: no network.
// Size: a year of candidates (`candidate` retention is 1 year) at 300 migrations a day (UNVERIFIED rate): about 110,000
// rows, TIMED of them holding a retry timer.
//   node --no-warnings packages/engine/scripts/measure-due.ts [rows] [timed]
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base58 } from '@bot/decoders';
import type { UnixMs } from '@bot/types';
import { DUE_SQL } from '../src/m05/store.ts';
import { openDb, type Db } from '../src/m24/db.ts';
import { MIGRATIONS, prepareDatabase } from '../src/m24/migrate.ts';
import { M0001_INITIAL } from '../src/m24/migrations/0001_initial.ts';
import { ulid } from '../src/recorder-main/ids.ts';

const ROWS = Number(process.argv[2] ?? 110_000);
const TIMED = Number(process.argv[3] ?? 10_000);
const STATES = ['prefiltered_out', 'rejected', 'blacklisted', 'evicted'];
/** The query before Z10 (m05/store.ts had `"state"`, not `+"state"`). */
const DUE_PLAIN = DUE_SQL.replace('+"state"', '"state"');
const clock = { kind: 'sim' as const, nowMs: () => Date.UTC(2026, 9, 16) as UnixMs };
const INSERT = 'INSERT INTO candidate (candidate_id, mint, pool_id, venue, state, reasons, cooldown_until, first_seen_at, last_screen_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)';
const t0 = Date.UTC(2025, 9, 16);
const key = (i: number, c: string): string => base58.encode(createHash('sha256').update(`${c}${i}`).digest());

async function build(label: string, migrations: typeof MIGRATIONS): Promise<Db> {
  const path = join(mkdtempSync(join(tmpdir(), `due-${label}-`)), 'bot.db');
  const db = openDb({ path, clock, create: true });
  const ok = await prepareDatabase(db, { clock, backupPath: `${path}.bak`, migrations });
  if (!ok.ok) throw new Error(ok.error.code);
  db.withTx((tx) => {
    for (let i = 0; i < ROWS; i++) {
      const at = t0 + Math.floor((i * 365 * 86_400_000) / ROWS);
      const timed = i % Math.max(1, Math.floor(ROWS / TIMED)) === 0;
      tx.run(INSERT, ulid(at, () => createHash('sha256').update(`r${i}`).digest().subarray(0, 10)), key(i, 'M'), key(i, 'P'), 'pumpswap', STATES[i % 4] as string, '{}', timed ? at + 21_600_000 : null, at, at, at);
    }
  });
  return db;
}

const now = t0 + 200 * 86_400_000;
function measure(db: Db, sql: string, label: string): void {
  const rd = db.reader();
  const plan = (rd.all(`EXPLAIN QUERY PLAN ${sql}`, ...STATES, now, 1_000) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
  const times: number[] = [];
  for (let k = 0; k < 50; k++) {
    const s = process.hrtime.bigint();
    rd.all(sql, ...STATES, now, 1_000);
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  times.sort((a, b) => a - b);
  console.log(`${label}: median ${(times[25] as number).toFixed(3)} ms, p95 ${(times[47] as number).toFixed(3)} ms; plan: ${plan}`);
}

console.log(`rows ${ROWS}, with a timer ${TIMED}`);
const without = await build('without', [M0001_INITIAL]);
measure(without, DUE_PLAIN, 'no index, query before Z10');
measure(without, DUE_SQL, 'no index, Z10 query');
without.close();
const withIndex = await build('with', MIGRATIONS);
measure(withIndex, DUE_PLAIN, 'index (0002), query before Z10');
measure(withIndex, DUE_SQL, 'index (0002), Z10 query');
withIndex.close();
