// GATE-1b: the deployer index, FEED-1's creates coverage contract (WatchOptions.coverage) and the create alias.
import { describe, expect, it } from 'vitest';
import { AsOfStore, OFF_CHAIN, SimClock, leakTest, replayOnce, type FeedEvent, type MarketEvent, type Moment, type ProofRun, type Strategy } from '../../src/engine/index.ts';
import {
  DAY_MS, DeployerIndex, HOUR_MS, createKey, rugCheckKey, type RugCheckFact, createsCoverage, deployerKey, evaluateHardRejects, evaluateSoftFeatures, type GateContext, type GateReason, type HardGate,
} from '../../src/gates/index.ts';
import { CONFIG } from '../fixtures.ts';
import { CHAIN_SKEW_MS, RUG_CHECK_CONFIG } from '../../src/config/index.ts';
import { CREATED_AT, DEV, MINT, NOW, SLOT, T, W, deps, drop, passingFacts, request, session, type Facts } from './world.ts';

const at = (receivedAt: number, slot: bigint, ix = OFF_CHAIN): Moment => ({ slot, txIndex: ix, ixIndex: ix, receivedAt });
const wrap = (value: unknown, seq = 1) => ({ value, source: 'worker', backfilled: false, seq });
const START = (via: string, fromSlot: bigint) => ['coverage:creates:start', wrap({ fromSlot, via })] as const;
const GAP = (via: string, fromSlot: bigint | null, toSlot: bigint | null, reason = 'disconnect') => ['coverage:creates:gap', wrap({ fromSlot, toSlot, reason, via })] as const;
const RESUME = (via: string, fromSlot: bigint, toSlot: bigint) => ['coverage:creates:resume', wrap({ fromSlot, toSlot, via })] as const;
const A = 'logs:pump-a';
const B = 'logs:pump-b';

type Row = readonly [string, unknown, Moment];
/** The passing world plus extra rows (several per key allowed), through a real AsOfStore. */
const contextWith = (rows: readonly Row[], base: Facts = passingFacts(), now: Moment = NOW, deployers?: DeployerIndex): GateContext => {
  const clock = new SimClock({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER });
  const store = new AsOfStore(clock);
  const all: Row[] = [...[...base].map(([k, { value, moment }]) => [k, value, moment] as Row), ...rows];
  all.sort((a, b) => (a[2].slot < b[2].slot ? -1 : a[2].slot > b[2].slot ? 1 : a[2].receivedAt - b[2].receivedAt));
  for (const [k, v, m] of all) {
    if (m.slot > now.slot || m.receivedAt > now.receivedAt) continue;
    clock.advanceTo(m);
    store.record(k, v, m, `${k}@${m.slot}`);
  }
  clock.advanceTo(now);
  return { now, observedTip: now.slot, lookup: (k, a) => store.lookup(k, a), history: (k, f, t) => store.history(k, f, t), ...(deployers ? { deployers } : {}) };
};
const h14 = (ctx: GateContext, rug?: 'RUG-1'): readonly GateReason[] =>
  evaluateHardRejects(ctx, deps('live', session(), rug), request(), { stopAtFirst: false }).reasons.filter((r) => r.gate === 'H14' || r.neededBy === ('H14' as HardGate));

const WINDOW = T - 14 * DAY_MS;
const old = (days: number, k = 0n) => at(T - days * DAY_MS, SLOT - BigInt(days) * 216_000n + k);

describe('creates coverage (FEED-1 contract)', () => {
  const cov = (rows: readonly Row[]) => {
    const ctx = contextWith(rows, new Map());
    return createsCoverage(ctx.history, ctx.now, WINDOW);
  };

  it('a start before the window and no gap covers', () => {
    expect(cov([[...START(A, 1n), old(30)]])).toEqual({ covered: true, fromMs: T - 30 * DAY_MS });
  });

  it('no start, or a start inside the window, is not covered', () => {
    expect(cov([]).covered).toBe(false);
    expect(cov([[...START(A, 1n), old(13)]]).covered).toBe(false);
  });

  it('an open gap at decision time is not covered, however old', () => {
    const r = cov([[...START(A, 1n), old(30)], [...GAP(A, 100n, null), old(20)]]);
    expect(r).toEqual({ covered: false, detail: expect.stringContaining('open gap') });
  });

  it('a resume after a lossless backfill covers', () => {
    expect(cov([[...START(A, 1n), old(30)], [...GAP(A, 100n, null), at(T - 3 * HOUR_MS, SLOT - 30_000n)], [...RESUME(A, 100n, 140n), at(T - 2 * HOUR_MS, SLOT - 20_000n)]]).covered).toBe(true);
  });

  it('a bounded lossy gap inside the window stays uncovered; one reported before the window does not matter', () => {
    const inside = cov([[...START(A, 1n), old(30)], [...GAP(A, 100n, null), old(5)], [...GAP(A, 100n, 150n), old(5, 10n)]]);
    expect(inside).toEqual({ covered: false, detail: expect.stringContaining('gap 100..150') });
    const before = cov([[...START(A, 1n), old(30)], [...GAP(A, 100n, null), old(20)], [...GAP(A, 100n, 150n), old(20, 10n)]]);
    expect(before).toEqual({ covered: true, fromMs: T - 20 * DAY_MS });
  });

  it('a resume must match via and fromSlot; another watch cannot close the gap', () => {
    expect(cov([[...START(A, 1n), old(30)], [...GAP(A, 100n, null), old(1)], [...RESUME(A, 101n, 140n), old(1, 5n)]]).covered).toBe(false);
    expect(cov([[...START(A, 1n), old(30)], [...GAP(A, 100n, null), old(1)], [...RESUME(B, 100n, 140n), old(1, 5n)]]).covered).toBe(false);
  });

  it('overlapping gaps from two watches: both must be settled', () => {
    const base: Row[] = [[...START(A, 1n), old(30)], [...START(B, 1n), old(30, 1n)], [...GAP(A, 100n, null), old(1)], [...GAP(B, 120n, null), old(1, 1n)]];
    expect(cov(base).covered).toBe(false);
    expect(cov([...base, [...RESUME(A, 100n, 160n), old(1, 9n)]]).covered).toBe(false);
    expect(cov([...base, [...RESUME(A, 100n, 160n), old(1, 9n)], [...RESUME(B, 120n, 170n), old(1, 10n)]]).covered).toBe(true);
    // One watch lossy while the other was up still counts as uncovered (the union is the safe side).
    expect(cov([...base, [...RESUME(A, 100n, 160n), old(1, 9n)], [...GAP(B, 120n, 170n), old(1, 10n)]]).covered).toBe(false);
  });

  it('an open gap settled by a new start on the same watch is a lossy range', () => {
    const r = cov([[...START(A, 1n), old(30)], [...GAP(A, 100n, null, 'halted'), old(3)], [...START(A, 900n), old(2)]]);
    expect(r).toEqual({ covered: false, detail: expect.stringContaining('started again') });
  });

  it('a gap without a start slot and an unreadable coverage fact are uncovered', () => {
    expect(cov([[...START(A, 1n), old(30)], [...GAP(A, null, null, 'refused'), old(1)]]).covered).toBe(false);
    expect(cov([[...START(A, 1n), old(30)], ['coverage:creates:gap', wrap({ toSlot: 5n }), old(1)]]).covered).toBe(false);
  });

  it("a start on another watch does not settle this watch's open gap", () => {
    expect(cov([[...START(A, 1n), old(30)], [...GAP(A, 100n, null), old(2)], [...START(B, 200n), old(1)]]).covered).toBe(false);
    // Even long before the window: B's start must not turn A's open gap into an old, settled one.
    expect(cov([[...START(A, 1n), old(30)], [...GAP(A, 100n, null), old(20)], [...START(B, 200n), old(19)]]).covered).toBe(false);
  });

  it('a gap reported after now is not seen (as of now)', () => {
    expect(cov([[...START(A, 1n), old(30)], [...GAP(A, 100n, null), at(T + 1, SLOT + 1n)]]).covered).toBe(true);
  });
});

