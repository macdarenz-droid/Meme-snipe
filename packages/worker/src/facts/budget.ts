// FACTS-1 read budget: what one candidate costs per minute on the free plans, from the readers' call counts and the
// providers' published prices (scheduler/limits.ts, docs/research/data.md §1.2, §7.3). An estimate with its
// assumptions written out, checked by test/facts-readers.test.ts so a change to a reader or a limit shows here.
import { ALCHEMY_FREE, HELIUS_FREE, HELIUS_RPC_CREDITS, RUGCHECK_FREE, GOPLUS_FREE } from '../scheduler/limits.ts';

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
} as const;

/** Helius credits each evaluation spends: accounts (1), holders (largest, accounts, owners: 3), simulation (1). */
export const HELIUS_CALLS_PER_EVALUATION = { accounts: 1, holders: 3, sim: 1 } as const;

export interface CandidateBudget {
  readonly heliusCreditsPerMinute: number;
  readonly heliusCreditsOnce: number;
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
  return {
    helius: Math.floor(f.heliusCredits / c.heliusCreditsPerMinute),
    alchemy: Math.floor(f.alchemyCu / c.alchemyCuPerMinute),
    rugcheck: Math.floor(f.rugcheck / c.rugcheckPerMinute),
    goplus: Math.floor(f.goplus / c.goplusPerMinute),
  };
};
