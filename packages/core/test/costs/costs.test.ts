import { describe, expect, test } from 'vitest';
import { type CurveState, type PoolState, PUMP_CURVE_PARAMS, curveBuyExactQuoteIn, curveSell, poolBuyExactQuoteIn, poolSell } from '../../src/amm/index.ts';
import {
  type NetworkPolicy, type RentInputs, type SizeCaps, type SizeInput,
  BASE_FEE_PER_SIGNATURE, MAX_TRADE_USD, MIN_TRADE_USD, PPM, ROUND_TRIP_ROUNDING_LAMPORTS,
  costAtSize, expectedFailureCost, feasibleSize, fixedCosts, priorityFeeLamports, pumpCurveRoundTrip, pumpSwapRoundTrip,
} from '../../src/costs/index.ts';
import { type MicroUsd, microUsdToLamports, mulDiv, solPriceMicroUsd } from '../../src/units/index.ts';
import { AMM_FEE_CONFIG, PUMP_FEE_CONFIG } from '../amm/helpers.ts';

const SOL = 1_000_000_000n;
const price = solPriceMicroUsd('119.37');
const curve: CurveState = {
  virtualTokenReserves: PUMP_CURVE_PARAMS.initialVirtualTokenReserves,
  virtualQuoteReserves: PUMP_CURVE_PARAMS.initialVirtualQuoteReserves,
  realTokenReserves: PUMP_CURVE_PARAMS.initialRealTokenReserves,
  realQuoteReserves: 0n,
  complete: false,
};
const curveCtx = { feeTiers: PUMP_FEE_CONFIG.feeTiers, supply: PUMP_CURVE_PARAMS.tokenTotalSupply, creatorFeeCharged: true };
const pool: PoolState = { baseReserve: 150_000_000_000_000n, quoteVault: 80n * SOL, virtualQuoteReserves: -2n * SOL };
const poolCtx = { feeConfig: AMM_FEE_CONFIG, canonical: true, quote: 'sol' as const, baseSupply: PUMP_CURVE_PARAMS.tokenTotalSupply, creatorFeeCharged: true };

// docs/research/execution.md section 8: base 5,000 + priority 20,000 + Sender tip 5,000 per transaction.
const network: NetworkPolicy = {
  signaturesPerTx: 1n, baseFeePerSignature: BASE_FEE_PER_SIGNATURE, entryPriorityFee: 20_000n, exitPriorityFee: 20_000n,
  tip: 5_000n, entryFailurePpm: 0n, exitFailurePpm: 0n,
};
// Token-2022 ATA (170 bytes) at 5,080 lamports/byte, closed in the sell; both volume accumulators still missing.
const rent: RentInputs = { tokenAccount: 1_513_840n, tokenAccountClosedOnExit: true, oneTime: 0n, transient: 0n };
const usd = (dollars: number) => BigInt(Math.round(dollars * 1e6)) as MicroUsd;
const roomy: SizeCaps = { lossAllowance: usd(20), executableDepth: usd(50), cash: usd(20), riskBudget: usd(20) };
const base = (over: Partial<SizeInput> = {}): SizeInput => ({
  quote: pumpCurveRoundTrip(curve, curveCtx), solPrice: price, edgePpm: 60_000n, network, rent, caps: roomy, ...over,
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
    ['pump curve', pumpCurveRoundTrip(curve, curveCtx), (s: bigint) => curveBuyExactQuoteIn(curve, s, curveCtx), (t: bigint) => curveSell({ ...curve, realQuoteReserves: 10n * SOL }, t, curveCtx)],
    ['PumpSwap', pumpSwapRoundTrip(pool, poolCtx), (s: bigint) => poolBuyExactQuoteIn(pool, s, poolCtx), (t: bigint) => poolSell(pool, t, poolCtx)],
  ] as const) {
    test(`${name}: loses exactly fees plus impact plus fixed costs`, () => {
      for (const dollars of [2, 3.33, 5]) {
        const spend = microUsdToLamports(usd(dollars), price, 'floor');
        const c = costAtSize(quote, spend, network, rent);
        // Independent replay: buy, then sell the same tokens into the untouched pre-entry state.
        const b = buy(spend);
        const tokens = 'tokens' in b ? b.tokens : b.base;
        const s = sell(tokens);
        const walletLoss = b.userQuote - s.userQuote + c.fixed.total;
        const fees = b.protocolFee + b.creatorFee + ('lpFee' in b ? b.lpFee : 0n) + s.protocolFee + s.creatorFee + ('lpFee' in s ? s.lpFee : 0n);
        expect(walletLoss).toBe(fees + b.impact + s.impact + c.fixed.total);
        expect(c.totalLoss).toBe(walletLoss);
        expect(c.proportional).toBe(fees + b.impact + s.impact);
        expect(c.vPpm).toBe(mulDiv(c.proportional, PPM, b.userQuote, 'ceil'));
      }
    });
  }

  test('v(q) stays under the conservative bound across the range', () => {
    const lo = microUsdToLamports(MIN_TRADE_USD, price, 'ceil');
    const hi = microUsdToLamports(MAX_TRADE_USD, price, 'floor');
    for (const quote of [pumpCurveRoundTrip(curve, curveCtx), pumpSwapRoundTrip(pool, poolCtx)]) {
      const vLo = costAtSize(quote, lo, network, rent).vPpm;
      const vHi = costAtSize(quote, hi, network, rent).vPpm;
      const bound = (vLo > vHi ? vLo : vHi) + mulDiv(ROUND_TRIP_ROUNDING_LAMPORTS, PPM, lo, 'ceil');
      for (let q: bigint = lo; q <= hi; q += 99_991n) expect(costAtSize(quote, q, network, rent).vPpm).toBeLessThanOrEqual(bound);
    }
  });

  test('fees dominate at $2: pump curve round trip costs about 2.5% plus impact', () => {
    const c = costAtSize(pumpCurveRoundTrip(curve, curveCtx), microUsdToLamports(usd(2), price, 'floor'), network, rent);
    expect(c.vPpm).toBeGreaterThan(25_000n);
    expect(c.vPpm).toBeLessThan(27_000n);
  });
});

