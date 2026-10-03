import { describe, expect, test } from 'vitest';
import * as costsModule from '../../src/costs/index.ts';
import { type CurveState, type PoolState, curveBuyExactQuoteIn, curveSell, poolBuyExactQuoteIn, poolSell } from '../../src/amm/index.ts';
import {
  type NetworkPolicy, type RentInputs, type SizeCaps, type SizeInput, type SizePolicy,
  BASE_FEE_PER_SIGNATURE, PPM, ROUND_TRIP_ROUNDING_LAMPORTS,
  costAtSize, expectedFailureCost, feasibleSize, fixedCosts, priorityFeeLamports, pumpCurveRoundTrip, pumpSwapRoundTrip,
} from '../../src/costs/index.ts';
import { type MicroUsd, bps, microUsdToLamports, mulDiv, solPriceMicroUsd } from '../../src/units/index.ts';
import { AMM_FEE_CONFIG, NORMAL_COIN, PUMP_FEE_CONFIG, CHECKED_GLOBAL, PUMP_GLOBAL, ok } from '../amm/helpers.ts';

const SOL = 1_000_000_000n;
const price = solPriceMicroUsd('119.37');
const curve: CurveState = {
  virtualTokenReserves: PUMP_GLOBAL.initialVirtualTokenReserves,
  virtualQuoteReserves: PUMP_GLOBAL.initialVirtualSolReserves,
  realTokenReserves: PUMP_GLOBAL.initialRealTokenReserves,
  realQuoteReserves: 0n,
  complete: false,
};
const curveCtx = { feeTiers: PUMP_FEE_CONFIG.feeTiers, global: CHECKED_GLOBAL, creatorFeeCharged: true, coin: NORMAL_COIN };
const pool: PoolState = { baseReserve: 150_000_000_000_000n, quoteVault: 80n * SOL, virtualQuoteReserves: -2n * SOL };
const poolCtx = { feeConfig: AMM_FEE_CONFIG, canonical: true, quote: 'sol' as const, baseSupply: PUMP_GLOBAL.tokenTotalSupply, creatorFeeCharged: true, coin: NORMAL_COIN, instruction: 'v1' as const, buybackFeeBps: bps(5_000) };

// docs/research/execution.md section 8: base 5,000 + priority 20,000 + Sender tip 5,000 per transaction.
const network: NetworkPolicy = {
  signaturesPerTx: 1n, baseFeePerSignature: BASE_FEE_PER_SIGNATURE, entryPriorityFee: 20_000n, exitPriorityFee: 20_000n,
  tip: 5_000n, entryFailurePpm: 0n, exitFailurePpm: 0n,
};
// Token-2022 ATA (170 bytes) at 5,080 lamports/byte, closed in the sell; volume accumulators already exist.
const rent: RentInputs = { tokenAccount: 1_513_840n, tokenAccountClosedOnExit: true, oneTime: 0n, transient: 0n };
const lamportsToUsdCeil = (l: bigint) => mulDiv(l, price, 1_000_000_000n, 'ceil');
const usd = (dollars: number) => BigInt(Math.round(dollars * 1e6)) as MicroUsd;
// Size settings are configuration (CLAUDE.md "Capital and trade size scale"): the trial and a scaled example.
interface Setting { name: string; policy: SizePolicy; caps: SizeCaps }
const trial: Setting = {
  name: 'trial ($20 bankroll, $2-$5)',
  policy: { minNotional: usd(2), maxNotional: usd(5), maxImpactPpm: 100_000n },
  caps: { lossAllowance: usd(20), executableDepth: usd(50), cash: usd(20), riskBudget: usd(20) },
};
const scaled: Setting = {
  name: 'scaled ($1,000 bankroll, $25-$200)',
  policy: { minNotional: usd(25), maxNotional: usd(200), maxImpactPpm: 100_000n },
  caps: { lossAllowance: usd(1_000), executableDepth: usd(5_000), cash: usd(1_000), riskBudget: usd(1_000) },
};
const settings = [trial, scaled];
const roomy = trial.caps;
const base = (over: Partial<SizeInput> = {}, setting: Setting = trial): SizeInput => ({
  quote: pumpCurveRoundTrip(curve, curveCtx), solPrice: price, edgePpm: 60_000n, network, rent, policy: setting.policy, caps: setting.caps, ...over,
});

