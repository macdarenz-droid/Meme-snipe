// A-M01-03 quote maths and minOut (card Z07): acceptance criteria "AC<n>", the ARCH 16.2 properties (fast-check 4.10.2,
// fixed seeds, 10,000 cases each; ruling Z07-7) and every error branch. Bug B2 (docs/MIGRATION.md "Known bugs"): the
// old Zeroed `quoteReserve` (`packages/core/src/exits/value.ts:42-43`, the effective reserve) is re-run through the same
// check and must be rejected.
import { strict as assert } from 'node:assert';
import fc from 'fast-check';
import { describe, it } from 'vitest';
import type { Bps, Quote } from '@bot/types';
import { MINTS, PROGRAMS } from '../src/constants.ts';
import type { CpPoolState } from '../src/pool.ts';
import { effectiveQuote, exitableQuoteLamports, isAllowedVenue, legWithSplit, maxSellableBase, minOut, quoteDetail, quoteExactIn, spotSolPerToken } from '../src/quote.ts';
import { CORE2_INPUTS, pool, SOL, split3 } from './helpers.ts';

const INPUTS = CORE2_INPUTS;
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return r.value;
};
const code = (r: { ok: boolean; error?: { code: string } }): string | null => (r.ok ? null : (r.error as { code: string }).code);

/** A fresh pump curve from the Global launch constants [EX-02]. */
const freshCurve = (over: Partial<CpPoolState> = {}): CpPoolState => pool({
  venue: 'pump_curve', isCanonical: null, curveComplete: false, quoteMint: MINTS.wsol,
  baseReserve: 1_073_000_000_000_000n, quoteReserveReal: 0n, quoteReserveVirtual: 30_000_000_000n,
  realBaseReserve: 793_100_000_000_000n, baseMintSupply: 1_000_000_000_000_000n, ...over,
});