describe('H14 reads coverage before trusting any deployer index', () => {
  it('an open gap at decision time rejects H14 as not covered, with the stored index too', () => {
    const r = h14(contextWith([[...GAP(A, 100n, null), old(1)]]));
    expect(r).toEqual([expect.objectContaining({ gate: 'H16', code: 'not-covered', input: 'coverage', neededBy: 'H14' })]);
  });

  it('H14 judges coverage over the 14-day look-back, not just 24 h: a lossy gap 3 days back rejects', () => {
    const r = h14(contextWith([[...GAP('logs:creates', 100n, null), old(3)], [...GAP('logs:creates', 100n, 150n), old(3, 10n)]]));
    expect(r).toEqual([expect.objectContaining({ gate: 'H16', code: 'not-covered', input: 'coverage', detail: expect.stringContaining('gap 100..150') })]);
  });

  it('the passing world (a 30-day start, no gaps) passes H14', () => {
    expect(h14(contextWith([]))).toEqual([]);
  });

  it('no coverage facts at all rejects', () => {
    const base = drop(passingFacts(), 'coverage:creates:start');
    expect(h14(contextWith([], base))).toEqual([expect.objectContaining({ code: 'not-covered', input: 'coverage' })]);
  });
});

/** A create event as FEED-1 emits it from logs (`logs:pump:CreateEvent:<mint>`) or a fetched tx (`pump:CreateEvent:<mint>`). */
const createEvent = (mint: string, creator: string, createdAtMs: number, slot: bigint) => ({
  event: { name: 'CreateEvent', program: 'pump', data: { mint, creator, timestamp: BigInt(createdAtMs / 1_000), name: 'x', symbol: 'x', uri: '' } },
  signature: `sig-${mint}`, txSlot: slot, truncated: false, via: 'logs:pump', source: 'helius', backfilled: false, seq: 1,
});
const marketOf = (key: string, value: unknown, moment: Moment, id = key): MarketEvent => ({ kind: 'market', id, moment, key, value });
/** An index that has watched since the creates stream started (30 days ago): it sees the start fact first. */
const started = (): DeployerIndex => {
  const idx = new DeployerIndex();
  idx.observe(marketOf('coverage:creates:start', wrap({ fromSlot: SLOT - 6_000_000n, via: 'logs:creates' }), at(T - 30 * DAY_MS, SLOT - 6_000_000n)));
  return idx;
};

