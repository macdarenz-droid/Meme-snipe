// pump.fun bonding-curve program accounts (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P), hand-written from the pinned
// IDL (pump-public-docs cb188ce, idl/pump.json). test/chain/idl.test.ts checks every field against that IDL.
import { findProgramAddress, addressBytes } from './address.ts';
import type { Address } from './bytes.ts';
import { PUMP_PROGRAM } from './programs.ts';
import { type Decoded, type LayoutValue, array, bool, decodeAnchorAccount, layout, pubkey, u64 } from './schema.ts';

export const GlobalLayout = layout(
  'Global',
  [167, 232, 232, 177, 200, 108, 114, 127],
  [
    ['initialized', bool],
    ['authority', pubkey],
    ['feeRecipient', pubkey],
    ['initialVirtualTokenReserves', u64],
    ['initialVirtualSolReserves', u64],
    ['initialRealTokenReserves', u64],
    ['tokenTotalSupply', u64],
    ['feeBasisPoints', u64],
    ['withdrawAuthority', pubkey],
    ['enableMigrate', bool],
    ['poolMigrationFee', u64],
    ['creatorFeeBasisPoints', u64],
    ['feeRecipients', array(pubkey, 7)],
  ],
  [
    ['setCreatorAuthority', pubkey],
    ['adminSetCreatorAuthority', pubkey],
    ['createV2Enabled', bool],
    ['whitelistPda', pubkey],
    ['reservedFeeRecipient', pubkey],
    ['mayhemModeEnabled', bool],
    ['reservedFeeRecipients', array(pubkey, 7)],
    ['isCashbackEnabled', bool],
    ['buybackFeeRecipients', array(pubkey, 8)],
    ['buybackBasisPoints', u64],
    ['initialVirtualQuoteReserves', u64],
    ['whitelistedQuoteMints', array(pubkey, 1)],
    ['creatorFeeConfigurable', bool],
    ['maxConfigurableCreatorFeeBps', u64],
    ['holderRewardClaimAuthority', pubkey],
    ['isHolderRewardEnabled', bool],
  ],
);

export const BondingCurveLayout = layout(
  'BondingCurve',
  [23, 183, 248, 55, 96, 216, 172, 96],
  [
    ['virtualTokenReserves', u64],
    ['virtualQuoteReserves', u64],
    ['realTokenReserves', u64],
    ['realQuoteReserves', u64],
    ['tokenTotalSupply', u64],
    ['complete', bool],
  ],
  [
    ['creator', pubkey],
    ['isMayhemMode', bool],
    ['isCashbackCoin', bool],
    ['quoteMint', pubkey],
    ['creatorFeeBps', u64],
    ['canEditCreatorFee', bool],
    ['isHolderReward', bool],
  ],
);

export type Global = LayoutValue<typeof GlobalLayout>;
export type BondingCurve = LayoutValue<typeof BondingCurveLayout>;

export const decodeGlobal = (data: Uint8Array): Decoded<Global> => decodeAnchorAccount(GlobalLayout, data);

/**
 * Decodes a `BondingCurve`. Curves written before a field existed are shorter: such fields are absent, never
 * defaulted. Its trading fields are `CurveState` in core/amm.
 */
export const decodeBondingCurve = (data: Uint8Array): Decoded<BondingCurve> => decodeAnchorAccount(BondingCurveLayout, data);

/** The curve account of a mint: PDA(["bonding-curve", mint], pump). */
export const bondingCurveAddress = (mint: Address): Address => findProgramAddress(['bonding-curve', addressBytes(mint)], PUMP_PROGRAM).address;

/** The pump PDA that creates every canonical PumpSwap pool: PDA(["pool-authority", mint], pump). */
export const pumpPoolAuthority = (mint: Address): Address => findProgramAddress(['pool-authority', addressBytes(mint)], PUMP_PROGRAM).address;
