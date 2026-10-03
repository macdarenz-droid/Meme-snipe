// SEED-1 at worker start (supervisor rulings 2026-10-04): a first start seeds the deployer index over the look-back by
// RPC up to the live creates watch's first slot; a restart fills only the downtime, from the first slot after the saved
// state. Day releases are not read yet (none are downloaded on the server), so their range is RPC's or a gap.
import type { Timers } from '../scheduler/index.ts';
import { buildSeed } from '../seed/seed.ts';
import type { SeedRpc } from '../seed/rpc.ts';
import type { SeedRequest, SeedResult } from './worker.ts';

/** Credits one seed or fill may spend: 15% of the Helius free month, so a start never starves the live feeds. */
export const SEED_CREDIT_CAP = 150_000;

export const runSeed = async (r: SeedRequest, o: { readonly rpc: SeedRpc; readonly timers: Timers }): Promise<SeedResult> => {
  if (r.untilSlot === null) return { mode: 'none', creates: [], coverage: [], report: 'the live creates watch did not start in time' };
  const rpc = { rpc: o.rpc, timers: o.timers, creditCap: SEED_CREDIT_CAP, provider: 'helius' as const };
  const last = r.saved.last;
  // A first start reads no RPC history: about 64,000 creates a day means a 14-day look-back costs far more than the
  // free month (rehearsal 37148935094 spent 4,000 credits in its first minutes and blocked the start meanwhile), and
  // a partial one leaves H14 not covered anyway. Without day releases the look-back is a gap until it passes live.
  const s = last === null
    ? await buildSeed({ days: [], untilSlot: r.untilSlot, asOf: r.asOf })
    : await buildSeed({
      days: [], rpc, untilSlot: r.untilSlot, asOf: r.asOf,
      fill: { fromSlot: last.slot + 1n > r.untilSlot + 1n ? r.untilSlot + 1n : last.slot + 1n, fromMs: last.ms, ...(r.close === null ? {} : { close: r.close }) },
    });
  const p = s.report;
  const rpcText = p.rpc === null ? 'no RPC' : `RPC ${p.rpc.result.creditsUsed} credits, stopped by ${p.rpc.result.stoppedBy}`;
  return { mode: p.mode, creates: s.creates, coverage: s.coverage, report: `${p.creates} creates, ${p.gaps.length} gaps, ${rpcText}` };
};