describe('deployer index', () => {
  it('OOM-MINT: prune drops in memory exactly what a save at the same line leaves out; mints inside the look-back still count', () => {
    const idx = started();
    const line = T - 15 * DAY_MS;
    const ages = [2 * DAY_MS, 14 * DAY_MS, 15 * DAY_MS - 1_000, 15 * DAY_MS + 1_000, 20 * DAY_MS];
    ages.forEach((age, k) => idx.observe(marketOf(`logs:pump:CreateEvent:A${k}`, createEvent(`A${k}`, DEV, T - age, SLOT - 6_000_000n + BigInt(k)), at(T - 29 * DAY_MS + k, SLOT - 6_000_000n + BigInt(k)))));
    idx.observe(marketOf('rug:OldRug', { mint: 'OldRug', creator: DEV }, at(T - 16 * DAY_MS, SLOT - 3_000_000n)));
    idx.observe(marketOf('rug:NewRug', { mint: 'NewRug', creator: DEV }, at(T - 3 * DAY_MS, SLOT - 600_000n)));
    const saved = idx.snapshot(NOW, line);
    const before = idx.factFor(DEV, NOW, T - 30 * DAY_MS);
    idx.prune(line);
    const after = idx.factFor(DEV, NOW, T - 30 * DAY_MS);
    // What stays in memory is what the save at that line holds.
    expect(after.mints.map((m) => [m.mint, m.createdAtMs])).toEqual(saved.mints.flatMap(([, rows]) => rows).sort(([a], [b]) => (a < b ? -1 : 1)));
    expect(after.mints.map((m) => m.mint)).toEqual(['A0', 'A1', 'A2']);
    expect(after.rugs.map((r) => r.mint)).toEqual(['NewRug']);
    // Every mint inside the H14 look-back (14 days) still counts, as before the prune.
    const inside = (f: typeof before) => f.mints.filter((m) => m.createdAtMs >= T - 14 * DAY_MS).map((m) => m.mint);
    expect(inside(after)).toEqual(inside(before));
  });

  it('counts each create once across logs and fetched transactions, per creator, as of now', () => {
    const idx = new DeployerIndex();
    idx.observe(marketOf(`logs:pump:CreateEvent:${MINT}`, createEvent(MINT, DEV, CREATED_AT, SLOT - 20_000n), at(CREATED_AT, SLOT - 20_000n)));
    idx.observe(marketOf(`pump:CreateEvent:${MINT}`, createEvent(MINT, DEV, CREATED_AT, SLOT - 20_000n), at(CREATED_AT + 400, SLOT - 19_999n)));
    idx.observe(marketOf('logs:pump:CreateEvent:M2', createEvent('M2', DEV, T - HOUR_MS, SLOT - 9_000n), at(T - HOUR_MS, SLOT - 9_000n)));
    idx.observe(marketOf('logs:pump:CreateEvent:M3', createEvent('M3', W(9), T - HOUR_MS, SLOT - 9_000n), at(T - HOUR_MS, SLOT - 9_000n)));
    idx.observe(marketOf('rug:Old', { mint: 'Old', creator: DEV }, at(T - 3 * DAY_MS, SLOT - 600_000n)));
    idx.observe(marketOf('logs:pump:CreateEvent:bad', { event: { name: 'CreateEvent', data: { mint: 'bad' } } }, at(T - 1, SLOT - 1n)));
    const f = idx.factFor(DEV, NOW, T - 30 * DAY_MS);
    expect(f.mints).toEqual([{ mint: 'M2', createdAtMs: T - HOUR_MS }, { mint: MINT, createdAtMs: CREATED_AT }].sort((a, b) => (a.mint < b.mint ? -1 : 1)));
    expect(f.rugs).toEqual([{ mint: 'Old', knownAtMs: T - 3 * DAY_MS }]);
    // As of an earlier moment, later entries are left out.
    expect(idx.factFor(DEV, at(T - 2 * HOUR_MS, SLOT - 18_000n), 0).mints).toEqual([{ mint: MINT, createdAtMs: CREATED_AT }]);
  });

  it('feeds H14 when the context carries it: a third mint in 24 h rejects, a rug label rejects (with RUG-1)', () => {
    const idx = started();
    for (const [m, t] of [[MINT, CREATED_AT], ['M2', T - HOUR_MS], ['M3', T - 2 * HOUR_MS]] as const) {
      idx.observe(marketOf(`logs:pump:CreateEvent:${m}`, createEvent(m, DEV, t, SLOT - 5_000n), at(t, SLOT - 5_000n)));
    }
    const base = drop(passingFacts(), deployerKey(DEV));
    expect(h14(contextWith([], base, NOW, idx)).map((r) => r.code)).toEqual(['serial-deployer']);
    const rug = started();
    rug.observe(marketOf('rug:Old', { mint: 'Old', creator: DEV }, at(T - DAY_MS, SLOT - 200_000n)));
    expect(h14(contextWith([], base, NOW, rug), 'RUG-1').map((r) => r.code)).toEqual(['prior-rug']);
    expect(h14(contextWith([], base, NOW, started()), 'RUG-1')).toEqual([]);
  });

  it('keeps the earliest create time per mint (a later copy cannot move it inside 24 h)', () => {
    const idx = started();
    const early = T - DAY_MS - 60_000;
    idx.observe(marketOf('pump:CreateEvent:E', createEvent('E', DEV, early, SLOT - 220_000n), at(early, SLOT - 220_000n)));
    idx.observe(marketOf('logs:pump:CreateEvent:E', createEvent('E', DEV, T - HOUR_MS, SLOT - 9_000n), at(T - HOUR_MS, SLOT - 9_000n)));
    expect(idx.factFor(DEV, NOW, 0).mints).toEqual([{ mint: 'E', createdAtMs: early }]);
    // And the reverse order: the earlier copy arriving second wins.
    const rev = started();
    rev.observe(marketOf('logs:pump:CreateEvent:E', createEvent('E', DEV, T - HOUR_MS, SLOT - 9_000n), at(T - HOUR_MS, SLOT - 9_000n)));
    rev.observe(marketOf('pump:CreateEvent:E', createEvent('E', DEV, early, SLOT - 9_000n), at(T - HOUR_MS + 1, SLOT - 9_000n)));
    expect(rev.factFor(DEV, NOW, 0).mints).toEqual([{ mint: 'E', createdAtMs: early }]);
  });

  it("keeps a rug's first-known time", () => {
    const idx = started();
    idx.observe(marketOf('rug:Old', { mint: 'Old', creator: DEV }, at(T - 20 * DAY_MS, SLOT - 4_000_000n)));
    idx.observe(marketOf('rug:Old', { mint: 'Old', creator: DEV }, at(T - DAY_MS, SLOT - 200_000n), 'rug-again'));
    expect(idx.factFor(DEV, NOW, 0).rugs).toEqual([{ mint: 'Old', knownAtMs: T - 20 * DAY_MS }]);
    const base = drop(passingFacts(), deployerKey(DEV));
    expect(h14(contextWith([], base, NOW, idx), 'RUG-1')).toEqual([]); // known 20 days ago: outside the 14-day look-back
  });

  it("an index fed only from after the window start (a restart) is not covered, even when the stream's facts are", () => {
    const late = new DeployerIndex();
    late.observe(marketOf('tick', 0, at(T - 3 * DAY_MS, SLOT - 600_000n)));
    const base = drop(passingFacts(), deployerKey(DEV));
    expect(h14(contextWith([], base, NOW, late))).toEqual([expect.objectContaining({ gate: 'H16', code: 'not-covered', input: 'deployer' })]);
    expect(h14(contextWith([], base, NOW, new DeployerIndex()))).toEqual([expect.objectContaining({ code: 'not-covered', input: 'deployer' })]);
  });

  it('a cut or undecodable creates log inside the window is uncovered until its transaction is fetched', () => {
    const base = drop(passingFacts(), deployerKey(DEV));
    const via = 'logs:creates';
    for (const [key, value] of [
      [`logs:truncated:${via}`, { signature: 'SigCut', source: 'helius', backfilled: false, seq: 3 }],
      [`logs:undecodable:${via}`, { signature: 'SigCut', error: 'bad', source: 'helius', backfilled: false, seq: 3 }],
      ['logs:pump:TradeEvent:X', { event: { name: 'TradeEvent', data: {} }, signature: 'SigCut', txSlot: SLOT - 9_000n, truncated: true, via, source: 'helius', backfilled: false, seq: 3 }],
    ] as const) {
      const idx = started();
      idx.observe(marketOf(key, value, at(T - HOUR_MS, SLOT - 9_000n)));
      expect(h14(contextWith([], base, NOW, idx))).toEqual([expect.objectContaining({ gate: 'H16', code: 'not-covered', input: 'coverage', detail: expect.stringContaining('SigCut') })]);
      idx.observe(marketOf('pump:CreateEvent:Z', createEvent('Z', W(5), T - HOUR_MS, SLOT - 9_000n), at(T - HOUR_MS + 5, SLOT - 9_000n), 'ev:SigCut:000:000'));
      expect(h14(contextWith([], base, NOW, idx))).toEqual([]);
    }
    // Another watch's cut log, or one before the window, does not count.
    const other = started();
    other.observe(marketOf('logs:truncated:logs:trades', { signature: 'S2' }, at(T - HOUR_MS, SLOT - 9_000n)));
    other.observe(marketOf(`logs:truncated:${via}`, { signature: 'S3' }, at(T - 15 * DAY_MS, SLOT - 3_000_000n)));
    expect(h14(contextWith([], base, NOW, other))).toEqual([]);
  });
});

