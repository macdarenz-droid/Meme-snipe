// The dashboard's clock module (ARCH 5.0; eslint.config.mjs CLOCK_AND_RNG_MODULES): the only dashboard file that reads
// the wall clock or the monotonic clock. Components and tooling take the shared Clock (@bot/types), or an
// ElapsedClock for durations, so tests drive time with a fake one.
import type { Clock, UnixMs } from '@bot/types';

/** The browser's (or Node's) wall clock. */
export const wallClock: Clock = { nowMs: () => Date.now() as UnixMs, kind: 'wall' };

/** A clock for measuring durations: milliseconds from an arbitrary origin. A Clock is one too. */
export interface ElapsedClock { nowMs(): number }

/** performance.now(): monotonic, so a wall-clock correction cannot shorten or stretch a measured duration. */
export const monotonicClock: ElapsedClock = { nowMs: () => performance.now() };
