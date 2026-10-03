// PumpSwap pool quotes (program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA), integer-exact.
// Formulas follow @pump-fun/pump-swap-sdk 1.20.0 `buy.ts`/`sell.ts`/`fees.ts` and pump-public-docs
// NEGATIVE_VIRTUAL_QUOTE_RESERVES.md; checked against mainnet BuyEvent/SellEvent in test/amm/golden.test.ts.
import { type Bps, applyBps } from '../units/index.ts';
import { type CoinFlags, type FeeConfig, type FeeSplit, type Quote, feeOf, marketCap, noQuote, selectFeeTier, unsupportedCoin } from './fees.ts';

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
  /** Coins priced differently (mayhem, Token-2022 transfer fee or hook) are refused. */
  readonly coin: CoinFlags;
  /**
   * The instruction family the trade uses. Prices are the same; only where fees land differs: on the v2 instructions
   * the creator and protocol fees, less the buyback share, stay in the vault and `virtual_quote_reserves` drops by the
   * same amount (measured on mainnet vault balances; see test/amm/golden.test.ts).
   */
  readonly instruction: 'v1' | 'v2';
  /** Buyback share of the protocol fee (`buyback_fee_basis_points`, 5,000 on 2026-10-03), used by v2 instructions. */
  readonly buybackFeeBps: Bps;
}

/** Vault + virtual (signed). The program keeps it >= 0; quotes refuse a pool where it is not > 0. */
export const effectiveQuoteReserve = (pool: PoolState): bigint => pool.quoteVault + pool.virtualQuoteReserves;

const isZero = (f: FeeSplit) => f.lp === 0 && f.protocol === 0 && f.creator === 0;

/**
 * Fee rates for a trade on this pool, as pump-fees `fees_for_quote_mint`: non-canonical pools pay the flat schedule;
 * canonical SOL pools the tier for the pre-trade market cap; canonical exotic pools the exotic schedule (flat if unset).
 */
export const poolFees = (pool: PoolState, ctx: PoolFeeContext): FeeSplit => {
  const { feeConfig } = ctx;
  if (pool.baseReserve <= 0n) throw new RangeError('base reserve must be > 0');
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
  /** Buyback share of the protocol fee (part of it, not extra). */
  readonly buybackFee: bigint;
  /** What the trader pays in (buy) or receives (sell), fees included. */
  readonly userQuote: bigint;
  /** Quote units lost to price impact against the pre-trade spot price (effective quote / base), exact. */
  readonly impact: bigint;
  readonly fees: FeeSplit;
  /**
   * Pool after the trade. The LP fee stays in the vault. On v2 instructions the creator and protocol fees less the
   * buyback share also stay in the vault, offset in `virtualQuoteReserves`, so the effective reserve is the same.
   */
  readonly after: PoolState;
}

const spotValue = (pool: PoolState, base: bigint) => (base * effectiveQuoteReserve(pool)) / pool.baseReserve;

const refuse = (pool: PoolState, ctx: PoolFeeContext): Quote<never> | null =>
  unsupportedCoin(ctx.coin)
  ?? (pool.baseReserve <= 0n || pool.quoteVault <= 0n || effectiveQuoteReserve(pool) <= 0n ? noQuote('no-liquidity', 'pool has no usable reserves') : null);

const charged = (feeBase: bigint, fees: FeeSplit, ctx: PoolFeeContext) => {
  const lpFee = feeOf(feeBase, fees.lp);
  const protocolFee = feeOf(feeBase, fees.protocol);
  const creatorFee = feeOf(feeBase, fees.creator);
  const buybackFee = applyBps(protocolFee, ctx.buybackFeeBps, 'floor');
  const retained = ctx.instruction === 'v2' ? creatorFee + protocolFee - buybackFee : 0n;
  return { lpFee, protocolFee, creatorFee, buybackFee, retained };
};