describe('A-M01-03 acceptance', () => {
  it('AC1: a buy sequence sells all real tokens; the curve completes with about 85.005 SOL real, each step within 1 lamport of an independent rational computation [EX-02, EX-03]', () => {
    let c = freshCurve();
    let steps = 0;
    while (c.curveComplete === false) {
      const d = ok(quoteDetail(c, 'buy', 3n * SOL, INPUTS));
      const { leg } = d;
      const vSol = c.quoteReserveReal + c.quoteReserveVirtual;
      const realTokens = c.realBaseReserve as bigint;
      // Independent: tokens out = B − k / (Q + x) as a rational, floored, capped at the real tokens left.
      const x = leg.amountOut === realTokens ? null : leg.netQuote - 1n;
      if (x !== null) {
        const k = c.baseReserve * vSol;
        const exact = c.baseReserve - (k + vSol + x - 1n) / (vSol + x);
        assert.ok(leg.amountOut - exact <= 1n && exact - leg.amountOut <= 1n);
      }
      const realSol = c.quoteReserveReal + leg.netQuote;
      const left = realTokens - leg.amountOut;
      c = { ...c, baseReserve: c.baseReserve - leg.amountOut, quoteReserveReal: realSol, quoteReserveVirtual: vSol + leg.netQuote - realSol, realBaseReserve: left, curveComplete: left === 0n };
      steps++;
    }
    // DERIVED: k / (1.073e15 − 7.931e14) − 30 SOL = 115.005… − 30 = 85.005… SOL. Each integer step leaves the pool at
    // most 2 lamports above the continuous curve (the swap input is q′ − 1 while q′ is charged, and tokens out are
    // floored, worth under 1 lamport at these prices), and never below it.
    const target = (30_000_000_000n * 1_073_000_000_000_000n) / 279_900_000_000_000n - 30_000_000_000n;
    assert.ok(c.quoteReserveReal >= target && c.quoteReserveReal - target <= 2n * BigInt(steps), `${c.quoteReserveReal} vs ${target} after ${steps} steps`);
    assert.ok(c.quoteReserveReal / 1_000_000n === 85_005n);
    const done = quoteExactIn(c, 'buy', SOL, INPUTS);
    assert.equal(code(done), 'E_CURVE_COMPLETE');
  });

  it('AC3: minOut(q, s) ≤ q.amountOut for every s in 0..10,000; an invalid s throws E_INVALID_SLIPPAGE', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 2n ** 64n }), fc.integer({ min: 0, max: 10_000 }), (out, s) => {
      const m = minOut({ amountOut: out } as Quote, s as Bps);
      return m <= out && m === (out * BigInt(10_000 - s)) / 10_000n;
    }), { numRuns: 10_000, seed: 7_031 });
    for (const s of [-1, 10_001, 1.5, Number.NaN]) assert.throws(() => minOut({ amountOut: 1n } as Quote, s as Bps), (e: unknown) => (e as { code: string }).code === 'E_INVALID_SLIPPAGE');
  });

  it('AC4: a negative virtual reserve with a non-negative sum quotes; a negative sum is E_NEGATIVE_EFFECTIVE [EX-09, DA-14]', () => {
    assert.ok(quoteExactIn(pool({ quoteReserveVirtual: -10n * SOL }), 'buy', SOL, INPUTS).ok);
    const neg = pool({ quoteReserveReal: SOL, quoteReserveVirtual: -2n * SOL });
    assert.equal(code(quoteExactIn(neg, 'buy', SOL, INPUTS)), 'E_NEGATIVE_EFFECTIVE');
    assert.throws(() => effectiveQuote(neg), (e: unknown) => (e as { code: string }).code === 'E_NEGATIVE_EFFECTIVE');
    assert.equal(effectiveQuote(pool()), 60n * SOL + 17_584_326_063n);
  });

  it('AC5: the drained pool (17.58 SOL virtual, 0.27 SOL real [RS-17]): a sell above the real vault is E_EXCEEDS_REAL_VAULT with maxSellableBase; that size quotes [VF-05]', () => {
    const drained = pool({ quoteReserveReal: 270_000_000n, quoteReserveVirtual: 17_580_000_000n, baseReserve: 400_000_000_000_000n });
    const big = quoteExactIn(drained, 'sell', 100_000_000_000_000n, INPUTS);
    assert.ok(!big.ok && big.error.code === 'E_EXCEEDS_REAL_VAULT');
    const max = big.error.maxSellableBase;
    assert.ok(max > 0n && max < 100_000_000_000_000n);
    const atMax = ok(quoteDetail(drained, 'sell', max, INPUTS));
    assert.ok(atMax.leg.netQuote - atMax.leg.lpFee <= drained.quoteReserveReal);
    assert.equal(code(quoteExactIn(drained, 'sell', max + 1n, INPUTS)), 'E_EXCEEDS_REAL_VAULT');
  });

  it('B2: SOL that can leave the drained pool is the real 0.27 SOL, not 17.85; the old Zeroed quoteReserve is rejected', () => {
    const drained = pool({ quoteReserveReal: 270_000_000n, quoteReserveVirtual: 17_580_000_000n });
    const oldQuoteReserve = (p: CpPoolState) => p.quoteReserveReal + p.quoteReserveVirtual;   // value.ts:42-43 (pumpswap branch)
    const check = (v: bigint) => assert.equal(v, 270_000_000n);
    check(exitableQuoteLamports(drained));
    assert.throws(() => check(oldQuoteReserve(drained)));
    check(exitableQuoteLamports(freshCurve({ quoteReserveReal: 270_000_000n })));
  });

  it('AC6: a mayhem pool tiers on a supply of 10^15; a configurable creator_fee_bps of 50 is the creator rate; a default coin_creator pays none [VF-04]', () => {
    const at = (p: CpPoolState) => ok(quoteDetail(p, 'buy', SOL, INPUTS)).leg.split;
    const mcap420 = pool({ baseReserve: 1_000_000_000_000_000n, baseMintSupply: 2_000_000_000_000_000n, quoteReserveReal: 420n * SOL, quoteReserveVirtual: 0n });
    assert.deepEqual(at({ ...mcap420, isMayhemMode: true }), split3(2, 93, 30));
    assert.equal(at({ ...mcap420, creatorFeeBps: 50 }).creatorBps, 50);
    assert.equal(at({ ...mcap420, coinCreatorSet: false }).creatorBps, 0);
  });
});

