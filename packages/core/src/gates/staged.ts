// The hard rejects in GATE-2's evaluation stages, one implementation for the live worker (FACTS-1f, #106) and the
// backtest study (BT-2, audit B2), so both name the same reasons for the same facts (G3 compares the reject mix) and an
// entry decision runs every stage from stage 1 in one call at one `ctx.now`.
import type { GateContext } from './evidence.ts';
import { evaluateHardRejects, type GateDeps, type GateRequest, gatesOfStages, type HardResult } from './hard.ts';
import { HARD_GATES, type HardGate } from './reasons.ts';

/** The stage groups: stage 1 (stream-derived), stage 2 (account reads, cross-checks), stages 3 and 4 (holder scan and funders, simulation). */
export const HARD_STAGE_GROUPS: readonly (readonly HardGate[])[] = [gatesOfStages([1]), gatesOfStages([2]), gatesOfStages([3, 4])];
/** The part of a reject's reason naming the gates a staged evaluation did not reach (the same words live and in the backtest). */
export const NOT_EVALUATED = 'not evaluated: ';

/** A staged evaluation: `stopped` when a group failed on a gate that is not ablated; the groups after it are unread. */
export interface Staged {
  readonly hard: HardResult;
  readonly stopped: boolean;
  readonly notEvaluated: readonly HardGate[];
}

/**
 * The groups in order, every gate of a group evaluated (`stopAtFirst: false`), stopping at the first group with a
 * reject; the gates after it are not evaluated, never passed or failed. `groups` limits how far the reads have landed
 * (the backtest's staged reads; live always evaluates all three). A paper ablation run (backtest only) goes on past a
 * group whose only failures are its ablated gates. `complete` is GATE-2's: every hard gate evaluated.
 */
export const stagedHardRejects = (gctx: GateContext, deps: GateDeps, req: GateRequest, groups: 1 | 2 | 3 = 3, ablate: readonly HardGate[] = []): Staged => {
  let hard: HardResult | null = null;
  for (let k = 0; k < groups; k++) {
    const r = evaluateHardRejects(gctx, deps, req, { stopAtFirst: false, only: HARD_STAGE_GROUPS[k]! });
    hard = hard === null ? r : {
      ...r, pass: hard.pass && r.pass, evaluated: [...hard.evaluated, ...r.evaluated], passed: [...hard.passed, ...r.passed],
      failed: [...hard.failed, ...r.failed], reasons: [...hard.reasons, ...r.reasons], notes: [...hard.notes, ...r.notes],
    };
    if (!r.pass && !r.failed.every((g) => ablate.includes(g))) return { hard: { ...hard, complete: false }, stopped: true, notEvaluated: HARD_STAGE_GROUPS.slice(k + 1).flat() };
  }
  const done = hard!;
  return { hard: { ...done, complete: HARD_GATES.every((g) => done.evaluated.includes(g)) }, stopped: false, notEvaluated: HARD_STAGE_GROUPS.slice(groups).flat() };
};

/** GATE-2's entry rule (supervisor ruling): every hard gate evaluated and none with a reason; a staged pass alone only clears the gates it ran. */
export const hardAllowsEntry = (hard: HardResult): boolean => hard.complete && hard.reasons.length === 0;
