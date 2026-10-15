// M01 pool state (ARCH M01 `CpPoolState`) with the card Z07 additions (clarifications C-59 and C-82, A08): the per-pool fee
// inputs read from chain at decision time, the base mint's decimals, and the curve's real token reserve. Pure types and
// constants only.
import type { BaseUnits, Bps, Commitment, Lamports, Pubkey, Slot, UnixMs, VenueId } from '@bot/types';

export interface CpPoolState {
  venue: VenueId; poolId: Pubkey; baseMint: Pubkey; quoteMint: Pubkey;
  /** PumpSwap: the base vault balance [EX-09]. Pump curve: `virtual_token_reserves` (the curve prices on it). */
  baseReserve: BaseUnits;
  /** PumpSwap: the quote vault balance. Pump curve: `real_sol_reserves`. */
  quoteReserveReal: Lamports;
  /** i128. PumpSwap: `Pool.virtual_quote_reserves` [EX-09, DA-14]. Pump curve: virtual − real SOL [EX-02]. */
  quoteReserveVirtual: bigint;
  baseMintSupply: BaseUnits; isCanonical: boolean | null; curveComplete: boolean | null;
  asOfSlot: Slot; commitment: Commitment; observedAtMs: UnixMs;
  /** NEW (Z07): false when `coin_creator` (PumpSwap) or the curve creator is the default key, so no creator fee [VF-04]; null when unread. */
  coinCreatorSet: boolean | null;
  /** NEW (Z07, A08): `Pool.creator_fee_bps`; replaces the schedule's creator rate when the global config allows it [VF-04]. 0 for curves. */
  creatorFeeBps: Bps;
  /** NEW (Z07): `is_mayhem_mode`; the tier's market cap then uses a fixed supply of 10^15 [VF-04]. */
  isMayhemMode: boolean;
  /** NEW (Z07): the base mint's decimals (pump mints 6 [DA-12]); null when unknown, and a quote is then refused. */
  baseDecimals: number | null;
  /** NEW (Z07): pump curve `real_token_reserves` (a buy is capped to it); null for PumpSwap. */
  realBaseReserve: BaseUnits | null;
  /** NEW (Z07, C-83): a PumpSwap pool whose base mint is wSOL, read with the roles swapped; its fee is not modelled. */
  swappedMints: boolean;
}

/** The fixed supply a mayhem pool's tier uses [VF-04]. */
export const MAYHEM_SUPPLY = 1_000_000_000_000_000n;
