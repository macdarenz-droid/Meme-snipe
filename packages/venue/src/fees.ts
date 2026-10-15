// A-M01-02 fee-schedule selection (pure). The decoded pump-fees `FeeConfig` and the PumpSwap `GlobalConfig` come in as
// `FeeInputs`; the rules are SPEC-A A-M01-02 logic 3-5 as settled on 2026-10-07 [VF-04] (supervisor ruling Z07-1):
// - market cap (lamports) = floor(effectiveQuote × supply / baseReserve), effectiveQuote = vault + virtual, supply the
//   mint supply or 10^15 on a mayhem pool;
// - a tier applies when the market cap is ≥ its threshold; below the first threshold the first tier applies;
// - the creator rate is 0 when `coin_creator` is the default key, and `Pool.creator_fee_bps` replaces it when the global
//   config allows it and it is > 0 (A08: read per pool from chain, so a fee from the tier table alone is wrong);
// - a quote mint other than SOL or USDC pays `exotic_flat_fees`, or `flat_fees` while every exotic rate is 0.
// Reference (ruling Z07-6: read only, never run or vendored), @pump-fun/pump-swap-sdk 1.20.0 tarball (npm sha256
// c558b4fb…a7a9f1), `src/sdk/`: `fees.ts:49` computeFeesBps (per-pool creator rate replaces the schedule's at :105),
// `fees.ts:125` feesForQuoteMint (non-pump pool → flat; SOL-like → tiers; USDC → stable tiers; else exotic, flat while
// exotic is all zero), `fees.ts:159` calculateFeeTier, `util.ts:40` poolMarketCap (mayhem supply `util.ts:37`).
// The SDK's SOL-like set also holds the zero key and the Token-2022 native mint; orientation (A-M01-04) admits only
// wSOL-quoted pools, so here any other non-USDC mint is exotic. The CORE-2 goldens (fixtures/core2) are the oracle.
// Conservative boundary rule (ARCH M01 failure table, ruling Z07-2): a market cap exactly at a threshold, or a trade
// whose post-trade market cap falls in another tier, is charged the dearer schedule.
import type { Bps, FeeSchedule, Lamports, Pubkey, Result, Slot } from '@bot/types';
import { MINTS } from './constants.ts';
import { MAYHEM_SUPPLY, type CpPoolState } from './pool.ts';

export interface FeeSplit { lpBps: Bps; protocolBps: Bps; creatorBps: Bps }
export interface FeeTierView { thresholdLamports: bigint; fees: FeeSplit }

/** A decoded pump-fees `FeeConfig` with where and when it was read. */
export interface FeeConfigView {
  account: Pubkey; asOfSlot: Slot; configHash: string;
  /** `fee_tiers`, as decoded (sorted and checked by `checkTiers`). */
  tiers: readonly FeeTierView[];
  flat: FeeSplit;
  exoticFlat: FeeSplit;
}

/** Everything the fee rules read besides the pool: one snapshot of the venue config cache. */
export interface FeeInputs {
  curve: FeeConfigView | null;
  pumpswap: FeeConfigView | null;
  /** PumpSwap `GlobalConfig.creator_fee_configurable`; null when the global config is unread. */
  creatorFeeConfigurable: boolean | null;
}

export type FeeError = { code: 'E_FEE_UNKNOWN'; detail: string };
const unknownFee = (detail: string): { ok: false; error: FeeError } => ({ ok: false, error: { code: 'E_FEE_UNKNOWN', detail } });

export const totalBps = (f: FeeSplit): Bps => f.lpBps + f.protocolBps + f.creatorBps;
const sameSplit = (a: FeeSplit, b: FeeSplit): boolean => a.lpBps === b.lpBps && a.protocolBps === b.protocolBps && a.creatorBps === b.creatorBps;

/**
 * Logic edge 5: tiers sorted by threshold ascending; equal thresholds with the same fees collapse to one, with
 * different fees mean the layout was misread (`E_FEE_UNKNOWN`). An empty tier list is unknown too.
 */
export function checkTiers(tiers: readonly FeeTierView[]): Result<FeeTierView[], FeeError> {
  const sorted = [...tiers].sort((a, b) => (a.thresholdLamports < b.thresholdLamports ? -1 : a.thresholdLamports > b.thresholdLamports ? 1 : 0));
  const out: FeeTierView[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && last.thresholdLamports === t.thresholdLamports) {
      if (!sameSplit(last.fees, t.fees)) return unknownFee('two tiers share a threshold with different fees');
      continue;
    }
    out.push(t);
  }
  if (out.length === 0) return unknownFee('no fee tiers');
  return { ok: true, value: out };
}

/** The chain's tier for a market cap: the last tier whose threshold is ≤ it, else the first [VF-04]. */
export function chainTierIndex(tiers: readonly FeeTierView[], marketCap: bigint): number {
  for (let i = tiers.length - 1; i > 0; i--) if (marketCap >= (tiers[i] as FeeTierView).thresholdLamports) return i;
  return 0;
}

/**
 * The tiers the conservative rule considers at one market cap: the chain's tier, and the tier below it when the market
 * cap sits exactly on the chain tier's threshold ("a pool exactly at a threshold": the dearer of the two adjacent tiers).
 */
export function tierIndicesAt(tiers: readonly FeeTierView[], marketCap: bigint): number[] {
  const i = chainTierIndex(tiers, marketCap);
  return i > 0 && marketCap === (tiers[i] as FeeTierView).thresholdLamports ? [i, i - 1] : [i];
}

/**
 * Market cap in lamports at an effective quote and base reserve [EX-07, VF-04]: floor(quote × supply / base), supply
 * 10^15 on a mayhem pool. The caller guarantees base > 0 and quote ≥ 0.
 */
