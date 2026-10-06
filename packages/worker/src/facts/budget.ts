// FACTS-1 read budget: what one candidate costs per minute on the free plans, from the readers' call counts and the
// providers' published prices (scheduler/limits.ts, docs/research/data.md §1.2, §7.3). An estimate with its
// assumptions written out, checked by test/facts-readers.test.ts so a change to a reader or a limit shows here.
import { ALCHEMY_FREE, HELIUS_FREE, HELIUS_GPA_CREDITS, HELIUS_RPC_CREDITS, RUGCHECK_FREE, GOPLUS_FREE } from '../scheduler/limits.ts';
import { HOLDER_SCANS_PER_DAY } from './readers.ts';
import { RUG_CHECK_CONFIG } from '../../../core/src/config/rugs.ts';
import { DEPLOYER_CHECK_CREDITS_PER_DAY } from './deployer-checks.ts';

/** Minutes in a 30-day month: the plans' budgets are monthly. */
export const MONTH_MINUTES = 30 * 24 * 60;

/** Assumptions behind the estimate. Change them here, not in the prose. */
export const ASSUMPTIONS = {
  /** Full gate evaluations per candidate per minute (expensive reads only after the free gates pass). */
  evaluationsPerMinute: 1,
  /** Bytes per pool log notification (data.md §7.3: 1.84 KB measured). */
  logBytes: 1_840,
  /** Swaps a minute on a busy candidate pool, 60 to 120 minutes after migration (an upper planning figure). */
  tradesPerMinute: 60,
  /** One-off insider lookups per candidate: signature pages of the mint, creation-window and first-buyer
   * transactions, and per first buyer up to 3 signature pages plus its oldest transaction. Measured on the recorded
   * coin (fixtures/facts.json meta.calls) and bounded by the readers' page caps. */
  insiderCallsOnce: 125,
  /** Owner-program batches (100 owners each) per complete holder scan: one for a young coin's off-curve owners. */
  ownerBatchesPerScan: 1,
} as const;

export { HELIUS_GPA_CREDITS };

/**
 * Helius credits of one complete holder scan (`readHoldersAll`): the mint read, one getProgramAccounts and the owner
 * programs. A refused mint-only scan's indexed fallback is one more getProgramAccounts, and takes a scan of its own
 * from the daily cap.
 */
export const holderScanCredits = (a: typeof ASSUMPTIONS = ASSUMPTIONS): { readonly scan: number; readonly fallback: number } => ({
  scan: HELIUS_RPC_CREDITS + HELIUS_GPA_CREDITS + a.ownerBatchesPerScan * HELIUS_RPC_CREDITS,
  fallback: HELIUS_GPA_CREDITS,
});

/** The most the complete holder scans can spend in a UTC day: every scan of the cap at the dearer of the two kinds. */
export const holderScanCreditsPerDay = (scansPerDay: number = HOLDER_SCANS_PER_DAY, a: typeof ASSUMPTIONS = ASSUMPTIONS): number => {
  const c = holderScanCredits(a);
  return scansPerDay * Math.max(c.scan, c.fallback);
};

/** Helius credits each evaluation spends: accounts (1), holders (largest, accounts, owners: 3), simulation (1). */
export const HELIUS_CALLS_PER_EVALUATION = { accounts: 1, holders: 3, sim: 1 } as const;

export interface CandidateBudget {
  readonly heliusCreditsPerMinute: number;
  readonly heliusCreditsOnce: number;
  /** RUG-1c: the first deployer check of a candidate's creator, at most the per-candidate cap (later ones come from the
   * per-creator cache, and all of them from the daily cap, `DEPLOYER_CHECK_CREDITS_PER_DAY`). */
  readonly deployerCheckCreditsOnce: number;
  readonly alchemyCuPerMinute: number;
  readonly rugcheckPerMinute: number;
  readonly goplusPerMinute: number;
  readonly jupiterPerMinute: number;
}

export const perCandidate = (a: typeof ASSUMPTIONS = ASSUMPTIONS): CandidateBudget => {
  const calls = HELIUS_CALLS_PER_EVALUATION.accounts + HELIUS_CALLS_PER_EVALUATION.holders + HELIUS_CALLS_PER_EVALUATION.sim;
  return {
    heliusCreditsPerMinute: calls * HELIUS_RPC_CREDITS * a.evaluationsPerMinute,
    heliusCreditsOnce: a.insiderCallsOnce * HELIUS_RPC_CREDITS,
    deployerCheckCreditsOnce: RUG_CHECK_CONFIG.creditCapPerCandidate,
    // Alchemy bills WebSocket traffic at 0.0002 CU a byte (data.md §4): the confirmed pool logs watch for candles.
    alchemyCuPerMinute: a.tradesPerMinute * a.logBytes * 0.0002,
    rugcheckPerMinute: a.evaluationsPerMinute,
    goplusPerMinute: a.evaluationsPerMinute,
    jupiterPerMinute: a.evaluationsPerMinute,
  };
};

/** What the free plans allow a minute, averaged over the month, below the 70% halt (§6.2), or by rate for keyless APIs. */
export const freePlanPerMinute = () => ({
  heliusCredits: (HELIUS_FREE.budget!.monthlyCredits * HELIUS_FREE.budget!.haltShare) / MONTH_MINUTES,
  alchemyCu: (ALCHEMY_FREE.budget!.monthlyCredits * ALCHEMY_FREE.budget!.haltShare) / MONTH_MINUTES,
  rugcheck: (60_000 / RUGCHECK_FREE.window.windowMs) * RUGCHECK_FREE.window.limit,
  goplus: (60_000 / GOPLUS_FREE.window.windowMs) * GOPLUS_FREE.window.limit,
});

/**
 * Candidates the free plans carry at once, evaluated at the assumed cadence for the whole month, before anything else
 * spends Helius credits. Every other Helius user (position feed, creates stream, graduations) comes out of the same
 * budget, so the real number is lower; the worker's scheduler enforces the halt either way.
 */
export const candidateCapacity = (a: typeof ASSUMPTIONS = ASSUMPTIONS): { readonly helius: number; readonly alchemy: number; readonly rugcheck: number; readonly goplus: number } => {
  const c = perCandidate(a);
  const f = freePlanPerMinute();
  // The complete holder scans and the deployer checks come off the top: each daily cap's worst case, spread over the day.
  const helius = f.heliusCredits - (holderScanCreditsPerDay(HOLDER_SCANS_PER_DAY, a) + DEPLOYER_CHECK_CREDITS_PER_DAY) / (24 * 60);
  return {
    helius: Math.floor(helius / c.heliusCreditsPerMinute),
    alchemy: Math.floor(f.alchemyCu / c.alchemyCuPerMinute),
    rugcheck: Math.floor(f.rugcheck / c.rugcheckPerMinute),
    goplus: Math.floor(f.goplus / c.goplusPerMinute),
  };
};

/**
 * The planned worst case for Helius in one day, against what the halt share allows a day: both daily caps spent in
 * full, plus the candidates the plan carries evaluated every minute all day. The scheduler halts at the share anyway;
 * this shows the plan stays under it (WORKER-1c review).
 */
export const plannedHeliusPerDay = (a: typeof ASSUMPTIONS = ASSUMPTIONS): { readonly planned: number; readonly allowed: number } => ({
  planned: holderScanCreditsPerDay(HOLDER_SCANS_PER_DAY, a) + DEPLOYER_CHECK_CREDITS_PER_DAY + candidateCapacity(a).helius * perCandidate(a).heliusCreditsPerMinute * 24 * 60,
  allowed: freePlanPerMinute().heliusCredits * 24 * 60,
});