describe('rug labels unavailable (RUG-1 review: not covered, never zero rugs)', () => {
  const notCovered = (r: { reasons: readonly GateReason[] }) => r.reasons.filter((x) => x.gate === 'H16' && x.neededBy === 'H14');

  it.each(['live', 'backtest'] as const)('without the labeller wired, H14 rejects as not covered, even with rug facts (%s)', (mode) => {
    const idx = started();
    idx.observe(marketOf('rug:Old', { mint: 'Old', creator: DEV }, at(T - DAY_MS, SLOT - 200_000n)));
    const r = evaluateHardRejects(contextWith([], drop(passingFacts(), deployerKey(DEV)), NOW, idx), deps(mode, session(), null), request(), { stopAtFirst: false });
    expect(notCovered(r)).toEqual([{ gate: 'H16', code: 'not-covered', input: 'coverage', neededBy: 'H14', detail: 'rug labels unavailable (no reviewed labeller; RUG-1)' }]);
    expect(r.reasons.filter((x) => x.code === 'prior-rug')).toEqual([]);
    expect(r.passed).not.toContain('H14');
    const soft = evaluateSoftFeatures(contextWith([]), deps(mode, session(), null), MINT).features.find((f) => f.name === 'indexRugs');
    expect(soft).toEqual({ name: 'indexRugs', value: null, note: expect.stringContaining('rug labels unavailable') });
  });

  it('the deployer-count half is still reported without rug labels', () => {
    const idx = started();
    for (const [m, t] of [[MINT, CREATED_AT], ['M2', T - HOUR_MS], ['M3', T - 2 * HOUR_MS]] as const) {
      idx.observe(marketOf(`logs:pump:CreateEvent:${m}`, createEvent(m, DEV, t, SLOT - 5_000n), at(t, SLOT - 5_000n)));
    }
    const r = evaluateHardRejects(contextWith([], drop(passingFacts(), deployerKey(DEV)), NOW, idx), deps('live', session(), null), request(), { stopAtFirst: false });
    expect(r.reasons).toContainEqual(expect.objectContaining({ gate: 'H14', code: 'serial-deployer' }));
    expect(notCovered(r)).toHaveLength(1);
  });

  it('with RUG-1 wired, a labeller with an open gap or no start is not covered; covered, H14 passes', () => {
    const gap: Row = ['coverage:rugs:gap', wrap({ fromSlot: SLOT - 100n, toSlot: null, reason: 'halted', via: 'rug-labeller' }), at(T - HOUR_MS, SLOT - 9_000n)];
    const r = evaluateHardRejects(contextWith([gap]), deps('live'), request(), { stopAtFirst: false });
    expect(notCovered(r)).toEqual([expect.objectContaining({ input: 'coverage', detail: expect.stringContaining('RUG-1 coverage: open gap') })]);
    const noStart = evaluateHardRejects(contextWith([], drop(passingFacts(), 'coverage:rugs:start')), deps('live'), request(), { stopAtFirst: false });
    expect(notCovered(noStart)).toEqual([expect.objectContaining({ input: 'coverage', detail: expect.stringContaining('no rugs coverage start') })]);
    const ok = evaluateHardRejects(contextWith([]), deps('live'), request(), { stopAtFirst: false });
    expect(notCovered(ok)).toEqual([]);
    expect(ok.passed).toContain('H14');
  });

  it('an unjudged mint by the deployer in the look-back makes H14 not covered; outside it, or the candidate itself, does not', () => {
    const run = (mint: string, days: number) => {
      const idx = started();
      idx.observe(marketOf(`rug-unjudged:${mint}`, { mint, creator: DEV, reason: 'the create carries no total supply' }, old(days)));
      return notCovered(evaluateHardRejects(contextWith([], drop(passingFacts(), deployerKey(DEV)), NOW, idx), deps('live'), request(), { stopAtFirst: false }));
    };
    expect(run('Old', 3)).toEqual([expect.objectContaining({ input: 'deployer', detail: expect.stringContaining('could not judge Old') })]);
    expect(run('Old', 15)).toEqual([]);
    expect(run(MINT, 3)).toEqual([]);
  });

  it('labels and unjudged mints are known from their full moment, not their receipt time alone', () => {
    const idx = started();
    const m: Moment = { slot: SLOT - 10n, txIndex: 5, ixIndex: 0, receivedAt: T - HOUR_MS };
    idx.observe(marketOf('rug:Old', { mint: 'Old', creator: DEV }, m));
    idx.observe(marketOf('rug-unjudged:U', { mint: 'U', creator: DEV }, m));
    const f = (now: Moment) => idx.factFor(DEV, now, 0);
    expect(f({ ...m, txIndex: 4 }).rugs).toEqual([]);
    expect(f({ ...m, txIndex: 4 }).unjudged).toEqual([]);
    expect(f(m).rugs).toEqual([{ mint: 'Old', knownAtMs: T - HOUR_MS }]);
    expect(f(m).unjudged).toEqual([{ mint: 'U', knownAtMs: T - HOUR_MS }]);
  });
});

