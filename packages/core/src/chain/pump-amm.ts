// PumpSwap program accounts (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA), hand-written from the pinned IDL
// (pump-public-docs cb188ce, idl/pump_amm.json). test/chain/idl.test.ts checks every field against that IDL.
import { addressBytes, findProgramAddress } from './address.ts';
import type { Address } from './bytes.ts';
import { pumpPoolAuthority } from './pump.ts';
import { PUMP_AMM_PROGRAM } from './programs.ts';
import { type Decoded, type LayoutValue, array, bool, decodeAnchorAccount, i128, layout, pubkey, u16, u64, u8 } from './schema.ts';

export const PoolLayout = layout(
  'Pool',
  [241, 154, 109, 4, 17, 177, 109, 188],
  [
    ['poolBump', u8],
    ['index', u16],
    ['creator', pubkey],
    ['baseMint', pubkey],
    ['quoteMint', pubkey],
    ['lpMint', pubkey],
    ['poolBaseTokenAccount', pubkey],
    ['poolQuoteTokenAccount', pubkey],
    ['lpSupply', u64],
  ],
  [
    ['coinCreator', pubkey],
    ['isMayhemMode', bool],
    ['isCashbackCoin', bool],
    ['virtualQuoteReserves', i128],
    ['creatorFeeBps', u64],
    ['canEditCreatorFee', bool],
    ['isHolderReward', bool],
  ],
);

export type Pool = LayoutValue<typeof PoolLayout>;

export const GlobalConfigLayout = layout(
  'GlobalConfig',
  [149, 8, 156, 202, 160, 252, 176, 217],
  [
    ['admin', pubkey],
    ['lpFeeBasisPoints', u64],
    ['protocolFeeBasisPoints', u64],
    ['disableFlags', u8],
    ['protocolFeeRecipients', array(pubkey, 8)],
  ],
  [
    ['coinCreatorFeeBasisPoints', u64],
    ['adminSetCoinCreatorAuthority', pubkey],
    ['whitelistPda', pubkey],
    ['reservedFeeRecipient', pubkey],
    ['mayhemModeEnabled', bool],
    ['reservedFeeRecipients', array(pubkey, 7)],
    ['isCashbackEnabled', bool],
    ['buybackFeeRecipients', array(pubkey, 8)],
    ['buybackBasisPoints', u64],
    ['boostAuthority', pubkey],
    ['boostEnabled', bool],
    ['creatorFeeConfigurable', bool],
    ['maxConfigurableCreatorFeeBps', u64],
  ],
);
export type GlobalConfig = LayoutValue<typeof GlobalConfigLayout>;

/** PumpSwap's single `GlobalConfig` (ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw): fee recipients, mayhem and boost switches, boost authority. */
export const decodeGlobalConfig = (data: Uint8Array): Decoded<GlobalConfig> => decodeAnchorAccount(GlobalConfigLayout, data);

/**
 * Decodes a PumpSwap `Pool`. `virtualQuoteReserves` is a signed i128 and may be negative from 2026-09-30; pools
 * written before the field existed lack it, and pump's NEGATIVE_VIRTUAL_QUOTE_RESERVES.md says to read that as 0
 * (see `poolVirtualQuoteReserves`).
 */
export const decodePool = (data: Uint8Array): Decoded<Pool> => decodeAnchorAccount(PoolLayout, data);

/** `virtual_quote_reserves` with pump's documented rule for pools that predate it: absent means 0. */
export const poolVirtualQuoteReserves = (pool: Pool): bigint => pool.virtualQuoteReserves ?? 0n;

/** The pool account address: PDA(["pool", index (u16 LE), creator, base_mint, quote_mint], pump_amm). */
export const poolAddress = (index: number, creator: Address, baseMint: Address, quoteMint: Address): Address => {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) throw new RangeError(`pool index must be a u16, got ${index}`);
  return findProgramAddress(
    ['pool', Uint8Array.of(index & 0xff, index >> 8), addressBytes(creator), addressBytes(baseMint), addressBytes(quoteMint)],
    PUMP_AMM_PROGRAM,
  ).address;
};

/**
 * A canonical pool is the one pump's `migrate` created for a graduated curve: `index == 0` and
 * `creator == PDA(["pool-authority", base_mint], pump)` (docs/research/safety.md 2.1; pump FEE_PROGRAM_README).
 * Only canonical pools have burned LP. Pass the account's own address to also prove the account sits at its PDA.
 */
export const isCanonicalPool = (pool: Pool, poolAccount?: Address): boolean => {
  if (pool.index !== 0) return false;
  if (pool.creator !== pumpPoolAuthority(pool.baseMint)) return false;
  return poolAccount === undefined || poolAddress(pool.index, pool.creator, pool.baseMint, pool.quoteMint) === poolAccount;
};
