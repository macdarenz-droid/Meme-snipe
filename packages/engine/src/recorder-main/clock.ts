// The recorder process's clocks (card Z10): the wall clock (record times, UTC hours and days) and the monotonic clock
// that every timer, pace and deadline runs on (M14 `systemTimers`). Listed in eslint.config.mjs CLOCK_AND_RNG_MODULES
// (B-M19-01 logic 3: the only files that may read the clocks); only run.ts imports it, every module gets them injected.
import type { Clock, UnixMs } from '@bot/types';
import { systemTimers } from '../m14/timers.ts';
import type { Scheduler } from '../m14/types.ts';

export const recorderWallClock: Clock = { nowMs: () => Date.now() as UnixMs, kind: 'wall' };
const monotonicMs = (): number => Number(process.hrtime.bigint() / 1_000n) / 1_000;
export const recorderTimers: Scheduler = systemTimers(monotonicMs);