describe('on-demand deployer check (RUG-1c)', () => {
  const notCovered = (r: { reasons: readonly GateReason[] }) => r.reasons.filter((x) => x.gate === 'H16' && x.neededBy === 'H14');
  const noStream = drop(drop(passingFacts(), deployerKey(DEV)), 'coverage:rugs:start');
  const withPrior = () => {
    const idx = started();
    idx.observe(marketOf('logs:pump:CreateEvent:P1', createEvent('P1', DEV, T - 3 * DAY_MS, SLOT - 600_000n), old(3)));
    return idx;
  };
  const check = (over: Partial<RugCheckFact> = {}, mints: RugCheckFact['mints'] = [{ mint: 'P1', createdAtMs: T - 3 * DAY_MS, status: 'clear', detail: '' }]): Row =>
    [rugCheckKey(DEV), wrap({ obs: { provider: 'rug-check', slot: SLOT - 10n, receivedAt: T - 1_000, quality: [], commitment: 'confirmed' }, creator: DEV, version: 'rug-check-1', fromMs: T - 15 * DAY_MS, asOfMs: T - 5_000, mints, credits: 7, ...over }), at(T - 1_000, SLOT - 10n)];
  const h = (rows: Row[], idx = withPrior()) => evaluateHardRejects(contextWith(rows, noStream, NOW, idx), deps('live'), request(), { stopAtFirst: false });

  it('without stream coverage or a check, H14 is not covered', () => {
    expect(notCovered(h([]))).toEqual([expect.objectContaining({ detail: expect.stringContaining('deployer check: no rug-check') })]);
  });

  it('a fresh, complete check covers the deployer: clear and open pass, a rug rejects', () => {
    const ok = h([check()]);
    expect(notCovered(ok)).toEqual([]);
    expect(ok.passed).toContain('H14');
    const open = h([check({}, [{ mint: 'P1', createdAtMs: T - 3 * DAY_MS, status: 'open', detail: '' }])]);
    expect(notCovered(open)).toEqual([]);
    expect(open.reasons.filter((x) => x.code === 'prior-rug')).toEqual([]);
    const rug = h([check({}, [{ mint: 'P1', createdAtMs: T - 3 * DAY_MS, status: 'rug', detail: 'collapse' }])]);
    expect(rug.reasons).toContainEqual(expect.objectContaining({ gate: 'H14', code: 'prior-rug', detail: expect.stringContaining('P1 (unknown kind)') }));
  });

  it('a check that missed, could not read or could not judge a prior mint is not coverage', () => {
    expect(notCovered(h([check({}, [])]))).toEqual([expect.objectContaining({ detail: expect.stringContaining('did not list P1') })]);
    for (const status of ['unfetched', 'unjudged'] as const) {
      expect(notCovered(h([check({}, [{ mint: 'P1', createdAtMs: T - 3 * DAY_MS, status, detail: 'x' }])]))).toHaveLength(1);
    }
  });

  it('a check for another deployer, from after the look-back start, too old, or in the future is not coverage', () => {
    expect(notCovered(h([check({ creator: W(9) })]))).toHaveLength(1);
    // The check must list mints from one rug window (1 day) before the 14-day look-back.
    expect(notCovered(h([check({ fromMs: T - 15 * DAY_MS + 1 })]))).toHaveLength(1);
    expect(notCovered(h([check({ fromMs: T - 15 * DAY_MS })]))).toEqual([]);
    const lag = RUG_CHECK_CONFIG.maxLagSlots;
    const at = (slot: bigint) => check({ obs: { provider: 'rug-check', slot, receivedAt: T - 1_000, quality: [], commitment: 'confirmed' } });
    expect(notCovered(h([at(SLOT - BigInt(lag))]))).toEqual([]);
    expect(notCovered(h([at(SLOT - BigInt(lag) - 1n)]))).toHaveLength(1);
    expect(notCovered(h([at(SLOT + 1n)]))).toHaveLength(1);
  });

  it('a check at processed commitment or in another shape is refused', () => {
    expect(notCovered(h([check({ obs: { provider: 'rug-check', slot: SLOT - 10n, receivedAt: T - 1_000, quality: [], commitment: 'processed' } })]))).toHaveLength(1);
    expect(notCovered(h([[rugCheckKey(DEV), wrap({ creator: DEV }), at(T - 1_000, SLOT - 10n)]]))).toHaveLength(1);
  });

  it('the check needs neither the candidate itself nor mints from before the look-back', () => {
    const idx = withPrior();
    idx.observe(marketOf(`logs:pump:CreateEvent:${MINT}`, createEvent(MINT, DEV, CREATED_AT, SLOT - 20_000n), at(CREATED_AT, SLOT - 20_000n)));
    idx.observe(marketOf('logs:pump:CreateEvent:Old', createEvent('Old', DEV, T - 15 * DAY_MS - 1_000, SLOT - 3_240_000n), old(15)));
    expect(notCovered(h([check()], idx))).toEqual([]);
  });

  it('names the kind of each prior rug: a deployer sale or a collapse', () => {
    const idx = withPrior();
    idx.observe(marketOf('rug:P1', { mint: 'P1', creator: DEV, rule: 'creator-dump', evidence: 'observed' }, old(2)));
    idx.observe(marketOf('rug:P2', { mint: 'P2', creator: DEV, rule: 'collapse', evidence: 'observed' }, old(1)));
    expect(idx.factFor(DEV, NOW, 0).rugs).toEqual([{ mint: 'P1', knownAtMs: T - 2 * DAY_MS, kind: 'creator-dump' }, { mint: 'P2', knownAtMs: T - DAY_MS, kind: 'collapse' }]);
    const r = evaluateHardRejects(contextWith([], drop(passingFacts(), deployerKey(DEV)), NOW, idx), deps('live'), request(), { stopAtFirst: false });
    expect(r.reasons).toContainEqual(expect.objectContaining({ code: 'prior-rug', detail: `${DEV} rugged P1 (creator-dump), P2 (collapse) within 14 days`, value: '2' }));
  });

  it('a rug known to the index without a kind takes the kind the check found', () => {
    const idx = withPrior();
    idx.observe(marketOf('rug:P1', { mint: 'P1', creator: DEV }, old(2)));
    const lab = { mint: 'P1', creator: DEV, rule: 'collapse', evidence: 'observed', atMs: 0, slot: 1n, version: 'v', detail: '', venue: 'curve', amounts: { peak: 2n, level: 0n } };
    const r = h([check({}, [{ mint: 'P1', createdAtMs: T - 3 * DAY_MS, status: 'rug', detail: 'collapse', label: lab as never }])], idx);
    expect(r.reasons).toContainEqual(expect.objectContaining({ code: 'prior-rug', detail: `${DEV} rugged P1 (collapse) within 14 days` }));
  });

  it('after a restart gap in the rug stream, a deployer checked on demand is covered, and only that deployer', () => {
    // The stream started 30 days ago and has an open restart gap since an hour ago (PERSIST-1).
    const restart: Row = ['coverage:rugs:gap', wrap({ fromSlot: SLOT - 9_000n, toSlot: null, reason: 'restart', via: 'rug-labeller' }), at(T - HOUR_MS, SLOT - 9_000n)];
    const withGap = drop(passingFacts(), deployerKey(DEV));
    const run = (rows: Row[]) => evaluateHardRejects(contextWith(rows, withGap, NOW, withPrior()), deps('live'), request(), { stopAtFirst: false });
    expect(notCovered(run([restart]))).toEqual([expect.objectContaining({ detail: expect.stringContaining('open gap') })]);
    expect(notCovered(run([restart, check()]))).toEqual([]);
    // A check of another deployer covers nothing for this one.
    expect(notCovered(run([restart, check({ creator: W(9) }), [rugCheckKey(W(9)), wrap({}), at(T - 1_000, SLOT - 10n)]]))).toHaveLength(1);
    // A check that could not read every prior mint leaves this deployer not covered.
    expect(notCovered(run([restart, check({}, [{ mint: 'P1', createdAtMs: T - 3 * DAY_MS, status: 'unfetched', detail: 'credit cap 500 reached' }])]))).toHaveLength(1);
  });

  it('a mint launched less than one rug window before the look-back must be in the check: it could be labelled inside the look-back', () => {
    const idx = withPrior();
    // Launched 1 h before the 14-day look-back starts; the stream path would count a dump of it an hour later.
    idx.observe(marketOf('logs:pump:CreateEvent:Edge', createEvent('Edge', DEV, T - 14 * DAY_MS - HOUR_MS, SLOT - 3_030_000n), old(14, -1n)));
    expect(notCovered(h([check({ fromMs: T - 14 * DAY_MS })], idx))).toEqual([expect.objectContaining({ detail: expect.stringContaining('must list mints from') })]);
    // Listed from early enough but without the edge mint: not covered either.
    expect(notCovered(h([check()], idx))).toEqual([expect.objectContaining({ detail: expect.stringContaining('did not list Edge') })]);
    const listed = check({ fromMs: T - 15 * DAY_MS }, [
      { mint: 'P1', createdAtMs: T - 3 * DAY_MS, status: 'clear', detail: '' },
      { mint: 'Edge', createdAtMs: T - 14 * DAY_MS - HOUR_MS, status: 'rug', detail: 'creator-dump' },
    ]);
    const r = h([listed], idx);
    expect(notCovered(r)).toEqual([]);
    expect(r.reasons).toContainEqual(expect.objectContaining({ code: 'prior-rug', detail: expect.stringContaining('Edge') }));
    // Exactly one window before the look-back start is still required.
    const exact = withPrior();
    exact.observe(marketOf('logs:pump:CreateEvent:Exact', createEvent('Exact', DEV, T - 15 * DAY_MS, SLOT - 3_240_000n), old(15)));
    expect(notCovered(h([check({ fromMs: T - 15 * DAY_MS })], exact))).toEqual([expect.objectContaining({ detail: expect.stringContaining('did not list Exact') })]);
    // A mint launched more than a window before the look-back cannot be labelled inside it and is not required.
    const far = withPrior();
    far.observe(marketOf('logs:pump:CreateEvent:Far', createEvent('Far', DEV, T - 16 * DAY_MS, SLOT - 3_456_000n), old(16)));
    expect(notCovered(h([check({ fromMs: T - 15 * DAY_MS })], far))).toEqual([]);
  });

  it('the stream coverage, when present, is used and a check is not needed', () => {
    const idx = withPrior();
    expect(notCovered(evaluateHardRejects(contextWith([], drop(passingFacts(), deployerKey(DEV)), NOW, idx), deps('live'), request(), { stopAtFirst: false }))).toEqual([]);
  });
});

