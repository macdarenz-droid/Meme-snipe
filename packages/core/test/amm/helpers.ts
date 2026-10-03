import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeeConfig, FeeSplit } from '../../src/amm/index.ts';
import { bps } from '../../src/units/index.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const readFixture = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;

type RawFees = { lp_fee_bps: string; protocol_fee_bps: string; creator_fee_bps: string };
type RawFeeConfig = { slot: number; flat_fees: RawFees; exotic_flat_fees: RawFees; fee_tiers: { market_cap_lamports_threshold: string; fees: RawFees }[] };

const split = (f: RawFees): FeeSplit => ({ lp: bps(Number(f.lp_fee_bps)), protocol: bps(Number(f.protocol_fee_bps)), creator: bps(Number(f.creator_fee_bps)) });
const toConfig = (raw: RawFeeConfig): FeeConfig => ({
  flatFees: split(raw.flat_fees),
  exoticFlatFees: split(raw.exotic_flat_fees),
  feeTiers: raw.fee_tiers.map((t) => ({ marketCapThreshold: BigInt(t.market_cap_lamports_threshold), fees: split(t.fees) })),
});

const configs = readFixture<{ pump: RawFeeConfig; amm: RawFeeConfig }>('fee-configs.json');
/** Live pump-fees FeeConfig for the bonding curve (8Wf5…) and for PumpSwap (5PHirr…). */
export const PUMP_FEE_CONFIG = toConfig(configs.pump);
export const AMM_FEE_CONFIG = toConfig(configs.amm);