export function marketCapAt(p: CpPoolState, effectiveQuote: bigint, baseReserve: bigint): Lamports {
  return (effectiveQuote * (p.isMayhemMode ? MAYHEM_SUPPLY : p.baseMintSupply)) / baseReserve;
}

/** The pool's pre-trade market cap; null when the base reserve is 0 or the effective quote negative. */
export function marketCapOf(p: CpPoolState): Lamports | null {
  const q = p.quoteReserveReal + p.quoteReserveVirtual;
  return p.baseReserve <= 0n || q < 0n ? null : marketCapAt(p, q, p.baseReserve);
}

/**
 * Which schedule family a pool pays, the config that holds it, and the creator rule: `creator` is the fixed creator
 * rate (0 with no coin creator, the per-pool rate when the global config allows it), or null to keep each schedule's.
 */
export interface FeeFamily { cfg: FeeConfigView; tiers: FeeTierView[] | null; flat: FeeSplit; creator: Bps | null }

/** Every reason a pool's fee cannot be known is decided here, before any market cap is looked at. */
export function feeFamily(p: CpPoolState, inputs: FeeInputs): Result<FeeFamily, FeeError> {
  let cfg: FeeConfigView;
  let tiers: FeeTierView[] | null = null;
  let flat: FeeSplit;
  if (p.venue === 'pump_curve') {
    if (inputs.curve === null) return unknownFee('curve fee config not read');
    const t = checkTiers(inputs.curve.tiers);
    if (!t.ok) return t;
    cfg = inputs.curve;
    tiers = t.value;
    flat = cfg.flat;
  } else {
    if (p.venue !== 'pumpswap') return unknownFee(`no fee rules for ${p.venue} until A-M01-06`);
    if (inputs.pumpswap === null) return unknownFee('PumpSwap fee config not read');
    if (p.isCanonical === null) return unknownFee('canonicality unknown');
    if (p.swappedMints) return unknownFee('fees on a pool with swapped mints are charged on the program sides, not modelled (C-83)');
    cfg = inputs.pumpswap;
    flat = cfg.flat;                                                                  // non-canonical [EX-08]
    if (p.isCanonical && p.quoteMint === MINTS.wsol) {
      const t = checkTiers(cfg.tiers);
      if (!t.ok) return t;
      tiers = t.value;
    } else if (p.isCanonical) {
      if (p.quoteMint === MINTS.usdc) return unknownFee('USDC-quoted pools use stable tiers, not modelled');   // [EX-07]
      if (totalBps(cfg.exoticFlat) !== 0) flat = cfg.exoticFlat;
    }
  }
  // The creator rate [VF-04]: none without a coin creator; the per-pool rate when the global config allows it.
  let creator: Bps | null = null;
  if (p.coinCreatorSet === false) creator = 0;
  else if (p.venue === 'pumpswap' && p.creatorFeeBps > 0) {
    if (inputs.creatorFeeConfigurable === null) return unknownFee('pool sets its own creator fee and the global config is not read');
    if (inputs.creatorFeeConfigurable) creator = p.creatorFeeBps;
  }
  return { ok: true, value: { cfg, tiers, flat, creator } };
}

/**
 * The distinct fee splits the conservative rule considers at `marketCaps` (pre-trade, and post-trade when the caller
 * knows it), with the creator rule applied. Order: the chain's pre-trade split first.
 */
export function splitsAt(fam: FeeFamily, marketCaps: readonly bigint[]): FeeSplit[] {
  const { tiers } = fam;
  const schedules = tiers === null ? [fam.flat] : [...new Set(marketCaps.flatMap((m) => tierIndicesAt(tiers, m)))].map((i) => (tiers[i] as FeeTierView).fees);
  const splits: FeeSplit[] = [];
  for (const s of schedules) {
    const split = { lpBps: s.lpBps, protocolBps: s.protocolBps, creatorBps: fam.creator ?? s.creatorBps };
    if (!splits.some((x) => sameSplit(x, split))) splits.push(split);
  }
  return splits;
}

/** `feeFamily` then `splitsAt`. */
export function candidateSplits(p: CpPoolState, inputs: FeeInputs, marketCaps: readonly bigint[]): Result<{ splits: FeeSplit[]; cfg: FeeConfigView }, FeeError> {
  const fam = feeFamily(p, inputs);
  return fam.ok ? { ok: true, value: { splits: splitsAt(fam.value, marketCaps), cfg: fam.value.cfg } } : fam;
}

/** Both pump venues add buy fees on top of the quote input and take sell fees from the gross output [EX-05, VF-04]. */
export const FEE_ON_BUY = 'added_on_top' as const;

export function toSchedule(split: FeeSplit, cfg: FeeConfigView): FeeSchedule {
  return { ...split, totalBps: totalBps(split), feeOnBuy: FEE_ON_BUY, sourceAccount: cfg.account, asOfSlot: cfg.asOfSlot, configHash: cfg.configHash };
}

/** The dearer of several splits by total (the first on a tie). */
export function dearest(splits: readonly FeeSplit[]): FeeSplit {
  return splits.reduce((a, b) => (totalBps(b) > totalBps(a) ? b : a));
}

/**
 * `feeFor` without the staleness check (the cache adds it): the schedule at the pre-trade market cap, the dearer
 * adjacent tier when the market cap is exactly on a threshold.
 */
export function feeScheduleFor(p: CpPoolState, inputs: FeeInputs): Result<FeeSchedule, FeeError> {
  const mcap = marketCapOf(p);
  if (mcap === null) return unknownFee('market cap undefined (zero base reserve or negative effective quote)');
  const c = candidateSplits(p, inputs, [mcap]);
  if (!c.ok) return c;
  return { ok: true, value: toSchedule(dearest(c.value.splits), c.value.cfg) };
}
