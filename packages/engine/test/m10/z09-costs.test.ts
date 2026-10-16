// A-M10-03 cost model (card Z09): ARCH Table 2-A goldens, the fixed-cost line, the three rows (A07, C-50, C-77), the
// size sweep, and the C-85 catch tests (E_ZERO_OUTPUT, E_INVALID_SLIPPAGE).
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { Cu, MicroLamportsPerCu } from '@bot/types';
import {
  costRows, entryPriorityCap, estimateRoundTripCostBps, fixedCostBpsPerTrade, fixedLamportsOf, fixedShareBps, INFINITE_COST_BPS,
  isUnpriced, sensitivityBps, sizeSweep, usdToLamports, type CostRows, type PoolPricing,
} from '../../src/m10/costs.ts';
import { PRIOR_2026_10, type SimParamSet } from '../../src/m10/params.ts';
import { archPool, atMinDepth, flatFees, pricingOf, SOL } from './pricing.ts';

/** ARCH Table 2-A's SOL/USD: a test value only (ruling Z09-5). */
const P_SOL = 150;
const NO_EXTRAS = { includeJanitor: false, includeRung2: false } as const;
const SLIP = { slippage: { entryBps: 100, exitBps: 100 } } as const;
const rows = (p: PoolPricing, n: bigint, o: Parameters<typeof costRows>[3] = SLIP): CostRows => {
  const r = costRows(p, n, PRIOR_2026_10, o);
  assert.ok(r.ok && !isUnpriced(r.value));
  return r.value as CostRows;
};
const fake = (code: string, on: 'buy' | 'sell'): PoolPricing => ({
  effectiveQuoteLamports: 100n * SOL, realQuoteLamports: 100n * SOL,
  quote: (side) => (side === on ? { ok: false, error: { code } } : { ok: true, value: { amountOut: 1_000n, venueFeeLamports: 0n } }),
});

