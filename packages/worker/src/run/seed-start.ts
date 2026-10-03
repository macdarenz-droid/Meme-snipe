// SEED-1 at worker start (supervisor rulings 2026-10-04): a first start seeds the deployer index over the look-back by
// RPC up to the live creates watch's first slot; a restart fills only the downtime, from the first slot after the saved
// state. Day releases are not read yet (none are downloaded on the server), so their range is RPC's or a gap.
import { DAY_MS } from '../../../core/src/config/time.ts';
import type { Timers } from '../scheduler/index.ts';
import { buildSeed } from '../seed/seed.ts';
import type { SeedRpc } from '../seed/rpc.ts';
import type { SeedRequest, SeedResult } from './worker.ts';

/** Credits one seed or fill may spend: 15% of the Helius free month, so a start never starves the live feeds. */
export const SEED_CREDIT_CAP = 150_000;
/** Mainnet slots a day at the 400 ms target, for the look-back's first slot (the backfill reads real block times). */
export const SLOTS_PER_DAY = 216_000n;

export const runSeed = async (r: SeedRequest, o: { readonly rpc: SeedRpc; readonly timers: Timers; readonly lookbackDays: number }): Promise<SeedResult> => {
  if (r.untilSlot === null) return { mode: 'none', creates: [], coverage: [], report: 'the live creates watch did not start in time' };
  const rpc = { rpc: o.rpc, timers: o.timers, creditCap: SEED_CREDIT_CAP, provider: 'helius' as const };
  const last = r.saved.last;
  const s = last === null
    ? await buildSeed({ days: [], rpc, rpcFrom: { slot: r.untilSlot - BigInt(o.lookbackDays) * SLOTS_PER_DAY, ms: r.asOf.receivedAt - o.lookbackDays * DAY_MS }, untilSlot: r.untilSlot, asOf: r.asOf })
    : await buildSeed({
      days: [], rpc, untilSlot: r.untilSlot, asOf: r.asOf,
      fill: { fromSlot: last.slot + 1n > r.untilSlot + 1n ? r.untilSlot + 1n : last.slot + 1n, fromMs: last.ms, ...(r.close === null ? {} : { close: r.close }) },
    });
  const p = s.report;
  const rpcText = p.rpc === null ? 'no RPC' : `RPC ${p.rpc.result.creditsUsed} credits, stopped by ${p.rpc.result.stoppedBy}`;
  return { mode: p.mode, creates: s.creates, coverage: s.coverage, report: `${p.creates} creates, ${p.gaps.length} gaps, ${rpcText}` };
};
