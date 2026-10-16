// A-M05-03 daily universe manifest (card Z09): a scripted day through the real state machine and watchlist, the
// golden canonical JSON, the hash in the day's CoverageReport, a late rebuild from M24, immutability, and the
// cross-check wiring of ruling Z08-9 (SPEC-A C-95).
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { canonicalJson, type Pubkey, type UnixMs } from '@bot/types';
import { MINTS } from '@bot/venue/constants';
import { buildUniverseManifest, dailyCrossCheck, dayBounds, eventsFromRows, manifestSha256, writeManifestOnce, type ManifestEvent, type UniverseManifestFile } from '../../src/m05/manifest.ts';
import { MemStore } from './mem-store.ts';
import { createUniverse, LIMIT_SETS, limitSetHash, UNIVERSE_DEFAULTS, type Transition } from '../../src/m05/universe.ts';
import { createWatchlist, WATCHLIST_DEFAULTS } from '../../src/m05/watchlist.ts';
import { computeCoverage } from '../../src/m07/coverage.ts';

const DAY = '2026-10-16';
const T0 = Date.UTC(2026, 9, 16);
const H = 3_600_000;
const SOL = 1_000_000_000n;
const GOLDEN = new URL('./fixtures/manifest-2026-10-16.json', import.meta.url);
const pool = (i: number): Pubkey => `pool-${String(i).padStart(2, '0')}`;
const CC = { poolsOnlyInVendor: 1, otherDexPairs: 2, knownPoolsUnderOtherDex: 0, status: 'ok' as const };
const MC = { chainMigrations: 14, seenByPumpPortal: 0, gapBps: 10_000 };
const LS = { id: 'pm01', paramHash: limitSetHash(LIMIT_SETS.pm01) };

/** 12 pools discovered at different hours (Phase 0); max_watched 8, so the deepest are watched; 3 evictions. */
function scriptedDay(): { events: Transition[]; tail: Array<{ poolId: Pubkey; atMs: number; reason: string; tailUntilMs: number | null }> } {
  let now = T0 + 30 * 60_000;
  const store = new MemStore();
  let id = 0;
  const depth = new Map<string, bigint>();
  const u = createUniverse({
    config: { ...UNIVERSE_DEFAULTS, screeningRequired: false }, store, nowMs: () => now as UnixMs, newId: () => `c${id++}`, wsolMint: MINTS.wsol,
    facts: (p) => ({ venue: 'pumpswap', quoteMint: MINTS.wsol, feeTotalBps: 30, effectiveQuoteLamports: depth.get(p) ?? 0n, observedAtMs: now as UnixMs }),
    lists: { isWrittenOff: () => false, isUnsolicited: () => false }, publish: () => {}, log: { event: () => {} },
  });
  const tail: Array<{ poolId: Pubkey; atMs: number; reason: string; tailUntilMs: number | null }> = [];
  const w = createWatchlist({
    restoreTails: () => [], config: { ...WATCHLIST_DEFAULTS, maxWatched: 8 }, nowMs: () => now as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
    tracker: { watch: () => true, unwatch: () => {} }, universe: u, onEviction: (e) => tail.push(e), log: { event: () => {} },
  });
  for (let i = 0; i < 12; i++) {
    depth.set(pool(i), BigInt(100 + 10 * i) * SOL);
    u.onDiscovery({ poolId: pool(i), baseMint: `mint-${i}`, quoteMint: MINTS.wsol, venue: 'pumpswap', verifiedOnChain: true, migratedAtMs: (T0 - 3 * H) as UnixMs });
    w.recompute(u.candidates());
    now += H;
  }
  // A watched pool goes stale; then the watch budget is lowered to 5: the stale pool goes first, then the 2 shallowest.
  u.onStale(pool(3), now as UnixMs);
  now += 31_000;
  u.tick();
  const w5 = createWatchlist({
    restoreTails: () => [], config: { ...WATCHLIST_DEFAULTS, maxWatched: 5 }, nowMs: () => now as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
    tracker: { watch: () => true, unwatch: () => {} }, universe: u, onEviction: (e) => tail.push(e), log: { event: () => {} },
  });
  w5.recompute(u.candidates());
  now = T0 + 23 * H;
  w5.recompute(u.candidates());
  return { events: store.log, tail };
}
const asEvents = (ts: readonly Transition[]): ManifestEvent[] => ts.map((t) => ({ poolId: t.poolId, mint: t.mint, from: t.from, to: t.to, reason: t.reason, atMs: t.atMs }));

