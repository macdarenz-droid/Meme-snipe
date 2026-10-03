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
  /**
   * The pool's quote mint class: 'sol' (WSOL, the zero key or the Token-2022 native mint) or 'exotic' (any mint other
   * than SOL and the listed stables). USDC-quoted pools use stable tiers, which this module does not model: reject them.
   */
  readonly quote: 'sol' | 'exotic';
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

const isZero = (f: FeeSplit) => f.lp === 0 && f.protocol === 0 && f.creator === 0;

/**
 * Fee rates for a trade on this pool, as pump-fees `fees_for_quote_mint`: non-canonical pools pay the flat schedule;
 * canonical SOL pools the tier for the pre-trade market cap; canonical exotic pools the exotic schedule (flat if unset).
 */
export const poolFees = (pool: PoolState, ctx: PoolFeeContext): FeeSplit => {
  const { feeConfig } = ctx;
  const schedule = !ctx.canonical
    ? feeConfig.flatFees
    : ctx.quote === 'sol'
      ? selectFeeTier(feeConfig.feeTiers, marketCap(effectiveQuoteReserve(pool), pool.baseReserve, ctx.baseSupply))
      : isZero(feeConfig.exoticFlatFees) ? feeConfig.flatFees : feeConfig.exoticFlatFees;
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
  /**
   * Pool after the trade. The effective reserve (and every later price) is exact. The vault/virtual split assumes the
   * LP fee stays in the vault and the protocol and creator fees leave it; some pools keep more in the vault and offset
   * it in `virtual_quote_reserves` (seen on exotic-quote pools), so re-read the pool rather than trust the split.
   */
  readonly after: PoolState;
}

const spotValue = (pool: PoolState, base: bigint) => (base * effectiveQuoteReserve(pool)) / pool.baseReserve;

const assertPool = (pool: PoolState) => {
  if (pool.baseReserve <= 0n || pool.quoteVault <= 0n) throw new RangeError('pool reserves must be > 0');
};

// Fees default to ceil(quote * bps); exact-quote-in passes the fees it computed before trimming the quote.
const buyResult = (pool: PoolState, base: bigint, quote: bigint, fees: FeeSplit, feeBase = quote): PoolTrade => {
  const lpFee = feeOf(feeBase, fees.lp);
  const protocolFee = feeOf(feeBase, fees.protocol);
  const creatorFee = feeOf(feeBase, fees.creator);
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
 * `buy_exact_quote_in`: spend at most `spend`, fees included. Net quote = floor(spend * 10,000 / (10,000 + fee bps));
 * the ceil fees are computed on it, then the net is lowered by any excess so net + fees fits in `spend` (fees are not
 * recomputed). Base out is priced on net - 1 (pump-swap-sdk `buyQuoteInput`; mainnet events confirm the order).
 */
export const poolBuyExactQuoteIn = (pool: PoolState, spend: bigint, ctx: PoolFeeContext): PoolTrade => {
  assertPool(pool);
  if (spend <= 1n) throw new RangeError('spend must be > 1');
  const fees = poolFees(pool, ctx);
  const totalBps = BigInt(fees.lp) + BigInt(fees.protocol) + BigInt(fees.creator);
  const untrimmed = (spend * 10_000n) / (10_000n + totalBps);
  const over = untrimmed + feeOf(untrimmed, fees.lp) + feeOf(untrimmed, fees.protocol) + feeOf(untrimmed, fees.creator) - spend;
  const quote = over > 0n ? untrimmed - over : untrimmed;
  const input = quote - 1n;
  const eq = effectiveQuoteReserve(pool);
  const base = (pool.baseReserve * input) / (eq + input);
  return buyResult(pool, base, quote, fees, untrimmed);
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