describe('fixed costs', () => {
  test('base fee is charged on failed attempts; the tip is not', () => {
    const f = fixedCosts({ ...network, entryFailurePpm: 500_000n }, rent);
    expect(f.entry.landed).toBe(30_000n);
    // 50% failure: one failed attempt expected, costing base + priority only.
    expect(f.entry.expectedFailures).toBe(25_000n);
    expect(f.total).toBe(30_000n + 25_000n + 30_000n);
    expect(f.recoverableRent).toBe(1_513_840n);
  });

  test('rent: one-time counts in F, a token account left open counts in F, a closed one does not', () => {
    expect(fixedCosts(network, { ...rent, oneTime: 2_692_400n }).total).toBe(60_000n + 2_692_400n);
    const open = fixedCosts(network, { ...rent, tokenAccountClosedOnExit: false });
    expect(open.total).toBe(60_000n + 1_513_840n);
    expect(open.recoverableRent).toBe(0n);
  });

  test('helpers round costs up and reject impossible inputs', () => {
    expect(expectedFailureCost(25_000n, 0n)).toBe(0n);
    expect(expectedFailureCost(25_000n, 1n)).toBe(1n);
    expect(() => expectedFailureCost(1n, PPM)).toThrow(RangeError);
    expect(priorityFeeLamports(1_535n, 200_000n)).toBe(307n);
    expect(priorityFeeLamports(1n, 1n)).toBe(1n);
    expect(() => fixedCosts({ ...network, signaturesPerTx: 0n }, rent)).toThrow(RangeError);
  });
});

describe('round trip with zero price move', () => {
  for (const [name, quote, buy, sell] of [
    ['pump curve', pumpCurveRoundTrip(curve, curveCtx), (s: bigint) => ok(curveBuyExactQuoteIn(curve, s, curveCtx)), (t: bigint) => ok(curveSell({ ...curve, realQuoteReserves: 10n * SOL }, t, curveCtx))],
    ['PumpSwap', pumpSwapRoundTrip(pool, poolCtx), (s: bigint) => ok(poolBuyExactQuoteIn(pool, s, poolCtx)), (t: bigint) => ok(poolSell(pool, t, poolCtx))],
  ] as const) {
    test(`${name}: loses exactly fees plus impact plus fixed costs`, () => {
      for (const dollars of [2, 3.33, 5]) {
        const spend = microUsdToLamports(usd(dollars), price, 'floor');
        const c = ok(costAtSize(quote, spend, network, rent));
        // Independent replay: buy, then sell the same tokens into the untouched pre-entry state.
        const b = buy(spend);
        const tokens = 'tokens' in b ? b.tokens : b.base;
        const s = sell(tokens);
        const walletLoss = b.userQuote - s.userQuote + c.fixed.total;
        const fees = b.protocolFee + b.creatorFee + ('lpFee' in b ? b.lpFee : 0n) + s.protocolFee + s.creatorFee + ('lpFee' in s ? s.lpFee : 0n);
        expect(c.totalLoss).toBe(walletLoss);
        expect(c.proportional).toBe(fees + b.impact + s.impact);
        expect(c.vPpm).toBe(mulDiv(c.proportional, PPM, b.userQuote, 'ceil'));
      }
    });
  }

  test.each(settings.map((x) => [x.name, x] as const))('v(q) stays under the conservative bound across the range: %s', (_, setting) => {
    const lo = microUsdToLamports(setting.policy.minNotional, price, 'ceil');
    const hi = microUsdToLamports(setting.policy.maxNotional, price, 'floor');
    const step = (hi - lo) / 400n;
    for (const quote of [pumpCurveRoundTrip(curve, curveCtx), pumpSwapRoundTrip(pool, poolCtx)]) {
      const vLo = ok(costAtSize(quote, lo, network, rent)).vPpm;
      const vHi = ok(costAtSize(quote, hi, network, rent)).vPpm;
      const bound = (vLo > vHi ? vLo : vHi) + mulDiv(ROUND_TRIP_ROUNDING_LAMPORTS, PPM, lo, 'ceil');
      for (let q: bigint = lo; q <= hi; q += step) expect(ok(costAtSize(quote, q, network, rent)).vPpm).toBeLessThanOrEqual(bound);
    }
  });

  test('fees dominate at $2: pump curve round trip costs about 2.5% plus impact', () => {
    const c = ok(costAtSize(pumpCurveRoundTrip(curve, curveCtx), microUsdToLamports(usd(2), price, 'floor'), network, rent));
    expect(c.vPpm).toBeGreaterThan(25_000n);
    expect(c.vPpm).toBeLessThan(27_000n);
  });
});

