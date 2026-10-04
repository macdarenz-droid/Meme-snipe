// EXIT-1 (docs/ARCHITECTURE.md §9): every accept item of the card, with exact boundaries so a changed comparison or
// threshold fails a test (mutation testing on triggers and the ladder).
import { describe, expect, test } from 'vitest';
import { type PoolState, poolSell } from '../../src/amm/index.ts';
import { FILL_CONFIG, MINUTE_MS, TRIAL_POLICY, type Policy, type UniverseExits, policyIssues } from '../../src/config/index.ts';
import { intentId, mint, positionId } from '../../src/domain/index.ts';
import {
  type EntryPlan, type ExitDecision, type ExitMarket, type ExitObservation, type ExitTracker, type FlowMinute, type Holding,
  type PriceBar, PRICE_SCALE, atOrBelow, atr, checkStopDistance, decideExit, execPrice, exitBookEvents, exitSettings,
  exitAttemptsOf, liquidationValue, maxExitTransactions, newTracker, noteAttempt, planAttempt, quoteReserve,
} from '../../src/exits/index.ts';
import { type ObservedFees, observedFeeContext } from '../../src/fills/index.ts';
import { type Book, applyBookEvent, emptyBook, isIllegal, newPosition, applyPositionEvent, type PositionState } from '../../src/lifecycle/index.ts';
import { bps, lamports, microUsd, raw } from '../../src/units/index.ts';
import { usd } from '../../src/config/index.ts';
import { CHECKED_GLOBAL, NORMAL_COIN, PUMP_FEE_CONFIG } from '../amm/helpers.ts';

const G = TRIAL_POLICY.exits;
const X = G.universes.U2;
/** The trial policy with U1's exits patched. */
const withU1 = (patch: Partial<UniverseExits>): Policy => ({ ...TRIAL_POLICY, exits: { ...G, universes: { ...G.universes, U1: { ...G.universes.U1, ...patch } } } });
/** The trial policy with U2's exits patched. */
const withU2 = (patch: Partial<UniverseExits>): Policy => ({ ...TRIAL_POLICY, exits: { ...G, universes: { ...G.universes, U2: { ...X, ...patch } } } });
const S = exitSettings(TRIAL_POLICY, 'wick', FILL_CONFIG.network);
const FEES: ObservedFees = { split: { lp: bps(20), protocol: bps(5), creator: bps(95) }, buybackFeeBps: bps(5000), instruction: 'v1' };
const SUPPLY = 1_000_000_000_000_000n;
const CTX = observedFeeContext(FEES, SUPPLY, NORMAL_COIN);
const BASE = 200_000_000_000_000n;
const pool = (quoteVault: bigint): PoolState => ({ baseReserve: BASE, quoteVault, virtualQuoteReserves: 0n });
const market = (quoteVault: bigint): ExitMarket => ({ venue: 'pumpswap', pool: pool(quoteVault), ctx: CTX });
// 25e9 divides 1e12 × value exactly, so a stop level can sit exactly on a value.
const QTY = 25_000_000_000n;
const VAULT = 80_000_000_000n;
const valueAt = (vault: bigint, qty = QTY): bigint => {
  const v = liquidationValue(market(vault), qty);
  if (!v.ok) throw new Error(v.detail);
  return v.value;
};
const V0 = valueAt(VAULT);
const EXIT_COST = 30_000n;
const R = 2_000_000n;

const plan = (o: Partial<EntryPlan> = {}): EntryPlan => ({
  universe: 'U2', openedAtMs: 0, notional: TRIAL_POLICY.capital.minNotional, riskUnit: R, stopPrice: 1n, entryReserve: VAULT, ...o,
});
/** costBasis chosen so the P&L at `vault` is exactly `pnl`. */
const holding = (o: Partial<Holding> & { pnl?: bigint; vault?: bigint } = {}): Holding => {
  const { pnl = 0n, vault = VAULT, ...rest } = o;
  const quantity = rest.quantity ?? QTY;
  const realized = rest.realized ?? 0n;
  return {
    status: 'open', quantity, sold: 0n, realized, exitCost: EXIT_COST, exitSeq: 1, exitAttempts: 0,
    tokenAccountBalance: rest.tokenAccountBalance ?? quantity, closeFailed: false,
    costBasis: realized + valueAt(vault, quantity) - EXIT_COST - pnl, ...rest,
  };
};
const obs = (nowMs: number, vault: bigint | null = VAULT, o: Partial<ExitObservation> = {}): ExitObservation => ({
  nowMs, slotClose: true, market: vault === null ? null : { atMs: nowMs, value: market(vault) }, deployerSoldBps: null, sellRoute: null,
  flow: [], bars: [], ...o,
});
const NOW = 60_000;
const decide = (h: Holding, o: ExitObservation, p: EntryPlan = plan(), t: ExitTracker = newTracker(), s = S) => decideExit(s, p, h, t, o);
const codes = (d: ExitDecision): string[] => (d.kind === 'merge' || d.kind === 'exit' ? d.fired : d.fired).map((f) => f.code).sort();
const kindOf = (d: ExitDecision) => d.kind;

describe('trigger value: executable liquidation value only', () => {
  test('the value is our whole size sold into current reserves, fees deducted, exactly the CORE-2 quote', () => {
    const q = poolSell(pool(VAULT), QTY, CTX);
    if (!q.ok) throw new Error(q.detail);
    expect(V0).toBe(q.trade.userQuote);
    // Price impact at the real size: twice the size is worth less than twice the value.
    expect(valueAt(VAULT, 2n * QTY)).toBeLessThan(2n * V0);
  });

  test('a curve position is valued with the curve sell quote', () => {
    const curve = { virtualTokenReserves: 1_000_000_000_000_000n, virtualQuoteReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n, realQuoteReserves: 10_000_000_000n, complete: false };
    const m: ExitMarket = { venue: 'pump-curve', curve, ctx: { feeTiers: PUMP_FEE_CONFIG.feeTiers, global: CHECKED_GLOBAL, creatorFeeCharged: true, coin: NORMAL_COIN } };
    const v = liquidationValue(m, QTY);
    expect(v.ok).toBe(true);
    expect(quoteReserve(m)).toBe(10_000_000_000n);
    expect(liquidationValue({ ...m, curve: { ...curve, complete: true } }, QTY)).toMatchObject({ ok: false, reason: 'curve-complete' });
  });

  test('nothing held has no value', () => {
    expect(liquidationValue(market(VAULT), 0n)).toMatchObject({ ok: false, reason: 'nothing-held' });
  });

  test('the price stop fires exactly at its level and not one unit above', () => {
    const level = execPrice(V0, QTY);
    expect(level * QTY).toBe(V0 * PRICE_SCALE);
    expect(codes(decide(holding(), obs(NOW), plan({ stopPrice: level })).decision)).toContain('price_stop');
    expect(codes(decide(holding(), obs(NOW), plan({ stopPrice: level - 1n })).decision)).not.toContain('price_stop');
    expect(atOrBelow(V0, QTY, level)).toBe(true);
    expect(atOrBelow(V0 + 1n, QTY, level)).toBe(false);
  });

  test('bars and prints never trigger a stop: a candle crash with an intact pool is no exit', () => {
    const crash: PriceBar[] = Array.from({ length: 20 }, (_, i) => ({ startMs: i * MINUTE_MS - 30 * MINUTE_MS, high: 10n, low: 1n, close: 1n }));
    const d = decide(holding(), obs(NOW, VAULT, { bars: crash }), plan({ stopPrice: execPrice(V0, QTY) / 2n })).decision;
    expect(d).toMatchObject({ kind: 'hold', detail: 'no trigger' });
  });

  test('a stale or missing market state is not a quote: no value trigger fires on it', () => {
    const stop = plan({ stopPrice: execPrice(V0, QTY) });
    const stale = { atMs: NOW - S.maxQuoteAgeMs - 1, value: market(VAULT) };
    expect(codes(decide(holding(), obs(NOW, VAULT, { market: stale }), stop).decision)).toEqual([]);
    const edge = { atMs: NOW - S.maxQuoteAgeMs, value: market(VAULT) };
    expect(codes(decide(holding(), obs(NOW, VAULT, { market: edge }), stop).decision)).toEqual(['price_stop']);
    expect(codes(decide(holding(), obs(NOW, null), stop).decision)).toEqual([]);
  });

  test('as-of only: a market state stamped after now is ignored and reported', () => {
    const future = { atMs: NOW + 1, value: market(VAULT) };
    const step = decide(holding(), obs(NOW, VAULT, { market: future, deployerSoldBps: { atMs: NOW + 1, value: 9000 }, sellRoute: { atMs: NOW + 1, value: 'missing' } }), plan({ stopPrice: execPrice(V0, QTY) }));
    expect(codes(step.decision)).toEqual([]);
    expect(step.ignored).toHaveLength(3);
    expect(step.tracker.lastQuoteAtMs).toBeNull();
    // A future bar is unfinished as of now and never enters the ATR.
    const bars = [...flatBars(14, 100n, 0), { startMs: 14 * MINUTE_MS, high: 10n ** 9n, low: 0n, close: 0n }];
    expect(atr(bars, 14, MINUTE_MS, 14 * MINUTE_MS)).toBe(100n);
  });
});

const flatBars = (n: number, range: bigint, fromMs: number, close = 1_000_000n): PriceBar[] =>
  Array.from({ length: n }, (_, i) => ({ startMs: fromMs + i * MINUTE_MS, high: close + range / 2n, low: close + range / 2n - range, close }));

