import { describe, expect, test } from 'vitest';
import {
  type CurveFeeContext, type CurveState, type FeeConfig, type PoolFeeContext, type PoolState,
  CurveCompleteError, PUMP_CURVE_PARAMS, curveBuyExactQuoteIn, curveBuyExactTokens, curveProgressPpm, curveSell,
  effectiveQuoteReserve, poolBuyExactBase, poolBuyExactQuoteIn, poolFees, poolSell, selectFeeTier,
} from '../../src/amm/index.ts';
import { bps } from '../../src/units/index.ts';
import { AMM_FEE_CONFIG, PUMP_FEE_CONFIG } from './helpers.ts';

const SOL = 1_000_000_000n;
const freshCurve: CurveState = {
  virtualTokenReserves: PUMP_CURVE_PARAMS.initialVirtualTokenReserves,
  virtualQuoteReserves: PUMP_CURVE_PARAMS.initialVirtualQuoteReserves,
  realTokenReserves: PUMP_CURVE_PARAMS.initialRealTokenReserves,
  realQuoteReserves: 0n,
  complete: false,
};
const curveCtx: CurveFeeContext = { feeTiers: PUMP_FEE_CONFIG.feeTiers, supply: PUMP_CURVE_PARAMS.tokenTotalSupply, creatorFeeCharged: true };
// A fresh graduate: ~206.9M tokens against ~85 SOL.
const pool: PoolState = { baseReserve: 206_900_000_000_000n, quoteVault: 84_990_000_000n, virtualQuoteReserves: 0n };
const poolCtx: PoolFeeContext = { feeConfig: AMM_FEE_CONFIG, canonical: true, quote: 'sol' as const, baseSupply: PUMP_CURVE_PARAMS.tokenTotalSupply, creatorFeeCharged: true };

// Deterministic generator so failures reproduce.
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return BigInt(seed);
};

describe('fee tiers', () => {
  const total = (f: { lp: number; protocol: number; creator: number }) => f.lp + f.protocol + f.creator;
  // Pool whose market cap equals the effective quote reserve (supply = base reserve).
  const atCap = (cap: bigint): [PoolState, PoolFeeContext] => [
    { baseReserve: 10n ** 15n, quoteVault: cap, virtualQuoteReserves: 0n },
    { ...poolCtx, baseSupply: 10n ** 15n },
  ];

  test('420 SOL boundary: below pays 2/93/30, at the threshold 20/5/95', () => {
    expect(poolFees(...atCap(420n * SOL - 1n))).toEqual({ lp: 2, protocol: 93, creator: 30 });
    expect(poolFees(...atCap(420n * SOL))).toEqual({ lp: 20, protocol: 5, creator: 95 });
    expect(total(poolFees(...atCap(420n * SOL - 1n)))).toBe(125);
    expect(total(poolFees(...atCap(420n * SOL)))).toBe(120);
  });

  test('1,470 SOL boundary: below 20/5/95, at the threshold 20/5/90', () => {
    expect(poolFees(...atCap(1_470n * SOL - 1n))).toEqual({ lp: 20, protocol: 5, creator: 95 });
    expect(poolFees(...atCap(1_470n * SOL))).toEqual({ lp: 20, protocol: 5, creator: 90 });
  });

  test('market cap counts virtual quote reserves, including negative ones', () => {
    const [p, ctx] = atCap(420n * SOL);
    expect(poolFees({ ...p, virtualQuoteReserves: -1n }, ctx).creator).toBe(30);
    expect(poolFees({ ...p, quoteVault: 420n * SOL - 5n, virtualQuoteReserves: 5n }, ctx).creator).toBe(95);
  });

  test('non-canonical pools pay the flat schedule; no creator fee without a coin creator', () => {
    expect(poolFees(pool, { ...poolCtx, canonical: false })).toEqual({ lp: 25, protocol: 5, creator: 0 });
    expect(poolFees(pool, { ...poolCtx, creatorFeeCharged: false }).creator).toBe(0);
    expect(poolFees(pool, { ...poolCtx, creatorFeeOverride: bps(40) }).creator).toBe(40);
    // Canonical pools quoted in another mint pay the exotic schedule, or the flat one while it is unset.
    expect(poolFees(pool, { ...poolCtx, quote: 'exotic' })).toEqual({ lp: 20, protocol: 5, creator: 5 });
    const unset = { ...AMM_FEE_CONFIG, exoticFlatFees: { lp: bps(0), protocol: bps(0), creator: bps(0) } };
    expect(poolFees(pool, { ...poolCtx, quote: 'exotic', feeConfig: unset })).toEqual({ lp: 25, protocol: 5, creator: 0 });
  });

  test('a curve tier with an LP rate is refused, not ignored', () => {
    const withLp = [{ marketCapThreshold: 0n, fees: { lp: bps(1), protocol: bps(95), creator: bps(30) } }];
    expect(() => curveBuyExactTokens(freshCurve, 1_000n, { ...curveCtx, feeTiers: withLp })).toThrow(RangeError);
  });

  test('selectFeeTier rejects empty or unsorted tiers', () => {
    expect(() => selectFeeTier([], 0n)).toThrow(RangeError);
    const f = { lp: bps(0), protocol: bps(1), creator: bps(0) };
    expect(() => selectFeeTier([{ marketCapThreshold: 5n, fees: f }, { marketCapThreshold: 1n, fees: f }], 3n)).toThrow(RangeError);
  });

  test('fees come from the config passed in, never from the quote code', () => {
    const doubled: FeeConfig = {
      ...AMM_FEE_CONFIG,
      feeTiers: AMM_FEE_CONFIG.feeTiers.map((t) => ({ ...t, fees: { lp: bps(t.fees.lp * 2), protocol: bps(t.fees.protocol * 2), creator: bps(t.fees.creator * 2) } })),
    };
    const a = poolBuyExactBase(pool, 1_000_000_000n, poolCtx);
    const b = poolBuyExactBase(pool, 1_000_000_000n, { ...poolCtx, feeConfig: doubled });
    expect(b.quote).toBe(a.quote);
    expect(b.protocolFee).toBeGreaterThan(a.protocolFee);
    const curveZero = curveBuyExactTokens(freshCurve, 1_000_000_000n, { ...curveCtx, feeTiers: [{ marketCapThreshold: 0n, fees: { lp: bps(0), protocol: bps(0), creator: bps(0) } }] });
    expect(curveZero.userQuote).toBe(curveZero.quote);
  });
});