// Fees default to ceil(quote * bps); exact-quote-in passes the fees it computed before trimming the quote.
const buyTrade = (pool: PoolState, base: bigint, quote: bigint, fees: FeeSplit, ctx: PoolFeeContext, feeBase = quote): Quote<PoolTrade> => {
  const { lpFee, protocolFee, creatorFee, buybackFee, retained } = charged(feeBase, fees, ctx);
  return {
    ok: true,
    trade: {
      base, quote, lpFee, protocolFee, creatorFee, buybackFee, fees,
      userQuote: quote + lpFee + protocolFee + creatorFee,
      impact: quote - spotValue(pool, base),
      after: {
        baseReserve: pool.baseReserve - base,
        quoteVault: pool.quoteVault + quote + lpFee + retained,
        virtualQuoteReserves: pool.virtualQuoteReserves - retained,
      },
    },
  };
};

/** `buy`: exactly `base` out; quote in = ceil(effQuote * base / (baseReserve - base)), fees on top. */
export const poolBuyExactBase = (pool: PoolState, base: bigint, ctx: PoolFeeContext): Quote<PoolTrade> => {
  if (base <= 0n) throw new RangeError('base out must be > 0');
  const no = refuse(pool, ctx);
  if (no) return no;
  if (base >= pool.baseReserve) return noQuote('exceeds-reserves', 'base out must be below the base reserve');
  const den = pool.baseReserve - base;
  const quote = (effectiveQuoteReserve(pool) * base + den - 1n) / den;
  return buyTrade(pool, base, quote, poolFees(pool, ctx), ctx);
};

/**
 * `buy_exact_quote_in`: spend at most `spend`, fees included. Net quote = floor(spend * 10,000 / (10,000 + fee bps));
 * the ceil fees are computed on it, then the net is lowered by any excess so net + fees fits in `spend` (fees are not
 * recomputed). Base out is priced on net - 1 (pump-swap-sdk `buyQuoteInput`; mainnet events confirm the order).
 */
export const poolBuyExactQuoteIn = (pool: PoolState, spend: bigint, ctx: PoolFeeContext): Quote<PoolTrade> => {
  if (spend <= 1n) throw new RangeError('spend must be > 1');
  const no = refuse(pool, ctx);
  if (no) return no;
  const fees = poolFees(pool, ctx);
  const totalBps = BigInt(fees.lp) + BigInt(fees.protocol) + BigInt(fees.creator);
  const untrimmed = (spend * 10_000n) / (10_000n + totalBps);
  const over = untrimmed + feeOf(untrimmed, fees.lp) + feeOf(untrimmed, fees.protocol) + feeOf(untrimmed, fees.creator) - spend;
  const quote = over > 0n ? untrimmed - over : untrimmed;
  const input = quote - 1n;
  const base = (pool.baseReserve * input) / (effectiveQuoteReserve(pool) + input);
  if (base <= 0n) return noQuote('zero-output', 'spend buys no tokens');
  return buyTrade(pool, base, quote, fees, ctx, untrimmed);
};

/** `sell`: exactly `base` in; quote out = floor(effQuote * base / (baseReserve + base)), fees taken from it. */
export const poolSell = (pool: PoolState, base: bigint, ctx: PoolFeeContext): Quote<PoolTrade> => {
  if (base <= 0n) throw new RangeError('base in must be > 0');
  const no = refuse(pool, ctx);
  if (no) return no;
  const fees = poolFees(pool, ctx);
  const quote = (effectiveQuoteReserve(pool) * base) / (pool.baseReserve + base);
  const { lpFee, protocolFee, creatorFee, buybackFee, retained } = charged(quote, fees, ctx);
  if (pool.quoteVault < quote - lpFee) return noQuote('exceeds-reserves', 'sell exceeds the real quote vault');
  const userQuote = quote - lpFee - protocolFee - creatorFee;
  if (userQuote <= 0n) return noQuote('zero-output', 'fees take all sell proceeds');
  return {
    ok: true,
    trade: {
      base, quote, lpFee, protocolFee, creatorFee, buybackFee, fees, userQuote,
      impact: spotValue(pool, base) - quote,
      after: {
        baseReserve: pool.baseReserve + base,
        quoteVault: pool.quoteVault - quote + lpFee + retained,
        virtualQuoteReserves: pool.virtualQuoteReserves - retained,
      },
    },
  };
};
