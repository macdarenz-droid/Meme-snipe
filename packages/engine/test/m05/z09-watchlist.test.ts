// A-M05-02 watchlist (card Z09): the acceptance cases, the pinned-never-evicted property, the tail and degraded reads.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { CandidateState, Lamports, UnixMs } from '@bot/types';
import { checkWatchlistConfig, createWatchlist, WATCHLIST_DEFAULTS, type WatchlistConfig } from '../../src/m05/watchlist.ts';
import type { CandidateRecord } from '../../src/m05/universe.ts';

const T0 = Date.UTC(2026, 9, 16);
const SOL = 1_000_000_000n;
const rec = (i: number, state: CandidateState, depthSol: number): CandidateRecord => ({
  candidateId: `c${i}`, mint: `m${i}`, poolId: `p${i}`, venue: 'pumpswap', state, firstSeenAtMs: (T0 + i) as UnixMs, cooldownUntilMs: null,
  reasons: [], version: 1, migratedAtMs: null, depthLamports: (BigInt(depthSol) * SOL) as Lamports, sinceMs: T0 as UnixMs, retryAtMs: null,
});

function setup(o: { config?: Partial<WatchlistConfig>; maxHoldMs?: number } = {}) {
  let now = T0;
  let mode: 'normal' | 'degraded_reads' = 'normal';
  const classes = new Map<string, string>();
  const unwatchedWhilePinned: string[] = [];
  const pinnedNow = new Set<string>();
  const granted: string[] = [], evicted: Array<[string, string]> = [], evictions: Array<{ poolId: string; reason: string; tailUntilMs: number | null }> = [];
  const w = createWatchlist({
    restoreTails: () => [], config: { ...WATCHLIST_DEFAULTS, ...o.config }, nowMs: () => now as UnixMs, maxHoldMs: () => o.maxHoldMs ?? 7_200_000, mode: () => mode,
    tracker: { watch: (p, c) => { classes.set(p, c); }, unwatch: (p) => { if (pinnedNow.has(p)) unwatchedWhilePinned.push(p); classes.delete(p); } },
    universe: { onWatched: (p) => { granted.push(p); return true; }, onEvicted: (p, r) => { if (pinnedNow.has(p)) unwatchedWhilePinned.push(`evicted ${p}`); evicted.push([p, r]); }, candidate: () => null },
    onEviction: (e) => evictions.push(e), log: { event: () => {} },
  });
  return {
    w, classes, granted, evicted, evictions, unwatchedWhilePinned,
    pin: (p: string) => { pinnedNow.add(p); w.pinForPosition(p); }, unpin: (p: string) => { pinnedNow.delete(p); w.unpin(p); },
    pinned: () => [...pinnedNow], advance: (ms: number) => { now += ms; }, degrade: (d: boolean) => { mode = d ? 'degraded_reads' : 'normal'; },
  };
}

describe('A-M05-02 acceptance (SYNTHETIC candidates)', () => {
  it('40 eligible candidates and 2 pinned pools: 30 candidates + 2 pinned are watched; the 10 shallowest wait', () => {
    const t = setup();
    const cands = Array.from({ length: 40 }, (_, i) => rec(i, 'eligible', 100 + i));
    t.pin('pos-a'); t.pin('pos-b');
    t.w.recompute(cands);
    const wl = t.w.watchlist();
    assert.equal(wl.filter((x) => x.priority === 0).length, 2);
    assert.equal(wl.filter((x) => x.priority === 1).length, 30);
    assert.deepEqual(t.granted.sort(), Array.from({ length: 30 }, (_, i) => `p${i + 10}`).sort());
    assert.equal(t.classes.get('pos-a'), 'position');
  });

  it('an evicted watched pool is polled at 0.1 Hz (tail) for at least max-hold + 1 h and appears in postEvictionTail', () => {
    const t = setup({ maxHoldMs: 7_200_000 });
    const c = Array.from({ length: 31 }, (_, i) => rec(i, 'watched', 100 + i));
    t.w.recompute(c);
    assert.deepEqual(t.evicted, [['p0', 'budget']]);
    assert.equal(t.classes.get('p0'), 'tail');
    assert.deepEqual(t.w.postEvictionTail(), [{ poolId: 'p0', untilMs: T0 + 7_200_000 + 3_600_000, reason: 'budget' }]);
    t.advance(7_200_000 + 3_600_000 - 1);
    t.w.recompute(c.slice(1));
    assert.equal(t.classes.get('p0'), 'tail');
    t.advance(1);
    t.w.recompute(c.slice(1));
    assert.equal(t.classes.has('p0'), false);
    assert.equal(t.w.postEvictionTail().length, 0);
  });

  it('in degraded_reads only pinned pools stay watched within one recompute; tail polling stops; normal again refills', () => {
    const t = setup();
    const c = Array.from({ length: 5 }, (_, i) => rec(i, 'watched', 100 + i));
    t.w.recompute(c);
    t.pin('pos');
    t.w.recompute([...c.slice(0, 4), rec(4, 'stale', 1)]);
    t.degrade(true);
    t.w.recompute(c);
    assert.deepEqual(t.w.watchlist(), [{ poolId: 'pos', priority: 0 }]);
    assert.ok(t.evicted.every(([, r]) => r === 'degraded') && t.evicted.length === 5);
    assert.equal(t.w.postEvictionTail().length, 0);
    t.degrade(false);
    t.w.recompute(c.map((x) => ({ ...x, state: 'eligible' as const })));
    assert.equal(t.w.watchlist().length, 6);
  });
});