const venues = [
  ['pump curve', pumpCurveRoundTrip(curve, curveCtx)],
  ['PumpSwap', pumpSwapRoundTrip(pool, poolCtx)],
] as const;
const cases = settings.flatMap((setting) => venues.map(([venue, quote]) => [`${setting.name}, ${venue}`, setting, quote] as const));

describe.each(cases)('feasible size: %s', (_, setting, quote) => {
  const at = (over: Partial<SizeInput> = {}) => feasibleSize(base({ quote, ...over }, setting));
  const lo = microUsdToLamports(setting.policy.minNotional, price, 'ceil');
  const hi = microUsdToLamports(setting.policy.maxNotional, price, 'floor');

  test('empty when the edge does not beat proportional cost (g <= v)', () => {
    const d = at({ edgePpm: 0n });
    expect(d.trade).toBe(false);
    if (d.trade) return;
    expect(d.reason).toBe('edge-not-above-cost');
    expect(at({ edgePpm: d.vPpm }).trade).toBe(false);
  });

  test('empty when any cap falls below the configured minimum', () => {
    const below = (setting.policy.minNotional - 10_000n) as MicroUsd;
    for (const key of ['lossAllowance', 'executableDepth', 'cash', 'riskBudget'] as const) {
      const d = at({ caps: { ...setting.caps, [key]: below } });
      expect(d.trade).toBe(false);
      if (!d.trade) expect(d.reason).toBe('caps-below-minimum');
      expect(d.bindingCap).toBe(key);
    }
    // Cash must also cover fixed costs and the rent locked in the token account.
    expect(at({ caps: { ...setting.caps, cash: (setting.policy.minNotional + 50_000n) as MicroUsd } }).trade).toBe(false);
  });

  test('never above the configured maximum or below the configured minimum, whatever the caps', () => {
    const wide = { ...setting.caps, cash: usd(1_000_000), lossAllowance: usd(1_000_000), riskBudget: usd(1_000_000), executableDepth: usd(1_000_000) };
    const mid = ((setting.policy.minNotional + setting.policy.maxNotional) / 2n) as MicroUsd;
    for (const caps of [setting.caps, wide, { ...setting.caps, executableDepth: mid }]) {
      const d = at({ caps, edgePpm: 300_000n });
      expect(d.trade).toBe(true);
      if (!d.trade) continue;
      expect(d.range.maxUsd).toBeLessThanOrEqual(setting.policy.maxNotional);
      expect(d.range.maxUsd).toBeLessThanOrEqual(caps.executableDepth);
      expect(d.range.minUsd).toBeGreaterThanOrEqual(setting.policy.minNotional);
      expect(d.range.minLamports).toBeLessThanOrEqual(d.range.maxLamports);
    }
  });

  test('break-even equals F / (g - v), and the range starts at the first profitable size', () => {
    // Fixed costs sized so break-even lands inside the range: F ~ lo * 9% at an edge 6 points above v, so ~1.5 lo.
    const v = at({ edgePpm: 300_000n }).vPpm;
    const priority = mulDiv(lo, 90_000n, PPM, 'ceil') / 2n;
    const d = at({ network: { ...network, entryPriorityFee: priority, exitPriorityFee: priority }, edgePpm: v + 60_000n });
    expect(d.trade).toBe(true);
    if (!d.trade) return;
    const margin = v + 60_000n - d.vPpm;
    expect(d.breakEvenLamports).toBe(mulDiv(d.fixed.total, PPM, margin, 'ceil'));
    expect(d.breakEvenLamports).toBeGreaterThan(lo);
    expect(d.range.minLamports * margin).toBeGreaterThan(d.fixed.total * PPM);
    expect((d.range.minLamports - 1n) * margin).toBeLessThanOrEqual(d.fixed.total * PPM);
    expect(d.expectedNetAtMaxUsd).toBeGreaterThan(0n);
  });

  test('empty when break-even lies above the maximum size', () => {
    const v = at({ edgePpm: 300_000n }).vPpm;
    const priority = mulDiv(hi, 100_000n, PPM, 'ceil');
    const d = at({ network: { ...network, entryPriorityFee: priority, exitPriorityFee: priority }, edgePpm: v + 20_000n });
    expect(d.trade).toBe(false);
    if (!d.trade) {
      expect(d.reason).toBe('break-even-above-maximum');
      expect(d.breakEvenLamports).toBeGreaterThan(hi);
    }
  });

  test('loss allowance and risk budget leave room for fixed costs', () => {
    const cap = ((setting.policy.minNotional + setting.policy.maxNotional) / 2n) as MicroUsd;
    const d = at({ edgePpm: 300_000n, caps: { ...setting.caps, riskBudget: cap } });
    expect(d.trade).toBe(true);
    expect(d.bindingCap).toBe('riskBudget');
    if (d.trade) expect(d.range.maxUsd).toBeLessThanOrEqual(cap - lamportsToUsdCeil(d.fixed.total));
  });

  test('the edge is charged its share of costs: v includes the cross term g * v', () => {
    const d = at({ edgePpm: 300_000n });
    const raw = ok(costAtSize(quote, lo, network, rent)).vPpm;
    expect(d.vPpm).toBeGreaterThanOrEqual(raw + mulDiv(300_000n, raw, PPM, 'ceil'));
  });

  test('other proportional costs raise v', () => {
    const plain = at({ edgePpm: 300_000n });
    const routed = at({ edgePpm: 300_000n, extraPpm: 10_000n });
    expect(routed.vPpm - plain.vPpm).toBeGreaterThanOrEqual(10_000n);
  });
});

