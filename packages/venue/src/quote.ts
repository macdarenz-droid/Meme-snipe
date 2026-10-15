// A-M01-03 constant-product ExactIn quotes and `minOut` (pure, bigint only, no floating point). Formulas and rounding
// (rulings Z07-1, Z07-6; @pump-fun/pump-swap-sdk 1.20.0 `src/sdk/`, read only, and the CORE-2 goldens as oracle):
// - each fee component is ceil(amount × bps / 10,000), taken separately for lp, protocol and creator (`util.ts:15`);
// - buys add fees on top: for a total spend S, q′ = floor(S × 10,000 / (10,000 + totalBps)), the fees are taken on q′,
//   q′ is lowered by any excess so q′ + fees ≤ S (fees not recomputed), and the curve input is q′ − 1
//   (`buy.ts:213-232`; the pump curve's buy_exact_quote_in_v2 does the same, per the CORE-2 curve goldens);
// - sells take fees from the gross output gross = floor(Q × t / (B + t));
// - a PumpSwap sell whose gross output less the LP fee exceeds the real quote vault is refused, never clamped
//   (`sell.ts:104`; VF-05), and so is a curve sell whose gross output exceeds the real SOL reserve.
// The SPEC-A A-M01-03 logic 2 wording (one fee on the total, `'from_input'` for PumpSwap) is superseded by A-M01-02
// logic 4 (settled 2026-10-07, VF-04); recorded as clarification C-80 (SPEC-A "Architecture clarifications").
// Tier choice (ruling Z07-2): `rule = 'conservative'` (every engine decision) prices the trade under each schedule the
// pre- and post-trade market caps can select (the dearer adjacent tier on an exact threshold) and keeps the one with the
// smallest output; `rule = 'chain'` uses the program's own tier for the pre-trade market cap (the goldens).
import type { BaseUnits, Bps, DecimalStr, Lamports, Pubkey, Quote, Result } from '@bot/types';
import { PROGRAMS } from './constants.ts';
import { feeFamily, marketCapAt, splitsAt, toSchedule, totalBps, type FeeInputs, type FeeSplit } from './fees.ts';
import type { CpPoolState } from './pool.ts';

export type QuoteError =
  | { code: 'E_FEE_UNKNOWN' | 'E_CONFIG_STALE' | 'E_NEGATIVE_EFFECTIVE' | 'E_ZERO_RESERVE' | 'E_ZERO_INPUT' | 'E_CURVE_COMPLETE'
      | 'E_VENUE_NOT_SPECIFIED' | 'E_OVERFLOW' | 'E_DECIMALS_UNKNOWN' | 'E_FEES_EXCEED_OUTPUT' | 'E_ZERO_OUTPUT'; detail: string }
  | { code: 'E_EXCEEDS_REAL_VAULT'; detail: string; maxSellableBase: BaseUnits };

export type TierRule = 'conservative' | 'chain';

const BPS = 10_000n;
/** Logic 10: any intermediate product above 2^128 is rejected (defensive; not reachable with u64 reserves). */
const PRODUCT_LIMIT = 2n ** 128n;
class Overflow extends Error {}
const mul = (a: bigint, b: bigint): bigint => {
  const r = a * b;
  if (r > PRODUCT_LIMIT || r < -PRODUCT_LIMIT) throw new Overflow();
  return r;
};
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const feeOf = (amount: bigint, rate: Bps): bigint => ceilDiv(mul(amount, BigInt(rate)), BPS);

/** One side priced under one fee split, with every amount the goldens and the venue status check read. */
export interface Leg {
  side: 'buy' | 'sell';
  split: FeeSplit;
  /** Buy: what the trader pays, fees included (≤ the spend; the cap of a completing curve buy lowers it). Sell: base in. */
  amountIn: bigint;
  /** Buy: base out. Sell: quote out after fees. */
  amountOut: bigint;
  /** Buy: q′, the net quote charged to the pool. Sell: the gross quote out of the pool. */
  netQuote: bigint;
  lpFee: bigint; protocolFee: bigint; creatorFee: bigint;
  /** Effective quote and base reserve after the trade (for the post-trade tier). */
  afterQuote: bigint; afterBase: bigint;
}