describe('ATR (Wilder) and the stop distance at entry', () => {
  test('first value is the mean true range, then Wilder smoothing; gaps and unfinished bars are not used', () => {
    expect(atr(flatBars(13, 100n, 0), 14, MINUTE_MS, 60 * MINUTE_MS)).toBeNull();
    expect(atr(flatBars(14, 100n, 0), 14, MINUTE_MS, 14 * MINUTE_MS)).toBe(100n);
    // The 14th bar is unfinished one millisecond earlier.
    expect(atr(flatBars(14, 100n, 0), 14, MINUTE_MS, 14 * MINUTE_MS - 1)).toBeNull();
    const more = [...flatBars(14, 100n, 0), { startMs: 14 * MINUTE_MS, high: 1_000_000n + 1500n, low: 1_000_000n - 100n, close: 1_000_000n }];
    // (100 × 13 + 1600) / 14 = 207 (floored).
    expect(atr(more, 14, MINUTE_MS, 15 * MINUTE_MS)).toBe(207n);
    // A gap restarts the run: only the bars after it count.
    const gap = [...flatBars(14, 100n, 0), ...flatBars(13, 50n, 20 * MINUTE_MS)];
    expect(atr(gap, 14, MINUTE_MS, 40 * MINUTE_MS)).toBeNull();
    expect(atr([...gap, ...flatBars(1, 50n, 33 * MINUTE_MS)], 14, MINUTE_MS, 40 * MINUTE_MS)).toBe(50n);
    expect(atr([], 1, MINUTE_MS, 0)).toBeNull();
    expect(() => atr([], 0, MINUTE_MS, 0)).toThrow(RangeError);
  });

  test('true range uses the previous close when it lies outside the bar', () => {
    const bars: PriceBar[] = [
      { startMs: 0, high: 110n, low: 90n, close: 200n },
      { startMs: MINUTE_MS, high: 120n, low: 100n, close: 110n }, // TR = 200 − 100 = 100
      { startMs: 2 * MINUTE_MS, high: 400n, low: 300n, close: 350n }, // TR = 400 − 110 = 290
    ];
    expect(atr(bars, 3, MINUTE_MS, 3 * MINUTE_MS)).toBe((20n + 100n + 290n) / 3n);
  });

  test('stop distance: below entry, within s_max and within 3 × ATR, exact at each edge', () => {
    const entry = 1_000_000n;
    const sMax = (entry * BigInt(TRIAL_POLICY.loss.stopMaxBps)) / 10_000n; // 200,000
    const wide = 10n ** 9n;
    expect(checkStopDistance(TRIAL_POLICY, 'U2', entry, entry, wide)).toMatchObject({ ok: false, reason: 'stop-not-below-entry' });
    expect(checkStopDistance(TRIAL_POLICY, 'U2', entry, 0n, wide)).toMatchObject({ ok: false, reason: 'stop-not-below-entry' });
    expect(checkStopDistance(TRIAL_POLICY, 'U2', entry, entry - sMax, wide)).toEqual({ ok: true });
    expect(checkStopDistance(TRIAL_POLICY, 'U2', entry, entry - sMax - 1n, wide)).toMatchObject({ ok: false, reason: 'too-wide' });
    expect(checkStopDistance(TRIAL_POLICY, 'U2', entry, entry - 1n, null)).toMatchObject({ ok: false, reason: 'no-atr' });
    // 3.0 × ATR 10,000 = 30,000.
    expect(checkStopDistance(TRIAL_POLICY, 'U2', entry, entry - 30_000n, 10_000n)).toEqual({ ok: true });
    expect(checkStopDistance(TRIAL_POLICY, 'U2', entry, entry - 30_001n, 10_000n)).toMatchObject({ ok: false, reason: 'beyond-atr' });
  });
});

describe('flow and thesis stops', () => {
  test('deployer cluster selling more than 2% of supply, not at 2%', () => {
    const at = (bps: number) => codes(decide(holding(), obs(NOW, VAULT, { deployerSoldBps: { atMs: NOW, value: bps } })).decision);
    expect(at(G.deployerSellSupplyBps)).toEqual([]);
    expect(at(G.deployerSellSupplyBps + 1)).toEqual(['deployer_sell']);
  });

  test('pool liquidity down 30% from entry fires at exactly 30%', () => {
    // Entry reserve 100 SOL; 70 SOL left is exactly −30%.
    const p = plan({ entryReserve: 100_000_000_000n });
    expect(codes(decide(holding({ vault: 70_000_000_000n }), obs(NOW, 70_000_000_000n), p).decision)).toEqual(['liquidity_drop']);
    expect(codes(decide(holding({ vault: 70_000_000_001n }), obs(NOW, 70_000_000_001n), p).decision)).toEqual([]);
  });

  test('a missing sell route exits; a present one does not', () => {
    expect(codes(decide(holding(), obs(NOW, VAULT, { sellRoute: { atMs: NOW, value: 'missing' } })).decision)).toEqual(['no_route']);
    expect(codes(decide(holding(), obs(NOW, VAULT, { sellRoute: { atMs: NOW, value: 'ok' } })).decision)).toEqual([]);
  });

  test('the reverse quote failing twice in a row; a success resets; one state is counted once', () => {
    const empty: ExitObservation['market'] = { atMs: NOW, value: market(0n) };
    const p = plan({ entryReserve: 1n }); // keep the liquidity stop out of this test
    const h = holding();
    const one = decide(h, obs(NOW, null, { market: empty }), p);
    expect(one.tracker.quoteFailures).toBe(1);
    expect(codes(one.decision)).not.toContain('quote_failures');
    // The same market state seen again is not a second failure.
    const same = decide(h, obs(NOW + 100, null, { market: empty }), p, one.tracker);
    expect(same.tracker.quoteFailures).toBe(1);
    const two = decide(h, obs(NOW + 200, null, { market: { atMs: NOW + 200, value: market(0n) } }), p, one.tracker);
    expect(two.tracker.quoteFailures).toBe(2);
    expect(codes(two.decision)).toContain('quote_failures');
    const healed = decide(h, obs(NOW + 300), p, one.tracker);
    expect(healed.tracker.quoteFailures).toBe(0);
  });

  const minute = (startMs: number, net: bigint): FlowMinute => ({ startMs, net });
  const negatives = (from: number, n: number) => Array.from({ length: n }, (_, i) => minute(from + i * MINUTE_MS, -1n));
  const flowAt = (now: number, flow: FlowMinute[], openedAtMs = 0) => codes(decide(holding(), obs(now, VAULT, { flow }), plan({ openedAtMs, entryReserve: VAULT })).decision);

  test('net SOL flow negative for 5 consecutive finished minutes after entry', () => {
    const end = 5 * MINUTE_MS;
    expect(flowAt(end, negatives(0, 5))).toEqual(['negative_flow']);
    expect(flowAt(end, negatives(0, 4))).toEqual([]);
    // The fifth minute is not finished one millisecond earlier.
    expect(flowAt(end - 1, negatives(0, 5))).toEqual([]);
    // A zero minute breaks the run.
    expect(flowAt(6 * MINUTE_MS, [...negatives(0, 2), minute(2 * MINUTE_MS, 0n), ...negatives(3 * MINUTE_MS, 3)])).toEqual([]);
    // A gap breaks the run.
    expect(flowAt(7 * MINUTE_MS, [...negatives(0, 2), ...negatives(3 * MINUTE_MS, 3)])).toEqual([]);
    // Minutes before the entry do not count.
    expect(flowAt(6 * MINUTE_MS, negatives(0, 5), 1)).toEqual([]);
    expect(flowAt(6 * MINUTE_MS, negatives(MINUTE_MS, 5), MINUTE_MS)).toEqual(['negative_flow']);
    // A run that happened stays a fired thesis stop.
    expect(flowAt(9 * MINUTE_MS, [...negatives(0, 5), minute(5 * MINUTE_MS, 7n)])).toEqual(['negative_flow']);
  });
});

describe('time stop', () => {
  test('hard T_max fires at exactly T_max, whatever the P&L', () => {
    const rich = holding({ pnl: 100n * R });
    const t = { ...newTracker(), flatMet: true };
    expect(codes(decide(rich, obs(X.tMaxMs), plan(), t).decision)).toContain('time_max');
    expect(codes(decide(rich, obs(X.tMaxMs - 1), plan(), t).decision)).not.toContain('time_max');
  });

  test('T_flat: exit unless +0.5R was reached by T_flat', () => {
    const half = (R * BigInt(X.flatMinRBps)) / 10_000n;
    expect(codes(decide(holding({ pnl: half - 1n }), obs(X.tFlatMs)).decision)).toEqual(['time_flat']);
    expect(codes(decide(holding({ pnl: half - 1n }), obs(X.tFlatMs - 1)).decision)).toEqual([]);
    // Reached exactly at T_flat counts.
    const met = decide(holding({ pnl: half }), obs(X.tFlatMs));
    expect(met.tracker.flatMet).toBe(true);
    expect(codes(met.decision)).toEqual([]);
    // Reached earlier and given back: no time-flat exit later.
    const early = decide(holding({ pnl: half }), obs(NOW)).tracker;
    expect(codes(decide(holding({ pnl: -1n }), obs(X.tFlatMs + 1), plan(), early).decision)).toEqual([]);
    // Reached only after T_flat does not count.
    const late = decide(holding({ pnl: half }), obs(X.tFlatMs + 1));
    expect(late.tracker.flatMet).toBe(false);
    expect(codes(late.decision)).toEqual(['time_flat']);
  });
});

