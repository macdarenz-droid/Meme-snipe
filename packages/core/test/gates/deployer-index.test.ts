// GATE-1b: the deployer index, FEED-1's creates coverage contract (WatchOptions.coverage) and the create alias.
import { describe, expect, it } from 'vitest';
import { AsOfStore, OFF_CHAIN, SimClock, leakTest, replayOnce, type FeedEvent, type MarketEvent, type Moment, type ProofRun, type Strategy } from '../../src/engine/index.ts';
import {
  DAY_MS, DeployerIndex, HOUR_MS, createKey, rugCheckKey, type RugCheckFact, createsCoverage, deployerKey, evaluateHardRejects, evaluateSoftFeatures, type GateContext, type GateReason, type HardGate,
} from '../../src/gates/index.ts';
import { CONFIG } from '../fixtures.ts';
import { RUG_CHECK_CONFIG } from '../../src/config/index.ts';
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
  return { now, lookup: (k, a) => store.lookup(k, a), history: (k, f, t) => store.history(k, f, t), ...(deployers ? { deployers } : {}) };
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
    [rugCheckKey(DEV), wrap({ obs: { provider: 'rug-check', slot: SLOT - 10n, receivedAt: T - 1_000, quality: [], commitment: 'confirmed' }, creator: DEV, version: 'rug-check-1', fromMs: T - 14 * DAY_MS, asOfMs: T - 5_000, mints, credits: 7, ...over }), at(T - 1_000, SLOT - 10n)];
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
    expect(rug.reasons).toContainEqual(expect.objectContaining({ gate: 'H14', code: 'prior-rug', detail: expect.stringContaining('P1') }));
  });

  it('a check that missed, could not read or could not judge a prior mint is not coverage', () => {
    expect(notCovered(h([check({}, [])]))).toEqual([expect.objectContaining({ detail: expect.stringContaining('did not list P1') })]);
    for (const status of ['unfetched', 'unjudged'] as const) {
      expect(notCovered(h([check({}, [{ mint: 'P1', createdAtMs: T - 3 * DAY_MS, status, detail: 'x' }])]))).toHaveLength(1);
    }
  });

  it('a check for another deployer, from after the look-back start, too old, or in the future is not coverage', () => {
    expect(notCovered(h([check({ creator: W(9) })]))).toHaveLength(1);
    expect(notCovered(h([check({ fromMs: T - 14 * DAY_MS + 1 })]))).toHaveLength(1);
    expect(notCovered(h([check({ fromMs: T - 14 * DAY_MS - 1 })]))).toEqual([]);
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
    idx.observe(marketOf('logs:pump:CreateEvent:Old', createEvent('Old', DEV, T - 15 * DAY_MS, SLOT - 3_240_000n), old(15)));
    expect(notCovered(h([check()], idx))).toEqual([]);
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
          const r = evaluateHardRejects({ now: ctx.now, lookup: ctx.lookup, history: ctx.history, deployers: idx }, deps('backtest'), request(), { stopAtFirst: false });
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