type LegResult = Result<Leg, QuoteError>;
const err = (code: Exclude<QuoteError['code'], 'E_EXCEEDS_REAL_VAULT'>, detail: string): { ok: false; error: QuoteError } => ({ ok: false, error: { code, detail } });

/** The pool's pricing reserves: Q effective (real + virtual) and B. */
function reserves(p: CpPoolState): Result<{ Q: bigint; B: bigint }, QuoteError> {
  const Q = p.quoteReserveReal + p.quoteReserveVirtual;
  if (Q < 0n) return err('E_NEGATIVE_EFFECTIVE', 'real + virtual quote reserve is negative');
  // A new curve holds no real SOL yet (it prices on virtual reserves); a PumpSwap pool with an empty vault is not usable.
  if (Q === 0n || p.baseReserve <= 0n || (p.venue === 'pumpswap' && p.quoteReserveReal <= 0n)) return err('E_ZERO_RESERVE', 'a reserve is zero');
  return { ok: true, value: { Q, B: p.baseReserve } };
}

/** The LP fee stays in the PumpSwap vault (part of the effective reserve after the trade); the curve has no LP fee. */
const lpRetained = (p: CpPoolState, lpFee: bigint): bigint => (p.venue === 'pumpswap' ? lpFee : 0n);

function buyLeg(p: CpPoolState, Q: bigint, B: bigint, spend: bigint, split: FeeSplit): LegResult {
  const total = BigInt(totalBps(split));
  const untrimmed = mul(spend, BPS) / (BPS + total);
  const lpFee = feeOf(untrimmed, split.lpBps);
  const protocolFee = feeOf(untrimmed, split.protocolBps);
  const creatorFee = feeOf(untrimmed, split.creatorBps);
  const over = untrimmed + lpFee + protocolFee + creatorFee - spend;
  const q = over > 0n ? untrimmed - over : untrimmed;
  const input = q - 1n;
  if (input <= 0n) return err('E_ZERO_INPUT', 'the spend leaves nothing after fees');
  const out = mul(B, input) / (Q + input);
  // #325 red team MAJOR-2: a quote of nothing is refused, never returned with a minimum out of 0 that any fill passes.
  if (out === 0n) return err('E_ZERO_OUTPUT', 'the spend buys no tokens');
  const real = p.realBaseReserve;
  if (p.venue === 'pump_curve' && real !== null && out > real) {
    // Logic 7 (research only): the buy that completes the curve gets the real tokens left, at the exact-tokens price
    // floor(t × Q / (B − t)) + 1 (pump `buy`, CORE-2 curve goldens), and pays less than the spend.
    const quote = mul(real, Q) / (B - real) + 1n;
    const c = { lp: feeOf(quote, split.lpBps), pr: feeOf(quote, split.protocolBps), cr: feeOf(quote, split.creatorBps) };
    return {
      ok: true,
      value: {
        side: 'buy', split, amountIn: quote + c.lp + c.pr + c.cr, amountOut: real, netQuote: quote,
        lpFee: c.lp, protocolFee: c.pr, creatorFee: c.cr, afterQuote: Q + quote, afterBase: B - real,
      },
    };
  }
  return {
    ok: true,
    value: {
      side: 'buy', split, amountIn: spend, amountOut: out, netQuote: q, lpFee, protocolFee, creatorFee,
      afterQuote: Q + q + lpRetained(p, lpFee), afterBase: B - out,
    },
  };
}

/** Gross sell output and whether the venue lets it land (PumpSwap: real vault ≥ gross − LP fee; curve: real ≥ gross). */
function sellGross(p: CpPoolState, Q: bigint, B: bigint, t: bigint, split: FeeSplit): { gross: bigint; lands: boolean } {
  const gross = mul(Q, t) / (B + t);
  const needed = p.venue === 'pumpswap' ? gross - feeOf(gross, split.lpBps) : gross;
  return { gross, lands: p.quoteReserveReal >= needed };
}

