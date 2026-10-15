// Shared test helpers for the M01 venue tests (card Z07): fee inputs from the recorded fixtures and pool builders.
// No address literals here (lint rule bot/no-program-id-literal); pool and mint ids are plain labels.
import { readFileSync } from 'node:fs';
import type { Bps, Slot, UnixMs } from '@bot/types';
import { ACCOUNTS, MINTS } from '../src/constants.ts';
import type { FeeConfigView, FeeInputs, FeeSplit } from '../src/fees.ts';
import type { CpPoolState } from '../src/pool.ts';

export const root = (path: string): URL => new URL(`../../../${path}`, import.meta.url);
export const readJson = <T>(path: string): T => JSON.parse(readFileSync(root(path), 'utf8')) as T;

type RawFees = { lp_fee_bps: string; protocol_fee_bps: string; creator_fee_bps: string };
type RawConfig = { slot: number; flat_fees: RawFees; exotic_flat_fees: RawFees; fee_tiers: Array<{ market_cap_lamports_threshold: string; fees: RawFees }> };
const split = (f: RawFees): FeeSplit => ({ lpBps: Number(f.lp_fee_bps), protocolBps: Number(f.protocol_fee_bps), creatorBps: Number(f.creator_fee_bps) });
const view = (raw: RawConfig, account: string): FeeConfigView => ({
  account, asOfSlot: BigInt(raw.slot) as Slot, configHash: `core2:${account}`, flat: split(raw.flat_fees), exoticFlat: split(raw.exotic_flat_fees),
  tiers: raw.fee_tiers.map((t) => ({ thresholdLamports: BigInt(t.market_cap_lamports_threshold), fees: split(t.fees) })),
});
const core2 = readJson<{ pump: RawConfig; amm: RawConfig }>('fixtures/core2/fee-configs.json');
/** The fee configs the CORE-2 goldens were captured against (fixtures/core2/README.md). */
export const CORE2_INPUTS: FeeInputs = { curve: view(core2.pump, ACCOUNTS.feeConfigCurve), pumpswap: view(core2.amm, ACCOUNTS.feeConfigPumpSwap), creatorFeeConfigurable: true };

export const split3 = (lp: number, protocol: number, creator: number): FeeSplit => ({ lpBps: lp as Bps, protocolBps: protocol as Bps, creatorBps: creator as Bps });
export const SOL = 1_000_000_000n;

/** A canonical wSOL PumpSwap pool; override any field. */
export function pool(over: Partial<CpPoolState> = {}): CpPoolState {
  return {
    venue: 'pumpswap', poolId: 'pool-1', baseMint: 'mint-1', quoteMint: MINTS.wsol,
    baseReserve: 200_000_000_000_000n, quoteReserveReal: 60n * SOL, quoteReserveVirtual: 17_584_326_063n,
    baseMintSupply: 1_000_000_000_000_000n, isCanonical: true, curveComplete: null,
    asOfSlot: 1_000n as Slot, commitment: 'confirmed', observedAtMs: 0 as UnixMs,
    coinCreatorSet: true, creatorFeeBps: 0, isMayhemMode: false, baseDecimals: 6, realBaseReserve: null,
    ...over,
  };
}

/** A pool whose market cap (effective quote × supply / base, lamports) is exactly `mcap`: base reserve = supply. */
export function poolAtMarketCap(mcap: bigint, over: Partial<CpPoolState> = {}): CpPoolState {
  const supply = 1_000_000_000_000_000n;
  return pool({ baseReserve: supply, baseMintSupply: supply, quoteReserveReal: mcap, quoteReserveVirtual: 0n, ...over });
}
