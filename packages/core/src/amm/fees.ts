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
