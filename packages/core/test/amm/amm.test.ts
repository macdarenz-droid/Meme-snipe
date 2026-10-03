import { describe, expect, test } from 'vitest';
import {
  type CurveFeeContext, type CurveState, type FeeConfig, type PoolFeeContext, type PoolState,
  curveBuyExactQuoteIn, curveBuyExactTokens, curveProgressPpm, curveSell, freshGlobal,
  effectiveQuoteReserve, poolBuyExactBase, poolBuyExactQuoteIn, poolFees, poolSell, selectFeeTier,
} from '../../src/amm/index.ts';
import { bps } from '../../src/units/index.ts';
import { AMM_FEE_CONFIG, NORMAL_COIN, PUMP_FEE_CONFIG, PUMP_GLOBAL, PUMP_GLOBAL_SLOT, ok } from './helpers.ts';

const SOL = 1_000_000_000n;
const freshCurve: CurveState = {
  virtualTokenReserves: PUMP_GLOBAL.initialVirtualTokenReserves,
  virtualQuoteReserves: PUMP_GLOBAL.initialVirtualSolReserves,
  realTokenReserves: PUMP_GLOBAL.initialRealTokenReserves,
  realQuoteReserves: 0n,
  complete: false,
};
const curveCtx: CurveFeeContext = { feeTiers: PUMP_FEE_CONFIG.feeTiers, supply: PUMP_GLOBAL.tokenTotalSupply, creatorFeeCharged: true, coin: NORMAL_COIN };
// A fresh graduate: ~206.9M tokens against ~85 SOL.
const pool: PoolState = { baseReserve: 206_900_000_000_000n, quoteVault: 84_990_000_000n, virtualQuoteReserves: 0n };
const poolCtx: PoolFeeContext = { feeConfig: AMM_FEE_CONFIG, canonical: true, quote: 'sol' as const, baseSupply: PUMP_GLOBAL.tokenTotalSupply, creatorFeeCharged: true, coin: NORMAL_COIN, instruction: 'v1', buybackFeeBps: bps(5_000) };

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

  test('a curve tier with an LP rate is charged, never dropped', () => {
    const withLp = [{ marketCapThreshold: 0n, fees: { lp: bps(10), protocol: bps(95), creator: bps(30) } }];
    const t = ok(curveBuyExactTokens(freshCurve, 1_000_000_000n, { ...curveCtx, feeTiers: withLp }));
    expect(t.lpFee).toBe((t.quote * 10n + 9_999n) / 10_000n);
    expect(t.userQuote).toBe(t.quote + t.lpFee + t.protocolFee + t.creatorFee);
    const s2 = ok(curveSell({ ...freshCurve, realQuoteReserves: 10n * SOL }, 1_000_000_000n, { ...curveCtx, feeTiers: withLp }));
    expect(s2.lpFee).toBeGreaterThan(0n);
    const e = ok(curveBuyExactQuoteIn(freshCurve, SOL, { ...curveCtx, feeTiers: withLp }));
    expect(e.lpFee).toBeGreaterThan(0n);
    expect(e.userQuote).toBeLessThanOrEqual(SOL);
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
    const a = ok(poolBuyExactBase(pool, 1_000_000_000n, poolCtx));
    const b = ok(poolBuyExactBase(pool, 1_000_000_000n, { ...poolCtx, feeConfig: doubled }));
    expect(b.quote).toBe(a.quote);
    expect(b.protocolFee).toBeGreaterThan(a.protocolFee);
    const curveZero = ok(curveBuyExactTokens(freshCurve, 1_000_000_000n, { ...curveCtx, feeTiers: [{ marketCapThreshold: 0n, fees: { lp: bps(0), protocol: bps(0), creator: bps(0) } }] }));
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
        ? ok(curveBuyExactTokens(s, 1n + (r() * 1_000_000_000n) % (s.realTokenReserves / 50n + 1n), curveCtx))
        : kind === 1n
          ? ok(curveBuyExactQuoteIn(s, 2n + (r() * 1_000n) % (2n * SOL), curveCtx))
          : s.realTokenReserves < PUMP_GLOBAL.initialRealTokenReserves
            ? ok(curveSell(s, 1n + (r() * 1_000_000n) % (PUMP_GLOBAL.initialRealTokenReserves - s.realTokenReserves), curveCtx))
            : ok(curveBuyExactQuoteIn(s, SOL, curveCtx));
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
        ? ok(poolBuyExactBase(p, 1n + (r() * 1_000_000n) % (p.baseReserve / 100n), poolCtx))
        : kind === 1n
          ? ok(poolBuyExactQuoteIn(p, 2n + (r() * 1_000n) % SOL, poolCtx))
          : ok(poolSell(p, 1n + (r() * 1_000_000n) % (p.baseReserve / 100n), poolCtx));
      expect(effectiveQuoteReserve(t.after) * t.after.baseReserve).toBeGreaterThanOrEqual(k);
      expect(t.impact).toBeGreaterThanOrEqual(0n);
      p = t.after;
    }
  });
});