describe('size searches treat an unquotable size as worse than any value', () => {
  test('largestWithin stops below the first unquotable size', () => {
    const { largestWithin } = costsModule;
    expect(largestWithin(0n, 100n, 1_000n, (q) => (q > 40n ? null : q))).toBe(40n);
    expect(largestWithin(0n, 100n, 1_000n, () => null)).toBeNull();
    expect(largestWithin(0n, 100n, 50n, (q) => q)).toBe(50n);
  });
  test('peakOf never picks an unquotable size', () => {
    const { peakOf } = costsModule;
    // Rises with q, but sizes above 60 cannot be quoted.
    expect(peakOf(0n, 100n, (q) => (q > 60n ? null : q))).toBe(60n);
    expect(peakOf(0n, 100n, (q) => -((q - 30n) ** 2n))).toBe(30n);
  });
});

describe('unquotable venues', () => {
  test('a state that cannot be quoted gives a typed no-trade reason, not an exception', () => {
    const done = { ...curve, realTokenReserves: 0n, complete: true };
    const d = feasibleSize(base({ quote: pumpCurveRoundTrip(done, curveCtx) }));
    expect(d.trade).toBe(false);
    if (!d.trade) {
      expect(d.reason).toBe('unquotable');
      expect(d.quoteReason).toBe('curve-complete');
    }
    const mayhem = feasibleSize(base({ quote: pumpSwapRoundTrip(pool, { ...poolCtx, coin: { ...NORMAL_COIN, mayhemMode: true } }) }));
    expect(mayhem).toMatchObject({ trade: false, reason: 'unquotable', quoteReason: 'unsupported-coin' });
    const empty = feasibleSize(base({ quote: pumpSwapRoundTrip({ ...pool, virtualQuoteReserves: -pool.quoteVault }, poolCtx) }));
    expect(empty).toMatchObject({ trade: false, reason: 'unquotable', quoteReason: 'no-liquidity' });
  });

  test('sizes the venue cannot fill are cut off the range, not thrown', () => {
    // A venue that quotes normally up to a limit and reports exceeds-reserves above it.
    const swap = pumpSwapRoundTrip(pool, poolCtx);
    const limit = microUsdToLamports(usd(80), price, 'floor');
    const capped: costsModule.RoundTripQuoter = (spend) => (spend > limit ? { ok: false, reason: 'exceeds-reserves', detail: 'test' } : swap(spend));
    const d = feasibleSize(base({ quote: capped, edgePpm: 300_000n }, scaled));
    expect(d.trade).toBe(true);
    if (d.trade) expect(d.range.maxLamports).toBeLessThanOrEqual(limit);
  });
});

