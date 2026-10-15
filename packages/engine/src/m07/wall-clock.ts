// The wall clock of the operator-side `md-pull` tool (card Z08): the receipt's `verifiedAtMs`. It is listed in
// eslint.config.mjs CLOCK_AND_RNG_MODULES (B-M19-01 logic 3: the only files that may read the wall clock). The engine
// never imports it; it gets its Clock injected.
import type { Clock, UnixMs } from '@bot/types';

export const operatorWallClock: Clock = { nowMs: () => Date.now() as UnixMs, kind: 'wall' };
