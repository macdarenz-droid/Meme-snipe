// EXIT-1 (docs/ARCHITECTURE.md §9): every accept item of the card, with exact boundaries so a changed comparison or
// threshold fails a test (mutation testing on triggers and the ladder).
import { describe, expect, test } from 'vitest';
import { type PoolState, poolSell } from '../../src/amm/index.ts';
import { FILL_CONFIG, MINUTE_MS, TRIAL_POLICY, type Policy, policyIssues } from '../../src/config/index.ts';
import { intentId, mint, positionId } from '../../src/domain/index.ts';
import {
  type EntryPlan, type ExitDecision, type ExitMarket, type ExitObservation, type ExitTracker, type FlowMinute, type Holding,
  type PriceBar, PRICE_SCALE, atOrBelow, atr, checkStopDistance, decideExit, execPrice, exitBookEvents, exitSettings,
  liquidationValue, maxExitTransactions, newTracker, noteAttempt, planAttempt, quoteReserve,
} from '../../src/exits/index.ts';
import { type ObservedFees, observedFeeContext } from '../../src/fills/index.ts';
import { type Book, applyBookEvent, emptyBook, isIllegal, newPosition, applyPositionEvent, type PositionState } from '../../src/lifecycle/index.ts';
import { bps, lamports, microUsd, raw } from '../../src/units/index.ts';
import { usd } from '../../src/config/index.ts';
import { CHECKED_GLOBAL, NORMAL_COIN, PUMP_FEE_CONFIG } from '../amm/helpers.ts';

const X = TRIAL_POLICY.exits;
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
  openedAtMs: 0, notional: TRIAL_POLICY.capital.minNotional, riskUnit: R, stopPrice: 1n, entryReserve: VAULT, ...o,
});
/** costBasis chosen so the P&L at `vault` is exactly `pnl`. */
const holding = (o: Partial<Holding> & { pnl?: bigint; vault?: bigint } = {}): Holding => {
  const { pnl = 0n, vault = VAULT, ...rest } = o;
  const quantity = rest.quantity ?? QTY;
  const realized = rest.realized ?? 0n;
  return {
    status: 'open', quantity, sold: 0n, realized, exitCost: EXIT_COST, exitSeq: 1,
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
    expect(checkStopDistance(TRIAL_POLICY, entry, entry, wide)).toMatchObject({ ok: false, reason: 'stop-not-below-entry' });
    expect(checkStopDistance(TRIAL_POLICY, entry, 0n, wide)).toMatchObject({ ok: false, reason: 'stop-not-below-entry' });
    expect(checkStopDistance(TRIAL_POLICY, entry, entry - sMax, wide)).toEqual({ ok: true });
    expect(checkStopDistance(TRIAL_POLICY, entry, entry - sMax - 1n, wide)).toMatchObject({ ok: false, reason: 'too-wide' });
    expect(checkStopDistance(TRIAL_POLICY, entry, entry - 1n, null)).toMatchObject({ ok: false, reason: 'no-atr' });
    // 3.0 × ATR 10,000 = 30,000.
    expect(checkStopDistance(TRIAL_POLICY, entry, entry - 30_000n, 10_000n)).toEqual({ ok: true });
    expect(checkStopDistance(TRIAL_POLICY, entry, entry - 30_001n, 10_000n)).toMatchObject({ ok: false, reason: 'beyond-atr' });
  });
});

