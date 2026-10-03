// Fee schedule selection for pump.fun venues, mirroring pump-fees `calculate_fee_tier` and the per-component
// ceil rounding used by both pump programs. Rates always come from the caller (decoded FeeConfig), never from here.
import { type Bps, applyBps } from '../units/index.ts';

/** One fee schedule as stored in the pump-fees `Fees` struct. */
export interface FeeSplit {
  readonly lp: Bps;
  readonly protocol: Bps;
  readonly creator: Bps;
}

/** A `FeeTier` from the pump-fees `FeeConfig`: the schedule applies from this market cap (quote base units) up. */
export interface FeeTier {
  readonly marketCapThreshold: bigint;
  readonly fees: FeeSplit;
}

/**
 * The tier for a market cap, as pump-fees `calculate_fee_tier`: below the first threshold the first tier,
 * otherwise the last tier whose threshold is <= the market cap. Tiers must be in ascending threshold order.
 */
export const selectFeeTier = (tiers: readonly FeeTier[], marketCap: bigint): FeeSplit => {
  const first = tiers[0];
  if (!first) throw new RangeError('fee tiers cannot be empty');
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i]!.marketCapThreshold < tiers[i - 1]!.marketCapThreshold) throw new RangeError('fee tiers must be in ascending threshold order');
  }
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (marketCap >= tiers[i]!.marketCapThreshold) return tiers[i]!.fees;
  }
  return first.fees;
};

/** A fee component as the programs charge it: ceil(amount * bps / 10,000). */
export const feeOf = (amount: bigint, rate: Bps): bigint => applyBps(amount, rate, 'ceil');

/** Market cap in quote base units: quoteReserve * supply / baseReserve, floored (pump `bonding_curve_market_cap`, pump-amm `Pool::market_cap`). */
export const marketCap = (quoteReserve: bigint, baseReserve: bigint, supply: bigint): bigint => {
  if (baseReserve <= 0n) throw new RangeError('base reserve must be > 0');
  return (quoteReserve * supply) / baseReserve;
};

/** The pump-fees `FeeConfig` fields the quote path needs. */
export interface FeeConfig {
  /** Charged on non-canonical PumpSwap pools. */
  readonly flatFees: FeeSplit;
  /** Market-cap tiers for SOL-quoted canonical pools and curves. */
  readonly feeTiers: readonly FeeTier[];
  /** Canonical pools quoted in a mint that is neither SOL nor a listed stable; all-zero means "use flatFees". */
  readonly exoticFlatFees: FeeSplit;
}

/** Why a state cannot be quoted. These are market facts, not caller mistakes: the answer is "no trade". */
export type NoQuoteReason =
  /** The bonding curve has completed; trade on the graduation pool. */
  | 'curve-complete'
  /** No usable reserves (an empty pool, or effective quote reserve <= 0). */
  | 'no-liquidity'
  /** The trade needs more than the reserves hold. */
  | 'exceeds-reserves'
  /** The trade would deliver nothing (fees take all proceeds, or the spend buys no tokens). */
  | 'zero-output'
  /** A coin this module does not price as normal: mayhem mode, or a Token-2022 transfer fee or transfer hook. */
  | 'unsupported-coin'
  /** Protocol parameters (pump Global) were not read. */
  | 'missing-params'
  /** Protocol parameters were read too long ago to trust. */
  | 'stale-params';

export type Quote<T> =
  | { readonly ok: true; readonly trade: T }
  | { readonly ok: false; readonly reason: NoQuoteReason; readonly detail: string };

export const noQuote = (reason: NoQuoteReason, detail: string): Quote<never> => ({ ok: false, reason, detail });

/**
 * Coin properties that change pricing in ways these quotes do not model. Read them from the curve or pool account
 * (`is_mayhem_mode`) and the mint's Token-2022 extensions. Any of them true refuses the quote.
 */
export interface CoinFlags {
  readonly mayhemMode: boolean;
  readonly transferFee: boolean;
  readonly transferHook: boolean;
}

export const unsupportedCoin = (coin: CoinFlags): Quote<never> | null =>
  coin.mayhemMode ? noQuote('unsupported-coin', 'mayhem-mode coin')
    : coin.transferFee ? noQuote('unsupported-coin', 'Token-2022 transfer fee')
      : coin.transferHook ? noQuote('unsupported-coin', 'Token-2022 transfer hook')
        : null;
