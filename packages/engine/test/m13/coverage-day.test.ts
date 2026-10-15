// Addendum A14 acceptance: on day-correlated simulations the gate interval (the more conservative of the stationary
// bootstrap and the day-cluster t-interval) covers within ±2 points of 95%. Each simulated window: 30 days, 2-6 trades
// a day, a day effect N(0, 0.5²) shared by the day's trades plus N(0, 1) per trade, true mean 0. Repetition k uses
// seed k. Also: the day-cluster interval alone at 4,000 repetitions, and DEFF above 1 on such data.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { Rng } from '@bot/types';
import { createRng } from '../../src/m10/rng.ts';
import { dayClusterMeanCi, gateMeanCi } from '../../src/m13/stats/intervals.ts';

const normal = (r: Rng): number => Math.sqrt(-2 * Math.log(1 - r.nextFloat())) * Math.cos(2 * Math.PI * r.nextFloat());
function window(rng: Rng): { x: number[]; days: string[] } {
  const x: number[] = [], days: string[] = [];
  for (let d = 0; d < 30; d++) {
    const effect = 0.5 * normal(rng), trades = 2 + Math.floor(rng.nextFloat() * 5);
    for (let i = 0; i < trades; i++) { x.push(effect + normal(rng)); days.push(`2026-08-${String(d + 1).padStart(2, '0')}`); }
  }
  return { x, days };
}

describe('A14 gate interval coverage on day-correlated data', () => {
  it('1,000 repetitions: the gate interval covers 95% ± 2 points; its DEFF is above 1 on average', { timeout: 900_000 }, () => {
    let hit = 0, deff = 0;
    for (let k = 0; k < 1_000; k++) {
      const rng = createRng(k), { x, days } = window(rng);
      const g = gateMeanCi(x, days, { rng });
      assert.ok(g !== null);
      if (g.low <= 0 && 0 <= g.high) hit++;
      deff += g.deff;
    }
    const coverage = hit / 10;
    assert.ok(Math.abs(coverage - 95) <= 2, `coverage ${coverage}%`);
    assert.ok(deff / 1_000 > 1, `mean DEFF ${deff / 1_000}`);
  });

  it('4,000 repetitions: the day-cluster t-interval alone covers 95% ± 2 points', () => {
    let hit = 0;
    for (let k = 0; k < 4_000; k++) {
      const { x, days } = window(createRng(100_000 + k));
      const c = dayClusterMeanCi(x, days);
      assert.ok(c !== null);
      if (c.low <= 0 && 0 <= c.high) hit++;
    }
    assert.ok(Math.abs(hit / 40 - 95) <= 2, `coverage ${hit / 40}%`);
  });
});
