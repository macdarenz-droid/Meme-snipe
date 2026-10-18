// Ruling Z10-53 (2026-10-16): the daily manifest read every candidate_event row before the day's end in one array
// (a year of events at the 366-day retention). It now reads them in pages along the `at` index and builds the
// manifest from a stream; the result must be the same manifest the whole-table read gave. SW-46: it reads only the
// pools that can matter to the day (each with its whole history), still in pages of at most 2,000 rows. The candidate
// rows are written as the M05 store writes them, in the event's transaction: state = the last event's `to`.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { CandidateState, Pubkey, UnixMs } from '@bot/types';
import { buildUniverseManifest, eventsFromRows, eventsInOrder } from '../../src/m05/manifest.ts';
import { createDailyJob } from '../../src/recorder-main/daily.ts';
import { kvEvictionLog } from '../../src/recorder-main/evictions.ts';
import { openDb, type Db } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { createRepos } from '../../src/m24/repos.ts';
import { fakeClock, tempDir } from '../helpers.ts';
import { pubkey, ulid } from '../m24/samples.ts';

const DAY_MS = 86_400_000;
const D = Date.UTC(2026, 9, 15);
const SQL_ALL = 'SELECT "pool_id", "mint", "from_state", "to_state", "reason", "at" FROM "candidate_event" WHERE "at" < ? ORDER BY "at"';
const ms = (n: number): UnixMs => n as UnixMs;