describe('create alias', () => {
  const base = drop(passingFacts(), createKey(MINT));
  const run = (rows: Row[]) => evaluateHardRejects(contextWith(rows, base), deps('live'), request(), { stopAtFirst: false }).reasons;

  it("reads FEED-1's confirmed create from a fetched transaction", () => {
    const r = run([[`pump:CreateEvent:${MINT}`, createEvent(MINT, DEV, CREATED_AT, SLOT - 20_000n), at(CREATED_AT, SLOT - 20_000n)]]);
    expect(r.filter((x) => x.input === 'create')).toEqual([]);
  });

  it('refuses a create read only from the processed logs stream (H16 degraded)', () => {
    const r = run([[`logs:pump:CreateEvent:${MINT}`, createEvent(MINT, DEV, CREATED_AT, SLOT - 20_000n), at(CREATED_AT, SLOT - 20_000n)]]);
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'degraded', input: 'create', value: 'processed' }));
  });

  it("refuses another mint's create under this key", () => {
    const r = run([[`pump:CreateEvent:${MINT}`, createEvent('Other', DEV, CREATED_AT, SLOT - 20_000n), at(CREATED_AT, SLOT - 20_000n)]]);
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'malformed', input: 'create' }));
  });
});

describe('leak test with the deployer index in the engine', () => {
  const TOKEN = 'FutureDeployerMarker111111111111111111111111';
  const MARKER: Moment = { slot: SLOT + 3n, txIndex: 0, ixIndex: 0, receivedAt: T + 1_200 };
  const proof = (): ProofRun => {
    const events: FeedEvent[] = [...passingFacts()].filter(([k]) => k !== deployerKey(DEV)).map(([key, { value, moment }], i) => ({ kind: 'market', id: `f${i}:${key}`, moment, key, value }));
    events.push({ kind: 'market', id: 'c0', moment: at(CREATED_AT, SLOT - 20_000n, 1), key: `logs:pump:CreateEvent:${MINT}`, value: createEvent(MINT, DEV, CREATED_AT, SLOT - 20_000n) });
    for (let k = 0; k <= 5; k++) {
      const m = { slot: SLOT + BigInt(k), txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: T + k * 400 };
      events.push({ kind: 'market', id: `head${k}`, moment: { ...m, txIndex: 0, ixIndex: 1 }, key: 'gates/stream:chain', value: { obs: { provider: 'test', slot: m.slot, receivedAt: m.receivedAt, quality: [], commitment: 'confirmed' }, gapFreeSince: SLOT - 10_000n } });
      events.push({ kind: 'market', id: `tick${k}`, moment: m, key: 'tick', value: k });
    }
    // Planted at the marker: two more creates by the dev (serial), a rug label and an open coverage gap.
    events.push(
      { kind: 'market', id: 'p0', moment: { ...MARKER, ixIndex: 0 }, key: `logs:pump:CreateEvent:${TOKEN}`, value: createEvent(TOKEN, DEV, T, MARKER.slot) },
      { kind: 'market', id: 'p1', moment: { ...MARKER, ixIndex: 1 }, key: 'logs:pump:CreateEvent:P2', value: { ...createEvent('P2', DEV, T, MARKER.slot), note: TOKEN } },
      { kind: 'market', id: 'p2', moment: { ...MARKER, ixIndex: 2 }, key: `rug:${TOKEN}`, value: { mint: TOKEN, creator: DEV } },
      { kind: 'market', id: 'p3', moment: { ...MARKER, ixIndex: 3 }, key: 'coverage:creates:gap', value: wrap({ fromSlot: SLOT, toSlot: null, reason: 'disconnect', via: TOKEN }) },
    );
    const strategy = (): Strategy => {
      const idx = new DeployerIndex();
      return {
        onMarket: (e, ctx) => {
          idx.observe(e);
          if (e.key !== 'tick') return [];
          const r = evaluateHardRejects({ now: ctx.now, observedTip: ctx.now.slot, lookup: ctx.lookup, history: ctx.history, deployers: idx }, deps('backtest'), request(), { stopAtFirst: false });
          return [{ action: null, reasons: [...r.reasons.map((x) => `${x.gate}:${x.code}:${x.input ?? ''}:${x.detail}`), `pass=${r.pass}`] }];
        },
      };
    };
    return { events, strategy, seed: 'gates-1b', book: CONFIG, start: { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER } };
  };

  it('passes before the marker, sees nothing planted early, and rejects after it', () => {
    const report = leakTest(proof(), { at: MARKER, token: TOKEN }, { rug: TOKEN });
    expect(report.violations).toEqual([]);
    const decisions = replayOnce(proof()).records.filter((r) => r.type === 'decision');
    const before = decisions.filter((r) => r.type === 'decision' && r.at.slot < MARKER.slot);
    const after = decisions.filter((r) => r.type === 'decision' && r.at.slot > MARKER.slot);
    expect(before.length).toBeGreaterThan(0);
    // One-shot pool and holder reads go stale after 2 slots; the first ticks are fully fresh and pass.
    for (const d of before) if (d.type === 'decision' && d.at.slot <= SLOT + 1n) expect(d.reasons).toEqual(['pass=true']);
    const late = after.flatMap((r) => (r.type === 'decision' ? r.reasons : []));
    expect(late.some((x) => x.startsWith('H16:not-covered:coverage'))).toBe(true);
  });
});

