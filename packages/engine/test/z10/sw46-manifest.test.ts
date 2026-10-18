// Card SWITCH-FIX-2 SW-46 (case c of the 192 h probe): each day's universe manifest re-read every candidate event since
// the first start, so its work grew with time (bounded only by the 1-year retention). It now reads the pools that can
// matter to the day, each with its whole history. Tests: (1) the rows read and pools held per build stay bounded over
// 10 synthetic days (fails before by day 8: the read grows with the history); (2) the manifest record, byte for byte
// with its SHA-256, is the one the whole-history read builds, on a history with the edge cases of the ruling.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { CandidateState, Pubkey, UnixMs } from '@bot/types';
import { buildUniverseManifest, eventsInOrder } from '../../src/m05/manifest.ts';
import { limitSetHash } from '../../src/m05/universe.ts';
import { createDailyJob } from '../../src/recorder-main/daily.ts';
import { kvEvictionLog, type EvictionLog } from '../../src/recorder-main/evictions.ts';
import { openDb, type Db } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { createRepos } from '../../src/m24/repos.ts';
import { deleteExpired } from '../../src/m24/retention.ts';
import { fakeClock, tempDir } from '../helpers.ts';
import { pubkey, ulid } from '../m24/samples.ts';

const DAY = 86_400_000;
const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);
const ms = (n: number): UnixMs => n as UnixMs;
const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
const repos = createRepos();

