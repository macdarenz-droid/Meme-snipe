// Manual M0 exit check (workflow provider-reads): one getSlot and one getHealth through each free provider.
// Prints, per provider, PASS or FAIL, the slot and the latency; never a URL, key, header or body. Exit 0 only if both pass.
import type { UnixMs } from '@bot/types';
import { runReadCheck } from '../src/m14/reads-check.ts';
import { systemTimers } from '../src/m14/timers.ts';
import type { FetchLike } from '../src/m14/types.ts';

// The ambient-clock rule (ARCH 5.0) keeps wall time and performance.now to the clock module, which the engine does not
// have yet (B-M19-01). hrtime is monotonic and enough here: the check only measures latency and paces its two calls; the
// "wall" reading goes to a no-op event bus.
const mono = (): number => Number(process.hrtime.bigint()) / 1e6;

const result = await runReadCheck({
  env: process.env,
  fetch: ((url, init) => fetch(url, init)) as FetchLike,
  clock: { nowMs: () => mono() as UnixMs, kind: 'wall' },
  scheduler: systemTimers(mono),
});
for (const line of result.lines) console.log(line);
process.exit(result.ok ? 0 : 1);
