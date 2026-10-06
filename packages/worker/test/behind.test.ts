// BEHIND: entries fail closed while the loop cannot keep up with its inputs; it clears only after a calm run.
import { describe, expect, it } from 'vitest';
import { BEHIND_MS, BehindGuard, CLEAR_FOR_MS, CLEAR_MS } from '../src/run/behind.ts';

const LOOP = 100;

describe('the behind guard', () => {
  it('trips on a cycle more than BEHIND_MS over its interval (start to start), not at exactly BEHIND_MS', () => {
    const g = new BehindGuard();
    expect(g.cycle(0, LOOP)).toBeNull();
    expect(g.cycle(LOOP + BEHIND_MS, LOOP)).toBeNull();
    expect(g.behind).toBe(false);
    const t = 2 * LOOP + 2 * BEHIND_MS + 1;
    expect(g.cycle(t, LOOP)).toEqual({ behind: true, lateMs: BEHIND_MS + 1 });
    expect(g.behind).toBe(true);
  });

  it('clears only after every cycle stays under CLEAR_MS for CLEAR_FOR_MS; one slow cycle restarts the wait', () => {
    const g = new BehindGuard();
    let t = 0;
    g.cycle(t, LOOP);
    t += LOOP + BEHIND_MS + 1;
    expect(g.cycle(t, LOOP)?.behind).toBe(true);
    // Calm cycles (late CLEAR_MS - 1) for most of the wait, then one at CLEAR_MS: the wait starts again.
    const step = LOOP + CLEAR_MS - 1;
    for (let n = 0; n < 5; n++) expect(g.cycle((t += step), LOOP)).toBeNull();
    expect(g.cycle((t += LOOP + CLEAR_MS), LOOP)).toBeNull();
    const calmFrom = (t += step);
    expect(g.cycle(calmFrom, LOOP)).toBeNull();
    while (t + step - calmFrom < CLEAR_FOR_MS) expect(g.cycle((t += step), LOOP)).toBeNull();
    expect(g.behind).toBe(true);
    // Exactly CLEAR_FOR_MS after the calm began: cleared.
    const last = calmFrom + CLEAR_FOR_MS;
    expect(g.cycle(last, LOOP)).toEqual({ behind: false, lateMs: last - t - LOOP });
    expect(g.behind).toBe(false);
  });

  it('a cycle on time is never late, and a clock that steps back counts as on time', () => {
    const g = new BehindGuard();
    g.cycle(1_000, LOOP);
    expect(g.cycle(1_000 + LOOP, LOOP)).toBeNull();
    expect(g.cycle(500, LOOP)).toBeNull();
    expect(g.behind).toBe(false);
  });
});
