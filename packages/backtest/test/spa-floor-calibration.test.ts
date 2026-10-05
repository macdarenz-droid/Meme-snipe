// 01FHfb's binding condition (ii) on the SE floor: one calibration case at the registered floor (0.0005 of the capital
// base per day) on the real layout, through the study's own selection: k = 6 (H1, H2, H3, H6 against S0-U1; H4, H5
// against S0-U2), the 64 practice days 2026-07-20 .. 09-21 with the registered regime layout, zero edge (every
// hypothesis and S0 at mean 0, the least favourable null), a sparse variant (H5, active on 12 days) and an all-costs
// variant (H2: a small daily cost and nothing else, the series the floor exists for). The global test's size and the
// pick rate must stay at most α. Daily SD 0.05 of the base (01FHfb's realistic 0.03–0.1). 300 seeded runs (about 20 s),
// the registered 2,000 replicates each. Measured at 0.0005: the global test rejected in 6 of 300 runs (2.0%) and a
// hypothesis was picked in 1 (0.33%); the runs are deterministic, so the counts are pinned.
import { describe, expect, test } from 'vitest';
import { createRng, nextNormal, type Rng } from '../../core/src/stats/index.ts';
import { STUDY_CONFIG } from '../src/strategy/config.ts';
import { selectHypotheses } from '../src/study/select.ts';
import type { SpaVariant } from '../src/study/spa.ts';

const T = 64;
const REAL_LAYOUT = [{ from: 0, to: 1 }, { from: 1, to: 51 }, { from: 51, to: 54 }, { from: 54, to: 64 }];
const SD = 0.05;
const ORDER = ['H1-U1-dip', 'H2-U1-quiet', 'H3-U1-breakout', 'H4-U2-reclaim', 'H5-U2-exhausted-dump', 'H6-U1-dip-sol'];
const UNIVERSE: Record<string, string> = { 'H1-U1-dip': 'U1', 'H2-U1-quiet': 'U1', 'H3-U1-breakout': 'U1', 'H6-U1-dip-sol': 'U1', 'H4-U2-reclaim': 'U2', 'H5-U2-exhausted-dump': 'U2' };
const ROOM = Object.fromEntries(ORDER.map((id) => [id, { entriesPerDay: 20, required: 300 }]));

const normal = (rng: Rng) => Array.from({ length: T }, () => SD * nextNormal(rng));
const variant = (id: string, daily: number[]): SpaVariant => ({ variant: id, daily, activeDays: daily.filter((x) => x !== 0).length, entries: 20 * T, eligible: true });

const world = (rng: Rng) => {
  const h1 = normal(rng);
  // H6 is H1 on the days its SOL gate allows (about half): a correlated subset, as the pre-registration defines it.
  const h6 = h1.map((x) => (nextNormal(rng) > 0 ? x : 0));
  // H5 trades on 12 days only (just above SPA_MIN_ACTIVE_DAYS).
  const days = new Set<number>();
  while (days.size < 12) days.add(Math.floor(rng.next() * T));
  const h5 = Array.from({ length: T }, (_, t) => (days.has(t) ? SD * nextNormal(rng) : 0));
  // H2 only pays costs: failed entries every day, about 25,000 lamports of a 0.13 SOL base, with a little jitter.
  const h2 = Array.from({ length: T }, () => -0.0002 * (1 + 0.01 * nextNormal(rng)));
  const variants = [variant('H1-U1-dip', h1), variant('H2-U1-quiet', h2), variant('H3-U1-breakout', normal(rng)), variant('H4-U2-reclaim', normal(rng)), variant('H5-U2-exhausted-dump', h5), variant('H6-U1-dip-sol', h6)];
  return { variants, s0: { U1: normal(rng), U2: normal(rng) } };
};

describe('SE floor calibration on the real layout (01FHfb condition ii)', () => {
  const runs = 300;
  test('at the registered floor, zero edge: the global test and the pick each reject in at most α of runs', () => {
    const s = STUDY_CONFIG.spa;
    expect(s.seFloor).toBe(0.0005);
    let global = 0;
    let picked = 0;
    for (let r = 0; r < runs; r++) {
      const { variants, s0 } = world(createRng(41_000 + r));
      const sel = selectHypotheses(variants, ORDER, UNIVERSE, s0, s, REAL_LAYOUT, 9_100_000 + r, ROOM);
      expect(sel.spa, `run ${r}`).not.toBeNull();
      if (sel.spa!.pValue < s.alpha) global++;
      if (Object.values(sel.byUniverse).some((x) => x !== null)) picked++;
    }
    expect(global / runs).toBeLessThanOrEqual(s.alpha);
    expect(picked / runs).toBeLessThanOrEqual(s.alpha);
    expect([global, picked]).toEqual([6, 1]);
  }, 900_000);
});