describe('A-M05-03 acceptance (SYNTHETIC scripted day)', () => {
  it('a scripted day: 12 pools eligible at different times and 3 evictions are listed with reasons; the SHA-256 equals the CoverageReport value', () => {
    const d = scriptedDay();
    const m = buildUniverseManifest({ dayUtc: DAY, events: asEvents(d.events), watchlistEvictions: d.tail, crossCheck: CC, migrationCoverage: MC, limitSet: LS, generatedAtMs: T0 + 86_400_000, late: false, prefilterOnly: true });
    assert.equal(m.eligible.length, 12);
    assert.deepEqual(m.eligible.map((e) => e.firstEligibleAtMs - T0), Array.from({ length: 12 }, (_, i) => 30 * 60_000 + i * H));
    assert.ok(m.eligible.every((e) => e.reason.startsWith('set=pm-01;fee=30bps;depth=') && e.reason.endsWith('phase0_unscreened')));
    assert.equal(m.evicted.length, 3);
    assert.deepEqual(m.evicted.map((e) => e.reason), ['budget', 'budget', 'stale']);
    assert.ok(m.evicted.every((e) => e.tailUntilMs === e.atMs + 3_600_000));
    assert.deepEqual(m.a24, { eligibleCount: 12, canonicalityUnknownCount: 0, maxSimultaneous: 12, upperBound: true });
    assert.deepEqual(m.evicted.map((e) => e.poolId), [pool(0), pool(1), pool(3)]);
    assert.deepEqual(m.limitSet, { id: 'pm01', paramHash: limitSetHash(LIMIT_SETS.pm01) });
    const { sha256, ...body } = m;
    assert.equal(sha256, manifestSha256(body));
    const cov = computeCoverage({ dayUtc: DAY, watched: [], pollCounts: [], gaps: [], records: {}, universeManifestSha256: m.sha256 });
    assert.equal(cov.report.universeManifestSha256, m.sha256);
    // Golden file of the canonical JSON (reviewed by hand and pinned; a missing golden fails).
    assert.ok(existsSync(GOLDEN), 'golden manifest missing');
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { SYNTHETIC: string; canonicalJson: string };
    assert.match(golden.SYNTHETIC, /not recorded data/);                              // Z09-30: marked inside the file
    assert.equal(canonicalJson(m), golden.canonicalJson);
  });
});

describe('A-M05-03 rules', () => {
  it('a late manifest is rebuilt from M24 rows with late: true and the same eligible set; written once (immutable)', () => {
    const d = scriptedDay();
    const rows = d.events.map((t) => ({ poolId: t.poolId, mint: t.mint, fromState: t.from, toState: t.to, reason: t.reason, at: t.atMs })).reverse();
    const late = buildUniverseManifest({ dayUtc: DAY, events: eventsFromRows(rows), crossCheck: CC, migrationCoverage: MC, limitSet: LS, generatedAtMs: T0 + 90_000_000, late: true, prefilterOnly: true });
    const live = buildUniverseManifest({ dayUtc: DAY, events: asEvents(d.events), crossCheck: CC, migrationCoverage: MC, limitSet: LS, generatedAtMs: T0 + 90_000_000, late: true, prefilterOnly: true });
    assert.deepEqual(late, live);
    assert.equal(late.late, true);
    assert.ok(late.evicted.every((e) => e.tailUntilMs === e.atMs + 3_600_000));      // the tail end is in the eviction record (Z09-18)
    const days = new Map<string, UniverseManifestFile>();
    const sink = { has: (x: string) => days.has(x), write: (x: UniverseManifestFile) => { days.set(x.dayUtc, x); } };
    assert.deepEqual(writeManifestOnce(sink, late), { ok: true, sha256: late.sha256 });
    assert.deepEqual(writeManifestOnce(sink, live), { ok: false, code: 'E_EXISTS' });
  });

  it('state carried in from the day before counts from 00:00; a span that ends before the day is not listed; events must be in order', () => {
    const prev = T0 - H;
    const ev: ManifestEvent[] = [
      { poolId: 'a', mint: 'ma', from: null, to: 'discovered', reason: 'discovery', atMs: prev - 10 },
      { poolId: 'a', mint: 'ma', from: 'discovered', to: 'eligible', reason: 'x', atMs: prev },
      { poolId: 'b', mint: 'mb', from: 'discovered', to: 'eligible', reason: 'y', atMs: prev },
      { poolId: 'b', mint: 'mb', from: 'eligible', to: 'blacklisted', reason: 'z', atMs: prev + 1 },
      { poolId: 'a', mint: 'ma', from: 'eligible', to: 'watched', reason: 'slot', atMs: T0 + 5 },
      { poolId: 'a', mint: 'ma', from: 'watched', to: 'blacklisted', reason: 'authority_changed', atMs: T0 + H },
      { poolId: 'c', mint: 'mc', from: 'discovered', to: 'eligible', reason: 'w', atMs: T0 + 86_400_000 + 1 },
    ];
    const m = buildUniverseManifest({ dayUtc: DAY, events: ev, crossCheck: CC, migrationCoverage: MC, limitSet: LS, generatedAtMs: 0, late: false, prefilterOnly: false });
    assert.deepEqual(m.eligible.map((e) => [e.poolId, e.firstEligibleAtMs - T0, e.lastEligibleAtMs - T0, e.reason]), [['a', 0, H, 'x']]);
    assert.equal(m.a24.upperBound, false);
    assert.throws(() => buildUniverseManifest({ dayUtc: DAY, events: [...ev].reverse(), crossCheck: CC, migrationCoverage: MC, limitSet: LS, generatedAtMs: 0, late: false, prefilterOnly: false }));
    assert.throws(() => dayBounds('2026-02-30'));
    assert.throws(() => dayBounds('16/10/2026'));
  });

  it('Z08-9 / C-95: the cross-check takes the base mints and pools of the migrations verified in the last 24 h', async () => {
    let asked: { mints: readonly Pubkey[]; pools: ReadonlySet<Pubkey> } | null = null;
    const check = { crossCheck: async (mints: readonly Pubkey[], pools: ReadonlySet<Pubkey>) => { asked = { mints, pools }; return { poolsOnlyInVendor: [1, 2], otherDexPairs: 3, knownPoolsUnderOtherDex: 1, status: 'dex_id_mismatch' as const }; } };
    let window = 0;
    const r = await dailyCrossCheck({ recentMigrations: (w) => { window = w; return [{ mint: 'm1', pool: 'p1' }, { mint: 'm2', pool: 'p2' }]; } }, check);
    assert.equal(window, 86_400_000);
    assert.deepEqual(asked, { mints: ['m1', 'm2'], pools: new Set(['p1', 'p2']) });
    assert.deepEqual(r, { poolsOnlyInVendor: 2, otherDexPairs: 3, knownPoolsUnderOtherDex: 1, status: 'dex_id_mismatch' });
    asked = null;
    assert.deepEqual(await dailyCrossCheck({ recentMigrations: () => [] }, check), { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'ok' });
    assert.equal(asked, null);
  });
});

