// ROUND 4 PARALYSIS PROBE (red team, latches): BEHIND trips at a 10 s late cycle but only clears after 30 s with EVERY
// cycle under 2 s (run/behind.ts:9-11, :38-46). One long stall (a GC, a restored boot's catch-up) followed by a steady
// load with a 2-10 s cycle every <30 s (e.g. a periodic summary/prune/seed step on a busy worker) keeps every entry off
// indefinitely, although no cycle after the stall comes near the 10 s bound that the guard itself accepts while not
// tripped. The halt then rests on staleness the unlatched guard would allow: not a proven reason. Frequency on mainnet:
// unknown (depends on the step-time profile; RC-H/OOM notes show multi-second steps after a restored boot). Non-paralysed
// behaviour asserted: after the stall, 10 minutes of cycles all at or under 3 s clear BEHIND. FAILS on cd4d7a6.
import { describe, expect, it } from 'vitest';
import { BehindGuard } from '../../src/run/behind.ts';

describe('round4 latches: BEHIND clears once the worker keeps up', () => {
  it('a 12 s stall then 10 min of cycles <= 3 s (one 3 s hiccup every 20 s) clears the halt', () => {
    const g = new BehindGuard();
    const loopMs = 100;
    let t = 1_000_000;
    g.cycle(t, loopMs);
    t += 12_000 + loopMs;
    expect(g.cycle(t, loopMs)).toMatchObject({ behind: true });
    const end = t + 10 * 60_000;
    let k = 0;
    while (t < end) {
      k++;
      t += loopMs + (k % 200 === 0 ? 3_000 : 0); // every 200 cycles (~20 s) one cycle runs 3 s late
      g.cycle(t, loopMs);
    }
    expect(g.behind).toBe(false);
  });
});