describe('SEED-1: seeding the index at start-up', () => {
  // A restart one hour ago: the live creates watch started then, the seed covers the 20 days before it.
  const LIVE = at(T - HOUR_MS, SLOT - 9_000n);
  const ASOF = LIVE;
  const liveStart: Row = [...START('logs:creates', SLOT - 9_000n), LIVE];
  const seedStart = (days = 20): MarketEvent => marketOf('coverage:creates:start', wrap({ fromSlot: SLOT - BigInt(days) * 216_000n, via: 'seed' }), old(days), 'seed:coverage:start:0');
  const seedGap = (fromDays: number, toDays: number): MarketEvent =>
    marketOf('coverage:creates:gap', wrap({ fromSlot: SLOT - BigInt(fromDays) * 216_000n, toSlot: SLOT - BigInt(toDays) * 216_000n, reason: 'unit gap', via: 'seed' }), old(toDays), 'seed:coverage:gap:1');
  const seedCreate = (mint: string, creator: string, t: number, slot: bigint): MarketEvent => marketOf(`pump:CreateEvent:${mint}`, createEvent(mint, creator, t, slot), at(t, slot, 7), `ev:seed-${mint}:00000:00000`);
  const rows = (coverage: readonly MarketEvent[]): Row[] => [...coverage.map((e): Row => [e.key, e.value, e.moment]), liveStart];
  const base = drop(drop(passingFacts(), deployerKey(DEV)), 'coverage:creates:start');
  /** A restarted index: seeded, then fed the live stream's start. */
  const restarted = (creates: readonly MarketEvent[], coverage: readonly MarketEvent[]): DeployerIndex => {
    const idx = new DeployerIndex();
    idx.seed(creates, coverage, ASOF);
    idx.observe(marketOf('coverage:creates:start', liveStart[1], LIVE));
    return idx;
  };

  it('without a seed a restart is not covered for the look-back; a gap-free seed covers it and its creates count', () => {
    const unseeded = new DeployerIndex();
    unseeded.observe(marketOf('coverage:creates:start', liveStart[1], LIVE));
    expect(h14(contextWith([liveStart], base, NOW, unseeded))).toEqual([expect.objectContaining({ gate: 'H16', code: 'not-covered' })]);
    const cov = [seedStart()];
    expect(h14(contextWith(rows(cov), base, NOW, restarted([], cov)))).toEqual([]);
    // Seeded creates are counted: two more mints by the dev inside 24 h make a serial deployer.
    const creates = [seedCreate('S1', DEV, T - 5 * HOUR_MS, SLOT - 45_000n), seedCreate('S2', DEV, T - 4 * HOUR_MS, SLOT - 36_000n)];
    expect(h14(contextWith(rows(cov), base, NOW, restarted(creates, cov))).map((r) => r.code)).toEqual(['serial-deployer']);
  });

  it('a gap in the seeded range stays a gap: H14 is not covered while it is inside the look-back', () => {
    const cov = [seedStart(), seedGap(6, 5)];
    expect(h14(contextWith(rows(cov), base, NOW, restarted([], cov)))).toEqual([expect.objectContaining({ gate: 'H16', code: 'not-covered', input: 'coverage' })]);
    // Older than the look-back, it no longer matters.
    const aged = [seedStart(), seedGap(17, 16)];
    expect(h14(contextWith(rows(aged), base, NOW, restarted([], aged)))).toEqual([]);
  });

  it('rugs are not seeded: after a restart the rug half stays not covered until the labeller has watched the look-back', () => {
    const cov = [seedStart()];
    const noRugs = drop(base, 'coverage:rugs:start');
    const rugLive: Row = ['coverage:rugs:start', wrap({ fromSlot: SLOT - 9_000n, via: 'rug-labeller' }), at(T - HOUR_MS + 1, SLOT - 9_000n)];
    expect(h14(contextWith([...rows(cov), rugLive], noRugs, NOW, restarted([], cov)))).toEqual([expect.objectContaining({ gate: 'H16', code: 'not-covered' })]);
  });

  it('a seed whose coverage never reaches the engine is not covered (H14 reads coverage only from history)', () => {
    const cov = [seedStart()];
    expect(h14(contextWith([liveStart], base, NOW, restarted([], cov)))).toEqual([expect.objectContaining({ gate: 'H16', code: 'not-covered' })]);
  });

  it('a seed without a coverage start leaves the index start at its first live event', () => {
    const idx = restarted([seedCreate('S1', DEV, T - 5 * HOUR_MS, SLOT - 45_000n)], []);
    expect(idx.factFor(DEV, NOW, 0).coverageFromMs).toBe(LIVE.receivedAt);
  });

  it('leak guard: nothing dated after the process start is seeded, and a refused seed changes nothing', () => {
    // Released after ASOF (T - 1 h) though its chain time is before it: the moment alone refuses it.
    const future = marketOf('pump:CreateEvent:FUTURE', createEvent('FUTURE', DEV, T - 2 * HOUR_MS, SLOT - 4_500n), at(T - 30 * 60_000, SLOT - 4_500n), 'ev:FUTURE:00000:00000');
    const idx = new DeployerIndex();
    expect(() => idx.seed([future], [seedStart()], ASOF)).toThrow(/dated after the process start/);
    expect(() => idx.seed([], [marketOf('coverage:creates:gap', wrap({}), NOW)], ASOF)).toThrow(/dated after the process start/);
    // A create placed before ASOF but whose chain time is after it is refused too.
    const late = marketOf('pump:CreateEvent:L', createEvent('L', DEV, T, SLOT - 50_000n), at(T - 2 * HOUR_MS, SLOT - 50_000n), 'ev:L:00000:00000');
    expect(() => idx.seed([late], [seedStart()], ASOF)).toThrow(/chain time after/);
    expect(idx.factFor(DEV, NOW, 0)).toMatchObject({ mints: [], coverageFromMs: Number.MAX_SAFE_INTEGER });
    expect(idx.last).toBeNull();
  });

  it('SAVE-ASOF: a create whose block time is seconds after the process start (clock skew) is seeded and filled as at the start; one released after it is still refused', () => {
    // Released before ASOF in moment order, its block time 5 s after ASOF's receipt time.
    const skewed = (mint: string, slot: bigint) => marketOf(`pump:CreateEvent:${mint}`, createEvent(mint, DEV, ASOF.receivedAt + 5_000, slot), at(ASOF.receivedAt - 2_000, slot, 7), `ev:${mint}:00000:00000`);
    const idx = new DeployerIndex();
    expect(idx.seed([skewed('K1', ASOF.slot - 2n)], [seedStart()], ASOF)).toMatchObject({ creates: 1 });
    expect(idx.fill([skewed('K2', ASOF.slot - 1n)], ASOF)).toEqual({ creates: 1 });
    expect(idx.factFor(DEV, ASOF, 0).mints).toEqual([{ mint: 'K1', createdAtMs: ASOF.receivedAt }, { mint: 'K2', createdAtMs: ASOF.receivedAt }]);
    // At the skew bound it is taken; past it, refused (the leak guard above: an hour ahead).
    expect(new DeployerIndex().seed([marketOf('pump:CreateEvent:B', createEvent('B', DEV, ASOF.receivedAt + CHAIN_SKEW_MS, ASOF.slot - 2n), at(ASOF.receivedAt - 2_000, ASOF.slot - 2n, 7), 'ev:B:00000:00000')], [seedStart()], ASOF)).toMatchObject({ creates: 1 });
    expect(() => new DeployerIndex().seed([marketOf('pump:CreateEvent:B', createEvent('B', DEV, ASOF.receivedAt + CHAIN_SKEW_MS + 1_000, ASOF.slot - 2n), at(ASOF.receivedAt - 2_000, ASOF.slot - 2n, 7), 'ev:B:00000:00000')], [seedStart()], ASOF)).toThrow(/chain time after/);
    // Released after the start (by slot), it is refused whatever its block time.
    expect(() => new DeployerIndex().seed([marketOf('pump:CreateEvent:F', createEvent('F', DEV, ASOF.receivedAt - 60_000, ASOF.slot + 1n), at(ASOF.receivedAt - 3_000, ASOF.slot + 1n, 7), 'ev:F:00000:00000')], [seedStart()], ASOF)).toThrow(/dated after the process start/);
  });

  it('downtime fill: creates backfilled after a restart enter an index that already has live events; the start is kept', () => {
    // Saved state restored (the watch has observed for 30 days), live events after the restart, then the fill.
    const idx = started();
    idx.observe(marketOf('tick', 0, LIVE));
    const before = idx.factFor(DEV, NOW, 0).coverageFromMs;
    const down = [seedCreate('D1', DEV, T - 3 * HOUR_MS, SLOT - 27_000n), seedCreate('D2', DEV, T - 2 * HOUR_MS, SLOT - 18_000n)];
    expect(() => idx.seed(down, [], ASOF)).toThrow(/only be seeded once/);
    expect(idx.fill(down, ASOF)).toEqual({ creates: 2 });
    expect(idx.factFor(DEV, NOW, 0)).toMatchObject({ coverageFromMs: before, mints: [{ mint: 'D1' }, { mint: 'D2' }] });
    // Same as-of and order checks, all or nothing.
    const future = marketOf('pump:CreateEvent:F', createEvent('F', DEV, T - 2 * HOUR_MS, SLOT - 4_500n), at(T - 30 * 60_000, SLOT - 4_500n), 'ev:F:00000:00000');
    expect(() => idx.fill([seedCreate('D3', DEV, T - 5 * HOUR_MS, SLOT - 45_000n), future], ASOF)).toThrow(/dated after the process start/);
    expect(() => idx.fill([down[1]!, down[0]!], ASOF)).toThrow(/is not after/);
    expect(idx.factFor(DEV, NOW, 0).mints.map((m) => m.mint)).toEqual(['D1', 'D2']);
  });

  it('seeds once, only before any live event, in release order, creates only', () => {
    const live = new DeployerIndex();
    live.observe(marketOf('tick', 0, LIVE));
    expect(() => live.seed([], [seedStart()], ASOF)).toThrow(/only be seeded once/);
    const twice = new DeployerIndex();
    twice.seed([], [], ASOF);
    expect(() => twice.seed([], [seedStart()], ASOF)).toThrow(/only be seeded once/);
    const a = seedCreate('A', DEV, T - 5 * HOUR_MS, SLOT - 45_000n);
    const b = seedCreate('B', DEV, T - 6 * HOUR_MS, SLOT - 54_000n);
    expect(() => new DeployerIndex().seed([a, b], [seedStart()], ASOF)).toThrow(/is not after/);
    expect(() => new DeployerIndex().seed([marketOf('rug:X', { mint: 'X', creator: DEV }, old(3))], [seedStart()], ASOF)).toThrow(/not a create/);
    expect(() => new DeployerIndex().seed([], [marketOf('coverage:rugs:start', wrap({ fromSlot: 1n, via: 'x' }), old(3))], ASOF)).toThrow(/not a creates coverage/);
  });
});