describe('constant-product invariant never decreases', () => {
  test('pump curve: 2,000 random trades', () => {
    const r = rng(7);
    let s = freshCurve;
    for (let i = 0; i < 2_000 && !s.complete; i++) {
      const k = s.virtualQuoteReserves * s.virtualTokenReserves;
      const kind = r() % 3n;
      const t = kind === 0n
        ? curveBuyExactTokens(s, 1n + (r() * 1_000_000_000n) % (s.realTokenReserves / 50n + 1n), curveCtx)
        : kind === 1n
          ? curveBuyExactQuoteIn(s, 2n + (r() * 1_000n) % (2n * SOL), curveCtx)
          : s.realTokenReserves < PUMP_CURVE_PARAMS.initialRealTokenReserves
            ? curveSell(s, 1n + (r() * 1_000_000n) % (PUMP_CURVE_PARAMS.initialRealTokenReserves - s.realTokenReserves), curveCtx)
            : curveBuyExactQuoteIn(s, SOL, curveCtx);
      expect(t.after.virtualQuoteReserves * t.after.virtualTokenReserves).toBeGreaterThanOrEqual(k);
      expect(t.impact).toBeGreaterThanOrEqual(0n);
      s = t.after;
    }
  });

  test('PumpSwap: 2,000 random trades, including negative virtual quote reserves', () => {
    const r = rng(11);
    let p: PoolState = { ...pool, virtualQuoteReserves: -20_000_000_000n };
    for (let i = 0; i < 2_000; i++) {
      const k = effectiveQuoteReserve(p) * p.baseReserve;
      const kind = r() % 3n;
      const t = kind === 0n
        ? poolBuyExactBase(p, 1n + (r() * 1_000_000n) % (p.baseReserve / 100n), poolCtx)
        : kind === 1n
          ? poolBuyExactQuoteIn(p, 2n + (r() * 1_000n) % SOL, poolCtx)
          : poolSell(p, 1n + (r() * 1_000_000n) % (p.baseReserve / 100n), poolCtx);
      expect(effectiveQuoteReserve(t.after) * t.after.baseReserve).toBeGreaterThanOrEqual(k);
      expect(t.impact).toBeGreaterThanOrEqual(0n);
      p = t.after;
    }
  });
});

describe('quote shapes', () => {
  test('exact-in buys never spend more than asked', () => {
    for (const spend of [2n, 3n, 101n, 16_755_000n, 41_887_000n, 10n * SOL]) {
      const c = curveBuyExactQuoteIn(freshCurve, spend, curveCtx);
      expect(c.userQuote).toBeLessThanOrEqual(spend);
      expect(c.userQuote).toBe(c.quote + c.protocolFee + c.creatorFee);
      const p = poolBuyExactQuoteIn(pool, spend, poolCtx);
      expect(p.userQuote).toBeLessThanOrEqual(spend);
      expect(p.userQuote).toBe(p.quote + p.lpFee + p.protocolFee + p.creatorFee);
    }
  });

  test('the curve completes on the buy that takes its real token reserves to zero', () => {
    const near: CurveState = { ...freshCurve, realTokenReserves: 1_000n };
    const t = curveBuyExactTokens(near, 5_000n, curveCtx);
    expect(t.tokens).toBe(1_000n);
    expect(t.after.complete).toBe(true);
    expect(curveProgressPpm(t.after)).toBe(1_000_000n);
    expect(() => curveSell(t.after, 1n, curveCtx)).toThrow(CurveCompleteError);
    expect(curveProgressPpm(freshCurve)).toBe(0n);
  });

  test('graduation point from the documented launch parameters: ~85.005 SOL raised', () => {
    const all = curveBuyExactTokens(freshCurve, PUMP_CURVE_PARAMS.initialRealTokenReserves, curveCtx);
    expect(all.after.complete).toBe(true);
    // 30 * 1,073M / 279.9M = 115.005 virtual SOL, so 85.005 SOL real (docs/research/venues.md 2.2).
    expect(all.quote / 1_000_000n).toBe(85_005n);
  });

  test('sells reject proceeds above the real quote held', () => {
    expect(() => curveSell(freshCurve, 1_000_000n, curveCtx)).toThrow(RangeError);
    expect(() => poolSell({ ...pool, quoteVault: 1n, virtualQuoteReserves: 84_989_999_999n }, 10n ** 12n, poolCtx)).toThrow(RangeError);
  });

  test('a negative virtual reserve prices against vault + virtual', () => {
    const lower = poolSell({ ...pool, virtualQuoteReserves: -10n * SOL }, 10n ** 12n, poolCtx);
    const same = poolSell({ baseReserve: pool.baseReserve, quoteVault: pool.quoteVault - 10n * SOL, virtualQuoteReserves: 0n }, 10n ** 12n, poolCtx);
    expect(lower.quote).toBe(same.quote);
    expect(() => effectiveQuoteReserve({ ...pool, virtualQuoteReserves: -pool.quoteVault })).toThrow(RangeError);
  });
});