/** The largest base input that lands (binary search; the gross output less the LP fee is non-decreasing in it). */
export function maxSellableBase(p: CpPoolState, Q: bigint, B: bigint, upTo: bigint, split: FeeSplit): bigint {
  let lo = 0n;
  let hi = upTo;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (sellGross(p, Q, B, mid, split).lands) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

function sellLeg(p: CpPoolState, Q: bigint, B: bigint, t: bigint, split: FeeSplit): LegResult {
  const { gross, lands } = sellGross(p, Q, B, t, split);
  if (!lands) {
    return { ok: false, error: { code: 'E_EXCEEDS_REAL_VAULT', detail: 'the sell output exceeds the real quote reserve', maxSellableBase: maxSellableBase(p, Q, B, t, split) } };
  }
  const lpFee = feeOf(gross, split.lpBps);
  const protocolFee = feeOf(gross, split.protocolBps);
  const creatorFee = feeOf(gross, split.creatorBps);
  const out = gross - lpFee - protocolFee - creatorFee;
  if (out < 0n) return err('E_FEES_EXCEED_OUTPUT', 'the fees exceed the sell output');
  if (out === 0n) return err('E_ZERO_OUTPUT', 'the sell gives nothing');
  return {
    ok: true,
    value: { side: 'sell', split, amountIn: t, amountOut: out, netQuote: gross, lpFee, protocolFee, creatorFee, afterQuote: Q - gross + lpRetained(p, lpFee), afterBase: B + t },
  };
}

/** The largest SPL token amount (u64). */
export const U64_MAX = 2n ** 64n - 1n;

/** One side under one split, after the pool checks. */
export function legWithSplit(p: CpPoolState, side: 'buy' | 'sell', amountIn: bigint, split: FeeSplit): LegResult {
  const r = reserves(p);
  if (!r.ok) return r;
  if (amountIn <= 0n) return err('E_ZERO_INPUT', 'amount in must be > 0');
  // Ruling Z07-16: an SPL amount is a u64; anything larger can never be a real instruction argument.
  if (amountIn > U64_MAX) return err('E_OVERFLOW', 'amount in exceeds 2^64 - 1');
  try {
    return side === 'buy' ? buyLeg(p, r.value.Q, r.value.B, amountIn, split) : sellLeg(p, r.value.Q, r.value.B, amountIn, split);
  } catch (e) {
    if (e instanceof Overflow) return err('E_OVERFLOW', 'an intermediate product exceeds 2^128');
    throw e;
  }
}

/** Spot price in SOL per whole token, exact rational truncated to 24 fractional digits (logic 5). */
export function spotSolPerToken(Q: bigint, B: bigint, decimals: number): DecimalStr {
  const scaled = (Q * 10n ** BigInt(decimals) * 10n ** 24n) / (B * 1_000_000_000n);
  const s = scaled.toString().padStart(25, '0');
  return `${s.slice(0, -24)}.${s.slice(-24)}`;
}

/** Price impact against the pre-trade spot (logic 6), rounded up; fees excluded. */
function impactBps(leg: Leg, Q: bigint, B: bigint): Bps {
  if (leg.side === 'buy') {
    const den = leg.amountOut * Q;
    return Number(ceilDiv((leg.netQuote * B - den) * BPS, den));
  }
  const den = leg.amountIn * Q;
  return Number(ceilDiv((den - leg.netQuote * B) * BPS, den));
}

/** The legs every candidate schedule gives, and the one the rule keeps. */
export interface QuoteDetail { leg: Leg; candidates: FeeSplit[]; quote: Quote }

/**
 * `quoteExactIn` with the leg it chose and the schedules it considered (A-M01-05 reads `candidates`). `inputs` is one
 * snapshot of the venue config cache; staleness is checked by the cache (`VenueModel.quoteExactIn`).
 */
export function quoteDetail(p: CpPoolState, side: 'buy' | 'sell', amountIn: bigint, inputs: FeeInputs, rule: TierRule = 'conservative'): Result<QuoteDetail, QuoteError> {
  if (p.venue !== 'pump_curve' && p.venue !== 'pumpswap') return err('E_VENUE_NOT_SPECIFIED', `${p.venue} is not specified until A-M01-06 (D18)`);
  if (p.venue === 'pump_curve' && (p.curveComplete !== false || p.realBaseReserve === 0n)) return err('E_CURVE_COMPLETE', 'the curve is complete; trading is on PumpSwap');
  const r = reserves(p);
  if (!r.ok) return r;
  if (amountIn <= 0n) return err('E_ZERO_INPUT', 'amount in must be > 0');
  if (p.baseDecimals === null) return err('E_DECIMALS_UNKNOWN', 'base mint decimals unknown');
  const { Q, B } = r.value;
  const pre = marketCapAt(p, Q, B);
  const fam = feeFamily(p, inputs);
  if (!fam.ok) return fam;
  const chainSplit = splitsAt(fam.value, [pre])[0] as FeeSplit;
  const chainLeg = legWithSplit(p, side, amountIn, chainSplit);
  if (!chainLeg.ok) return chainLeg;
  let candidates = [chainSplit];
  let leg = chainLeg.value;
  if (rule === 'conservative') {
    // After any trade the base reserve stays > 0 (a buy takes floor(B·x/(Q+x)) < B) and the effective quote ≥ 0.
    candidates = splitsAt(fam.value, [pre, marketCapAt(p, leg.afterQuote, leg.afterBase)]);
    for (const split of candidates.slice(1)) {
      const other = legWithSplit(p, side, amountIn, split);
      if (!other.ok) return other;                          // a schedule that refuses the trade refuses it
      const o = other.value;
      if (o.amountOut < leg.amountOut || (o.amountOut === leg.amountOut && totalBps(o.split) > totalBps(leg.split))) leg = o;
    }
  }
  const quote: Quote = {
    side, amountIn: leg.amountIn, amountOut: leg.amountOut,
    venueFeeLamports: (leg.lpFee + leg.protocolFee + leg.creatorFee) as Lamports,
    priceImpactBps: impactBps(leg, Q, B),
    spotBeforeSolPerToken: spotSolPerToken(Q, B, p.baseDecimals),
    feeSchedule: toSchedule(leg.split, fam.value.cfg), poolAsOfSlot: p.asOfSlot,
  };
  return { ok: true, value: { leg, candidates, quote } };
}

/** `VenueModel.quoteExactIn` without the staleness check. */
export function quoteExactIn(p: CpPoolState, side: 'buy' | 'sell', amountIn: bigint, inputs: FeeInputs, rule: TierRule = 'conservative'): Result<Quote, QuoteError> {
  const d = quoteDetail(p, side, amountIn, inputs, rule);
  return d.ok ? { ok: true, value: d.value.quote } : d;
}

/**
 * Logic 8: floor(amountOut × (10,000 − s) / 10,000); `s` must be an integer 0..10,000. A minimum of 0 would let any
 * fill pass, so it throws `E_ZERO_OUTPUT` (#325 red team MAJOR-2; slippage 10,000 or a dust quote).
 */
export function minOut(q: Quote, slippageBps: Bps): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw { code: 'E_INVALID_SLIPPAGE' };
  const m = (q.amountOut * (BPS - BigInt(slippageBps))) / BPS;
  if (m === 0n) throw { code: 'E_ZERO_OUTPUT' };
  return m;
}

