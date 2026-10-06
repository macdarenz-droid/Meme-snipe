// SEED-1 at worker start (supervisor rulings 2026-10-04): a first start seeds the deployer index over the look-back by
// RPC up to the live creates watch's first slot; a restart fills only the downtime, from the first slot after the saved
// state. Day releases are not read yet (none are downloaded on the server), so their range is RPC's or a gap.
import { DEFAULT_HELIUS_PLAN, HELIUS_PLANS, type SchedulerSpec, type Timers } from '../scheduler/index.ts';
import { SIM_READS_PER_HOUR } from './sim-read.ts';
import { DEPLOYER_CHECK_CREDITS_PER_DAY } from '../facts/deployer-checks.ts';
import { holderScanCreditsPerDay } from '../facts/budget.ts';
import { buildSeed } from '../seed/seed.ts';
import type { SeedRpc } from '../seed/rpc.ts';
import type { DailyBudget } from '../persist/index.ts';
import type { SeedRequest, SeedResult } from './worker.ts';

/** The share of the plan's month one seed or fill may spend, so a start never starves the live feeds. */
export const SEED_MONTH_SHARE = 0.15;
/** HELIUS-PLAN: credits one seed or fill may spend on a plan: SEED_MONTH_SHARE of its month (150,000 Free, 1,500,000 Developer). */
export const seedCreditCap = (plan: SchedulerSpec): number => Math.floor(plan.budget!.monthlyCredits * SEED_MONTH_SHARE);
/** On the default plan. The fills' daily budget (FILL-BUDGET, configured) still bounds every seed: it takes the lesser. */
export const SEED_CREDIT_CAP = seedCreditCap(HELIUS_PLANS[DEFAULT_HELIUS_PLAN]);
/**
 * Helius credits a day the code itself caps on recurring non-exit reads (S0-ZERO budget review), a ceiling, not a
 * measurement. Five reads:
 * - H15's simulations: `SIM_READS_PER_HOUR`, each one market read and one simulate (5,760);
 * - the stand-in's funding check: at most once a minute, `standInCheckMs` 60 s in main.ts (1,440);
 * - the delay probe: one confirmed read a minute (1,440);
 * - RUG-1c's deployer checks: `DEPLOYER_CHECK_CREDITS_PER_DAY` (5,000);
 * - the complete holder scans: `HOLDER_SCANS_PER_DAY` at the dearer of a scan and its indexed fallback, which takes a
 *   scan of its own from the same cap (`holderScanCreditsPerDay`, 1,200).
 * Socket bytes, migration fetches and the per-candidate fact reads are not capped in code and are not in it.
 */
export const CAPPED_READ_CREDITS_PER_DAY = SIM_READS_PER_HOUR * 24 * 2 + 24 * 60 + 24 * 60 + DEPLOYER_CHECK_CREDITS_PER_DAY + holderScanCreditsPerDay();
/**
 * The share of what is left of the plan's Helius non-exit allowance (HELIUS_FREE's monthly credits up to its 70% planning share, less the capped
 * reads) that the fills may use; the rest is for the uncapped reads (socket bytes, migration fetches, fact reads) until
 * the shakedown's quota report measures them. Supervisor to set it from those figures.
 */
export const FILL_SHARE = 0.5;
/**
 * The plan's share of credits the fills may spend in a UTC day, across restarts (PERSIST-1's `DailyBudget`, wired by
 * WORKER-1c; one budget for the restart's downtime fill and the pool watches' in-run fills, S0-ZERO). Derived from the plan:
 * (1,000,000 × 0.7 − 31 × 14,840) × 0.5 / 31 = 3,870 a day on Helius Free. A 31-day month keeps it inside any month.
 * Every call is also metered by the Helius scheduler, which has no monthly halt of the worker's own (`HELIUS_WORKER`); when
 * Helius itself refuses for used-up credits (HELIUS-EXHAUSTED), non-exit calls are held whatever is left here.
 */
export const planFillCreditsPerDay = (plan: SchedulerSpec): number =>
  Math.floor(((plan.budget!.monthlyCredits * plan.budget!.haltShare) - 31 * CAPPED_READ_CREDITS_PER_DAY) * FILL_SHARE / 31);
/**
 * HELIUS-PLAN: on the default plan (Developer): (10,000,000 × 0.7 − 31 × 14,840) × 0.5 / 31 = 105,483 a day (3,870 on
 * Free). A reference figure: the fills spend the configured `FILL_CREDITS_PER_DAY` (ZEROED_FILL_CREDITS_PER_DAY), which
 * is not raised here; S1 raises it once the real burn is measured against the dashboard.
 */
export const PLAN_FILL_CREDITS_PER_DAY = planFillCreditsPerDay(HELIUS_PLANS[DEFAULT_HELIUS_PLAN]);
/** FILL-BUDGET: the configured default (see config.ts). */
export { FILL_CREDITS_PER_DAY } from './config.ts';
/** The budget's file in the worker's state dir. */
export const FILL_BUDGET_FILE = 'fill-budget.json';

export const runSeed = async (r: SeedRequest, o: { readonly rpc: SeedRpc; readonly timers: Timers; readonly budget?: DailyBudget; readonly creditCap?: number }): Promise<SeedResult> => {
  if (r.untilSlot === null) return { mode: 'none', creates: [], coverage: [], report: 'the live creates watch did not start in time' };
  const now = o.timers.now();
  const planCap = o.creditCap ?? SEED_CREDIT_CAP;
  const cap = o.budget === undefined ? planCap : Math.min(planCap, o.budget.remaining(now));
  // The whole cap is counted before the fill reads (a crash mid-fill cannot spend it again), the unused part after.
  o.budget?.spend(cap, now);
  const rpc = { rpc: o.rpc, timers: o.timers, creditCap: cap, provider: 'helius' as const, signal: r.signal };
  const last = r.saved.last;
  // A first start reads no RPC history: about 64,000 creates a day means a 14-day look-back costs far more than the
  // free month (rehearsal 37148935094 spent 4,000 credits in its first minutes and blocked the start meanwhile), and
  // a partial one leaves H14 not covered anyway. Without day releases the look-back is a gap until it passes live.
  const s = last === null
    ? await buildSeed({ days: [], untilSlot: r.untilSlot, asOf: r.asOf })
    : await buildSeed({
      days: [], rpc, untilSlot: r.untilSlot, asOf: r.asOf,
      fill: { fromSlot: last.slot + 1n > r.untilSlot + 1n ? r.untilSlot + 1n : last.slot + 1n, fromMs: last.ms, ...(r.close === null ? {} : { close: r.close }), ...(r.liveStart === null ? {} : { liveStart: r.liveStart }) },
    });
  const p = s.report;
  o.budget?.refund(cap - (p.rpc === null ? 0 : p.rpc.result.creditsUsed), o.timers.now());
  const rpcText = p.rpc === null ? 'no RPC' : `RPC ${p.rpc.result.creditsUsed} credits, stopped by ${p.rpc.result.stoppedBy}`;
  return { mode: p.mode, creates: s.creates, coverage: s.coverage, report: `${p.creates} creates, ${p.gaps.length} gaps, ${rpcText}` };
};