describe('A-M05-03 branch cases', () => {
  it('two spans of one pool, a first event past eligible, tail-capacity entries in and out of the day, ties, a broken chain', () => {
    const e = (poolId: string, from: ManifestEvent['from'], to: ManifestEvent['to'], reason: string, atMs: number): ManifestEvent => ({ poolId, mint: `m-${poolId}`, from, to, reason, atMs });
    const ev = [
      e('b', null, 'watched', 'restored', T0 + 10),
      e('a', 'discovered', 'eligible', 'r1', T0 + 10),
      e('a', 'eligible', 'blacklisted', 'x', T0 + 20),
      e('a', 'blacklisted', 'eligible', 'r2', T0 + 30),
      e('c', 'watched', 'evicted', 'budget', T0 + 40),
      e('d', 'watched', 'evicted', 'budget', T0 + 40),
      e('d', 'evicted', 'evicted', 'stale', T0 + 40),
    ];
    const m = buildUniverseManifest({
      dayUtc: DAY, events: ev, crossCheck: CC, migrationCoverage: MC, limitSet: LS, generatedAtMs: 0, late: false, prefilterOnly: true,
      watchlistEvictions: [{ poolId: 'z', atMs: T0 + 40, reason: 'tail_capacity', tailUntilMs: null }, { poolId: 'y', atMs: T0 - 1, reason: 'tail_capacity', tailUntilMs: null },
        { poolId: 'x', atMs: T0 + 86_400_000, reason: 'tail_capacity', tailUntilMs: null }],
    });
    assert.deepEqual(m.eligible.map((x) => [x.poolId, x.firstEligibleAtMs - T0, x.reason]), [['a', 10, 'r2'], ['b', 10, 'restored'], ['c', 40, 'budget'], ['d', 40, 'budget']]);
    assert.deepEqual(m.evicted.map((x) => [x.poolId, x.reason]), [['c', 'budget'], ['d', 'budget'], ['d', 'stale'], ['z', 'tail_capacity']]);
    // Rows whose chain does not link (a lost row) keep their stored order.
    const rows = [{ poolId: 'q', mint: 'mq', fromState: 'watched' as const, toState: 'evicted' as const, reason: 'budget', at: T0 }, { poolId: 'q', mint: 'mq', fromState: 'stale' as const, toState: 'watched' as const, reason: 'fresh', at: T0 }];
    assert.deepEqual(eventsFromRows(rows).map((x) => x.to), ['evicted', 'watched']);
  });
});

describe('Z09-41: a tail cut at a restart ends the pool\'s eligible span there', () => {
  it('tail_restart_cut joins its eviction like tail_capacity', () => {
    const P = 'pool-r', M = 'mint-r';
    const events = [
      { poolId: P, mint: M, from: 'discovered' as const, to: 'eligible' as const, reason: 'set=pm-01;phase0_unscreened', atMs: T0 },
      { poolId: P, mint: M, from: 'eligible' as const, to: 'watched' as const, reason: 'slot', atMs: T0 + 1 },
      { poolId: P, mint: M, from: 'watched' as const, to: 'evicted' as const, reason: `budget;tail_until=${T0 + 3_600_000}`, atMs: T0 + 2 },
    ];
    const m = buildUniverseManifest({ dayUtc: DAY, events, crossCheck: { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'ok' },
      migrationCoverage: { chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 }, limitSet: { id: 'pm01', paramHash: 'x' }, generatedAtMs: 0, late: false, prefilterOnly: true,
      watchlistEvictions: [{ poolId: P, atMs: T0 + 600_000, reason: 'tail_restart_cut', tailUntilMs: null }] });
    assert.deepEqual(m.eligible[0]?.intervals, [[T0, T0 + 600_000]]);
  });
});