/** Logic 1: real + virtual; throws `E_NEGATIVE_EFFECTIVE` when negative. */
export function effectiveQuote(p: CpPoolState): Lamports {
  const e = p.quoteReserveReal + p.quoteReserveVirtual;
  if (e < 0n) throw { code: 'E_NEGATIVE_EFFECTIVE' };
  return e;
}

/** Logic 9: the allowlisted programs (D18); Raydium maps but does not quote until A-M01-06. */
export function isAllowedVenue(programId: Pubkey): CpPoolState['venue'] | null {
  switch (programId) {
    case PROGRAMS.pumpCurve: return 'pump_curve';
    case PROGRAMS.pumpSwap: return 'pumpswap';
    case PROGRAMS.raydiumAmmV4: return 'raydium_amm_v4';
    case PROGRAMS.raydiumCpmm: return 'raydium_cpmm';
    default: return null;
  }
}

/**
 * SOL that can leave the market (bug B2, docs/MIGRATION.md "Known bugs"): the real quote vault (PumpSwap) or the real
 * SOL reserve (curve), never the effective reserve. Price and impact stay on effective reserves (ARCH 2.1); depth,
 * exits and liquidation value use this.
 */
export function exitableQuoteLamports(p: CpPoolState): Lamports {
  return p.quoteReserveReal;
}
