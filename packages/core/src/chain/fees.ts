// The pump-fees `FeeConfig` account (owner pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ): one per program, at
// PDA(["fee_config", program id], pump-fees). Pump's FeeConfig is 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt and
// PumpSwap's is 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx. Layout from the pinned IDL (idl/pump_fees.json, cb188ce);
// the copies in idl/pump.json and idl/pump_amm.json are identical (checked in test/chain/idl.test.ts).
import { addressBytes, findProgramAddress } from './address.ts';
import type { Address } from './bytes.ts';
import { PUMP_FEES_PROGRAM } from './programs.ts';
import { type Decoded, type LayoutValue, bpsU64, decodeAnchorAccount, layout, pubkey, struct, u128, u8, vec } from './schema.ts';
import type { Bps } from '../units/index.ts';

export const Fees = struct('Fees', [
  ['lpFeeBps', bpsU64],
  ['protocolFeeBps', bpsU64],
  ['creatorFeeBps', bpsU64],
] as const);

export const FeeTier = struct('FeeTier', [
  ['marketCapLamportsThreshold', u128],
  ['fees', Fees],
] as const);

export const FeeConfigLayout = layout(
  'FeeConfig',
  [143, 52, 146, 187, 219, 123, 76, 155],
  [
    ['bump', u8],
    ['admin', pubkey],
    ['flatFees', Fees],
    ['feeTiers', vec(FeeTier)],
  ],
  [
    ['stableFeeTiers', vec(FeeTier)],
    ['exoticFlatFees', Fees],
  ],
);

export type FeeConfigAccount = LayoutValue<typeof FeeConfigLayout>;

export const decodeFeeConfig = (data: Uint8Array): Decoded<FeeConfigAccount> => decodeAnchorAccount(FeeConfigLayout, data);

export const feeConfigAddress = (program: Address): Address =>
  findProgramAddress(['fee_config', addressBytes(program)], PUMP_FEES_PROGRAM).address;

/** One fee schedule in the shape core/amm `FeeSplit` uses. */
export interface FeeSchedule {
  readonly lp: Bps;
  readonly protocol: Bps;
  readonly creator: Bps;
}

export interface FeeScheduleTier {
  readonly marketCapThreshold: bigint;
  readonly fees: FeeSchedule;
}

/** The decoded config in the shape core/amm `FeeConfig` reads (field names match, so it passes straight in). */
export interface FeeSchedules {
  readonly flatFees: FeeSchedule;
  readonly feeTiers: readonly FeeScheduleTier[];
  /** Absent when the account predates stable tiers (pump-fees layout of 2026-05-19). */
  readonly stableFeeTiers?: readonly FeeScheduleTier[];
  /** Absent when the account predates exotic fees (layout of 2026-09-12). */
  readonly exoticFlatFees?: FeeSchedule;
}

const schedule = (f: { lpFeeBps: Bps; protocolFeeBps: Bps; creatorFeeBps: Bps }): FeeSchedule => ({
  lp: f.lpFeeBps,
  protocol: f.protocolFeeBps,
  creator: f.creatorFeeBps,
});

const tiers = (t: readonly { marketCapLamportsThreshold: bigint; fees: { lpFeeBps: Bps; protocolFeeBps: Bps; creatorFeeBps: Bps } }[]) =>
  t.map((x) => ({ marketCapThreshold: x.marketCapLamportsThreshold, fees: schedule(x.fees) }));

export const feeSchedules = (c: FeeConfigAccount): FeeSchedules => ({
  flatFees: schedule(c.flatFees),
  feeTiers: tiers(c.feeTiers),
  ...(c.stableFeeTiers !== undefined && { stableFeeTiers: tiers(c.stableFeeTiers) }),
  ...(c.exoticFlatFees !== undefined && { exoticFlatFees: schedule(c.exoticFlatFees) }),
});
