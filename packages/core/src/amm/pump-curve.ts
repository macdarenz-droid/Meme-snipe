// pump.fun bonding curve quotes (program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P), integer-exact.
// Formulas follow @pump-fun/pump-sdk 2.0.0 `bondingCurve.ts`/`fees.ts` and are checked against mainnet
// TradeEvents in test/amm/golden.test.ts.
import type { Bps } from '../units/index.ts';
import { type FeeTier, feeOf, marketCap, selectFeeTier } from './fees.ts';

/** The trading fields of the `BondingCurve` account (raw units: lamports and token base units). */
export interface CurveState {
  readonly virtualTokenReserves: bigint;
  readonly virtualQuoteReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly realQuoteReserves: bigint;
  readonly complete: boolean;
}

/**
 * Launch parameters read from the pump `Global` account on 2026-10-03 (slot 452,916,922; docs/research/venues.md 2.1).
 * They are inputs, not constants of the quote path: pass the live values when they differ.
 */
export const PUMP_CURVE_PARAMS = {
  initialVirtualTokenReserves: 1_073_000_000_000_000n,
  initialVirtualQuoteReserves: 30_000_000_000n,
  initialRealTokenReserves: 793_100_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  /** Charged by `migrate` when the curve graduates to PumpSwap (README; pump.fun fee page lists 0.015 SOL). */
  poolMigrationFee: 15_000_001n,
} as const;

export interface CurveFeeContext {
  /** `fee_tiers` from the pump FeeConfig (`8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt`). */
  readonly feeTiers: readonly FeeTier[];
  /** Supply used for the tier's market cap: 1e15 for normal coins (pump-sdk `ONE_BILLION_SUPPLY`). */
  readonly supply: bigint;
  /** False when `BondingCurve.creator` is the default key: no creator fee is charged then. */
  readonly creatorFeeCharged: boolean;
}

export interface CurveFees {
  readonly protocol: Bps;
  readonly creator: Bps;
}

export class CurveCompleteError extends Error {
  constructor() {
    super('bonding curve is complete; trade on the graduation pool');
    this.name = 'CurveCompleteError';
  }
}

/** Fee rates for a trade on this curve, tiered by the pre-trade market cap (pump `compute_fees`). */
export const curveFees = (state: CurveState, ctx: CurveFeeContext): CurveFees => {
  const tier = selectFeeTier(ctx.feeTiers, marketCap(state.virtualQuoteReserves, state.virtualTokenReserves, ctx.supply));
  return { protocol: tier.protocol, creator: ctx.creatorFeeCharged ? tier.creator : (0 as Bps) };
};

export interface CurveTrade {
  /** Tokens moved (received on a buy, sold on a sell). */
  readonly tokens: bigint;
  /** Lamports into or out of the curve, before fees (`TradeEvent.sol_amount`). */
  readonly quote: bigint;
  readonly protocolFee: bigint;
  readonly creatorFee: bigint;
  /** What the trader pays in (buy) or receives (sell), fees included. */
  readonly userQuote: bigint;
  /** Lamports lost to price impact against the pre-trade spot price (vQuote / vToken), exact. */
  readonly impact: bigint;
  readonly after: CurveState;
}

const assertTradable = (state: CurveState) => {
  if (state.complete || state.virtualTokenReserves === 0n) throw new CurveCompleteError();
};

// Value of `tokens` at the pre-trade spot price, floored.
const spotValue = (state: CurveState, tokens: bigint) => (tokens * state.virtualQuoteReserves) / state.virtualTokenReserves;

const afterBuy = (s: CurveState, tokens: bigint, quote: bigint): CurveState => ({
  virtualTokenReserves: s.virtualTokenReserves - tokens,
  virtualQuoteReserves: s.virtualQuoteReserves + quote,
  realTokenReserves: s.realTokenReserves - tokens,
  realQuoteReserves: s.realQuoteReserves + quote,
  complete: s.realTokenReserves - tokens === 0n,
});