describe('flow and thesis stops', () => {
  test('deployer cluster selling more than 2% of supply, not at 2%', () => {
    const at = (bps: number) => codes(decide(holding(), obs(NOW, VAULT, { deployerSoldBps: { atMs: NOW, value: bps } })).decision);
    expect(at(X.deployerSellSupplyBps)).toEqual([]);
    expect(at(X.deployerSellSupplyBps + 1)).toEqual(['deployer_sell']);
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

describe('profit taking: partial and runner, by size', () => {
  const tp = (R * BigInt(X.partialAtRBps)) / 10_000n; // 1.5R = 3,000,000

  test('size rule: two exit transactions at q_min, three from 2 × q_min', () => {
    const min = TRIAL_POLICY.capital.minNotional;
    expect(maxExitTransactions(S, min)).toBe(X.maxExitTxAtMinNotional);
    expect(maxExitTransactions(S, microUsd(2n * min - 1n))).toBe(X.maxExitTxAtMinNotional);
    expect(maxExitTransactions(S, microUsd(2n * min))).toBe(X.maxExitTxAboveDoubleMin);
  });

  test('a partial of at least half at +1.5R, and not one lamport below', () => {
    const d = decide(holding({ pnl: tp }), obs(NOW)).decision;
    expect(d).toMatchObject({ kind: 'exit', partial: true, retry: false, quantity: QTY / 2n, reasons: ['take_profit'], startRung: 0, maxAttempts: X.ladder.maxAttempts });
    expect(decide(holding({ pnl: tp - 1n }), obs(NOW)).decision.kind).toBe('hold');
  });

  test('the partial share rounds up, and a share that is the whole holding is a full exit', () => {
    const odd = holding({ pnl: tp, quantity: QTY + 1n });
    expect(decide(odd, obs(NOW)).decision).toMatchObject({ kind: 'exit', partial: true, quantity: QTY / 2n + 1n });
    const all = exitSettings({ ...TRIAL_POLICY, exits: { ...X, partialMinShareBps: 10_000 } }, 'wick', FILL_CONFIG.network);
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
  const L = X.ladder;
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
const holdingOf = (p: PositionState, pnl = 0n): Holding => holding({ status: p.status, quantity: p.quantity, sold: p.sold, pnl });

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

describe('blocked exits: retried on the ladder, bounded, alerting', () => {
  const blockedBook = (): Book => {
    const step = decide(holding(), obs(NOW, 0n)).decision;
    return apply(openBook(), exitBookEvents(PID, step, intentId('ex1'))).book;
  };

  test('first seen blocked: wait; retry after blockedRetryMs at the last rung with one attempt', () => {
    const p = blockedBook().positions[PID]!;
    const h = holdingOf(p);
    const seen = decide(h, obs(NOW));
    expect(seen.decision).toMatchObject({ kind: 'hold', detail: 'exit blocked: waiting to retry' });
    expect(seen.tracker.blockedAtMs).toBe(NOW);
    expect(decide(h, obs(NOW + X.blockedRetryMs - 1), plan(), seen.tracker).decision.kind).toBe('hold');
    const retry = decide(h, obs(NOW + X.blockedRetryMs), plan(), seen.tracker);
    expect(retry.decision).toMatchObject({
      kind: 'exit', retry: true, partial: false, quantity: QTY, reasons: ['emergency'], startRung: X.ladder.steps.length - 1, maxAttempts: 1,
    });
    expect(retry.tracker).toMatchObject({ blockedAtMs: null, blockedRetries: 1 });
    // The retry is a new exit owner on the blocked position.
    const { book } = apply(blockedBook(), exitBookEvents(PID, retry.decision, intentId('ex2')));
    expect(book.positions[PID]).toMatchObject({ status: 'exit_requested', exitOwner: { intentId: 'ex2', quantity: QTY } });
  });

  test('a retry carries the reasons that still hold', () => {
    const h = holdingOf(blockedBook().positions[PID]!);
    const t = { ...newTracker(), blockedAtMs: 0 };
    const d = decide(h, obs(X.blockedRetryMs, VAULT, { sellRoute: { atMs: X.blockedRetryMs, value: 'missing' } }), plan(), t).decision;
    expect(d).toMatchObject({ kind: 'exit', retry: true, reasons: ['liquidity'] });
  });

  test('no retry without a quote, when the quote does not cover the attempt, or once the retries are used', () => {
    const h = holdingOf(blockedBook().positions[PID]!);
    const t = { ...newTracker(), blockedAtMs: 0 };
    const at = X.blockedRetryMs;
    expect(decide(h, obs(at, 0n), plan({ entryReserve: 1n }), t).decision).toMatchObject({ kind: 'hold', detail: 'exit blocked: pool has no usable reserves' });
    const v = valueAt(VAULT);
    const at0 = (retryCost: bigint) => ({ ...S, retryCost });
    expect(decide(h, obs(at), plan(), t, at0(v)).decision).toMatchObject({ kind: 'hold', detail: 'exit blocked: the quote does not cover the attempt' });
    expect(decide(h, obs(at), plan(), t, at0(v - 1n)).decision).toMatchObject({ kind: 'exit', retry: true });
    // The retry cost is base + the last rung's capped fee + tip, not the first-rung exit cost.
    const n = FILL_CONFIG.network;
    expect(S.retryCost).toBe(n.signaturesPerTx * n.baseFeePerSignature + X.ladder.maxFeePerAttempt + n.tip);
    const lowCap = exitSettings({ ...TRIAL_POLICY, exits: { ...X, ladder: { ...X.ladder, maxFeePerAttempt: lamports(400_000n) } } }, 'wick', n);
    expect(lowCap.retryCost).toBe(n.signaturesPerTx * n.baseFeePerSignature + 400_000n + n.tip);
    const highCap = exitSettings({ ...TRIAL_POLICY, exits: { ...X, ladder: { ...X.ladder, maxFeePerAttempt: lamports(600_000n) } } }, 'wick', n);
    expect(highCap.retryCost).toBe(n.signaturesPerTx * n.baseFeePerSignature + 500_000n + n.tip);
    expect(decide({ ...h, exitCost: v }, obs(at), plan(), t).decision).toMatchObject({ kind: 'exit', retry: true });
    const used = { ...t, blockedRetries: X.blockedRetryAttempts };
    expect(decide(h, obs(at), plan(), used).decision).toMatchObject({ kind: 'hold', detail: 'exit blocked: retries used' });
    expect(decide(h, obs(at), plan(), { ...used, blockedRetries: X.blockedRetryAttempts - 1 }).decision).toMatchObject({ kind: 'exit', retry: true });
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
  const tightened = (patch: Partial<Policy['exits']>) => exitSettings({ ...TRIAL_POLICY, exits: { ...X, ...patch } }, 'wick', FILL_CONFIG.network);

  test('each trigger moves with its policy value', () => {
    const dev = obs(NOW, VAULT, { deployerSoldBps: { atMs: NOW, value: 101 } });
    expect(codes(decide(holding(), dev).decision)).toEqual([]);
    expect(codes(decide(holding(), dev, plan(), newTracker(), tightened({ deployerSellSupplyBps: 100 })).decision)).toEqual(['deployer_sell']);
    expect(codes(decide(holding(), obs(60 * MINUTE_MS), plan(), { ...newTracker(), flatMet: true }, tightened({ tMaxMs: 60 * MINUTE_MS })).decision)).toEqual(['time_max']);
    expect(decide(holding({ pnl: R }), obs(NOW), plan(), newTracker(), tightened({ partialAtRBps: 10_000, partialMinShareBps: 7_500 })).decision)
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
    expect(checkStopDistance(anyWidth, 1_000n, 1n, 10n ** 9n)).toEqual({ ok: true });
  });

  test('ladder: a trigger value of one lamport is valid', () => {
    expect(planAttempt(X.ladder, 1, 1n, 1n)).toMatchObject({ ok: true, rung: 0 });
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

  test('a time stop with no market or a stale one still exits, and the exit says why it has no quote', () => {
    const t = { ...newTracker(), flatMet: true };
    expect(decide(holding(), obs(X.tMaxMs, null), plan(), t).decision).toMatchObject({ kind: 'exit', value: { ok: false, reason: 'no-market', detail: 'no market state' } });
    const stale = { atMs: 0, value: market(VAULT) };
    expect(decide(holding(), obs(X.tMaxMs, VAULT, { market: stale }), plan(), t).decision).toMatchObject({ kind: 'exit', value: { ok: false, detail: 'market state is stale' } });
  });

  test('time is measured from the entry fill, not from zero', () => {
    const opened = 10 * MINUTE_MS;
    const t = { ...newTracker(), flatMet: true };
    expect(codes(decide(holding(), obs(opened + X.tMaxMs - 1), plan({ openedAtMs: opened }), t).decision)).toEqual([]);
    expect(codes(decide(holding(), obs(opened + X.tMaxMs), plan({ openedAtMs: opened }), t).decision)).toEqual(['time_max']);
  });

  test('a full exit is neither a partial nor a retry', () => {
    expect(decide(holding(), obs(NOW), plan({ stopPrice: execPrice(V0, QTY) })).decision).toMatchObject({ kind: 'exit', partial: false, retry: false, startRung: 0 });
    const all = exitSettings({ ...TRIAL_POLICY, exits: { ...X, partialMinShareBps: 10_000 } }, 'wick', FILL_CONFIG.network);
    const tp = (R * BigInt(X.partialAtRBps)) / 10_000n;
    expect(decide(holding({ pnl: tp }), obs(NOW), plan(), newTracker(), all).decision).toMatchObject({ kind: 'exit', partial: false, retry: false });
  });
});

// Review round 1 (PR #33): the ladder budget is per position, escalation never goes down, retry cost, partial count.
describe('ladder budget per position', () => {
  const stop = plan({ stopPrice: execPrice(V0, QTY) });
  const used = (n: number, rung = 3): ExitTracker => {
    let t = newTracker();
    for (let i = 0; i < n; i++) t = noteAttempt(t, Math.min(i, rung));
    return t;
  };

  test('noteAttempt counts attempts and keeps the highest rung', () => {
    const t = noteAttempt(noteAttempt(newTracker(), 2), 1);
    expect(t).toMatchObject({ attemptsUsed: 2, lastRung: 2 });
    expect(noteAttempt(t, 3).lastRung).toBe(3);
  });

  test('a new owner gets only the attempts that remain, starting above the highest rung tried', () => {
    expect(decide(holding(), obs(NOW), stop).decision).toMatchObject({ kind: 'exit', startRung: 0, maxAttempts: X.ladder.maxAttempts, blocked: null });
    expect(decide(holding(), obs(NOW), stop, used(3)).decision).toMatchObject({ kind: 'exit', startRung: 3, maxAttempts: 2, blocked: null });
    expect(decide(holding(), obs(NOW), stop, used(1)).decision).toMatchObject({ kind: 'exit', startRung: 1, maxAttempts: 4 });
    expect(decide(holding(), obs(NOW), stop, used(4)).decision).toMatchObject({ kind: 'exit', startRung: 3, maxAttempts: 1, blocked: null });
  });

  test('with the ladder used up, a trigger books the exit blocked at once with a critical alert', () => {
    const d = decide(holding(), obs(NOW), stop, used(X.ladder.maxAttempts)).decision;
    expect(d).toMatchObject({ kind: 'exit', maxAttempts: 0, blocked: `exit ladder used: ${X.ladder.maxAttempts} attempts on this position` });
    const events = exitBookEvents(PID, d, intentId('ex9'));
    expect(events.map((e) => e.type)).toEqual(['trigger_exit', 'exit_blocked']);
    const { book, effects } = apply(openBook(), events);
    expect(book.positions[PID]).toMatchObject({ status: 'exit_blocked', quantity: QTY, blockedReason: `exit ladder used: ${X.ladder.maxAttempts} attempts on this position` });
    expect(effects).toContainEqual({ type: 'alert', level: 'critical', code: 'exit_blocked', subject: PID });
  });

  test('owners that end unfilled never restart the ladder: at most maxAttempts in total, then blocked', () => {
    let book = openBook();
    let t = newTracker();
    let attempts = 0;
    for (let round = 0; round < 50; round++) {
      const p = book.positions[PID]!;
      if (p.status === 'exit_blocked') break;
      const step = decide(holdingOf(p), obs(NOW + round), stop, t);
      t = step.tracker;
      const d = step.decision;
      if (d.kind !== 'exit') throw new Error(`round ${round}: ${d.kind}`);
      book = apply(book, exitBookEvents(PID, d, intentId(`ex${round}`))).book;
      if (d.blocked !== null) break;
      // Two attempts per owner, each landing unfilled, then the owner ends unfilled.
      for (let n = 1; n <= Math.min(2, d.maxAttempts); n++) {
        const a = planAttempt(X.ladder, n, V0, V0, d.startRung, d.maxAttempts, t.lastRung);
        if (!a.ok) break;
        t = noteAttempt(t, a.rung);
        attempts++;
      }
      const r = applyPositionEvent(book.positions[PID]!, { type: 'exit_unfilled' });
      if (isIllegal(r)) throw new Error(r.reason);
      book = { ...book, positions: { [PID]: r.state } };
    }
    expect(attempts).toBe(X.ladder.maxAttempts);
    expect(book.positions[PID]!.status).toBe('exit_blocked');
  });

  test('escalation never goes down after a skip upward or across owners', () => {
    const trig = 10_000_000n;
    expect(planAttempt(X.ladder, 1, trig, trig, 0, 5, 1)).toMatchObject({ ok: true, rung: 2 });
    expect(planAttempt(X.ladder, 1, trig, trig, 0, 5, 0)).toMatchObject({ ok: true, rung: 1 });
    // Attempt 2 is scheduled at rung 1, but rung 2 was already tried.
    expect(planAttempt(X.ladder, 2, trig, trig, 0, 5, 2)).toMatchObject({ ok: true, rung: 3 });
    // At the last rung it stays there.
    expect(planAttempt(X.ladder, 1, trig, trig, 0, 5, 3)).toMatchObject({ ok: true, rung: 3 });
    expect(planAttempt(X.ladder, 1, trig, trig, 0, 5, null)).toMatchObject({ ok: true, rung: 0 });
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
  const withExits = (patch: Partial<Policy['exits']>) => ({ ...TRIAL_POLICY, exits: { ...X, ...patch } });
  test('blockedRetryAttempts is a whole number >= 0; atrPeriod a whole number >= 1', () => {
    expect(policyIssues(withExits({ blockedRetryAttempts: 0 }))).toEqual([]);
    expect(policyIssues(withExits({ blockedRetryAttempts: -1 })).length).toBeGreaterThan(0);
    expect(policyIssues(withExits({ blockedRetryAttempts: 1.5 })).length).toBeGreaterThan(0);
    expect(policyIssues(withExits({ atrPeriod: 1 }))).toEqual([]);
    expect(policyIssues(withExits({ atrPeriod: 0 })).length).toBeGreaterThan(0);
    expect(policyIssues(withExits({ atrPeriod: 2.5 })).length).toBeGreaterThan(0);
  });
});