async function seeded(): Promise<Db> {
  const path = join(tempDir('z10-manifest-pages'), 'm.db');
  const db = openDb({ create: true, path, clock: fakeClock() });
  assert.equal((await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` })).ok, true);
  const repos = createRepos();
  let id = 1;
  const rows: Array<[number, number, CandidateState | null, CandidateState, string]> = [];
  for (let p = 0; p < 400; p++) {
    const t0 = D - DAY_MS + p * 60_000;                                                // the day before: history the day needs
    rows.push([p, t0, null, 'discovered', 'migration'], [p, t0 + 1_000, 'discovered', 'eligible', p % 2 === 0 ? 'mr01' : 'pm01']);
    if (p % 4 === 0) {
      // Two moves in one millisecond, written in reverse: only chain order puts them right.
      rows.push([p, D + p * 1_000, 'watched', 'stale', 'no_poll'], [p, D + p * 1_000, 'eligible', 'watched', 'watch']);
    }
    if (p % 3 === 0) rows.push([p, D + 3_600_000 + p, 'eligible', 'rejected', 'screen_fail']);
  }
  // A burst wider than a page at one millisecond: 2,500 rows across pages.
  for (let p = 400; p < 2_900; p++) rows.push([p, D + 7_200_000, 'discovered', 'eligible', 'mr01']);
  for (let p = 400; p < 2_900; p++) rows.push([p, D - 1, null, 'discovered', 'migration']);
  rows.push([1, D + DAY_MS + 5, 'eligible', 'rejected', 'after_the_day']);              // after the day: never read
  const last = new Map<number, { to: CandidateState; at: number; first: number }>();
  db.withTx((tx) => {
    for (const [p, at, from, to, reason] of rows) {
      repos.candidate_event.insert(tx, { eventId: ulid(id++), candidateId: ulid(1_000_000 + p), poolId: pubkey(10_000 + p), mint: pubkey(20_000 + p), fromState: from, toState: to, reason, at: ms(at), createdAt: ms(at) });
      const l = last.get(p);
      if (l === undefined || at >= l.at) last.set(p, { to, at, first: l?.first ?? at });
    }
    for (const [p, l] of last) {
      repos.candidate.insert(tx, { candidateId: ulid(1_000_000 + p), mint: pubkey(20_000 + p), poolId: pubkey(10_000 + p), venue: 'pumpswap', state: l.to, reasons: '{}',
        cooldownUntil: null, firstSeenAt: ms(l.first), lastScreenId: null, version: 1, createdAt: ms(l.first), updatedAt: ms(l.at) });
    }
  });
  return db;
}

/** The database with every `all` on candidate_event counted. */
function counted(db: Db, sizes: number[], builds: Array<{ endMs: number; rids: number[] }> = []): Db {
  return new Proxy(db, {
    get(t, k) {
      if (k === 'reader') {
        return () => {
          const r = t.reader();
          return { ...r, all: (sql: string, ...ps: Parameters<typeof r.all>[1][]) => { const out = r.all(sql, ...ps);
            if (sql.includes('candidate')) sizes.push(out.length);
            // The per-candidate history reads: every row they return is fed to the manifest.
            if (sql.includes('INDEXED BY "candidate_event_candidate"')) {
              if (builds.at(-1)?.endMs !== Number(ps[1])) builds.push({ endMs: Number(ps[1]), rids: [] });   // a new day's build
              builds[builds.length - 1]?.rids.push(...out.map((x) => Number(x.rid)));
            }
            return out; } };
        };
      }
      const v = Reflect.get(t, k) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

describe('Z10-53 manifest reads candidate events in pages', () => {
  it('the daily job builds the same manifest as the whole-table read, and no read returns more than 2,000 rows (fails before: one read of 6,000+ rows)', async () => {
    const db = await seeded();
    const sizes: number[] = [];
    const builds: Array<{ endMs: number; rids: number[] }> = [];
    let payload: Record<string, unknown> | null = null;
    let now = D - 2 * DAY_MS;
    const job = createDailyJob({
      db: counted(db, sizes, builds), dataDir: tempDir('z10-manifest-pages-md'), evictions: kvEvictionLog(db, () => ms(now)), limits: [], limitSetId: 'x', prefilterOnly: true,
      migrationCoverage: () => ({ chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 }), closedThrough: () => '2026-10-15T23',
      append: (r) => { if (r.stream === 'universe_manifest') payload = r.payload as Record<string, unknown>; return 'queued'; }, nowMs: () => ms(now), log: { event: () => {} },
    });
    now = D + DAY_MS + 600_000;
    job.tick(ms(now));
    assert.notEqual(payload, null);
    const all = db.reader().all(SQL_ALL, D + DAY_MS).map((r) => ({ poolId: String(r.pool_id) as Pubkey, mint: String(r.mint) as Pubkey, fromState: (r.from_state ?? null) as CandidateState | null, toState: String(r.to_state) as CandidateState, reason: String(r.reason), at: Number(r.at) }));
    assert.ok(all.length > 6_000);
    const want = buildUniverseManifest({ dayUtc: '2026-10-15', events: eventsFromRows(all), crossCheck: { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'unavailable' }, migrationCoverage: { chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 }, limitSet: { id: 'x', paramHash: '' }, generatedAtMs: now, late: false, prefilterOnly: true });
    const got = payload as unknown as typeof want;
    assert.deepEqual(got.eligible, want.eligible);
    assert.deepEqual(got.evicted, want.evicted);
    assert.deepEqual(got.a24, want.a24);
    assert.ok(want.a24.eligibleCount > 2_500);
    assert.ok(sizes.length >= 4, `paged reads: ${sizes.join(',')}`);
    // Ruling Z10-55, read with SW-46: every row before the day's end of a pool that can matter (an event since the
    // day's start, or a candidate eligible now) streamed exactly once (page edges never twice).
    assert.ok(builds.length >= 1);
    for (const b of builds) {
      const want = Number(db.reader().get(`SELECT count(*) AS n FROM "candidate_event" WHERE "at" < ? AND "pool_id" IN (SELECT "pool_id" FROM "candidate_event" WHERE "at" >= ?
        UNION SELECT "pool_id" FROM "candidate" WHERE "state" IN ('eligible', 'watched', 'stale', 'signalled', 'in_position', 'cooldown', 'evicted'))`, b.endMs, D)?.n);
      assert.equal(b.rids.length, want, `rows streamed for the day ending ${b.endMs}`);
      assert.equal(new Set(b.rids).size, want);
    }
    assert.equal(job.lastManifestRead()?.events, builds.at(-1)?.rids.length);
    assert.ok(Math.max(...sizes) <= 2_000, `largest read ${Math.max(...sizes)} rows`);
  }, 60_000);

  it('eventsInOrder gives eventsFromRows\'s order for rows in time order, and refuses rows out of time order', () => {
    const r = (pool: number, at: number, from: CandidateState | null, to: CandidateState) => ({ poolId: pubkey(pool), mint: pubkey(pool + 1), fromState: from, toState: to, reason: 'x', at });
    const rows = [r(1, 10, null, 'discovered'), r(2, 10, null, 'discovered'), r(1, 20, 'eligible', 'watched'), r(1, 20, 'discovered', 'eligible'), r(2, 30, 'discovered', 'rejected')];
    assert.deepEqual([...eventsInOrder(rows)], eventsFromRows(rows).sort((a, b) => a.atMs - b.atMs));
    assert.deepEqual([...eventsInOrder(rows)].map((e) => e.to), ['discovered', 'discovered', 'eligible', 'watched', 'rejected']);
    assert.throws(() => [...eventsInOrder([r(1, 20, null, 'discovered'), r(1, 10, 'discovered', 'eligible')])], (e: { code?: string }) => e.code === 'E_ORDER');
  });
});