describe('quote shapes', () => {
  test('exact-in buys never spend more than asked', () => {
    for (const spend of [101n, 1_000n, 16_755_000n, 41_887_000n, 10n * SOL]) {
      const c = ok(curveBuyExactQuoteIn(freshCurve, spend, curveCtx));
      expect(c.userQuote).toBeLessThanOrEqual(spend);
      expect(c.userQuote).toBe(c.quote + c.protocolFee + c.creatorFee);
      const p = ok(poolBuyExactQuoteIn(pool, spend, poolCtx));
      expect(p.userQuote).toBeLessThanOrEqual(spend);
      expect(p.userQuote).toBe(p.quote + p.lpFee + p.protocolFee + p.creatorFee);
    }
  });

  test('the curve completes on the buy that takes its real token reserves to zero', () => {
    const near: CurveState = { ...freshCurve, realTokenReserves: 1_000n };
    const t = ok(curveBuyExactTokens(near, 1_000n, curveCtx));
    expect(t.tokens).toBe(1_000n);
    expect(t.after.complete).toBe(true);
    expect(curveProgressPpm(t.after, PUMP_GLOBAL)).toBe(1_000_000n);
    expect(curveSell(t.after, 1n, curveCtx)).toMatchObject({ ok: false, reason: 'curve-complete' });
    expect(curveProgressPpm(freshCurve, PUMP_GLOBAL)).toBe(0n);
  });

  test('buys past the tokens left are refused: the program behaviour there is not verified', () => {
    const near: CurveState = { ...freshCurve, realTokenReserves: 1_000n };
    expect(curveBuyExactTokens(near, 1_001n, curveCtx)).toMatchObject({ ok: false, reason: 'exceeds-reserves' });
    expect(curveBuyExactQuoteIn(near, SOL, curveCtx)).toMatchObject({ ok: false, reason: 'exceeds-reserves' });
  });

  test('pump Global parameters must be read and fresh', () => {
    const reading = { value: PUMP_GLOBAL, readAtSlot: PUMP_GLOBAL_SLOT };
    expect(ok(freshGlobal(reading, PUMP_GLOBAL_SLOT + 100n, 150n))).toBe(PUMP_GLOBAL);
    expect(freshGlobal(reading, PUMP_GLOBAL_SLOT + 151n, 150n)).toMatchObject({ ok: false, reason: 'stale-params' });
    expect(freshGlobal({ value: null, readAtSlot: 0n }, PUMP_GLOBAL_SLOT, 150n)).toMatchObject({ ok: false, reason: 'missing-params' });
    // A reading from after the current slot (a backtest must never see the future) is refused, not treated as fresh.
    expect(freshGlobal(reading, PUMP_GLOBAL_SLOT - 1n, 150n)).toMatchObject({ ok: false, reason: 'stale-params' });
    expect(freshGlobal({ value: { ...PUMP_GLOBAL, tokenTotalSupply: 0n }, readAtSlot: PUMP_GLOBAL_SLOT }, PUMP_GLOBAL_SLOT, 150n)).toMatchObject({ ok: false, reason: 'missing-params' });
    expect(freshGlobal({ value: { ...PUMP_GLOBAL, initialRealTokenReserves: 0n }, readAtSlot: PUMP_GLOBAL_SLOT }, PUMP_GLOBAL_SLOT, 150n)).toMatchObject({ ok: false, reason: 'missing-params' });
  });

  test('graduation point from the documented launch parameters: ~85.005 SOL raised', () => {
    const all = ok(curveBuyExactTokens(freshCurve, PUMP_GLOBAL.initialRealTokenReserves, curveCtx));
    expect(all.after.complete).toBe(true);
    // 30 * 1,073M / 279.9M = 115.005 virtual SOL, so 85.005 SOL real (docs/research/venues.md 2.2).
    expect(all.quote / 1_000_000n).toBe(85_005n);
  });

  test('sells above the real quote held return exceeds-reserves', () => {
    expect(curveSell(freshCurve, 1_000_000n, curveCtx)).toMatchObject({ ok: false, reason: 'exceeds-reserves' });
    expect(poolSell({ ...pool, quoteVault: 1n, virtualQuoteReserves: 84_989_999_999n }, 10n ** 12n, poolCtx)).toMatchObject({ ok: false, reason: 'exceeds-reserves' });
  });

  test('a negative virtual reserve prices against vault + virtual', () => {
    const lower = ok(poolSell({ ...pool, virtualQuoteReserves: -10n * SOL }, 10n ** 12n, poolCtx));
    const same = ok(poolSell({ baseReserve: pool.baseReserve, quoteVault: pool.quoteVault - 10n * SOL, virtualQuoteReserves: 0n }, 10n ** 12n, poolCtx));
    expect(lower.quote).toBe(same.quote);
    expect(poolSell({ ...pool, virtualQuoteReserves: -pool.quoteVault }, 1n, poolCtx)).toMatchObject({ ok: false, reason: 'no-liquidity' });
  });
});

