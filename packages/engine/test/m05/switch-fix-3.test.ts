// Card SWITCH-FIX-3 SW-47 (red team 2 on #336): a candidate's event times were the universe clock's, so after a
// backward clock step an eviction could be stamped before the move it followed. Both manifest builders then read the
// events out of their written order, and the bounded one (SW-46) dropped a pool still in its eviction tail. The M05
// store now stamps each event no earlier than the candidate's last one.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { CandidateState, Pubkey, UnixMs } from '@bot/types';
import { MINTS } from '@bot/venue/constants';
import { buildUniverseManifest, eventsInOrder } from '../../src/m05/manifest.ts';
import { m24CandidateStore } from '../../src/m05/store.ts';
import { createUniverse, limitSetHash, UNIVERSE_DEFAULTS, type UniverseDeps } from '../../src/m05/universe.ts';
import { createDailyJob } from '../../src/recorder-main/daily.ts';
import { kvEvictionLog } from '../../src/recorder-main/evictions.ts';
import { openDb } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { fakeClock, tempDir } from '../helpers.ts';
import { pubkey, ulid } from '../m24/samples.ts';

const SOL = 1_000_000_000n;
const H = 3_600_000;
const D = Date.UTC(2026, 9, 16);                                                       // the day built

describe('SW-47: candidate event times never go back', () => {
  it('a backward clock step between watched and evicted: the events keep their order, and the day\'s manifest keeps the pool in its tail (fails before: stamped back, the pool dropped)', async () => {
    const path = join(tempDir('sw47'), 'm.db');
    const db = openDb({ create: true, path, clock: fakeClock() });
    assert.equal((await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` })).ok, true);
    let now = D - 3 * H;
    let id = 1;
    const deps: UniverseDeps = {
      config: { ...UNIVERSE_DEFAULTS, screeningRequired: false }, store: m24CandidateStore(db, { newId: () => ulid(id++), nowMs: () => now as UnixMs }),
      nowMs: () => now as UnixMs, newId: () => ulid(id++), wsolMint: MINTS.wsol,
      facts: () => ({ observedAtMs: now as UnixMs, venue: 'pumpswap', quoteMint: MINTS.wsol, feeTotalBps: 30, effectiveQuoteLamports: 400n * SOL }),
      lists: { isWrittenOff: () => false, isUnsolicited: () => false }, publish: () => undefined, log: { event: () => undefined },
    };
    const u = createUniverse(deps);
    // The recorder's first start is before the history, so the day is built.
    const clock = { t: D - 4 * H };
    const evictions = kvEvictionLog(db, () => clock.t as UnixMs);
    let got = '';
    const job = createDailyJob({
      db, dataDir: tempDir('sw47-md'), evictions, limits: [], limitSetId: 'x', prefilterOnly: true,
      migrationCoverage: () => ({ chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 }), closedThrough: () => '2000-01-01T00',
      append: (r) => { if (r.stream === 'universe_manifest') got = JSON.stringify(r.payload); return 'queued'; }, nowMs: () => clock.t as UnixMs, log: { event: () => undefined },
    });
    const A = pubkey(100) as Pubkey;
    u.onDiscovery({ poolId: A, baseMint: pubkey(200) as Pubkey, quoteMint: MINTS.wsol, venue: 'pumpswap', verifiedOnChain: true, migratedAtMs: (now - 1_800_000) as UnixMs });
    now = D - H;
    assert.equal(u.onWatched(A), true);
    now = D - 90 * 60_000;                                                              // the clock steps back 30 min
    u.onEvicted(A, 'budget', (D + H) as UnixMs);                                        // its tail runs into the day
    const rows = db.reader().all('SELECT "to_state", "at" FROM "candidate_event" WHERE "pool_id" = ? ORDER BY rowid', A);
    assert.deepEqual(rows.map((r) => String(r.to_state)), ['discovered', 'eligible', 'watched', 'evicted']);
    const ats = rows.map((r) => Number(r.at));
    assert.ok(ats.every((t, i) => i === 0 || t >= (ats[i - 1] as number)), `event times go back: ${ats.map((t) => t - D).join(', ')}`);
    assert.equal(ats[3], D - H, 'stamped at the last event\'s time, not the stepped-back clock');

    // The day's manifest (the bounded read) and the whole-history read agree, and both keep A in its tail.
    clock.t = D + 24 * H + 600_001;
    const all = db.reader().all('SELECT "pool_id", "mint", "from_state", "to_state", "reason", "at" FROM "candidate_event" WHERE "at" < ? ORDER BY "at", rowid', D + 24 * H)
      .map((r) => ({ poolId: String(r.pool_id) as Pubkey, mint: String(r.mint) as Pubkey, fromState: (r.from_state ?? null) as CandidateState | null, toState: String(r.to_state) as CandidateState, reason: String(r.reason), at: Number(r.at) }));
    const want = JSON.stringify(buildUniverseManifest({
      dayUtc: '2026-10-16', events: eventsInOrder(all), watchlistEvictions: evictions.between(0, D + 24 * H),
      crossCheck: { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'unavailable' }, migrationCoverage: { chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 },
      limitSet: { id: 'x', paramHash: limitSetHash([]) }, enumerationCoverage: 'migrations_since_start', generatedAtMs: clock.t, late: true, prefilterOnly: true,
    }));
    job.tick(clock.t as UnixMs);
    assert.equal(got, want, 'the bounded read gives the whole-history read\'s record');
    const m = JSON.parse(got) as { eligible: Array<{ poolId: string; lastEligibleAtMs: number }> };
    const a = m.eligible.find((e) => e.poolId === A);
    assert.ok(a !== undefined, 'A is in its tail at the day\'s start');
    assert.equal(a.lastEligibleAtMs, D + H, 'until its tail ends');
  });
});