/** `buy` / `buy_v2`: exactly `tokens` out (capped at the real reserves left), cost rounded up. */
export const curveBuyExactTokens = (state: CurveState, tokens: bigint, ctx: CurveFeeContext): CurveTrade => {
  assertTradable(state);
  if (tokens <= 0n) throw new RangeError('tokens must be > 0');
  const fees = curveFees(state, ctx);
  const out = tokens < state.realTokenReserves ? tokens : state.realTokenReserves;
  const quote = (out * state.virtualQuoteReserves) / (state.virtualTokenReserves - out) + 1n;
  const protocolFee = feeOf(quote, fees.protocol);
  const creatorFee = feeOf(quote, fees.creator);
  return {
    tokens: out, quote, protocolFee, creatorFee,
    userQuote: quote + protocolFee + creatorFee,
    impact: quote - spotValue(state, out),
    after: afterBuy(state, out, quote),
  };
};

/**
 * `buy_exact_sol_in` / `buy_exact_quote_in_v2`: spend at most `spend` lamports, fees included.
 * The net amount is floor(spend * 10,000 / (10,000 + fee bps)), lowered until net + ceil fees fits in `spend`;
 * tokens out are priced on net - 1, as the program does (verified on mainnet events).
 */
export const curveBuyExactQuoteIn = (state: CurveState, spend: bigint, ctx: CurveFeeContext): CurveTrade => {
  assertTradable(state);
  if (spend <= 1n) throw new RangeError('spend must be > 1 lamport');
  const fees = curveFees(state, ctx);
  const totalBps = BigInt(fees.protocol) + BigInt(fees.creator);
  let quote = (spend * 10_000n) / (10_000n + totalBps);
  const over = quote + feeOf(quote, fees.protocol) + feeOf(quote, fees.creator) - spend;
  if (over > 0n) quote -= over;
  const input = quote - 1n;
  let tokens = (input * state.virtualTokenReserves) / (state.virtualQuoteReserves + input);
  if (tokens > state.realTokenReserves) tokens = state.realTokenReserves;
  const protocolFee = feeOf(quote, fees.protocol);
  const creatorFee = feeOf(quote, fees.creator);
  return {
    tokens, quote, protocolFee, creatorFee,
    userQuote: quote + protocolFee + creatorFee,
    impact: quote - spotValue(state, tokens),
    after: afterBuy(state, tokens, quote),
  };
};

/** `sell` / `sell_v2`: exactly `tokens` in; proceeds floored, fees rounded up and taken from them. */
export const curveSell = (state: CurveState, tokens: bigint, ctx: CurveFeeContext): CurveTrade => {
  assertTradable(state);
  if (tokens <= 0n) throw new RangeError('tokens must be > 0');
  const fees = curveFees(state, ctx);
  const quote = (tokens * state.virtualQuoteReserves) / (state.virtualTokenReserves + tokens);
  if (quote > state.realQuoteReserves) throw new RangeError('sell exceeds the real quote reserves');
  const protocolFee = feeOf(quote, fees.protocol);
  const creatorFee = feeOf(quote, fees.creator);
  const userQuote = quote - protocolFee - creatorFee;
  if (userQuote < 0n) throw new RangeError('fees exceed the sell proceeds');
  return {
    tokens, quote, protocolFee, creatorFee, userQuote,
    impact: spotValue(state, tokens) - quote,
    after: {
      virtualTokenReserves: state.virtualTokenReserves + tokens,
      virtualQuoteReserves: state.virtualQuoteReserves - quote,
      realTokenReserves: state.realTokenReserves + tokens,
      realQuoteReserves: state.realQuoteReserves - quote,
      complete: false,
    },
  };
};

/** Share of the curve's sellable tokens already sold, in parts per million (floored). */
export const curveProgressPpm = (state: CurveState, initialRealTokenReserves: bigint = PUMP_CURVE_PARAMS.initialRealTokenReserves): bigint => {
  if (initialRealTokenReserves <= 0n) throw new RangeError('initial real token reserves must be > 0');
  if (state.complete) return 1_000_000n;
  return ((initialRealTokenReserves - state.realTokenReserves) * 1_000_000n) / initialRealTokenReserves;
};