describe('A-M10-03 acceptance', () => {
  it('reproduces ARCH Table 2-A for V3, V4, V5 within ±2 bps (lean, $150, fFail 0.2, no janitor or rung-2)', () => {
    const table: Array<[number, bigint, number[]]> = [[125, 85n, [273, 276, 297, 336]], [95, 500n, [205, 201, 202, 207]], [30, 1_500n, [71, 66, 65, 66]]];
    for (const [fee, q, want] of table) {
      [5, 10, 25, 50].forEach((usd, i) => {
        const got = estimateRoundTripCostBps(pricingOf(archPool(q), flatFees(fee)), usdToLamports(usd, P_SOL), 'lean', PRIOR_2026_10, NO_EXTRAS);
        assert.ok(Math.abs(got - (want[i] as number)) <= 2, `fee ${fee} Q ${q} $${usd}: ${got} vs ${want[i]}`);
      });
    }
  });

  it('fixedCostBpsPerTrade: $12/month at $150 (80,000,000 lamports), 10 trades a day, $10 → 40 bps', () => {
    assert.equal(fixedCostBpsPerTrade(80_000_000n, 10, 66_666_667n), 40);
    for (const [m, t, n] of [[1n, 0, 1n], [1n, -1, 1n], [1n, 1, 0n], [1n, Number.NaN, 1n], [-1n, 1, 1n], [1n, 1e-9, 1n]] as const) {
      assert.throws(() => fixedCostBpsPerTrade(m, t, n), (e: unknown) => (e as { code: string }).code === 'E_INVALID_ARG');
    }
  });

  it('premium landing at $5 on V5: the fixed part alone is about 754 bps (total 819, ARCH Table 2-B)', () => {
    const p = pricingOf(archPool(1_500n), flatFees(30));
    assert.equal(estimateRoundTripCostBps(p, usdToLamports(5, P_SOL), 'premium', PRIOR_2026_10, NO_EXTRAS), 819);
    const premium: SimParamSet = { ...PRIOR_2026_10, cost: { ...PRIOR_2026_10.cost, leanCuPriceMicroLamports: PRIOR_2026_10.cost.premiumCuPriceMicroLamports, senderTipLamports: PRIOR_2026_10.cost.premiumTipLamports } };
    const r = costRows(p, usdToLamports(5, P_SOL), premium, SLIP);
    assert.ok(r.ok && !isUnpriced(r.value));
    const lean = (r.value as CostRows).lean;
    const fixedBps = ((lean.legFixedLamports + lean.failedOverheadLamports) * 10_000n) / usdToLamports(5, P_SOL);
    const fixed = Number(fixedBps);
    assert.ok(Math.abs(fixed - 754) <= 1, `${fixed}`);
  });

  it('PREREG §4 inputs: the strict row fixed part is 174,740 lamports', () => {
    const s = rows(pricingOf(archPool(1_500n), flatFees(30)), usdToLamports(5, P_SOL)).strict;
    assert.equal(s.legFixedLamports, 120_000n);
    assert.equal(s.failedOverheadLamports, 27_500n);
    assert.equal(s.janitorLamports, 15_000n);
    assert.equal(s.rung2ExpectedLamports, 12_240n);
    assert.equal(s.legFixedLamports + s.failedOverheadLamports + s.janitorLamports + s.rung2ExpectedLamports, 174_740n);
  });

  it('conservative = strict + 0.145 × rent deposits + one dust close; the 414,009 line is shown apart', () => {
    const r = rows(pricingOf(archPool(1_500n), flatFees(30)), usdToLamports(10, P_SOL), { ...SLIP, rentDepositsLamports: 1_513_840n });
    assert.equal(r.conservative.lostRentLamports, 219_507n);                     // ceil(0.145 × 1,513,840)
    assert.equal(r.conservative.dustLamports, 15_000n);
    assert.equal(fixedLamportsOf(r.conservative) - fixedLamportsOf(r.strict), 234_507n);
    assert.equal(sensitivityBps(66_666_667n), 63);                                // 414,009 ÷ 66,666,667 ≈ 0.62%
    assert.equal(fixedShareBps(r.lean, 66_666_667n), Number((fixedLamportsOf(r.lean) * 10_000n + 66_666_666n) / 66_666_667n));
    assert.throws(() => fixedShareBps(r.lean, 0n));
    assert.throws(() => sensitivityBps(0n));
  });

  it('property: lean ≤ strict ≤ conservative in total cost and in g*', () => {
    fc.assert(fc.property(fc.bigInt({ min: 20n, max: 200_000n }), fc.integer({ min: 2, max: 250 }), fc.bigInt({ min: 1_000_000n, max: 500n * SOL }),
      fc.integer({ min: 0, max: 5_000 }), (q, fee, notional, slip) => {
        const r = costRows(pricingOf(archPool(q), flatFees(fee)), notional, PRIOR_2026_10, { slippage: { entryBps: slip, exitBps: slip } });
        assert.ok(r.ok);
        if (isUnpriced(r.value)) return;
        const v = r.value as CostRows;
        const total = (b: CostRows['lean']): bigint => fixedLamportsOf(b) + b.sandwichLamports + b.stuckLamports;
        assert.ok(total(v.lean) <= total(v.strict) && total(v.strict) <= total(v.conservative));
        assert.ok(v.lean.gStarBps <= v.strict.gStarBps && v.strict.gStarBps <= v.conservative.gStarBps);
      }), { numRuns: 200 });
  });
});