describe('exits by the position\'s universe (CFG-2)', () => {
  const U1 = G.universes.U1;
  const t = { ...newTracker(), flatMet: true };

  test("a U1 position uses U1's T_max and a U2 position U2's", () => {
    // Both are at the 120-min hard maximum in the trial policy, so U1's is tightened to 60 min to tell them apart.
    const s = exitSettings(withU1({ tFlatMs: 30 * MINUTE_MS, tMaxMs: 60 * MINUTE_MS }), 'wick', FILL_CONFIG.network);
    const at = (ms: number, universe: 'U1' | 'U2') => codes(decide(holding(), obs(ms), plan({ universe }), t, s).decision);
    expect(at(60 * MINUTE_MS - 1, 'U1')).toEqual([]);
    expect(at(60 * MINUTE_MS, 'U1')).toEqual(['time_max']);
    expect(at(60 * MINUTE_MS, 'U2')).toEqual([]);
    expect(at(X.tMaxMs - 1, 'U2')).toEqual([]);
    expect(at(X.tMaxMs, 'U2')).toEqual(['time_max']);
  });

  test("T_flat and the partial follow the position's universe", () => {
    expect(codes(decide(holding(), obs(X.tFlatMs), plan({ universe: 'U2' })).decision)).toEqual(['time_flat']);
    expect(codes(decide(holding(), obs(X.tFlatMs), plan({ universe: 'U1' })).decision)).toEqual([]);
    expect(codes(decide(holding(), obs(U1.tFlatMs), plan({ universe: 'U1' })).decision)).toEqual(['time_flat']);
    // +1.5R takes U2's partial; U1 waits for +2R.
    const u2tp = (R * BigInt(X.partialAtRBps)) / 10_000n;
    const u1tp = (R * BigInt(U1.partialAtRBps)) / 10_000n;
    expect(decide(holding({ pnl: u2tp }), obs(NOW), plan({ universe: 'U2' })).decision.kind).toBe('exit');
    expect(decide(holding({ pnl: u2tp }), obs(NOW), plan({ universe: 'U1' })).decision.kind).toBe('hold');
    expect(decide(holding({ pnl: u1tp - 1n }), obs(NOW), plan({ universe: 'U1' })).decision.kind).toBe('hold');
    expect(decide(holding({ pnl: u1tp }), obs(NOW), plan({ universe: 'U1' })).decision).toMatchObject({ kind: 'exit', partial: true });
  });

  test("the ATR uses the universe's bar length", () => {
    // 14 one-minute bars give U2 an ATR, and none on U1's 5-minute bars, so a U1 entry has no ATR stop yet.
    const entry = 1_000_000n;
    const bars = flatBars(14, 10_000n, 0);
    expect(atr(bars, X.atrPeriod, X.atrBarMs, 14 * MINUTE_MS)).not.toBeNull();
    expect(atr(bars, U1.atrPeriod, U1.atrBarMs, 14 * MINUTE_MS)).toBeNull();
    const stopU1 = withU1({ stopAtrTenths: 10 });
    expect(checkStopDistance(stopU1, 'U2', entry, entry - 30_000n, 10_000n)).toEqual({ ok: true });
    expect(checkStopDistance(stopU1, 'U1', entry, entry - 30_000n, 10_000n)).toMatchObject({ ok: false, reason: 'beyond-atr' });
  });

  test('a universe without a block is never given another universe\'s exits', () => {
    for (const u of ['S0', 'U3']) {
      expect(() => decide(holding(), obs(NOW), plan({ universe: u as never }))).toThrow(`no exit parameters for universe ${u}`);
      expect(() => checkStopDistance(TRIAL_POLICY, u as never, 1_000n, 900n, 10n ** 9n)).toThrow(/no exit parameters/);
    }
  });
});

describe('profit taking: partial and runner, by size', () => {
  const tp = (R * BigInt(X.partialAtRBps)) / 10_000n; // 1.5R = 3,000,000

  test('size rule: two exit transactions at q_min, three from 2 × q_min', () => {
    const min = TRIAL_POLICY.capital.minNotional;
    expect(maxExitTransactions(S, min)).toBe(G.maxExitTxAtMinNotional);
    expect(maxExitTransactions(S, microUsd(2n * min - 1n))).toBe(G.maxExitTxAtMinNotional);
    expect(maxExitTransactions(S, microUsd(2n * min))).toBe(G.maxExitTxAboveDoubleMin);
  });

  test('a partial of at least half at +1.5R, and not one lamport below', () => {
    const d = decide(holding({ pnl: tp }), obs(NOW)).decision;
    expect(d).toMatchObject({ kind: 'exit', partial: true, retry: false, quantity: QTY / 2n, reasons: ['take_profit'], startRung: 0, maxAttempts: G.ladder.maxAttempts });
    expect(decide(holding({ pnl: tp - 1n }), obs(NOW)).decision.kind).toBe('hold');
  });

  test('the partial share rounds up, and a share that is the whole holding is a full exit', () => {
    const odd = holding({ pnl: tp, quantity: QTY + 1n });
    expect(decide(odd, obs(NOW)).decision).toMatchObject({ kind: 'exit', partial: true, quantity: QTY / 2n + 1n });
    const all = exitSettings(withU2({ partialMinShareBps: 10_000 }), 'wick', FILL_CONFIG.network);
    expect(decide(holding({ pnl: tp }), obs(NOW), plan(), newTracker(), all).decision).toMatchObject({ kind: 'exit', partial: false, quantity: QTY, reasons: ['take_profit'] });
  });

  test('or at +100% on the cost basis when that comes first', () => {
    // 1R so large that the R rule cannot fire; the P&L is carried by the realized side.
    const big = plan({ riskUnit: 10n ** 15n });
    const h = holding({ pnl: 0n });
    const gain = (h.costBasis * BigInt(X.partialAtGainBps)) / 10_000n;
    expect(decide({ ...h, realized: gain }, obs(NOW), big).decision).toMatchObject({ kind: 'exit', partial: true });
    expect(decide({ ...h, realized: gain - 1n }, obs(NOW), big).decision.kind).toBe('hold');
  });

  test('close-based take-profit (conservative) waits for the slot close; stops do not', () => {
    const close = exitSettings(TRIAL_POLICY, 'close', FILL_CONFIG.network);
    expect(decide(holding({ pnl: tp }), obs(NOW, VAULT, { slotClose: false }), plan(), newTracker(), close).decision.kind).toBe('hold');
    expect(decide(holding({ pnl: tp }), obs(NOW, VAULT, { slotClose: true }), plan(), newTracker(), close).decision.kind).toBe('exit');
    const stop = plan({ stopPrice: execPrice(V0, QTY) });
    expect(decide(holding(), obs(NOW, VAULT, { slotClose: false }), stop, newTracker(), close).decision).toMatchObject({ kind: 'exit', partial: false });
    // Wick mode does not wait.
    expect(decide(holding({ pnl: tp }), obs(NOW, VAULT, { slotClose: false })).decision.kind).toBe('exit');
  });

  const afterPartial = (t: ExitTracker = newTracker()): ExitTracker => ({ ...t, partials: 1, lastSold: QTY, flatMet: true });

  test('a sale that leaves tokens counts as the partial; selling everything does not', () => {
    const h = holding({ pnl: R, sold: QTY });
    expect(decide(h, obs(NOW)).tracker).toMatchObject({ partials: 1, lastSold: QTY });
    expect(decide(h, obs(NOW), plan(), afterPartial()).tracker.partials).toBe(1);
  });

  test('at q_min only one partial: the runner then has no take-profit', () => {
    const runner = holding({ pnl: 10n * R, sold: QTY });
    expect(codes(decide(runner, obs(NOW), plan(), afterPartial()).decision)).toEqual([]);
  });

  test('from 2 × q_min a second partial at twice the first threshold', () => {
    const p = plan({ notional: microUsd(2n * TRIAL_POLICY.capital.minNotional) });
    const t = afterPartial();
    expect(decide(holding({ pnl: 2n * tp, sold: QTY }), obs(NOW), p, t).decision).toMatchObject({ kind: 'exit', partial: true });
    expect(decide(holding({ pnl: 2n * tp - 1n, sold: QTY }), obs(NOW), p, t).decision.kind).toBe('hold');
    expect(codes(decide(holding({ pnl: 10n * R, sold: QTY }), obs(NOW), p, { ...t, partials: 2 }).decision)).toEqual([]);
  });

  test('runner on break-even after costs: fires at zero P&L, not at +1 lamport', () => {
    expect(codes(decide(holding({ pnl: 0n, sold: QTY }), obs(NOW), plan(), afterPartial()).decision)).toEqual(['break_even']);
    expect(codes(decide(holding({ pnl: 1n, sold: QTY }), obs(NOW), plan(), afterPartial()).decision)).toEqual([]);
    // Before any partial, break-even is not a stop.
    expect(codes(decide(holding({ pnl: 0n }), obs(NOW)).decision)).toEqual([]);
  });

  test('chandelier trail: peak − 3 × ATR(14, 1 min), exact at its level, and it never moves down', () => {
    const price = execPrice(V0, QTY);
    const bars = flatBars(14, 1000n, 0);
    const now = 14 * MINUTE_MS;
    const peak = price + 3000n; // trail level = peak − 3.0 × 1,000 = price
    const t = { ...afterPartial(), peak };
    const h = holding({ pnl: R, sold: QTY });
    const at = decide(h, obs(now, VAULT, { bars }), plan(), t);
    expect(at.tracker.trail).toBe(price);
    expect(codes(at.decision)).toEqual(['trailing_stop']);
    const above = decide(h, obs(now, VAULT, { bars }), plan(), { ...t, peak: peak - 1n });
    expect(codes(above.decision)).toEqual([]);
    // A wider ATR would lower the level: the stored trail keeps the higher one.
    const wider = decide(h, obs(now + MINUTE_MS, VAULT, { bars: [...bars, ...flatBars(1, 1_000_000n, now)] }), plan(), at.tracker);
    expect(wider.tracker.trail).toBe(price);
    // No trail before the partial.
    expect(decide(holding({ pnl: R }), obs(now, VAULT, { bars }), plan(), { ...newTracker(), peak, flatMet: true }).tracker.trail).toBeNull();
  });

  test('the peak is the highest executable price seen', () => {
    const a = decide(holding(), obs(NOW, 90_000_000_000n)).tracker;
    const b = decide(holding(), obs(NOW + 1, VAULT), plan(), a).tracker;
    expect(b.peak).toBe(execPrice(valueAt(90_000_000_000n), QTY));
    expect(b.peak! > execPrice(V0, QTY)).toBe(true);
  });
});