describe('unquotable states return a reason; caller mistakes throw', () => {
  const done: CurveState = { ...freshCurve, realTokenReserves: 0n, complete: true };
  test('completed curve', () => {
    for (const q of [curveBuyExactTokens(done, 1n, curveCtx), curveBuyExactQuoteIn(done, SOL, curveCtx), curveSell(done, 1n, curveCtx)]) {
      expect(q).toMatchObject({ ok: false, reason: 'curve-complete' });
    }
  });
  test('no liquidity, too large, nothing out', () => {
    const empty: PoolState = { baseReserve: 0n, quoteVault: 0n, virtualQuoteReserves: 0n };
    expect(poolBuyExactQuoteIn(empty, SOL, poolCtx)).toMatchObject({ ok: false, reason: 'no-liquidity' });
    expect(poolBuyExactQuoteIn({ ...pool, virtualQuoteReserves: -pool.quoteVault - 1n }, SOL, poolCtx)).toMatchObject({ ok: false, reason: 'no-liquidity' });
    expect(poolBuyExactBase(pool, pool.baseReserve, poolCtx)).toMatchObject({ ok: false, reason: 'exceeds-reserves' });
    // 2 lamports buy nothing on a deep pool; selling one raw unit yields nothing after fees.
    expect(poolBuyExactQuoteIn({ ...pool, baseReserve: 1_000n }, 2n, poolCtx)).toMatchObject({ ok: false, reason: 'zero-output' });
    expect(poolSell(pool, 1n, poolCtx)).toMatchObject({ ok: false, reason: 'zero-output' });
    expect(curveSell({ ...freshCurve, realQuoteReserves: SOL }, 1n, curveCtx)).toMatchObject({ ok: false, reason: 'zero-output' });
  });
  test('mayhem coins and Token-2022 transfer-fee or hook mints are refused', () => {
    for (const coin of [{ ...NORMAL_COIN, mayhemMode: true }, { ...NORMAL_COIN, transferFee: true }, { ...NORMAL_COIN, transferHook: true }]) {
      expect(curveBuyExactQuoteIn(freshCurve, SOL, { ...curveCtx, coin })).toMatchObject({ ok: false, reason: 'unsupported-coin' });
      expect(curveSell({ ...freshCurve, realQuoteReserves: SOL }, 10n ** 9n, { ...curveCtx, coin })).toMatchObject({ ok: false, reason: 'unsupported-coin' });
      expect(poolBuyExactBase(pool, 10n ** 9n, { ...poolCtx, coin })).toMatchObject({ ok: false, reason: 'unsupported-coin' });
      expect(poolSell(pool, 10n ** 9n, { ...poolCtx, coin })).toMatchObject({ ok: false, reason: 'unsupported-coin' });
    }
  });
  test('non-positive amounts are programmer errors and throw', () => {
    expect(() => curveBuyExactTokens(freshCurve, 0n, curveCtx)).toThrow(RangeError);
    expect(() => curveBuyExactQuoteIn(freshCurve, 1n, curveCtx)).toThrow(RangeError);
    expect(() => poolSell(pool, 0n, poolCtx)).toThrow(RangeError);
    expect(() => poolBuyExactBase(pool, -1n, poolCtx)).toThrow(RangeError);
  });
});

describe('PumpSwap vault accounting by instruction family', () => {
  test('v2 keeps creator + protocol - buyback in the vault and lowers the virtual reserve by the same amount', () => {
    const v1 = ok(poolSell(pool, 10n ** 12n, poolCtx));
    const v2 = ok(poolSell(pool, 10n ** 12n, { ...poolCtx, instruction: 'v2' }));
    const retained = v2.creatorFee + v2.protocolFee - v2.buybackFee;
    expect(v2.buybackFee).toBe((v2.protocolFee * 5_000n) / 10_000n);
    expect(v2.userQuote).toBe(v1.userQuote);
    expect(v2.after.quoteVault - v1.after.quoteVault).toBe(retained);
    expect(v1.after.virtualQuoteReserves - v2.after.virtualQuoteReserves).toBe(retained);
    expect(effectiveQuoteReserve(v2.after)).toBe(effectiveQuoteReserve(v1.after));
    const b = ok(poolBuyExactQuoteIn(pool, SOL, { ...poolCtx, instruction: 'v2' }));
    expect(b.after.quoteVault).toBe(pool.quoteVault + b.quote + b.lpFee + b.creatorFee + b.protocolFee - b.buybackFee);
  });
});
