// The exit escalation ladder (docs/ARCHITECTURE.md §9): rungs of rising priority fee and wider min-out below the
// trigger value, at most `maxAttempts` attempts per exit, each fee capped. Past the last attempt the exit is blocked.
import type { Policy } from '../config/index.ts';
import { BPS_DENOMINATOR, mulDiv } from '../units/index.ts';

export type Ladder = Policy['exits']['ladder'];

export type AttemptPlan =
  | {
    readonly ok: true;
    /** Index into the ladder's steps. */
    readonly rung: number;
    readonly priorityFee: bigint;
    /** Least accepted output, from the trigger value. */
    readonly minOut: bigint;
  }
  | { readonly ok: false; readonly reason: 'ladder-exhausted' | 'quote-below-min-out'; readonly detail: string };

const minOutAt = (ladder: Ladder, rung: number, triggerValue: bigint): bigint =>
  mulDiv(triggerValue, BPS_DENOMINATOR - BigInt(ladder.steps[rung]!.minOutBelowTriggerBps), BPS_DENOMINATOR, 'floor');

/**
 * The plan for attempt `attempt` (1-based) of one exit. The scheduled rung is `startRung + attempt − 1`, held at the
 * last rung, and never below `lastRung + 1` (the highest rung already tried, held at the last rung). A rung whose
 * min-out is above the fresh quote would fail on chain and only burn its fee, so the plan moves up to the first rung
 * the quote can meet; when none can, the exit is blocked now. Every fee is capped at `maxFeePerAttempt`.
 */
export const planAttempt = (
  ladder: Ladder, attempt: number, triggerValue: bigint, freshQuote: bigint, startRung = 0, maxAttempts = ladder.maxAttempts, lastRung: number | null = null,
): AttemptPlan => {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a whole number >= 1');
  if (!Number.isSafeInteger(startRung) || startRung < 0) throw new RangeError('startRung must be a whole number >= 0');
  if (triggerValue <= 0n) throw new RangeError('trigger value must be > 0');
  // A caller can narrow the budget (a blocked-exit retry gets one attempt), never widen it past the policy.
  const budget = Math.min(maxAttempts, ladder.maxAttempts);
  if (attempt > budget) return { ok: false, reason: 'ladder-exhausted', detail: `${budget} attempts used` };
  const last = ladder.steps.length - 1;
  // Never below the rung after the highest one tried (a skip upward is not undone by the next attempt).
  const floor = lastRung === null ? 0 : Math.min(lastRung + 1, last);
  for (let rung = Math.max(Math.min(startRung + attempt - 1, last), floor); rung <= last; rung++) {
    const minOut = minOutAt(ladder, rung, triggerValue);
    if (minOut > freshQuote) continue;
    const fee = ladder.steps[rung]!.priorityFeeLamports;
    return { ok: true, rung, priorityFee: fee < ladder.maxFeePerAttempt ? fee : ladder.maxFeePerAttempt, minOut };
  }
  return { ok: false, reason: 'quote-below-min-out', detail: `quote ${freshQuote} below the last rung's min-out ${minOutAt(ladder, last, triggerValue)}` };
};