describe('escalation ladder with caps', () => {
  const L = G.ladder;
  const trig = 10_000_000n;
  const minOut = (bp: number) => (trig * BigInt(10_000 - bp)) / 10_000n;

  test('rungs in order, min-out from the trigger value, fee capped, then exhausted', () => {
    const plans = [1, 2, 3, 4, 5].map((n) => planAttempt(L, n, trig, trig));
    expect(plans.map((p) => (p.ok ? p.rung : -1))).toEqual([0, 1, 2, 3, 3]);
    expect(plans[0]).toEqual({ ok: true, rung: 0, priorityFee: 20_000n, minOut: minOut(800) });
    expect(plans[2]).toEqual({ ok: true, rung: 2, priorityFee: 150_000n, minOut: minOut(2500) });
    expect(planAttempt(L, L.maxAttempts + 1, trig, trig)).toMatchObject({ ok: false, reason: 'ladder-exhausted' });
    const capped = { ...L, maxFeePerAttempt: lamports(100_000n) };
    expect(planAttempt(capped, 3, trig, trig)).toMatchObject({ ok: true, priorityFee: 100_000n });
    expect(planAttempt({ ...L, maxFeePerAttempt: lamports(20_000n) }, 1, trig, trig)).toMatchObject({ ok: true, priorityFee: 20_000n });
  });

  test('a rung the fresh quote cannot meet is skipped without spending an attempt; none left blocks', () => {
    expect(planAttempt(L, 1, trig, minOut(800))).toMatchObject({ ok: true, rung: 0 });
    expect(planAttempt(L, 1, trig, minOut(800) - 1n)).toMatchObject({ ok: true, rung: 2, minOut: minOut(2500) });
    expect(planAttempt(L, 1, trig, minOut(2500) - 1n)).toMatchObject({ ok: false, reason: 'quote-below-min-out' });
  });

  test('a start rung and a narrower budget; the budget never widens past the policy', () => {
    expect(planAttempt(L, 1, trig, trig, 3, 1)).toMatchObject({ ok: true, rung: 3, priorityFee: 500_000n });
    expect(planAttempt(L, 2, trig, trig, 3, 1)).toMatchObject({ ok: false, reason: 'ladder-exhausted' });
    expect(planAttempt(L, L.maxAttempts, trig, trig, 0, 99)).toMatchObject({ ok: true });
    expect(planAttempt(L, L.maxAttempts + 1, trig, trig, 0, 99)).toMatchObject({ ok: false, reason: 'ladder-exhausted' });
    expect(() => planAttempt(L, 0, trig, trig)).toThrow(RangeError);
    expect(() => planAttempt(L, 1, trig, trig, -1)).toThrow(RangeError);
    expect(() => planAttempt(L, 1, 0n, trig)).toThrow(RangeError);
  });
});

// ---------- Book integration: one exit owner, blocked exits, simultaneous triggers, a drained pool ----------

const PID = positionId('p1');
const MINT = mint('So11111111111111111111111111111111111111112');
const openBook = (qty = QTY): Book => {
  const p0 = newPosition({ id: PID, mint: MINT, venue: 'pumpswap', entryIntentId: intentId('en1') });
  const r = applyPositionEvent(p0, { type: 'entry_filled', quantity: raw(qty), cost: lamports(V0) });
  if (isIllegal(r)) throw new Error(r.reason);
  return { ...emptyBook({ maxOpenPositions: 1 }), positions: { [PID]: r.state } };
};
const apply = (b: Book, events: ReturnType<typeof exitBookEvents>) => {
  let book = b;
  const effects = [];
  for (const e of events) {
    const r = applyBookEvent(book, e);
    if (isIllegal(r)) throw new Error(`${e.type}: ${r.reason}`);
    book = r.state;
    effects.push(...r.effects);
  }
  return { book, effects };
};
const holdingOf = (p: PositionState, pnl = 0n, book?: Book): Holding =>
  holding({ status: p.status, quantity: p.quantity, sold: p.sold, pnl, exitSeq: p.exitSeq, exitAttempts: book === undefined ? 0 : exitAttemptsOf(book.intents, p.id) });

describe('one exit owner and simultaneous triggers', () => {
  test('a stop, a take-profit and a flow stop in one update: one exit intent for the whole quantity', () => {
    const tp = (R * BigInt(X.partialAtRBps)) / 10_000n;
    const step = decide(holding({ pnl: tp }), obs(NOW, VAULT, { deployerSoldBps: { atMs: NOW, value: 5000 } }), plan({ stopPrice: execPrice(V0, QTY) }));
    expect(step.decision).toMatchObject({ kind: 'exit', partial: false, quantity: QTY });
    expect(codes(step.decision)).toEqual(['deployer_sell', 'price_stop', 'take_profit']);
    if (step.decision.kind !== 'exit') throw new Error('expected an exit');
    expect([...step.decision.reasons].sort()).toEqual(['stop', 'take_profit', 'thesis_lost']);
    const { book } = apply(openBook(), exitBookEvents(PID, step.decision, intentId('ex1')));
    const exits = Object.values(book.intents).filter((i) => i.intent.purpose === 'exit');
    expect(exits).toHaveLength(1);
    expect(book.positions[PID]).toMatchObject({ status: 'exit_requested', exitOwner: { quantity: QTY } });
  });

  test('while an exit is in flight, new triggers merge into the owner and create nothing', () => {
    const first = decide(holding(), obs(NOW), plan({ stopPrice: execPrice(V0, QTY) })).decision;
    const { book } = apply(openBook(), exitBookEvents(PID, first, intentId('ex1')));
    const p = book.positions[PID]!;
    const second = decide(holdingOf(p), obs(NOW + 1, VAULT, { sellRoute: { atMs: NOW + 1, value: 'missing' } }), plan({ stopPrice: execPrice(V0, QTY) })).decision;
    expect(second).toMatchObject({ kind: 'merge' });
    const after = apply(book, exitBookEvents(PID, second, intentId('ex2'))).book;
    expect(Object.keys(after.intents)).toEqual(['ex1']);
    expect([...after.positions[PID]!.exitOwner!.reasons].sort()).toEqual(['liquidity', 'stop']);
    // Nothing fired: hold, no events.
    expect(decide(holdingOf(p), obs(NOW + 2)).decision).toMatchObject({ kind: 'hold', detail: 'exit in progress' });
    expect(exitBookEvents(PID, decide(holdingOf(p), obs(NOW + 2)).decision, intentId('ex3'))).toEqual([]);
  });

  test('a stop during an in-flight partial waits for it, then sells the rest', () => {
    const tp = (R * BigInt(X.partialAtRBps)) / 10_000n;
    const part = decide(holding({ pnl: tp }), obs(NOW)).decision;
    let { book } = apply(openBook(), exitBookEvents(PID, part, intentId('ex1')));
    const stop = plan({ stopPrice: execPrice(V0, QTY) * 10n });
    expect(decide(holdingOf(book.positions[PID]!), obs(NOW + 1), stop).decision.kind).toBe('merge');
    // The partial ends unfilled: the position is open again with everything, and the stop now takes all of it.
    const p = applyPositionEvent(book.positions[PID]!, { type: 'exit_unfilled' });
    if (isIllegal(p)) throw new Error(p.reason);
    book = { ...book, positions: { [PID]: p.state } };
    expect(decide(holdingOf(p.state), obs(NOW + 2), stop).decision).toMatchObject({ kind: 'exit', partial: false, quantity: QTY });
  });

  test('positions that are opening or closed are not managed', () => {
    expect(decide(holding({ status: 'opening' }), obs(NOW), plan({ stopPrice: 10n ** 30n })).decision).toMatchObject({ kind: 'hold' });
    expect(decide(holding({ status: 'closed' }), obs(NOW), plan({ stopPrice: 10n ** 30n })).decision).toMatchObject({ kind: 'hold' });
    expect(decide({ ...holding(), quantity: 0n }, obs(NOW), plan({ stopPrice: 10n ** 30n })).decision).toMatchObject({ kind: 'hold' });
  });
});

describe('a pool drained inside one update', () => {
  test('liquidity stop fires, no executable quote: the exit is booked blocked with an alert, nothing sold', () => {
    const t1 = decide(holding(), obs(NOW)).tracker;
    // One update later the vault is empty.
    const step = decide(holding(), obs(NOW + 400, 0n), plan(), t1);
    expect(codes(step.decision)).toEqual(['liquidity_drop']);
    expect(step.decision).toMatchObject({ kind: 'exit', quantity: QTY, value: { ok: false, reason: 'no-liquidity' } });
    const events = exitBookEvents(PID, step.decision, intentId('ex1'));
    expect(events.map((e) => e.type)).toEqual(['trigger_exit', 'exit_blocked']);
    const { book, effects } = apply(openBook(), events);
    expect(book.positions[PID]).toMatchObject({ status: 'exit_blocked', quantity: QTY, sold: 0n, exitOwner: null });
    expect(effects).toContainEqual({ type: 'alert', level: 'critical', code: 'exit_blocked', subject: PID });
    expect(book.intents['ex1']!.fills).toEqual([]);
    // The next drained state adds the quote-failure stop.
    const next = decide(holdingOf(book.positions[PID]!), obs(NOW + 800, 0n), plan(), step.tracker);
    expect(codes(next.decision)).toEqual(['liquidity_drop', 'quote_failures']);
  });

  test('a pool drained to dust (quotes but worth nothing) still exits on liquidity', () => {
    const dust = 1_000n;
    const step = decide(holding(), obs(NOW, dust));
    expect(codes(step.decision)).toContain('liquidity_drop');
    expect(step.decision.kind).toBe('exit');
  });
});

