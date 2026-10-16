// Card Z10, ruling Z09-23: the cost of M05's `due` query (m05/store.ts) on a candidate table of realistic size, with
// and without an index on `cooldown_until`. Prints the query plan and the median time of 50 runs. Local only: no
// network. Size: a year of candidates (`candidate` retention is 1 year) at 300 migrations a day (UNVERIFIED rate; the
// table then holds about 110,000 rows), with TIMED of them holding a retry timer.
//   node --no-warnings packages/engine/scripts/measure-due.ts [rows] [timed]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { base58 } from '@bot/decoders';
import { openDb } from '../src/m24/db.ts';
import { prepareDatabase } from '../src/m24/migrate.ts';
import { ulid } from '../src/recorder-main/ids.ts';

const ROWS = Number(process.argv[2] ?? 110_000);
const TIMED = Number(process.argv[3] ?? 10_000);
const STATES = ['prefiltered_out', 'rejected', 'blacklisted', 'evicted'];
const clock = { kind: 'wall' as const, nowMs: () => Date.UTC(2026, 9, 16) as never };
const path = join(mkdtempSync(join(tmpdir(), 'due-')), 'bot.db');
const db = openDb({ path, clock, create: true });
const ok = await prepareDatabase(db, { clock, backupPath: `${path}.bak` });
if (!ok.ok) throw new Error(ok.error.code);
db.close();
const raw = new DatabaseSync(path);
raw.exec('BEGIN');
const ins = raw.prepare('INSERT INTO candidate (candidate_id, mint, pool_id, venue, state, reasons, cooldown_until, first_seen_at, last_screen_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)');
const t0 = Date.UTC(2025, 9, 16);
const key = (i: number, c: string): string => base58.encode(createHash('sha256').update(`${c}${i}`).digest());
for (let i = 0; i < ROWS; i++) {
  const at = t0 + Math.floor((i * 365 * 86_400_000) / ROWS);
  const timed = i % Math.max(1, Math.floor(ROWS / TIMED)) === 0;
  ins.run(ulid(at), key(i, 'M'), key(i, 'P'), 'pumpswap', STATES[i % 4] as string, '{}', timed ? at + 21_600_000 : null, at, at, at);
}
raw.exec('COMMIT');
// The query as m05/store.ts runs it (Z10: `+"state"` keeps the planner off candidate_state, so it takes the retry-time
// index without ANALYZE statistics; DUE_PLAIN is the query before Z10).
const DUE_PLAIN = `SELECT "candidate_id" FROM "candidate" WHERE "state" IN (?, ?, ?, ?) AND "cooldown_until" IS NOT NULL AND "cooldown_until" <= ? ORDER BY "cooldown_until", "candidate_id" LIMIT ?`;
let due = DUE_PLAIN;
const DUE_Z10 = `SELECT "candidate_id" FROM "candidate" WHERE +"state" IN (?, ?, ?, ?) AND "cooldown_until" IS NOT NULL AND "cooldown_until" <= ? ORDER BY "cooldown_until", "candidate_id" LIMIT ?`;
const now = t0 + 200 * 86_400_000;
const measure = (label: string): void => {
  const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${due}`).all(...STATES, now, 1_000) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
  const st = raw.prepare(due);
  const times: number[] = [];
  for (let k = 0; k < 50; k++) {
    const s = process.hrtime.bigint();
    st.all(...STATES, now, 1_000);
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  times.sort((a, b) => a - b);
  console.log(`${label}: median ${times[25]!.toFixed(3)} ms, p95 ${times[47]!.toFixed(3)} ms; plan: ${plan}`);
};
console.log(`rows ${ROWS}, with a timer ${TIMED}`);
// Migration 0002 already made the index: drop it to measure the query without it.
raw.exec('DROP INDEX IF EXISTS "candidate_cooldown_until"');
measure('without');
due = DUE_Z10;
measure('Z10 query (+state), no index');
due = DUE_PLAIN;
raw.exec('CREATE INDEX "candidate_cooldown_until" ON "candidate" ("cooldown_until") WHERE "cooldown_until" IS NOT NULL');
measure('with partial index on cooldown_until, no ANALYZE (as in production)');
due = DUE_Z10;
measure('Z10 query (+state), partial index, no ANALYZE');
raw.exec('ANALYZE');
measure('with partial index on cooldown_until, after ANALYZE');
raw.close();