describe('A-M01-03 properties (ARCH 16.2; 10,000 cases each, fixed seeds)', () => {
  const pools = fc.record({
    q: fc.bigInt({ min: 10_000_000n, max: 1_000_000n * SOL }),
    v: fc.bigInt({ min: 0n, max: 100n * SOL }),
    b: fc.bigInt({ min: 1_000_000n, max: 1_000_000_000_000_000n }),
    canonical: fc.boolean(),
  }).map(({ q, v, b, canonical }) => pool({ quoteReserveReal: q, quoteReserveVirtual: v, baseReserve: b, isCanonical: canonical }));
  const spend = fc.bigInt({ min: 2n, max: 10_000n * SOL });

  it('k after a swap, before fee extraction, is ≥ k before (buys and sells)', () => {
    fc.assert(fc.property(pools, spend, (p, x) => {
      const k = (p.quoteReserveReal + p.quoteReserveVirtual) * p.baseReserve;
      const buy = quoteDetail(p, 'buy', x, INPUTS);
      const sell = quoteDetail(p, 'sell', x, INPUTS);
      const kb = buy.ok ? (p.quoteReserveReal + p.quoteReserveVirtual + buy.value.leg.netQuote - 1n) * buy.value.leg.afterBase >= k : true;
      const ks = sell.ok ? (p.quoteReserveReal + p.quoteReserveVirtual - sell.value.leg.netQuote) * sell.value.leg.afterBase >= k : true;
      return kb && ks;
    }), { numRuns: 10_000, seed: 7_032 });
  });

  it('a buy then a sell of the tokens received, with no other flow, returns ≤ the input', () => {
    fc.assert(fc.property(pools, spend, (p, x) => {
      const buy = quoteDetail(p, 'buy', x, INPUTS);
      if (!buy.ok || buy.value.leg.amountOut === 0n) return true;
      const after: CpPoolState = { ...p, baseReserve: buy.value.leg.afterBase, quoteReserveReal: p.quoteReserveReal + buy.value.leg.netQuote + buy.value.leg.lpFee };
      const sell = quoteDetail(after, 'sell', buy.value.leg.amountOut, INPUTS);
      return !sell.ok || sell.value.leg.amountOut <= x;
    }), { numRuns: 10_000, seed: 7_033 });
  });

  it('output is monotonic (non-decreasing) in input, for buys and sells', () => {
    fc.assert(fc.property(pools, spend, spend, fc.constantFrom<'buy' | 'sell'>('buy', 'sell'), (p, a, b, side) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const ql = quoteExactIn(p, side, lo, INPUTS, 'chain');
      const qh = quoteExactIn(p, side, hi, INPUTS, 'chain');
      return !ql.ok || !qh.ok || qh.value.amountOut >= ql.value.amountOut;
    }), { numRuns: 10_000, seed: 7_034 });
  });

  it('minOut ≤ amountOut on real quotes', () => {
    fc.assert(fc.property(pools, spend, fc.integer({ min: 0, max: 10_000 }), (p, x, s) => {
      const q = quoteExactIn(p, 'buy', x, INPUTS);
      return !q.ok || minOut(q.value, s as Bps) <= q.value.amountOut;
    }), { numRuns: 10_000, seed: 7_035 });
  });
});

