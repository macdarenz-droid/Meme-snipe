import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FeeConfig, type FeeSplit, type Quote, freshGlobal } from '../../src/amm/index.ts';
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

/** Unwraps a quote that must succeed. */
export const ok = <T>(q: Quote<T>): T => {
  if (!q.ok) throw new Error(`expected a quote, got ${q.reason}: ${q.detail}`);
  return q.trade;
};
/** Normal coin: no mayhem mode, no Token-2022 transfer fee or hook. */
export const NORMAL_COIN = { mayhemMode: false, transferFee: false, transferHook: false } as const;

const g = readFixture<Record<string, string>>('pump-global.json');
/** pump Global launch parameters as read on chain (fixture, with its source slot). */
export const PUMP_GLOBAL = {
  initialVirtualTokenReserves: BigInt(g['initialVirtualTokenReserves']!),
  initialVirtualSolReserves: BigInt(g['initialVirtualSolReserves']!),
  initialRealTokenReserves: BigInt(g['initialRealTokenReserves']!),
  tokenTotalSupply: BigInt(g['tokenTotalSupply']!),
  poolMigrationFee: BigInt(g['poolMigrationFee']!),
};
export const PUMP_GLOBAL_SLOT = BigInt(g['readAtSlot']!);
/** The fixture Global after `freshGlobal`, as quotes require. */
export const CHECKED_GLOBAL = ok(freshGlobal({ value: PUMP_GLOBAL, readAtSlot: PUMP_GLOBAL_SLOT }, PUMP_GLOBAL_SLOT, 0n));