const blockedBook = (): Book => {
  const step = decide(holding(), obs(NOW, 0n)).decision;
  return apply(openBook(), exitBookEvents(PID, step, intentId('ex1'))).book;
};

describe('blocked exits: retried on the ladder, bounded, alerting', () => {

  test('first seen blocked: wait; retry after blockedRetryMs at the last rung with one attempt', () => {
    const p = blockedBook().positions[PID]!;
    const h = holdingOf(p);
    const seen = decide(h, obs(NOW));
    expect(seen.decision).toMatchObject({ kind: 'hold', detail: 'exit blocked: waiting to retry' });
    expect(seen.tracker.blockedAtMs).toBe(NOW);
    expect(decide(h, obs(NOW + G.blockedRetryMs - 1), plan(), seen.tracker).decision.kind).toBe('hold');
    const retry = decide(h, obs(NOW + G.blockedRetryMs), plan(), seen.tracker);
    expect(retry.decision).toMatchObject({
      kind: 'exit', retry: true, partial: false, quantity: QTY, reasons: ['emergency'], startRung: G.ladder.steps.length - 1, maxAttempts: 1,
    });
    expect(retry.tracker).toMatchObject({ blockedAtMs: null, blockedRetries: 1 });
    // The retry is a new exit owner on the blocked position.
    const { book } = apply(blockedBook(), exitBookEvents(PID, retry.decision, intentId('ex2')));
    expect(book.positions[PID]).toMatchObject({ status: 'exit_requested', exitOwner: { intentId: 'ex2', quantity: QTY } });
  });

  test('a retry carries the reasons that still hold', () => {
    const h = holdingOf(blockedBook().positions[PID]!);
    const t = { ...newTracker(), blockedAtMs: 0 };
    const d = decide(h, obs(G.blockedRetryMs, VAULT, { sellRoute: { atMs: G.blockedRetryMs, value: 'missing' } }), plan(), t).decision;
    expect(d).toMatchObject({ kind: 'exit', retry: true, reasons: ['liquidity'] });
  });

  test('no retry without a quote, when the quote does not cover the attempt, or once the retries are used', () => {
    const h = holdingOf(blockedBook().positions[PID]!);
    const t = { ...newTracker(), blockedAtMs: 0 };
    const at = G.blockedRetryMs;
    expect(decide(h, obs(at, 0n), plan({ entryReserve: 1n }), t).decision).toMatchObject({ kind: 'hold', detail: 'exit blocked: pool has no usable reserves' });
    const v = valueAt(VAULT);
    const at0 = (retryCost: bigint) => ({ ...S, retryCost });
    // The least proceeds the last rung accepts must cover the attempt (EXIT-1b; the quote alone was not enough).
    const least = (v * (10_000n - BigInt(G.ladder.steps[G.ladder.steps.length - 1]!.minOutBelowTriggerBps))) / 10_000n;
    expect(decide(h, obs(at), plan(), t, at0(least)).decision).toMatchObject({ kind: 'hold', detail: 'exit blocked: the least accepted proceeds do not cover the attempt' });
    expect(decide(h, obs(at), plan(), t, at0(least - 1n)).decision).toMatchObject({ kind: 'exit', retry: true });
    // The retry cost is base + the last rung's capped fee + tip, not the first-rung exit cost.
    const n = FILL_CONFIG.network;
    expect(S.retryCost).toBe(n.signaturesPerTx * n.baseFeePerSignature + G.ladder.maxFeePerAttempt + n.tip);
    const lowCap = exitSettings({ ...TRIAL_POLICY, exits: { ...G, ladder: { ...G.ladder, maxFeePerAttempt: lamports(400_000n) } } }, 'wick', n);
    expect(lowCap.retryCost).toBe(n.signaturesPerTx * n.baseFeePerSignature + 400_000n + n.tip);
    const highCap = exitSettings({ ...TRIAL_POLICY, exits: { ...G, ladder: { ...G.ladder, maxFeePerAttempt: lamports(600_000n) } } }, 'wick', n);
    expect(highCap.retryCost).toBe(n.signaturesPerTx * n.baseFeePerSignature + 500_000n + n.tip);
    expect(decide({ ...h, exitCost: v }, obs(at), plan(), t).decision).toMatchObject({ kind: 'exit', retry: true });
    const used = { ...t, blockedRetries: G.blockedRetryAttempts };
    expect(decide(h, obs(at), plan(), used).decision).toMatchObject({ kind: 'hold', detail: 'exit blocked: retries used' });
    expect(decide(h, obs(at), plan(), { ...used, blockedRetries: G.blockedRetryAttempts - 1 }).decision).toMatchObject({ kind: 'exit', retry: true });
  });

  test('exits are never blocked by risk: paused entries still take an exit, and the module reads no risk state', async () => {
    const paused = apply(openBook(), [{ type: 'pause_entries', reason: 'daily_loss' }, { type: 'pause_entries', reason: 'owner' }]).book;
    const d = decide(holding(), obs(NOW), plan({ stopPrice: execPrice(V0, QTY) })).decision;
    const { book } = apply(paused, exitBookEvents(PID, d, intentId('ex1')));
    expect(book.positions[PID]!.status).toBe('exit_requested');
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../../src/exits/', import.meta.url);
    for (const f of readdirSync(dir)) expect(readFileSync(new URL(f, dir), 'utf8')).not.toMatch(/from '\.\.\/risk|from "\.\.\/risk/);
  });
});

describe('thresholds come from the policy', () => {
  const tightened = (patch: Partial<Policy['exits']>) => exitSettings({ ...TRIAL_POLICY, exits: { ...G, ...patch } }, 'wick', FILL_CONFIG.network);
  const tightenedU2 = (patch: Partial<UniverseExits>) => exitSettings(withU2(patch), 'wick', FILL_CONFIG.network);

  test('each trigger moves with its policy value', () => {
    const dev = obs(NOW, VAULT, { deployerSoldBps: { atMs: NOW, value: 101 } });
    expect(codes(decide(holding(), dev).decision)).toEqual([]);
    expect(codes(decide(holding(), dev, plan(), newTracker(), tightened({ deployerSellSupplyBps: 100 })).decision)).toEqual(['deployer_sell']);
    expect(codes(decide(holding(), obs(60 * MINUTE_MS), plan(), { ...newTracker(), flatMet: true }, tightenedU2({ tMaxMs: 60 * MINUTE_MS })).decision)).toEqual(['time_max']);
    expect(decide(holding({ pnl: R }), obs(NOW), plan(), newTracker(), tightenedU2({ partialAtRBps: 10_000, partialMinShareBps: 7_500 })).decision)
      .toMatchObject({ kind: 'exit', partial: true, quantity: (QTY * 3n) / 4n });
    expect(codes(decide(holding(), obs(NOW, 90_000_000_000n), plan({ entryReserve: 100_000_000_000n }), newTracker(), tightened({ liquidityDropBps: 1000 })).decision)).toEqual(['liquidity_drop']);
    expect(exitSettings(TRIAL_POLICY, 'close', FILL_CONFIG.network)).toMatchObject({ minNotional: usd('2'), maxQuoteAgeMs: TRIAL_POLICY.gates.maxQuoteAgeMs, takeProfitOn: 'close' });
  });

  test('the same inputs always give the same step', () => {
    const args = [holding({ pnl: R }), obs(NOW, VAULT, { bars: flatBars(14, 500n, 0) }), plan()] as const;
    expect(decide(...args)).toEqual(decide(...args));
    expect(kindOf(decide(...args).decision)).toBe('hold');
  });
});

// Mutation run 1: each test below kills a named survivor (see the PR for the run and the justified equivalents).
describe('boundaries found by mutation testing', () => {
  test('liquidation value: one raw token is something to sell; execPrice needs tokens', () => {
    expect(liquidationValue(market(VAULT), 1n)).not.toMatchObject({ reason: 'nothing-held' });
    expect(execPrice(5n, 1n)).toBe(5n * PRICE_SCALE);
    expect(() => execPrice(5n, 0n)).toThrow('tokens must be > 0');
  });

  test('ATR: an invalid period is refused by name; a gap just before the last bar leaves one bar', () => {
    expect(() => atr(flatBars(3, 10n, 0), 0, MINUTE_MS, 10 * MINUTE_MS)).toThrow('period must be');
    expect(() => atr(flatBars(3, 10n, 0), -1, MINUTE_MS, 10 * MINUTE_MS)).toThrow('period must be');
    expect(() => atr(flatBars(3, 10n, 0), 1.5, MINUTE_MS, 10 * MINUTE_MS)).toThrow('period must be');
    expect(atr([...flatBars(14, 10n, 0), ...flatBars(1, 10n, 15 * MINUTE_MS)], 14, MINUTE_MS, 20 * MINUTE_MS)).toBeNull();
    expect(atr([...flatBars(14, 10n, 0), ...flatBars(1, 10n, 15 * MINUTE_MS)], 1, MINUTE_MS, 20 * MINUTE_MS)).toBe(10n);
  });

  test('a stop at one unit is a stop when s_max allows it', () => {
    const anyWidth = { ...TRIAL_POLICY, loss: { ...TRIAL_POLICY.loss, stopMaxBps: 10_000 } };
    expect(checkStopDistance(anyWidth, 'U2', 1_000n, 1n, 10n ** 9n)).toEqual({ ok: true });
  });

  test('ladder: a trigger value of one lamport is valid', () => {
    expect(planAttempt(G.ladder, 1, 1n, 1n)).toMatchObject({ ok: true, rung: 0 });
  });

  test('a sale of one raw unit counts as the partial', () => {
    expect(decide(holding({ sold: 1n }), obs(NOW)).tracker).toMatchObject({ partials: 1, lastSold: 1n });
  });

  test('a zero-flow minute is not the start of a negative run', () => {
    const flow = [{ startMs: 0, net: 0n }, ...Array.from({ length: 4 }, (_, i) => ({ startMs: (i + 1) * MINUTE_MS, net: -1n }))];
    expect(codes(decide(holding(), obs(5 * MINUTE_MS, VAULT, { flow })).decision)).toEqual([]);
  });

  test('the peak rises to a higher price after a lower one', () => {
    const low = decide(holding(), obs(NOW, 70_000_000_000n)).tracker;
    expect(decide(holding(), obs(NOW + 1, VAULT), plan(), low).tracker.peak).toBe(execPrice(V0, QTY));
  });

  test('nothing held is not managed; one raw unit is', () => {
    expect(decide({ ...holding(), quantity: 0n }, obs(NOW)).decision).toMatchObject({ kind: 'hold', detail: 'nothing to manage (open)' });
    const one: Holding = { ...holding(), quantity: 1n };
    expect(decide(one, obs(X.tMaxMs), plan(), { ...newTracker(), flatMet: true }).decision).toMatchObject({ kind: 'exit', quantity: 1n, reasons: ['max_hold'] });
  });

  test('a time stop with no market or a stale one is remembered until a fresh quote (EXIT-1c), never booked blocked', () => {
    const t = { ...newTracker(), flatMet: true };
    for (const o of [obs(X.tMaxMs, null), obs(X.tMaxMs, VAULT, { market: { atMs: 0, value: market(VAULT) } })]) {
      const step = decide(holding(), o, plan(), t);
      expect(step.decision).toMatchObject({ kind: 'hold', detail: 'full exit remembered: waiting for a fresh quote' });
      expect(codes(step.decision)).toEqual(['time_max']);
      expect(step.tracker.pendingFull).toEqual(['max_hold']);
    }
    // One millisecond inside the quote age is fresh: the exit goes.
    const edge = { atMs: X.tMaxMs - S.maxQuoteAgeMs, value: market(VAULT) };
    expect(decide(holding(), obs(X.tMaxMs, VAULT, { market: edge }), plan(), t).decision).toMatchObject({ kind: 'exit', value: { ok: true } });
    const past = { atMs: X.tMaxMs - S.maxQuoteAgeMs - 1, value: market(VAULT) };
    expect(decide(holding(), obs(X.tMaxMs, VAULT, { market: past }), plan(), t).decision.kind).toBe('hold');
  });

  test('time is measured from the entry fill, not from zero', () => {
    const opened = 10 * MINUTE_MS;
    const t = { ...newTracker(), flatMet: true };
    expect(codes(decide(holding(), obs(opened + X.tMaxMs - 1), plan({ openedAtMs: opened }), t).decision)).toEqual([]);
    expect(codes(decide(holding(), obs(opened + X.tMaxMs), plan({ openedAtMs: opened }), t).decision)).toEqual(['time_max']);
  });

  test('a full exit is neither a partial nor a retry', () => {
    expect(decide(holding(), obs(NOW), plan({ stopPrice: execPrice(V0, QTY) })).decision).toMatchObject({ kind: 'exit', partial: false, retry: false, startRung: 0 });
    const all = exitSettings(withU2({ partialMinShareBps: 10_000 }), 'wick', FILL_CONFIG.network);
    const tp = (R * BigInt(X.partialAtRBps)) / 10_000n;
    expect(decide(holding({ pnl: tp }), obs(NOW), plan(), newTracker(), all).decision).toMatchObject({ kind: 'exit', partial: false, retry: false });
  });
});

// Review round 1 (PR #33): the ladder budget is per position, escalation never goes down, retry cost, partial count.
describe('ladder budget per position', () => {
  const stop = plan({ stopPrice: execPrice(V0, QTY) });
  const tried = (rung: number | null): ExitTracker => ({ ...newTracker(), lastRung: rung });
  /** An attempt recorded on an exit intent, as the book holds it after a sign. Only the count matters here. */
  const signOn = (b: Book, id: string): Book => {
    const i = b.intents[id]!;
    return { ...b, intents: { ...b.intents, [id]: { ...i, attempts: [...i.attempts, i.attempts[0] ?? ({ id: `${id}.a` } as never)] } } };
  };
  const unfilled = (b: Book): Book => {
    const r = applyPositionEvent(b.positions[PID]!, { type: 'exit_unfilled' });
    if (isIllegal(r)) throw new Error(r.reason);
    return { ...b, positions: { [PID]: r.state } };
  };

  test('noteAttempt keeps the highest rung', () => {
    const t = noteAttempt(noteAttempt(newTracker(), 2), 1);
    expect(t.lastRung).toBe(2);
    expect(noteAttempt(t, 3).lastRung).toBe(3);
  });

  test('exitAttemptsOf counts the signed attempts of this position\'s exit intents only', () => {
    let { book } = apply(openBook(), exitBookEvents(PID, decide(holding(), obs(NOW), stop).decision, intentId('ex1')));
    book = signOn(signOn(book, 'ex1'), 'ex1');
    const other = { ...book.intents['ex1']!, intent: { ...book.intents['ex1']!.intent, positionId: positionId('p2') } };
    const entry = { ...book.intents['ex1']!, intent: { ...book.intents['ex1']!.intent, purpose: 'entry' } } as never;
    const mixed = { ...book.intents, ex2: other, en9: entry };
    expect(exitAttemptsOf(book.intents, PID)).toBe(2);
    expect(exitAttemptsOf(mixed, PID)).toBe(2);
    expect(exitAttemptsOf({}, PID)).toBe(0);
  });

  test('a new owner gets only the attempts that remain, starting above the highest rung tried', () => {
    const at = (exitAttempts: number, t = tried(null)) => decide(holding({ exitAttempts }), obs(NOW), stop, t).decision;
    expect(at(0)).toMatchObject({ kind: 'exit', startRung: 0, maxAttempts: G.ladder.maxAttempts, blocked: null });
    expect(at(3, tried(2))).toMatchObject({ kind: 'exit', startRung: 3, maxAttempts: 2, blocked: null });
    expect(at(1, tried(0))).toMatchObject({ kind: 'exit', startRung: 1, maxAttempts: 4 });
    expect(at(1, tried(2))).toMatchObject({ kind: 'exit', startRung: 3, maxAttempts: 4 });
    expect(at(4, tried(3))).toMatchObject({ kind: 'exit', startRung: 3, maxAttempts: 1, blocked: null });
    // A lost rung (restart): the count is the floor, so escalation never goes down.
    expect(at(2)).toMatchObject({ kind: 'exit', startRung: 2, maxAttempts: 3 });
    expect(at(4)).toMatchObject({ kind: 'exit', startRung: 3, maxAttempts: 1 });
  });

  test('with the ladder used up, a trigger books the exit blocked at once with a critical alert', () => {
    const d = decide(holding({ exitAttempts: G.ladder.maxAttempts }), obs(NOW), stop).decision;
    expect(d).toMatchObject({ kind: 'exit', maxAttempts: 0, blocked: `exit ladder used: ${G.ladder.maxAttempts} attempts on this position` });
    const events = exitBookEvents(PID, d, intentId('ex9'));
    expect(events.map((e) => e.type)).toEqual(['trigger_exit', 'exit_blocked']);
    const { book, effects } = apply(openBook(), events);
    expect(book.positions[PID]).toMatchObject({ status: 'exit_blocked', quantity: QTY, blockedReason: `exit ladder used: ${G.ladder.maxAttempts} attempts on this position` });
    expect(effects).toContainEqual({ type: 'alert', level: 'critical', code: 'exit_blocked', subject: PID });
  });

  /** Owners end unfilled after two attempts each; the count lives in the book. `restartEvery` drops the tracker. */
  const drive = (restartEvery: number | null) => {
    let book = openBook();
    let t = newTracker();
    let attempts = 0;
    let now = NOW;
    for (let round = 0; round < 60; round++) {
      if (restartEvery !== null && round % restartEvery === 0) t = newTracker();
      const p = book.positions[PID]!;
      now += G.blockedRetryMs;
      const step = decide(holdingOf(p, 0n, book), obs(now), stop, t);
      t = step.tracker;
      const d = step.decision;
      if (d.kind !== 'exit') continue;
      const id = `ex${round}`;
      book = apply(book, exitBookEvents(PID, d, intentId(id))).book;
      if (d.blocked !== null) continue;
      for (let n = 1; n <= Math.min(2, d.maxAttempts); n++) {
        const a = planAttempt(G.ladder, n, V0, V0, d.startRung, d.maxAttempts, t.lastRung);
        if (!a.ok) break;
        t = noteAttempt(t, a.rung);
        book = signOn(book, id);
        attempts++;
      }
      // The owner's attempts all failed: blocked if it was a retry, else back to open.
      book = d.retry ? apply(book, [{ type: 'exit_blocked', positionId: PID, reason: 'retry failed' }]).book : unfilled(book);
    }
    return { attempts, book };
  };

  test('owners that end unfilled never restart the ladder: maxAttempts plus the bounded retries, then blocked', () => {
    const { attempts, book } = drive(null);
    expect(attempts).toBe(G.ladder.maxAttempts + G.blockedRetryAttempts);
    expect(exitAttemptsOf(book.intents, PID)).toBe(attempts);
    expect(book.positions[PID]!.status).toBe('exit_blocked');
  });

  test('a restart with a fresh tracker and the same book gets no new ladder and no new retries', () => {
    for (const every of [1, 2, 3]) {
      const { attempts, book } = drive(every);
      // Never more than the bound; a restart also restarts the retry wait, so it can only be fewer.
      expect(attempts).toBeGreaterThanOrEqual(G.ladder.maxAttempts);
      expect(attempts).toBeLessThanOrEqual(G.ladder.maxAttempts + G.blockedRetryAttempts);
      expect(book.positions[PID]!.status).toBe('exit_blocked');
    }
    // Directly: budget used, then a fresh tracker.
    const spent = holding({ exitAttempts: G.ladder.maxAttempts });
    expect(decide(spent, obs(NOW), stop, newTracker()).decision).toMatchObject({ kind: 'exit', maxAttempts: 0, blocked: expect.any(String) });
    const blocked = { ...spent, status: 'exit_blocked' as const, exitAttempts: G.ladder.maxAttempts + G.blockedRetryAttempts };
    expect(decide(blocked, obs(NOW + G.blockedRetryMs), stop, { ...newTracker(), blockedAtMs: NOW }).decision).toMatchObject({ kind: 'hold', detail: 'exit blocked: retries used' });
    const oneLeft = { ...blocked, exitAttempts: G.ladder.maxAttempts + G.blockedRetryAttempts - 1 };
    const retry = decide(oneLeft, obs(NOW + G.blockedRetryMs), stop, { ...newTracker(), blockedAtMs: NOW });
    expect(retry.decision).toMatchObject({ kind: 'exit', retry: true });
    expect(retry.tracker.blockedRetries).toBe(G.blockedRetryAttempts);
  });

  test('escalation never goes down after a skip upward or across owners', () => {
    const trig = 10_000_000n;
    expect(planAttempt(G.ladder, 1, trig, trig, 0, 5, 1)).toMatchObject({ ok: true, rung: 2 });
    expect(planAttempt(G.ladder, 1, trig, trig, 0, 5, 0)).toMatchObject({ ok: true, rung: 1 });
    // Attempt 2 is scheduled at rung 1, but rung 2 was already tried.
    expect(planAttempt(G.ladder, 2, trig, trig, 0, 5, 2)).toMatchObject({ ok: true, rung: 3 });
    // At the last rung it stays there.
    expect(planAttempt(G.ladder, 1, trig, trig, 0, 5, 3)).toMatchObject({ ok: true, rung: 3 });
    expect(planAttempt(G.ladder, 1, trig, trig, 0, 5, null)).toMatchObject({ ok: true, rung: 0 });
  });

  test('a partial filled in two steps under one owner is one partial', () => {
    const t1 = decide(holding({ sold: QTY / 4n, exitSeq: 1 }), obs(NOW)).tracker;
    expect(t1).toMatchObject({ partials: 1, partialSeq: 1 });
    const t2 = decide(holding({ sold: QTY / 2n, exitSeq: 1 }), obs(NOW + 1), plan(), t1).tracker;
    expect(t2).toMatchObject({ partials: 1, lastSold: QTY / 2n });
    const t3 = decide(holding({ sold: (3n * QTY) / 4n, exitSeq: 2 }), obs(NOW + 2), plan(), t2).tracker;
    expect(t3).toMatchObject({ partials: 2, partialSeq: 2 });
  });
});

describe('policy validation of the new exit fields', () => {
  const withExits = (patch: Partial<Policy['exits']>) => ({ ...TRIAL_POLICY, exits: { ...G, ...patch } });
  test('blockedRetryAttempts is a whole number >= 0; atrPeriod a whole number >= 1', () => {
    expect(policyIssues(withExits({ blockedRetryAttempts: 0 }))).toEqual([]);
    expect(policyIssues(withExits({ blockedRetryAttempts: -1 })).length).toBeGreaterThan(0);
    expect(policyIssues(withExits({ blockedRetryAttempts: 1.5 })).length).toBeGreaterThan(0);
    expect(policyIssues(withU2({ atrPeriod: 1 }))).toEqual([]);
    expect(policyIssues(withU2({ atrPeriod: 0 })).length).toBeGreaterThan(0);
    expect(policyIssues(withU2({ atrPeriod: 2.5 })).length).toBeGreaterThan(0);
  });
});

// ---------- EXIT-1b (external review): each case first failed on the merged EXIT-1 ----------
describe('EXIT-1b item 4: an exit quotes the quantity it sells', () => {
  const tp = (R * BigInt(X.partialAtRBps)) / 10_000n;
  test('a partial carries the quote for its own quantity, and the ladder, min-out and fill agree in an unchanged pool', () => {
    const d = decide(holding({ pnl: tp }), obs(NOW)).decision;
    if (d.kind !== 'exit') throw new Error('expected an exit');
    expect(d.partial).toBe(true);
    const half = valueAt(VAULT, d.quantity);
    expect(d.value).toEqual({ ok: true, value: half });
    expect(half).toBeLessThan(V0); // the whole holding's value is not what this order sells
    if (!d.value.ok) throw new Error('unquotable');
    // Every rung, the last included, accepts the fresh quote of the same quantity in the same pool.
    for (let rung = 0; rung < G.ladder.steps.length; rung++) {
      const p = planAttempt(G.ladder, 1, d.value.value, half, rung, 1);
      expect(p, `rung ${rung}`).toMatchObject({ ok: true, rung });
      if (!p.ok) continue;
      const fill = poolSell(pool(VAULT), d.quantity, CTX);
      expect(fill.ok && fill.trade.userQuote >= p.minOut, `rung ${rung}`).toBe(true);
    }
  });
  test('a full exit still carries the whole holding\'s quote', () => {
    const d = decide(holding(), obs(NOW), plan({ stopPrice: execPrice(V0, QTY) })).decision;
    expect(d).toMatchObject({ kind: 'exit', partial: false, quantity: QTY, value: { ok: true, value: V0 } });
  });
});

describe('EXIT-1b item 5: a blocked retry must pay for itself after the worst slippage', () => {
  test('the least proceeds the last rung accepts, not the quote, must exceed the attempt cost', () => {
    const h = holdingOf(blockedBook().positions[PID]!);
    const t = { ...newTracker(), blockedAtMs: 0 };
    const at = G.blockedRetryMs;
    const v = valueAt(VAULT);
    const lastSlip = BigInt(G.ladder.steps[G.ladder.steps.length - 1]!.minOutBelowTriggerBps);
    const leastProceeds = (v * (10_000n - lastSlip)) / 10_000n;
    const withCost = (retryCost: bigint) => ({ ...S, retryCost });
    // The quote is above the cost, but the least the last rung accepts is not: no retry.
    expect(v).toBeGreaterThan(leastProceeds);
    expect(decide(h, obs(at), plan(), t, withCost(leastProceeds)).decision).toMatchObject({ kind: 'hold', detail: 'exit blocked: the least accepted proceeds do not cover the attempt' });
    expect(decide(h, obs(at), plan(), t, withCost(v - 1n)).decision.kind).toBe('hold');
    expect(decide(h, obs(at), plan(), t, withCost(leastProceeds - 1n)).decision).toMatchObject({ kind: 'exit', retry: true });
  });
});

describe('EXIT-1b item 6: when an in-flight partial resolves, the rest is reassessed at once', () => {
  const tp = (R * BigInt(X.partialAtRBps)) / 10_000n;
  test('a stop that fired during the partial exits the rest on the first step with a fresh quote, on the normal ladder', () => {
    const stop = plan({ stopPrice: execPrice(V0, QTY) });
    // The partial is in flight; the price stop fires on the whole holding and is merged into the partial's owner.
    const pending = decide(holding({ status: 'exit_pending' }), obs(NOW), stop);
    expect(pending.decision.kind).toBe('merge');
    const rest = holding({ quantity: QTY / 2n, sold: QTY / 2n, exitSeq: 2, exitAttempts: 1 });
    // The partial fills while the market state is stale: a timing artefact, so it waits and keeps the stop.
    const atFill = decideExit(S, stop, rest, pending.tracker, obs(NOW + 60_000, null));
    expect(atFill.decision).toMatchObject({ kind: 'hold', detail: 'full exit remembered: waiting for a fresh quote' });
    expect(atFill.tracker.pendingFull).toEqual(pending.tracker.pendingFull);
    // 2 s later with a fresh quote the rest goes at once: no blocked retry, the next rung, the attempts left.
    const after = decideExit(S, stop, rest, atFill.tracker, obs(NOW + 62_000));
    expect(after.decision).toMatchObject({ kind: 'exit', partial: false, retry: false, quantity: QTY / 2n, maxAttempts: G.ladder.maxAttempts - 1 });
    if (after.decision.kind !== 'exit') return;
    expect(after.decision.startRung).toBe(Math.min(Math.max(atFill.tracker.lastRung === null ? 0 : atFill.tracker.lastRung + 1, 1), G.ladder.steps.length - 1));
    expect(after.decision.reasons).toContain('stop');
    expect(after.decision.value.ok).toBe(true);
    expect(after.decision.blocked).toBeNull();
    // Once taken, the remembered trigger is cleared.
    expect(after.tracker.pendingFull).toBeNull();
  });
  test('with a fresh quote, the remembered exit goes even when the price has recovered and nothing fires now', () => {
    const stop = plan({ stopPrice: execPrice(V0, QTY) });
    const pending = decide(holding({ status: 'exit_pending' }), obs(NOW), stop);
    const recovered = holding({ quantity: QTY / 2n, sold: QTY / 2n, exitSeq: 2, vault: VAULT * 2n, pnl: R });
    const d = decideExit(S, stop, recovered, pending.tracker, obs(NOW + 1_000, VAULT * 2n));
    expect(d.decision).toMatchObject({ kind: 'exit', partial: false, retry: false, startRung: 0, maxAttempts: G.ladder.maxAttempts, fired: [] });
    if (d.decision.kind !== 'exit') return;
    expect(d.decision.reasons).toEqual(['stop']);
    expect(d.tracker.pendingFull).toBeNull();
  });
  test('with no quote, a trigger that fires without one joins the remembered exit, which goes on the first fresh quote (EXIT-1c)', () => {
    const stop = plan({ stopPrice: execPrice(V0, QTY) });
    const pending = decide(holding({ status: 'exit_pending' }), obs(NOW), stop);
    const rest = holding({ quantity: QTY / 2n, sold: QTY / 2n, exitSeq: 2 });
    const late = decideExit(S, stop, rest, pending.tracker, obs(NOW + X.tMaxMs, null));
    expect(late.decision).toMatchObject({ kind: 'hold', detail: 'full exit remembered: waiting for a fresh quote' });
    expect(late.tracker.pendingFull).toEqual(expect.arrayContaining(['stop', 'max_hold']));
    const quoted = decideExit(S, stop, rest, late.tracker, obs(NOW + X.tMaxMs + 400));
    expect(quoted.decision).toMatchObject({ kind: 'exit', partial: false, retry: false, quantity: QTY / 2n, blocked: null });
    if (quoted.decision.kind !== 'exit') return;
    expect(quoted.decision.reasons).toEqual(expect.arrayContaining(['stop', 'max_hold']));
    expect(quoted.decision.value.ok).toBe(true);
    expect(quoted.tracker.pendingFull).toBeNull();
  });
  test('a take-profit merged into an in-flight exit is not remembered as a full exit', () => {
    const pending = decide(holding({ status: 'exit_pending', pnl: tp }), obs(NOW));
    expect(pending.tracker.pendingFull).toBeNull();
  });
});

describe('EXIT-1b edges (mutation)', () => {
  const L = G.ladder;
  test('min-out rounds down, to the lamport', () => {
    const trig = 1_000_003n; // trig x 9,200 is not a multiple of 10,000
    const p = planAttempt(L, 1, trig, trig);
    expect(p).toMatchObject({ ok: true, rung: 0, minOut: (trig * BigInt(10_000 - L.steps[0]!.minOutBelowTriggerBps)) / 10_000n });
    expect((trig * BigInt(10_000 - L.steps[0]!.minOutBelowTriggerBps)) % 10_000n).not.toBe(0n);
  });
  test('the attempt number and start rung must be whole numbers', () => {
    expect(() => planAttempt(L, 1.5, 1_000n, 1_000n)).toThrow(RangeError);
    expect(() => planAttempt(L, Number.NaN, 1_000n, 1_000n)).toThrow(RangeError);
    expect(() => planAttempt(L, 1, 1_000n, 1_000n, 0.5)).toThrow(RangeError);
    expect(() => planAttempt(L, 1, 1_000n, 1_000n, Number.NaN)).toThrow(RangeError);
  });
  const afterPartial = { ...newTracker(), partials: 1, lastSold: QTY, flatMet: true };
  const bars = flatBars(20, 1_000n, 0);
  test('a runner with no quote yet: no trail, no break-even, no trailing stop, and nothing throws', () => {
    const runner = holding({ sold: QTY });
    const later = 21 * MINUTE_MS; // enough finished bars for an ATR
    expect(atr(bars, X.atrPeriod, X.atrBarMs, later)).not.toBeNull();
    const step = decide(runner, obs(later, null, { bars }), plan(), afterPartial);
    expect(step.tracker.trail).toBeNull();
    expect(codes(step.decision)).not.toContain('break_even');
    const withTrail = decide(runner, obs(NOW, null, { bars }), plan(), { ...afterPartial, peak: 10n ** 30n, trail: 10n ** 30n });
    expect(codes(withTrail.decision)).not.toContain('trailing_stop');
  });
  test('the exit taken after a partial resolves is an ordinary exit on the ladder, not a blocked retry', () => {
    const stop = plan({ stopPrice: execPrice(V0, QTY) });
    const pending = decide(holding({ status: 'exit_pending' }), obs(NOW), stop);
    const after = decideExit(S, stop, holding({ quantity: QTY / 2n, sold: QTY / 2n, exitSeq: 2 }), pending.tracker, obs(NOW + 60_000));
    expect(after.decision).toMatchObject({ kind: 'exit', retry: false, startRung: 0, maxAttempts: G.ladder.maxAttempts });
  });
});

describe('EXIT-1b follow-up ruling: sell before reclaiming rent; a bounded sell-only recovery path', () => {
  const stop = plan({ stopPrice: execPrice(V0, QTY) });
  test('a full exit of a clean account sells and closes in one transaction (rent comes back only if it lands)', () => {
    expect(decide(holding(), obs(NOW), stop).decision).toMatchObject({ kind: 'exit', partial: false, quantity: QTY, closeAccount: true });
  });
  test('a partial never closes the account', () => {
    const tp = (R * BigInt(X.partialAtRBps)) / 10_000n;
    expect(decide(holding({ pnl: tp }), obs(NOW)).decision).toMatchObject({ kind: 'exit', partial: true, closeAccount: false });
  });
  test('dust or unsolicited tokens in the account do not block the sale: our quantity is sold and the account stays open', () => {
    const extra = holding({ tokenAccountBalance: QTY + 1_000n });
    expect(decide(extra, obs(NOW), stop).decision).toMatchObject({ kind: 'exit', partial: false, quantity: QTY, closeAccount: false, value: { ok: true, value: V0 } });
  });
  test('after a sell-and-close failed at the close, later exits sell only, within the same ladder and retries', () => {
    const failed = holding({ closeFailed: true, exitAttempts: 1 });
    const d = decide(failed, obs(NOW), stop).decision;
    expect(d).toMatchObject({ kind: 'exit', partial: false, quantity: QTY, closeAccount: false, maxAttempts: G.ladder.maxAttempts - 1 });
    // A blocked position retries sell-only too.
    const blocked = { ...holdingOf(blockedBook().positions[PID]!), closeFailed: true };
    const retry = decide(blocked, obs(G.blockedRetryMs), plan(), { ...newTracker(), blockedAtMs: 0 }).decision;
    expect(retry).toMatchObject({ kind: 'exit', retry: true, closeAccount: false });
    // Bounded: once the ladder is used, the exit is booked blocked like any other.
    expect(decide({ ...failed, exitAttempts: G.ladder.maxAttempts }, obs(NOW), stop).decision).toMatchObject({ kind: 'exit', closeAccount: false, blocked: `exit ladder used: ${G.ladder.maxAttempts} attempts on this position` });
  });
});

describe('EXIT-1c: an exit with no quote yet waits for the first fresh quote, never booked blocked', () => {
  const flat = { ...newTracker(), flatMet: true };
  const toBook = (d: ExitDecision) => exitBookEvents(PID, d, intentId('ex1')).map((e) => e.type);
  const firstQuote = (reason: string, h: Holding, t: ExitTracker, at: number, o: Partial<ExitObservation> = {}) => {
    const after = decide(h, obs(at, VAULT, o), plan(), t);
    expect(after.decision).toMatchObject({ kind: 'exit', partial: false, retry: false, quantity: QTY, startRung: 0, maxAttempts: G.ladder.maxAttempts, blocked: null });
    if (after.decision.kind !== 'exit') return;
    expect(after.decision.value.ok).toBe(true);
    expect(after.decision.reasons).toContain(reason);
    expect(toBook(after.decision)).toEqual(['trigger_exit']);
    expect(after.tracker.pendingFull).toBeNull();
  };
  test('a time stop after downtime longer than T_max, with no market state yet: held, then fires on the first quote', () => {
    const late = X.tMaxMs + 3_600_000;
    const waiting = decide(holding(), obs(late, null), plan(), flat);
    expect(waiting.decision).toMatchObject({ kind: 'hold', detail: 'full exit remembered: waiting for a fresh quote' });
    expect(codes(waiting.decision)).toEqual(['time_max']);
    expect(waiting.tracker.pendingFull).toEqual(['max_hold']);
    // A stale market state is no quote either.
    const stale = decide(holding(), obs(late + 400, VAULT, { market: { atMs: 0, value: market(VAULT) } }), plan(), waiting.tracker);
    expect(stale.decision).toMatchObject({ kind: 'hold', detail: 'full exit remembered: waiting for a fresh quote' });
    firstQuote('max_hold', holding(), stale.tracker, late + 800);
  });
  test('a deployer sale seen with no market state yet: held, then fires on the first quote even if the deployer reading is gone', () => {
    const dev = { deployerSoldBps: { atMs: NOW, value: G.deployerSellSupplyBps + 1 } };
    const waiting = decide(holding(), obs(NOW, null, dev));
    expect(waiting.decision).toMatchObject({ kind: 'hold', detail: 'full exit remembered: waiting for a fresh quote' });
    expect(waiting.tracker.pendingFull).toEqual(['thesis_lost']);
    firstQuote('thesis_lost', holding(), waiting.tracker, NOW + 400);
  });
  test('a real refusal is still booked blocked: a fresh market that cannot quote the sale', () => {
    const t1 = decide(holding(), obs(NOW)).tracker;
    const step = decide(holding(), obs(NOW + 400, 0n), plan(), t1);
    expect(step.decision).toMatchObject({ kind: 'exit', value: { ok: false, reason: 'no-liquidity' } });
    expect(toBook(step.decision)).toEqual(['trigger_exit', 'exit_blocked']);
  });
  test('a used ladder is still booked blocked once the quote is there', () => {
    const used = holding({ exitAttempts: G.ladder.maxAttempts });
    const waiting = decide(used, obs(X.tMaxMs, null), plan(), flat);
    expect(waiting.decision.kind).toBe('hold');
    const after = decide(used, obs(X.tMaxMs + 400), plan(), waiting.tracker);
    expect(after.decision).toMatchObject({ kind: 'exit', blocked: `exit ladder used: ${G.ladder.maxAttempts} attempts on this position` });
  });
});