describe('size scaling', () => {
  test('impact over the limit at the minimum size has its own reason', () => {
    const d = feasibleSize(base({ quote: pumpSwapRoundTrip(pool, poolCtx), edgePpm: 300_000n, policy: { ...scaled.policy, maxImpactPpm: 1_000n } }, scaled));
    expect(d.trade).toBe(false);
    if (!d.trade) expect(d.reason).toBe('impact-above-limit');
    expect(d.bindingCap).toBe('impactLimit');
  });

  // The same pool (~78 SOL effective quote) at both settings.
  const swap = pumpSwapRoundTrip(pool, poolCtx);

  test('a 2% impact limit leaves the trial range whole but cuts the scaled range by pool depth', () => {
    const policy = (s: Setting) => ({ ...s.policy, maxImpactPpm: 20_000n });
    const t = feasibleSize(base({ quote: swap, edgePpm: 300_000n, policy: policy(trial) }, trial));
    expect(t.trade).toBe(true);
    expect(t.bindingCap).toBe('maxNotional');
    const d = feasibleSize(base({ quote: swap, edgePpm: 300_000n, policy: policy(scaled) }, scaled));
    expect(d.trade).toBe(true);
    if (!d.trade) return;
    expect(d.bindingCap).toBe('impactLimit');
    expect(d.range.maxUsd).toBeLessThan(scaled.policy.maxNotional);
    // The cap is the largest size within the limit.
    const { roundTripImpactPpm } = costsModule;
    expect(roundTripImpactPpm(swap, d.range.maxLamports)).toBeLessThanOrEqual(20_000n);
    expect(roundTripImpactPpm(swap, d.range.maxLamports + 1n)).toBeGreaterThan(20_000n);
  });

  test('larger sizes are dropped once their impact lowers expected net', () => {
    // At $25-$200 v grows from ~2.9% to ~6.3% with impact; at a 5% edge expected net peaks well below $200.
    const d = feasibleSize(base({ quote: swap, edgePpm: 50_000n }, scaled));
    expect(d.trade).toBe(true);
    if (!d.trade) return;
    expect(d.bindingCap).toBe('costLimit');
    expect(d.range.maxUsd).toBeLessThan(scaled.policy.maxNotional);
    expect(d.vPpm).toBeLessThan(50_000n);
    // Expected net at the cut beats both a larger and a smaller size.
    const allowance = mulDiv(ROUND_TRIP_ROUNDING_LAMPORTS, PPM, microUsdToLamports(scaled.policy.minNotional, price, 'ceil'), 'ceil');
    const netAt = (q: bigint) => {
      const v = ok(costAtSize(swap, q, network, rent)).vPpm + allowance;
      return q * (50_000n - v - mulDiv(50_000n, v, PPM, 'ceil'));
    };
    const top = d.range.maxLamports;
    expect(netAt(top)).toBeGreaterThan(netAt(top + 100_000_000n));
    expect(netAt(top)).toBeGreaterThan(netAt(top - 100_000_000n));
    expect(netAt(top)).toBeGreaterThan(netAt(microUsdToLamports(scaled.policy.maxNotional, price, 'floor')));
    // The same edge takes the whole trial range: impact is small at $2-$5.
    const t = feasibleSize(base({ quote: swap, edgePpm: 50_000n }, trial));
    expect(t.trade).toBe(true);
    expect(t.bindingCap).toBe('maxNotional');
  });

  test('fixed costs weigh less at larger sizes: break-even falls as a share of size', () => {
    const tc = ok(costAtSize(swap, microUsdToLamports(usd(2), price, 'floor'), network, rent));
    const sc = ok(costAtSize(swap, microUsdToLamports(usd(100), price, 'floor'), network, rent));
    expect(tc.fixed.total).toBe(sc.fixed.total);
    expect(tc.fixed.total * PPM / tc.roundTrip.paid).toBeGreaterThan(sc.fixed.total * PPM / sc.roundTrip.paid);
    // Impact, by contrast, is quoted from reserves at the real size and grows with it.
    expect(sc.roundTrip.entryImpact * PPM / sc.roundTrip.paid).toBeGreaterThan(tc.roundTrip.entryImpact * PPM / tc.roundTrip.paid);
  });

  test('policy is validated', () => {
    expect(() => feasibleSize(base({ policy: { minNotional: usd(5), maxNotional: usd(2), maxImpactPpm: 0n } }))).toThrow(RangeError);
    expect(() => feasibleSize(base({ policy: { minNotional: usd(0), maxNotional: usd(2), maxImpactPpm: 0n } }))).toThrow(RangeError);
  });
});
