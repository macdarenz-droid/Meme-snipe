// Node timers on an injected monotonic clock (A-M14-01/02; review C03 R5, R7).
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62).
import type { Scheduler } from './types.ts';

/** The longest delay Node's timers keep (2^31 − 1 ms); a longer `timeoutMs` is refused as `bad_options` (review C03 R7). */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Node timers on the given monotonic clock (production: `performance.now` from the clock module, which alone may read
 * it, B-M19-01 logic 3). A delay is clamped to 0..MAX_TIMER_MS; a timer that fires early only re-checks its queue.
 */
export function systemTimers(monotonicNowMs: () => number): Scheduler {
  return {
    nowMs: monotonicNowMs,
    set(fn, ms) {
      const t = setTimeout(fn, Math.min(MAX_TIMER_MS, Math.max(0, ms)));
      return () => clearTimeout(t);
    },
  };
}