describe('A-M10-03 properties and edges', () => {
  it('cost is non-decreasing in cuPrice and tip', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 2_000_000n }), fc.bigInt({ min: 0n, max: 2_000_000n }), fc.bigInt({ min: 0n, max: 2_000_000n }),
      (cu, extraCu, tip) => {
        const p = pricingOf(archPool(1_500n), flatFees(30));
        const set = (c: bigint, t: bigint): SimParamSet => ({ ...PRIOR_2026_10, cost: { ...PRIOR_2026_10.cost, leanCuPriceMicroLamports: c as MicroLamportsPerCu, senderTipLamports: t as never } });
        const a = estimateRoundTripCostBps(p, usdToLamports(20, P_SOL), 'lean', set(cu, tip));
        assert.ok(a <= estimateRoundTripCostBps(p, usdToLamports(20, P_SOL), 'lean', set(cu + extraCu, tip)));
        assert.ok(a <= estimateRoundTripCostBps(p, usdToLamports(20, P_SOL), 'lean', set(cu, tip + extraCu)));
      }), { numRuns: 100 });
  });

  it('beyond the fixed-cost region, g* rises with notional (impact)', () => {
    const p = pricingOf(archPool(500n), flatFees(95));
    let last = 0;
    for (const sol of [50n, 100n, 200n, 400n]) {
      const g = estimateRoundTripCostBps(p, sol * SOL, 'lean', PRIOR_2026_10);
      assert.ok(g >= last);
      last = g;
    }
  });

  it('C-85: E_ZERO_OUTPUT on the buy or the sell gives the infinite cost, never 0, and is logged', () => {
    for (const on of ['buy', 'sell'] as const) {
      const events: string[] = [];
      const log = { event: (_l: string, code: string, f: Readonly<Record<string, unknown>>) => { events.push(`${code}:${String(f.reason)}`); } };
      assert.equal(estimateRoundTripCostBps(fake('E_ZERO_OUTPUT', on), 1_000_000n, 'lean', PRIOR_2026_10, {}, log), INFINITE_COST_BPS);
      const r = costRows(fake('E_ZERO_OUTPUT', on), 1_000_000n, PRIOR_2026_10, SLIP, log);
      assert.ok(r.ok && isUnpriced(r.value));
      assert.deepEqual(r.value, { unpriced: 'E_ZERO_OUTPUT', gStarBps: INFINITE_COST_BPS });
      assert.deepEqual(events, ['m10.cost_unpriced:E_ZERO_OUTPUT', 'm10.cost_unpriced:E_ZERO_OUTPUT']);
    }
    // A sell that "succeeds" with 0 out is refused too.
    const zero: PoolPricing = { effectiveQuoteLamports: 1n, realQuoteLamports: 1n, quote: () => ({ ok: true, value: { amountOut: 0n, venueFeeLamports: 0n } }) };
    assert.equal(estimateRoundTripCostBps(zero, 1_000n, 'lean', PRIOR_2026_10), INFINITE_COST_BPS);
    // The real venue: a buy too small to buy one base unit.
    const dust = archPool(1_500n, { baseReserve: 1_000n });
    assert.equal(estimateRoundTripCostBps(pricingOf(dust, flatFees(30)), 10_000n, 'lean', PRIOR_2026_10), INFINITE_COST_BPS);
    // Other refusals (fee unknown) are infinite too.
    assert.equal(estimateRoundTripCostBps(fake('E_FEE_UNKNOWN', 'buy'), 1_000n, 'lean', PRIOR_2026_10), INFINITE_COST_BPS);
  });

  it('C-85: E_INVALID_SLIPPAGE when the bounds are missing or outside 0-10,000', () => {
    const p = pricingOf(archPool(1_500n), flatFees(30));
    for (const o of [{}, { slippage: { entryBps: -1, exitBps: 0 } }, { slippage: { entryBps: 0, exitBps: 10_001 } }, { slippage: { entryBps: 1.5, exitBps: 0 } }]) {
      const r = costRows(p, 1n * SOL, PRIOR_2026_10, o);
      assert.ok(!r.ok && r.error.code === 'E_INVALID_SLIPPAGE');
    }
    const s = sizeSweep(p, PRIOR_2026_10, {}, P_SOL);
    assert.ok(!s.ok && s.error.code === 'E_INVALID_SLIPPAGE');
  });

  it('bad arguments: notional 0, negative rent', () => {
    const p = pricingOf(archPool(1_500n), flatFees(30));
    assert.throws(() => estimateRoundTripCostBps(p, 0n, 'lean', PRIOR_2026_10));
    const z = costRows(p, 0n, PRIOR_2026_10, SLIP);
    assert.ok(!z.ok && z.error.code === 'E_INVALID_ARG');
    const n = costRows(p, 1n * SOL, PRIOR_2026_10, { ...SLIP, rentDepositsLamports: -1n });
    assert.ok(!n.ok && n.error.code === 'E_INVALID_ARG');
    assert.throws(() => usdToLamports(0, P_SOL));
    assert.throws(() => usdToLamports(5, 0));
  });

  it('entry priority cap: min(50,000, 20 bps of notional); strict never below lean', () => {
    assert.equal(entryPriorityCap(33_333_333n), 50_000n);
    assert.equal(entryPriorityCap(1_000_000n), 2_000n);
    const r = rows(pricingOf(archPool(1_500n), flatFees(30)), 1_000_000n);
    assert.equal(r.strict.assumptions.priorityLamports, 5_000n);                // lean priority 25,000 µL × 200,000 CU
    assert.equal(r.lean.assumptions.pSw, 0);
    assert.equal(r.conservative.assumptions.lostRentRate, 0.145);
    const cu = PRIOR_2026_10.cost.cuLimit as Cu;
    assert.equal(cu, 200_000);
  });

  it('USD sizes at $150: $5 = 33,333,333; $10 = 66,666,667; $10,000 = 66,666,666,667', () => {
    assert.equal(usdToLamports(5, P_SOL), 33_333_333n);
    assert.equal(usdToLamports(10, P_SOL), 66_666_667n);
    assert.equal(usdToLamports(10_000, P_SOL), 66_666_666_667n);
    assert.equal(usdToLamports(100, 200), 500_000_000n);
  });
});

