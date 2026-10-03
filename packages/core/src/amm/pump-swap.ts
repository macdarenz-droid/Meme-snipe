// PumpSwap pool quotes (program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA), integer-exact.
// Formulas follow @pump-fun/pump-swap-sdk 1.20.0 `buy.ts`/`sell.ts`/`fees.ts` and pump-public-docs
// NEGATIVE_VIRTUAL_QUOTE_RESERVES.md; checked against mainnet BuyEvent/SellEvent in test/amm/golden.test.ts.
import type { Bps } from '../units/index.ts';
import { type FeeConfig, type FeeSplit, feeOf, marketCap, selectFeeTier } from './fees.ts';

export interface PoolState {
  /** `pool_base_token_account.amount`. */
  readonly baseReserve: bigint;
  /** `pool_quote_token_account.amount` (the real vault balance). */
  readonly quoteVault: bigint;
  /** `Pool.virtual_quote_reserves`: a signed i128 that may be negative from 2026-09-30. */
  readonly virtualQuoteReserves: bigint;
}

export interface PoolFeeContext {
  readonly feeConfig: FeeConfig;
  /** True when `Pool.creator` is the pump "pool-authority" PDA of the base mint (a graduated pump coin). */
  readonly canonical: boolean;
  /** Base mint supply for the tier's market cap (pump-amm `Pool::market_cap` uses the live mint supply). */
  readonly baseSupply: bigint;
  /** False when `Pool.coin_creator` is the default key: no creator fee is charged then. */
  readonly creatorFeeCharged: boolean;
  /** `Pool.creator_fee_bps` when non-zero and the global config lets it replace the schedule's creator rate. */
  readonly creatorFeeOverride?: Bps;
}

/** The quote reserve every price uses: vault + virtual (signed). The program guarantees it is >= 0. */
export const effectiveQuoteReserve = (pool: PoolState): bigint => {
  const q = pool.quoteVault + pool.virtualQuoteReserves;
  if (q <= 0n) throw new RangeError(`effective quote reserve must be > 0, got ${q}`);
  return q;
};

/** Fee rates for a trade on this pool: canonical pools by pre-trade market-cap tier, others the flat schedule. */
export const poolFees = (pool: PoolState, ctx: PoolFeeContext): FeeSplit => {
  const schedule = ctx.canonical
    ? selectFeeTier(ctx.feeConfig.feeTiers, marketCap(effectiveQuoteReserve(pool), pool.baseReserve, ctx.baseSupply))
    : ctx.feeConfig.flatFees;
  const creator = !ctx.creatorFeeCharged ? (0 as Bps) : ctx.creatorFeeOverride !== undefined && ctx.creatorFeeOverride > 0 ? ctx.creatorFeeOverride : schedule.creator;
  return { lp: schedule.lp, protocol: schedule.protocol, creator };
};

export interface PoolTrade {
  readonly base: bigint;
  /** Quote into (buy) or out of (sell) the constant product, before fees. */
  readonly quote: bigint;
  readonly lpFee: bigint;
  readonly protocolFee: bigint;
  readonly creatorFee: bigint;
  /** What the trader pays in (buy) or receives (sell), fees included. */
  readonly userQuote: bigint;
  /** Quote units lost to price impact against the pre-trade spot price (effective quote / base), exact. */
  readonly impact: bigint;
  readonly fees: FeeSplit;
  /** Pool after the trade: the LP fee stays in the vault; protocol and creator fees leave it. */
  readonly after: PoolState;
}

const spotValue = (pool: PoolState, base: bigint) => (base * effectiveQuoteReserve(pool)) / pool.baseReserve;

const assertPool = (pool: PoolState) => {
  if (pool.baseReserve <= 0n || pool.quoteVault <= 0n) throw new RangeError('pool reserves must be > 0');
};

const buyResult = (pool: PoolState, base: bigint, quote: bigint, fees: FeeSplit): PoolTrade => {
  const lpFee = feeOf(quote, fees.lp);
  const protocolFee = feeOf(quote, fees.protocol);
  const creatorFee = feeOf(quote, fees.creator);
  return {
    base, quote, lpFee, protocolFee, creatorFee, fees,
    userQuote: quote + lpFee + protocolFee + creatorFee,
    impact: quote - spotValue(pool, base),
    after: { baseReserve: pool.baseReserve - base, quoteVault: pool.quoteVault + quote + lpFee, virtualQuoteReserves: pool.virtualQuoteReserves },
  };
};

/** `buy`: exactly `base` out; quote in = ceil(effQuote * base / (baseReserve - base)), fees on top. */
export const poolBuyExactBase = (pool: PoolState, base: bigint, ctx: PoolFeeContext): PoolTrade => {
  assertPool(pool);
  if (base <= 0n || base >= pool.baseReserve) throw new RangeError('base out must be > 0 and below the base reserve');
  const fees = poolFees(pool, ctx);
  const eq = effectiveQuoteReserve(pool);
  const den = pool.baseReserve - base;
  const quote = (eq * base + den - 1n) / den;
  return buyResult(pool, base, quote, fees);
};

/**
 * `buy_exact_quote_in`: spend at most `spend`, fees included. Net quote = floor(spend * 10,000 / (10,000 + fee bps)),
 * lowered until net + ceil fees fits in `spend`; base out is priced on net - 1 (pump-swap-sdk `buyQuoteInput`).
 */
export const poolBuyExactQuoteIn = (pool: PoolState, spend: bigint, ctx: PoolFeeContext): PoolTrade => {
  assertPool(pool);
  if (spend <= 1n) throw new RangeError('spend must be > 1');
  const fees = poolFees(pool, ctx);
  const totalBps = BigInt(fees.lp) + BigInt(fees.protocol) + BigInt(fees.creator);
  let quote = (spend * 10_000n) / (10_000n + totalBps);
  const over = quote + feeOf(quote, fees.lp) + feeOf(quote, fees.protocol) + feeOf(quote, fees.creator) - spend;
  if (over > 0n) quote -= over;
  const input = quote - 1n;
  const eq = effectiveQuoteReserve(pool);
  const base = (pool.baseReserve * input) / (eq + input);
  return buyResult(pool, base, quote, fees);
};

/** `sell`: exactly `base` in; quote out = floor(effQuote * base / (baseReserve + base)), fees taken from it. */
export const poolSell = (pool: PoolState, base: bigint, ctx: PoolFeeContext): PoolTrade => {
  assertPool(pool);
  if (base <= 0n) throw new RangeError('base in must be > 0');
  const fees = poolFees(pool, ctx);
  const eq = effectiveQuoteReserve(pool);
  const quote = (eq * base) / (pool.baseReserve + base);
  const lpFee = feeOf(quote, fees.lp);
  const protocolFee = feeOf(quote, fees.protocol);
  const creatorFee = feeOf(quote, fees.creator);
  if (pool.quoteVault < quote - lpFee) throw new RangeError('sell exceeds the real quote vault');
  const userQuote = quote - lpFee - protocolFee - creatorFee;
  if (userQuote < 0n) throw new RangeError('fees exceed the sell proceeds');
  return {
    base, quote, lpFee, protocolFee, creatorFee, fees, userQuote,
    impact: spotValue(pool, base) - quote,
    after: { baseReserve: pool.baseReserve + base, quoteVault: pool.quoteVault - quote + lpFee, virtualQuoteReserves: pool.virtualQuoteReserves },
  };
};