describe('A-M01-03 branches', () => {
  it('edge 1-2: zero input, zero reserves and a spend that leaves nothing after fees', () => {
    assert.equal(code(quoteExactIn(pool(), 'buy', 0n, INPUTS)), 'E_ZERO_INPUT');
    assert.equal(code(quoteExactIn(pool(), 'buy', 1n, INPUTS)), 'E_ZERO_INPUT');
    assert.equal(code(quoteExactIn(pool({ baseReserve: 0n }), 'buy', SOL, INPUTS)), 'E_ZERO_RESERVE');
    assert.equal(code(quoteExactIn(pool({ quoteReserveReal: 0n }), 'buy', SOL, INPUTS)), 'E_ZERO_RESERVE');
    assert.equal(code(quoteExactIn(pool({ quoteReserveReal: 0n, quoteReserveVirtual: 0n }), 'sell', SOL, INPUTS)), 'E_ZERO_RESERVE');
    assert.equal(code(legWithSplit(pool(), 'sell', 0n, split3(0, 0, 0))), 'E_ZERO_INPUT');
    assert.equal(code(legWithSplit(pool({ baseReserve: 0n }), 'sell', 1n, split3(0, 0, 0))), 'E_ZERO_RESERVE');
    // A new curve has no real SOL and still quotes.
    assert.ok(quoteExactIn(freshCurve(), 'buy', SOL, INPUTS).ok);
  });

  it('edge 3: a buy that gets no tokens is returned with amountOut 0 and impact 10,000 bps', () => {
    const q = ok(quoteExactIn(pool({ baseReserve: 1n }), 'buy', 1_000_000n, INPUTS));
    assert.equal(q.amountOut, 0n);
    assert.equal(q.priceImpactBps, 10_000);
  });

  it('fees that exceed a dust sell output are E_FEES_EXCEED_OUTPUT; a zero gross sell is amountOut 0', () => {
    const p = pool({ quoteReserveReal: 1_000_000_000_000n, quoteReserveVirtual: 0n, baseReserve: 1_000_000_000_000n });
    assert.equal(code(legWithSplit(p, 'sell', 2n, split3(1, 1, 1))), 'E_FEES_EXCEED_OUTPUT');
    assert.equal(ok(legWithSplit(p, 'sell', 1n, split3(1, 1, 1))).amountOut, 0n);
  });

  it('curve: complete, null or zero real tokens are E_CURVE_COMPLETE; a sell above the real SOL is refused; a capped completing buy pays less', () => {
    assert.equal(code(quoteExactIn(freshCurve({ curveComplete: true }), 'buy', SOL, INPUTS)), 'E_CURVE_COMPLETE');
    assert.equal(code(quoteExactIn(freshCurve({ curveComplete: null }), 'buy', SOL, INPUTS)), 'E_CURVE_COMPLETE');
    assert.equal(code(quoteExactIn(freshCurve({ realBaseReserve: 0n }), 'buy', SOL, INPUTS)), 'E_CURVE_COMPLETE');
    const sell = quoteExactIn(freshCurve({ quoteReserveReal: SOL, quoteReserveVirtual: 29n * SOL }), 'sell', 100_000_000_000_000n, INPUTS);
    assert.ok(!sell.ok && sell.error.code === 'E_EXCEEDS_REAL_VAULT');
    const nearEnd = freshCurve({ realBaseReserve: 1_000_000n });
    const capped = ok(quoteExactIn(nearEnd, 'buy', 10n * SOL, INPUTS));
    assert.equal(capped.amountOut, 1_000_000n);
    assert.ok(capped.amountIn < 10n * SOL);
  });

  it('decimals unknown, a Raydium venue, overflow and an unknown fee are refused', () => {
    assert.equal(code(quoteExactIn(pool({ baseDecimals: null }), 'buy', SOL, INPUTS)), 'E_DECIMALS_UNKNOWN');
    assert.equal(code(quoteExactIn(pool({ venue: 'raydium_amm_v4' }), 'buy', SOL, INPUTS)), 'E_VENUE_NOT_SPECIFIED');
    assert.equal(code(quoteExactIn(pool({ baseReserve: 2n ** 100n }), 'buy', 2n ** 40n, INPUTS)), 'E_OVERFLOW');
    assert.equal(code(quoteExactIn(pool({ isCanonical: null }), 'buy', SOL, INPUTS)), 'E_FEE_UNKNOWN');
    assert.equal(code(quoteExactIn(pool({ creatorFeeBps: 50 }), 'buy', SOL, { ...INPUTS, creatorFeeConfigurable: null })), 'E_FEE_UNKNOWN');
    assert.throws(() => legWithSplit(pool(), 'buy', SOL, null as never));
  });

  it('a conservative candidate that refuses the trade refuses it', () => {
    // At exactly 420 SOL the candidates are 20/5/95 and 2/93/30; a sell sized between their real-vault limits lands
    // under the bigger LP fee (20 bps) and not under 2 bps, so the conservative quote refuses.
    const p = pool({ baseReserve: 1_000_000_000_000_000n, quoteReserveReal: 2n * SOL, quoteReserveVirtual: 418n * SOL });
    const big = maxSellableBase(p, 420n * SOL, p.baseReserve, 10n ** 15n, split3(20, 5, 95));
    const small = maxSellableBase(p, 420n * SOL, p.baseReserve, 10n ** 15n, split3(2, 93, 30));
    assert.ok(big > small);
    assert.ok(quoteExactIn(p, 'sell', big, INPUTS, 'chain').ok);
    assert.equal(code(quoteExactIn(p, 'sell', big, INPUTS)), 'E_EXCEEDS_REAL_VAULT');
  });

  it('on equal outputs the conservative rule keeps the dearer schedule (a tiny sell exactly at 420 SOL)', () => {
    const p = pool({ baseReserve: 1_000_000_000_000_000n, quoteReserveReal: 420n * SOL, quoteReserveVirtual: 0n });
    const chain = ok(quoteDetail(p, 'sell', 250_000n, INPUTS, 'chain'));
    const cons = ok(quoteDetail(p, 'sell', 250_000n, INPUTS));
    assert.equal(cons.leg.amountOut, chain.leg.amountOut);
    assert.deepEqual([chain.quote.feeSchedule.totalBps, cons.quote.feeSchedule.totalBps], [120, 125]);
  });

  it('spot price is exact to 24 digits, truncated; impact is ≥ 0 and grows with size', () => {
    assert.equal(spotSolPerToken(30_000_000_000n, 1_073_000_000_000_000n, 6), '0.000000027958993476234855');
    assert.equal(spotSolPerToken(2n * SOL, 1_000_000n, 6), '2.000000000000000000000000');
    const p = pool();
    const small = ok(quoteExactIn(p, 'buy', SOL / 100n, INPUTS));
    const big = ok(quoteExactIn(p, 'buy', 10n * SOL, INPUTS));
    assert.ok(small.priceImpactBps >= 0 && big.priceImpactBps > small.priceImpactBps);
    const s = ok(quoteExactIn(p, 'sell', 10n ** 13n, INPUTS));
    assert.ok(s.priceImpactBps > 0 && s.spotBeforeSolPerToken === small.spotBeforeSolPerToken);
    assert.equal(s.feeSchedule.feeOnBuy, 'added_on_top');
    assert.equal(s.venueFeeLamports > 0n, true);
  });

  it('isAllowedVenue maps the four allowlisted programs and nothing else (D18)', () => {
    assert.equal(isAllowedVenue(PROGRAMS.pumpCurve), 'pump_curve');
    assert.equal(isAllowedVenue(PROGRAMS.pumpSwap), 'pumpswap');
    assert.equal(isAllowedVenue(PROGRAMS.raydiumAmmV4), 'raydium_amm_v4');
    assert.equal(isAllowedVenue(PROGRAMS.raydiumCpmm), 'raydium_cpmm');
    assert.equal(isAllowedVenue(PROGRAMS.raydiumClmm), null);
  });
});