describe('A-M05-02 rules', () => {
  it('property: a pinned pool is never evicted or unwatched while pinned', () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom('pin', 'unpin', 'recompute', 'degrade', 'normal', 'time'), fc.integer({ min: 0, max: 39 })), { maxLength: 60 }), (ops) => {
      const t = setup({ config: { maxWatched: 5, tailMaxPools: 3 } });
      const states: CandidateState[] = ['eligible', 'watched', 'stale', 'evicted', 'blacklisted', 'signalled'];
      for (const [op, i] of ops) {
        if (op === 'pin') t.pin(`p${i}`);
        else if (op === 'unpin') t.unpin(`p${i}`);
        else if (op === 'degrade') t.degrade(true);
        else if (op === 'normal') t.degrade(false);
        else if (op === 'time') t.advance(i * 600_000);
        else t.w.recompute(Array.from({ length: 40 }, (_, k) => rec(k, states[(k + i) % states.length] as CandidateState, (k * 7 + i) % 50)));
      }
      assert.deepEqual(t.unwatchedWhilePinned, []);
      for (const p of t.pinned()) assert.ok(t.w.watchlist().some((x) => x.poolId === p && x.priority === 0), p);
    }), { numRuns: 300 });
  });

  it('stale pools go first, then the shallowest; the tail cap ends the oldest tail first (tail_capacity)', () => {
    const t = setup({ config: { maxWatched: 3, tailMaxPools: 1 } });
    t.w.recompute([rec(0, 'watched', 5), rec(1, 'stale', 900), rec(2, 'watched', 1), rec(3, 'watched', 50), rec(4, 'watched', 60)]);
    assert.deepEqual(t.evicted, [['p1', 'stale'], ['p2', 'budget']]);
    assert.deepEqual(t.evictions.map((e) => [e.poolId, e.reason]), [['p1', 'stale'], ['p1', 'tail_capacity'], ['p2', 'budget']]);
    assert.equal(t.evictions[0]?.tailUntilMs, T0 + 7_200_000 + 3_600_000);
    assert.equal(t.evictions[2]?.tailUntilMs, T0 + 7_200_000 + 3_600_000);
    assert.deepEqual(t.w.postEvictionTail().map((x) => x.poolId), ['p2']);
  });

  it('unpin demotes to candidate; unpin of an unknown pool is a no-op; pools that leave every slot state stop being watched', () => {
    const t = setup();
    t.pin('p0');
    t.unpin('p0');
    t.unpin('nope');
    t.w.recompute([rec(0, 'watched', 1)]);
    assert.deepEqual(t.w.watchlist(), [{ poolId: 'p0', priority: 1 }]);
    t.w.recompute([rec(0, 'blacklisted', 1)]);
    assert.deepEqual(t.w.watchlist(), []);
  });

  it('config: max_watched never above floor(max_accounts_per_call / 3); tail limits', () => {
    assert.equal(checkWatchlistConfig(WATCHLIST_DEFAULTS), null);
    assert.match(checkWatchlistConfig({ ...WATCHLIST_DEFAULTS, maxWatched: 31 }) as string, /1-30/);
    assert.equal(checkWatchlistConfig({ ...WATCHLIST_DEFAULTS, maxAccountsPerCall: 60, maxWatched: 20 }), null);
    assert.notEqual(checkWatchlistConfig({ ...WATCHLIST_DEFAULTS, tailMaxPools: 61 }), null);
    assert.notEqual(checkWatchlistConfig({ ...WATCHLIST_DEFAULTS, tailExtraMs: 3_599_999 }), null);
    assert.throws(() => setup({ config: { maxWatched: 0 } }));
    const t = setup({ config: { tailMaxPools: 0 } });
    t.w.recompute(Array.from({ length: 31 }, (_, i) => rec(i, 'watched', i)));
    assert.equal(t.evictions[0]?.tailUntilMs, null);
  });
});