async function fresh(name: string): Promise<Db> {
  const path = join(tempDir(name), 'm.db');
  const db = openDb({ create: true, path, clock: fakeClock() });
  assert.equal((await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` })).ok, true);
  return db;
}

/** One candidate transition as the M05 store writes it: the event and the candidate's new state in one transaction. */
function writer(db: Db, oldBefore = -Infinity): (p: number, at: number, from: CandidateState | null, to: CandidateState, reason: string) => void {
  let id = 1;
  // Events before `oldBefore` are written as over a year old, so the retention job purges them (the purge case).
  const createdOf = (at: number): number => (at < oldBefore ? at - 400 * DAY : at);
  return (p, at, from, to, reason) => {
    db.withTx((tx) => {
      const candidateId = ulid(1_000_000 + p);
      if (from === null) {
        repos.candidate.insert(tx, { candidateId, mint: pubkey(20_000 + p), poolId: pubkey(10_000 + p), venue: 'pumpswap', state: to, reasons: '{}',
          cooldownUntil: null, firstSeenAt: ms(at), lastScreenId: null, version: 1, createdAt: ms(at), updatedAt: ms(at) });
      } else {
        tx.run('UPDATE "candidate" SET "state" = ?, "updated_at" = ?, "version" = "version" + 1 WHERE "candidate_id" = ?', to, at, candidateId);
      }
      repos.candidate_event.insert(tx, { eventId: ulid(id++), candidateId, poolId: pubkey(10_000 + p), mint: pubkey(20_000 + p), fromState: from, toState: to, reason, at: ms(at), createdAt: ms(createdOf(at)) });
    });
  };
}

/** Every row a query on the candidate tables returned, counted per call. */
function counting(db: Db, rows: number[]): Db {
  return new Proxy(db, {
    get(t, k) {
      if (k === 'reader') {
        return () => {
          const r = t.reader();
          return { ...r, all: (sql: string, ...ps: Parameters<typeof r.all>[1][]) => { const out = r.all(sql, ...ps); if (sql.includes('candidate')) rows.push(out.length); return out; } };
        };
      }
      const v = Reflect.get(t, k) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

function job(db: Db, evictions: EvictionLog, clock: { t: number }, out: Map<string, string>) {
  return createDailyJob({
    db, dataDir: tempDir('sw46-md'), evictions, limits: [], limitSetId: 'x', prefilterOnly: true,
    migrationCoverage: () => ({ chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 }), closedThrough: () => '2000-01-01T00',
    append: (r) => { if (r.stream === 'universe_manifest') { const m = r.payload as { dayUtc: string }; out.set(m.dayUtc, JSON.stringify(r.payload)); } return 'queued'; },
    nowMs: () => ms(clock.t), log: { event: () => {} },
  });
}

/** The manifest the whole-history read built (before SW-46): every event before the day's end, in (at, rowid) order. */
function wholeHistory(db: Db, evictions: EvictionLog, day: string, now: number): string {
  const start = Date.parse(`${day}T00:00:00Z`);
  const rows = db.reader().all('SELECT "pool_id", "mint", "from_state", "to_state", "reason", "at" FROM "candidate_event" WHERE "at" < ? ORDER BY "at", rowid', start + DAY)
    .map((r) => ({ poolId: String(r.pool_id) as Pubkey, mint: String(r.mint) as Pubkey, fromState: (r.from_state ?? null) as CandidateState | null, toState: String(r.to_state) as CandidateState, reason: String(r.reason), at: Number(r.at) }));
  return JSON.stringify(buildUniverseManifest({
    dayUtc: day, events: eventsInOrder(rows), watchlistEvictions: evictions.between(0, start + DAY),
    crossCheck: { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'unavailable' },
    migrationCoverage: { chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 }, limitSet: { id: 'x', paramHash: limitSetHash([]) },
    enumerationCoverage: 'migrations_since_start', generatedAtMs: now, late: now > start + DAY + 600_000, prefilterOnly: true,
  }));
}

/** One synthetic day: 100 pools discovered, eligible and watched; most retired the same day, every tenth evicted with a tail, every fifth still watched at midnight and out the next morning. */
function day(w: ReturnType<typeof writer>, d: number): void {
  const start = T0 + d * DAY;
  for (let i = 0; i < 100; i++) {
    const p = d * 100 + i, t = start + i * 600_000;
    w(p, t, null, 'discovered', 'migration');
    w(p, t + 1_000, 'discovered', 'eligible', 'pm01');
    w(p, t + 2_000, 'eligible', 'watched', 'slot');
    if (i % 5 === 0) continue;                                                       // still watched at midnight
    if (i % 10 === 1) { w(p, t + H, 'watched', 'evicted', `budget;tail_until=${t + 2 * H}`); continue; }
    w(p, t + H, 'watched', 'prefiltered_out', 'past_entry_age');
  }
  for (let i = 0; i < 100; i += 5) if (d > 0) w((d - 1) * 100 + i, start + 3 * H + i, 'watched', 'prefiltered_out', 'past_entry_age');
}

describe('SW-46: the daily manifest reads a bounded set of pools', () => {
  it('rows read and pools held per build stay bounded over 10 days (fails before by day 8: every event since the first start)', async () => {
    const db = await fresh('sw46-bound');
    const clock = { t: T0 - 1 };
    const evictions = kvEvictionLog(db, () => ms(clock.t));
    const rows: number[] = [];
    const out = new Map<string, string>();
    const j = job(counting(db, rows), evictions, clock, out);
    const w = writer(db);
    const held: number[] = [];
    for (let d = 0; d < 10; d++) {
      day(w, d);
      clock.t = T0 + (d + 1) * DAY + 600_001;
      rows.length = 0;
      j.tick(ms(clock.t));
      assert.ok(out.has(dayOf(T0 + d * DAY)), `day ${d} built`);
      const read = rows.reduce((a, b) => a + b, 0);
      // Per build: the day's 100 pools and the 20 carried in from the night before, each with its whole history; the
      // day's events once more to find its pools; one row for each evicted candidate written in the last 8 days
      // (KEEP_MS: 10 a day here; only one whose tail reaches the day's start is kept). Measured: 1,400 on day 0, then
      // 1,020 rising 10 a day to 1,090 from day 8. The whole-history read passes 1,400 by day 2 and 4,000 by day 8.
      assert.ok(read <= 1_400, `day ${d}: ${read} candidate rows read`);
      assert.equal(out.get(dayOf(T0 + d * DAY)), wholeHistory(db, evictions, dayOf(T0 + d * DAY), clock.t), `day ${d}: the same record`);
      held.push(j.lastManifestRead()?.pools ?? Infinity);
    }
    assert.ok(held.every((n) => n <= 100 + 20), `pools held per build: ${held.join(', ')}`);
  }, 120_000);

  it('the record is byte-identical to the whole-history read, with the edge cases (a span across midnight, an eviction before the day, a tail cut, a restart, a day down, a purge)', async () => {
    const db = await fresh('sw46-same');
    const clock = { t: T0 - 1 };
    const evictions = kvEvictionLog(db, () => ms(clock.t));
    const out = new Map<string, string>();
    job(db, evictions, clock, new Map());                                              // the first start: before the history
    const PURGE_BEFORE = T0 + DAY + H + 1;
    const w = writer(db, PURGE_BEFORE);
    const D = T0 + 5 * DAY;
    // Long history (pools 0-299, days 0-2), most of it closed.
    for (let d = 0; d < 3; d++) day(w, d);
    // A pool eligible since day 1 with no event since (the recorder down on day 3 and day 4): eligible all of day D.
    w(9_001, T0 + DAY + H, null, 'discovered', 'migration');
    w(9_001, T0 + DAY + H + 1, 'discovered', 'eligible', 'mr01');
    // A span open across midnight into D, closed at 03:00.
    w(9_002, D - 2 * H, null, 'discovered', 'migration');
    w(9_002, D - 2 * H + 1, 'discovered', 'eligible', 'pm01');
    w(9_002, D - H, 'eligible', 'watched', 'slot');
    w(9_002, D + 3 * H, 'watched', 'rejected', 'screen_fail');
    // An eviction before D whose tail runs into D, cut by a tail_capacity record at 00:10.
    w(9_003, D - 3 * H, null, 'discovered', 'migration');
    w(9_003, D - 3 * H + 1, 'discovered', 'eligible', 'pm01');
    w(9_003, D - 2 * H, 'eligible', 'watched', 'slot');
    w(9_003, D - 30 * 60_000, 'watched', 'evicted', `budget;tail_until=${D + H}`);
    clock.t = D + 10 * 60_000;
    evictions.append({ poolId: pubkey(10_000 + 9_003) as Pubkey, atMs: ms(D + 10 * 60_000), reason: 'tail_capacity', tailUntilMs: null });
    // An eviction before D whose tail ended before D (counts nothing in D), and one with no tail.
    w(9_004, D - 5 * H, null, 'discovered', 'migration');
    w(9_004, D - 5 * H + 1, 'discovered', 'eligible', 'pm01');
    w(9_004, D - 4 * H, 'eligible', 'evicted', `budget;tail_until=${D - H}`);
    w(9_005, D - 5 * H, null, 'discovered', 'migration');
    w(9_005, D - 5 * H + 1, 'discovered', 'eligible', 'pm01');
    w(9_005, D - 4 * H, 'eligible', 'evicted', 'budget');
    // Day D itself.
    day(w, 5);
    // A purge: the oldest events of the long history and of pool 9001's discovery are gone (retention), the same
    // database for both reads.
    const purged = deleteExpired(db, 'candidate_event', { kind: 'sim', nowMs: () => ms(D) } as never);
    assert.ok(purged > 100, `${purged} events purged`);
    // The first process builds D; a restart (a new job on the same database) builds D+1 after more events.
    clock.t = D + DAY + 600_001;
    const first = job(db, evictions, clock, out);
    first.tick(ms(clock.t));
    const dDay = dayOf(D);
    assert.ok(out.has(dDay));
    assert.equal(out.get(dDay), wholeHistory(db, evictions, dDay, clock.t));
    const m = JSON.parse(out.get(dDay) as string) as { eligible: Array<{ poolId: string }>; evicted: unknown[] };
    for (const p of [9_001, 9_002, 9_003]) assert.ok(m.eligible.some((e) => e.poolId === pubkey(10_000 + p)), `pool ${p} eligible in D`);
    assert.ok(!m.eligible.some((e) => e.poolId === pubkey(10_000 + 9_004) || e.poolId === pubkey(10_000 + 9_005)), 'ended tails count nothing');
    day(w, 6);
    w(9_002, D + DAY + 5 * H, 'rejected', 'eligible', 'pm01');
    clock.t = D + 2 * DAY + 600_001;
    const restarted = job(db, evictions, clock, out);
    restarted.tick(ms(clock.t));
    const next = dayOf(D + DAY);
    assert.equal(out.get(next), wholeHistory(db, evictions, next, clock.t));
  }, 120_000);
});
