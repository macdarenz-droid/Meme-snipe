// The pump-fees `FeeConfig` account (owner pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ): one per program, at
// PDA(["fee_config", program id], pump-fees). Pump's FeeConfig is 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt and
// PumpSwap's is 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx. Layout from the pinned IDL (idl/pump_fees.json, cb188ce);
// the copies in idl/pump.json and idl/pump_amm.json are identical (checked in test/chain/idl.test.ts).
import { addressBytes, findProgramAddress } from './address.ts';
import { type Address, DecodeError } from './bytes.ts';
import type { FeeConfig, FeeSplit, FeeTier } from '../amm/fees.ts';
import { PUMP_FEES_PROGRAM } from './programs.ts';
import { type Decoded, type LayoutValue, bpsU64, decodeAnchorAccount, layout, pubkey, struct, u128, u8, vec } from './schema.ts';
import type { Bps } from '../units/index.ts';

export const Fees = struct('Fees', [
  ['lpFeeBps', bpsU64],
  ['protocolFeeBps', bpsU64],
  ['creatorFeeBps', bpsU64],
] as const);

export const FeeTierStruct = struct('FeeTier', [
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
    ['feeTiers', vec(FeeTierStruct)],
  ],
  [
    ['stableFeeTiers', vec(FeeTierStruct)],
    ['exoticFlatFees', Fees],
  ],
);

export type FeeConfigAccount = LayoutValue<typeof FeeConfigLayout>;

export const decodeFeeConfig = (data: Uint8Array): Decoded<FeeConfigAccount> => decodeAnchorAccount(FeeConfigLayout, data);

export const feeConfigAddress = (program: Address): Address =>
  findProgramAddress(['fee_config', addressBytes(program)], PUMP_FEES_PROGRAM).address;

/** The decoded config as core/amm's `FeeConfig`, plus the stable-quote tiers that module does not model yet. */
export type FeeSchedules = FeeConfig & { readonly stableFeeTiers: readonly FeeTier[] };

const schedule = (f: { lpFeeBps: Bps; protocolFeeBps: Bps; creatorFeeBps: Bps }): FeeSplit => ({
  lp: f.lpFeeBps,
  protocol: f.protocolFeeBps,
  creator: f.creatorFeeBps,
});

const tiers = (t: readonly { marketCapLamportsThreshold: bigint; fees: { lpFeeBps: Bps; protocolFeeBps: Bps; creatorFeeBps: Bps } }[]): FeeTier[] =>
  t.map((x) => ({ marketCapThreshold: x.marketCapLamportsThreshold, fees: schedule(x.fees) }));

/**
 * The fee schedules core/amm quotes with. A config written before the stable tiers (2026-05-19 layout) or the exotic
 * fees (2026-09-12 layout) existed is refused rather than filled in: the current programs read both.
 */
export const feeSchedules = (c: FeeConfigAccount): FeeSchedules => {
  if (c.stableFeeTiers === undefined || c.exoticFlatFees === undefined) {
    throw new DecodeError('FeeConfig predates stable tiers or exotic fees; the current fee schedule cannot be read from it');
  }
  return { flatFees: schedule(c.flatFees), feeTiers: tiers(c.feeTiers), stableFeeTiers: tiers(c.stableFeeTiers), exoticFlatFees: schedule(c.exoticFlatFees) };
};