describe('Z09-41 (RT-12): eviction tails survive a restart', () => {
  type Ev = { poolId: string; atMs: UnixMs; reason: string; tailUntilMs: UnixMs | null };
  function mk(o: { now: () => number; records: Ev[]; watchOk?: (id: string) => boolean; tailMaxPools?: number; mode?: 'normal' | 'degraded_reads' }) {
    const classes = new Map<string, string>();
    const w = createWatchlist({
      config: { ...WATCHLIST_DEFAULTS, tailMaxPools: o.tailMaxPools ?? WATCHLIST_DEFAULTS.tailMaxPools }, nowMs: () => o.now() as UnixMs, maxHoldMs: () => 7_200_000, mode: () => o.mode ?? 'normal',
      tracker: { watch: (id, c) => { if (o.watchOk !== undefined && !o.watchOk(id)) return false; classes.set(id, c); return true; }, unwatch: (id) => { classes.delete(id); } },
      universe: { onWatched: () => true, onEvicted: () => {}, candidate: () => null },
      onEviction: (e) => o.records.push(e), log: { event: () => {} },
      // What Z10 reads back from the persisted eviction records.
      restoreTails: () => o.records.filter((e) => e.tailUntilMs !== null).map((e) => ({ poolId: e.poolId, reason: e.reason, tailUntilMs: e.tailUntilMs as UnixMs })),
    });
    return { w, classes };
  }

  it('the red team\'s repro: the tail started before a restart is restored after it, and polled at 0.1 Hz again', () => {
    let now = T0;
    const records: Ev[] = [];
    const a = mk({ now: () => now, records });
    a.w.recompute([rec(0, 'eligible', 100)]);
    a.w.recompute([]);                                                             // the universe moved p0 out
    const before = a.w.postEvictionTail();
    assert.equal(before.length, 1);
    now += 1_000;
    const b = mk({ now: () => now, records });                                      // worker restart
    assert.deepEqual(b.w.postEvictionTail(), before);
    assert.equal(b.classes.get('p0'), 'tail');
    // The tail still ends when it was due to.
    now = before[0]?.untilMs as number;
    b.w.recompute([]);
    assert.deepEqual([b.w.postEvictionTail(), b.classes.has('p0')], [[], false]);
    // A restart after the tail ended restores nothing.
    assert.deepEqual(mk({ now: () => now + 1, records }).w.postEvictionTail(), []);
  });

  it('a tail that cannot be restored (refused, over the cap, degraded) is recorded as tail_restart_cut', () => {
    const now = T0 + 1_000;
    const records: Ev[] = [
      { poolId: 'pa', atMs: T0 as UnixMs, reason: 'budget', tailUntilMs: (T0 + 9_000_000) as UnixMs },
      { poolId: 'pb', atMs: T0 as UnixMs, reason: 'budget', tailUntilMs: (T0 + 8_000_000) as UnixMs },
      { poolId: 'pc', atMs: T0 as UnixMs, reason: 'stale', tailUntilMs: (T0 + 7_000_000) as UnixMs },
    ];
    const r = mk({ now: () => now, records, watchOk: (id) => id !== 'pa', tailMaxPools: 1 });
    // pa refused by M04; pb restored (the cap is 1); pc over the cap.
    assert.deepEqual(r.w.postEvictionTail().map((t) => t.poolId), ['pb']);
    assert.deepEqual(records.slice(3).map((e) => [e.poolId, e.reason, e.atMs, e.tailUntilMs]), [['pa', 'tail_restart_cut', now, null], ['pc', 'tail_restart_cut', now, null]]);
    const d: Ev[] = records.slice(0, 1).map((e) => ({ ...e }));
    assert.deepEqual(mk({ now: () => now, records: d, mode: 'degraded_reads' }).w.postEvictionTail(), []);
    assert.equal(d.at(-1)?.reason, 'tail_restart_cut');
  });
});
