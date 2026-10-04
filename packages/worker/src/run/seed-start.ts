// SEED-1 at worker start (supervisor rulings 2026-10-04): a first start seeds the deployer index over the look-back by
// RPC up to the live creates watch's first slot; a restart fills only the downtime, from the first slot after the saved
// state. Day releases are not read yet (none are downloaded on the server), so their range is RPC's or a gap.
import type { Timers } from '../scheduler/index.ts';
import { buildSeed } from '../seed/seed.ts';
import type { SeedRpc } from '../seed/rpc.ts';
import type { DailyBudget } from '../persist/index.ts';
import type { SeedRequest, SeedResult } from './worker.ts';

/** Credits one seed or fill may spend: 15% of the Helius free month, so a start never starves the live feeds. */
export const SEED_CREDIT_CAP = 150_000;
/**
 * Credits the downtime fills may spend in a UTC day, across restarts (PERSIST-1's `DailyBudget`, wired by WORKER-1c):
 * a restart tops up only its downtime (a few hundred credits for minutes), so a reboot loop stops here.
 */
export const FILL_CREDITS_PER_DAY = 20_000;
/** The budget's file in the worker's state dir. */
export const FILL_BUDGET_FILE = 'fill-budget.json';

export const runSeed = async (r: SeedRequest, o: { readonly rpc: SeedRpc; readonly timers: Timers; readonly budget?: DailyBudget }): Promise<SeedResult> => {
  if (r.untilSlot === null) return { mode: 'none', creates: [], coverage: [], report: 'the live creates watch did not start in time' };
  const now = o.timers.now();
  const cap = o.budget === undefined ? SEED_CREDIT_CAP : Math.min(SEED_CREDIT_CAP, o.budget.remaining(now));
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