describe('size sweep ($5, $20, $100, $1,000, $10,000)', () => {
  it('splits venue fees, impact, fixed and the rest, on min(real, effective) depth, with the depth cap', () => {
    // A pool whose virtual quote is large: impact is charged on the real vault, not the effective reserve.
    const p = archPool(1_500n, { quoteReserveReal: 300n * SOL, quoteReserveVirtual: 1_200n * SOL });
    const r = sizeSweep(pricingOf(atMinDepth(p), flatFees(30)), PRIOR_2026_10, SLIP, P_SOL);
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((x) => x.usd), [5, 20, 100, 1_000, 10_000]);
    for (const x of r.value) {
      assert.equal(x.depthLamports, 300n * SOL);
      assert.equal(x.withinDepthCap, x.sizeLamports * 10_000n <= 300n * SOL * 50n);
      assert.ok(x.rows !== null);
      const lean = x.rows.lean;
      assert.ok(lean.venueFeesBps >= 45 && lean.venueFeesBps <= 61, `${x.usd}: ${lean.venueFeesBps}`);
      assert.ok(lean.gStarBps >= lean.venueFeesBps + lean.impactBps + lean.fixedBps - 3);
    }
    // Fixed costs shrink and impact grows with size.
    const lean = r.value.map((x) => x.rows?.lean as NonNullable<typeof x.rows>['lean']);
    assert.ok((lean[0] as { fixedBps: number }).fixedBps > (lean[4] as { fixedBps: number }).fixedBps);
    assert.ok((lean[4] as { impactBps: number }).impactBps > (lean[0] as { impactBps: number }).impactBps);
    // Impact on the real vault (300 SOL) exceeds impact on the effective reserve (1,500 SOL) at $10,000.
    const eff = sizeSweep(pricingOf(p, flatFees(30)), PRIOR_2026_10, SLIP, P_SOL);
    assert.ok(eff.ok);
    assert.ok((lean[4] as { impactBps: number }).impactBps > (eff.value[4]?.rows?.lean.impactBps as number));
  });

  it('an unpriceable size is listed with its reason, not dropped', () => {
    const r = sizeSweep(fake('E_EXCEEDS_REAL_VAULT', 'sell'), PRIOR_2026_10, SLIP, P_SOL);
    assert.ok(r.ok);
    assert.ok(r.value.every((x) => x.unpriced === 'E_EXCEEDS_REAL_VAULT' && x.rows === null));
  });
});

describe('A-M10-03 branch cases', () => {
  it('a round trip that gains (a fake pool) costs at least 0 g* and no negative impact; an empty pool has depth 0 in the sweep', () => {
    const gain: PoolPricing = { effectiveQuoteLamports: 0n, realQuoteLamports: 0n, quote: (side, a) => ({ ok: true, value: { amountOut: side === 'buy' ? a : a * 1_000n, venueFeeLamports: 0n } }) };
    const r = rows(gain, 1n * SOL);
    assert.equal(r.lean.gStarBps, 0);
    assert.equal(r.lean.impactLamports, 0n);
    const s = sizeSweep(gain, PRIOR_2026_10, SLIP, 150, [5]);
    assert.ok(s.ok);
    assert.deepEqual([s.value[0]?.depthLamports, s.value[0]?.withinDepthCap], [0n, false]);
  });
});