describe('feasible size', () => {
  test('empty when the edge does not beat proportional cost (g <= v)', () => {
    const atCost = feasibleSize(base({ edgePpm: 0n }));
    expect(atCost.trade).toBe(false);
    if (atCost.trade) return;
    expect(atCost.reason).toBe('edge-not-above-cost');
    expect(feasibleSize(base({ edgePpm: atCost.vPpm })).trade).toBe(false);
    expect(feasibleSize(base({ edgePpm: atCost.vPpm + 1n })).trade).toBe(false); // break-even far above $5
  });

  test('empty when any cap falls below $2', () => {
    for (const key of ['lossAllowance', 'executableDepth', 'cash', 'riskBudget'] as const) {
      const d = feasibleSize(base({ caps: { ...roomy, [key]: usd(1.99) } }));
      expect(d.trade).toBe(false);
      if (!d.trade) expect(d.reason).toBe('caps-below-minimum');
      expect(d.bindingCap).toBe(key);
    }
    // Cash must also cover fixed costs and the rent locked in the token account.
    const tight = feasibleSize(base({ caps: { ...roomy, cash: usd(2.05) } }));
    expect(tight.trade).toBe(false);
  });

  test('never above $5 or below $2, whatever the caps', () => {
    for (const caps of [roomy, { ...roomy, cash: usd(1_000) }, { ...roomy, executableDepth: usd(3.1) }]) {
      const d = feasibleSize(base({ caps, edgePpm: 200_000n }));
      expect(d.trade).toBe(true);
      if (!d.trade) continue;
      expect(d.range.maxUsd).toBeLessThanOrEqual(MAX_TRADE_USD);
      expect(d.range.maxUsd).toBeLessThanOrEqual(caps.executableDepth);
      expect(d.range.minUsd).toBeGreaterThanOrEqual(MIN_TRADE_USD);
      expect(d.range.minLamports).toBeLessThanOrEqual(d.range.maxLamports);
    }
  });

  test('break-even equals F / (g - v), and the range starts there', () => {
    const fat = { ...network, entryPriorityFee: 600_000n, exitPriorityFee: 600_000n };
    const d = feasibleSize(base({ network: fat, edgePpm: 80_000n }));
    expect(d.trade).toBe(true);
    if (!d.trade) return;
    const margin = 80_000n - d.vPpm;
    expect(d.breakEvenLamports).toBe(mulDiv(d.fixed.total, PPM, margin, 'ceil'));
    const lo = microUsdToLamports(MIN_TRADE_USD, price, 'ceil');
    expect(d.breakEvenLamports).toBeGreaterThan(lo);
    // First size with strictly positive expected net.
    expect(d.range.minLamports * margin).toBeGreaterThan(d.fixed.total * PPM);
    expect((d.range.minLamports - 1n) * margin).toBeLessThanOrEqual(d.fixed.total * PPM);
    expect(d.expectedNetAtMaxUsd).toBeGreaterThan(0n);
  });

  test('empty when break-even lies above the maximum size', () => {
    const d = feasibleSize(base({ network: { ...network, entryPriorityFee: 400_000n, exitPriorityFee: 400_000n }, edgePpm: 40_000n }));
    expect(d.trade).toBe(false);
    if (!d.trade) {
      expect(d.reason).toBe('break-even-above-maximum');
      expect(d.breakEvenLamports).toBeGreaterThan(microUsdToLamports(MAX_TRADE_USD, price, 'floor'));
    }
  });

  test('loss allowance and risk budget leave room for fixed costs', () => {
    const d = feasibleSize(base({ edgePpm: 200_000n, caps: { ...roomy, riskBudget: usd(4) } }));
    expect(d.bindingCap).toBe('riskBudget');
    if (d.trade) expect(d.range.maxUsd).toBeLessThan(usd(4));
  });

  test('works on a PumpSwap pool and with other proportional costs', () => {
    const plain = feasibleSize(base({ quote: pumpSwapRoundTrip(pool, poolCtx), edgePpm: 60_000n }));
    const routed = feasibleSize(base({ quote: pumpSwapRoundTrip(pool, poolCtx), edgePpm: 60_000n, extraPpm: 10_000n }));
    expect(routed.vPpm - plain.vPpm).toBeGreaterThanOrEqual(10_000n);
  });
});
