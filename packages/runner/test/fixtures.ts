import { coverageGaps, lookupLatency, quotaReport, rejections } from '../src/quota.ts';
import type { Drill } from '../src/plan.ts';
import type { DrillOutcome, Ops } from '../src/report.ts';

/** Quota and coverage of a clean run: one provider well inside its plan, nothing shed. */
export const OPS_OK: Ops = {
  quota: quotaReport(
    [
      {
        quota: [
          { provider: 'helius', credits_used: 10, credits_by_class: [1, 4, 3, 2], monthly_credits: 1_000_000, granted: [1, 1, 1, 1], shed: [0, 0, 0, 0], halted: false },
          { provider: 'alchemy', credits_used: 0, credits_by_class: [0, 0, 0, 0], monthly_credits: 30_000_000, granted: [0, 0, 0, 0], shed: [0, 0, 0, 0], halted: false },
          { provider: 'jupiter', credits_used: 0, credits_by_class: [0, 0, 0, 0], monthly_credits: null, granted: [0, 0, 0, 0], shed: [0, 0, 0, 0], halted: false },
        ],
        lookups: { counts: [] },
      },
    ],
    100_000,
  ),
  lookups: lookupLatency([]),
  coverage: coverageGaps([], 0),
  rejections: rejections([]),
};

/** A passing outcome for every drill of a plan: each restart cause recovered its state, mid-trade. */
export const fullDrills = (plan: readonly Drill[]): DrillOutcome[] =>
  plan.map((d): DrillOutcome => {
    if (d.kind === 'feed') return { id: d.id, kind: 'feed', plannedAt: 0, at: 0, pass: true, feed: d.feed, notes: [] };
    if (d.kind === 'rpc') return { id: d.id, kind: 'rpc', plannedAt: 0, at: 0, pass: true, recovery: { reconciled_ms: null, exit_capable_ms: 100, clock: 'monotonic' }, notes: [] };
    return {
      id: d.id, kind: 'restart', cause: d.cause, plannedAt: 0, at: 0, pass: true, midTrade: true, recoveredMs: 1, keep: 1,
      // A host loss on the host is a tabletop whose restore was compared with the live worker at the backup.
      ...(d.cause === 'host-loss' ? { off_run: true, compared: true } : {}),
      recovery: { reconciled_ms: 500, exit_capable_ms: 800, clock: 'monotonic' },
      state: { source: d.cause === 'chain-rebuild' ? 'chain' : 'state', expected_pending_exits: [], recovered_pending_exits: [], missing: [], lost: [], state_ok: true, universe_ok: true, notes: [] },
      notes: [],
    };
  });
