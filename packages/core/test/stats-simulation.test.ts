// Simulation checks from quant.md §5: false positives at most α when the true edge is zero, and about 80% power at
// the effect the sample was designed for. All seeded, so every run gives the same numbers.
import { describe, expect, test } from 'vitest';
import {
  bettingEProcess, clopperPearsonUpper, createRng, dayBlockMeanInterval, designEffect, expectedMaxSharpe, mean,
  meanPredictiveInterval, median, nextNormal, nPower, reverseEProcess, sd, sharpeRatio,
} from '../src/stats/index.ts';
import { bracketDraw, bracketSd, bracketTakeProfitShare, bracketTrades, dayKey } from './stats-fixtures.ts';

const ALPHA = 0.05;
const SLOW = 60_000;

const eProcessRun = (seed: number, trueMean: number, reps: number, cap: number) => {
  const rng = createRng(seed);
  const crossings: number[] = [];
  for (let r = 0; r < reps; r++) {
    const xs = Array.from({ length: cap }, () => bracketDraw(rng, trueMean));
    const e = bettingEProcess(xs);
    if (e.crossedAt !== null) crossings.push(e.crossedAt);
  }
  return { rejectRate: crossings.length / reps, medianTrades: crossings.length ? median(crossings) : null };
};

describe('bracket model (quant.md §5.1)', () => {
  test('take-profit share and SD are close to the published model', () => {
    expect(bracketTakeProfitShare(0)).toBeCloseTo(0.493, 3); // published 48.7%
    expect(bracketSd(0)).toBeGreaterThan(0.3);
    expect(bracketSd(0)).toBeLessThan(0.34); // published 0.320
    const rng = createRng(1);
    const xs = Array.from({ length: 200_000 }, () => bracketDraw(rng, 0.05));
    expect(mean(xs)).toBeCloseTo(0.05, 2);
    expect(sd(xs)).toBeCloseTo(bracketSd(0.05), 2);
  });
});

describe('betting e-process (quant.md §5.4: 1,000 reps, cap 3,000 trades)', () => {
  test('false-positive rate is at most α at zero edge (published 0.036)', () => {
    const r = eProcessRun(101, 0, 1000, 3000);
    expect(r.rejectRate).toBeLessThanOrEqual(ALPHA);
  }, SLOW);
  test('never promotes a losing strategy (−5%)', () => {
    expect(eProcessRun(102, -0.05, 300, 3000).rejectRate).toBe(0);
  }, SLOW);
  test('promotes at +5% (published: 100%, median 282 trades) and +10% (100%, median 87)', () => {
    const five = eProcessRun(103, 0.05, 1000, 3000);
    expect(five.rejectRate).toBeGreaterThanOrEqual(0.99);
    expect(five.medianTrades!).toBeGreaterThan(200);
    expect(five.medianTrades!).toBeLessThan(400);
    const ten = eProcessRun(104, 0.1, 1000, 3000);
    expect(ten.rejectRate).toBe(1);
    expect(ten.medianTrades!).toBeGreaterThan(50);
    expect(ten.medianTrades!).toBeLessThan(150);
  }, SLOW);
  test('reverse process: false demotion at most α at zero edge, and catches −5% decay', () => {
    const rng = createRng(105);
    let falseDemotions = 0;
    let caught = 0;
    for (let r = 0; r < 1000; r++) {
      if (reverseEProcess(Array.from({ length: 3000 }, () => bracketDraw(rng, 0)), { cap: 0.27 }).crossedAt !== null) falseDemotions++;
    }
    for (let r = 0; r < 300; r++) {
      if (reverseEProcess(Array.from({ length: 3000 }, () => bracketDraw(rng, -0.05)), { cap: 0.27 }).crossedAt !== null) caught++;
    }
    expect(falseDemotions / 1000).toBeLessThanOrEqual(ALPHA);
    expect(caught / 300).toBeGreaterThanOrEqual(0.99);
  }, SLOW);
});

describe('day-block bootstrap CI and n_power (quant.md §5.2)', () => {
  const rejectRate = (trades: (seed: number) => { day: string; rNet: number }[], reps: number, seed: number): number => {
    let rejects = 0;
    for (let r = 0; r < reps; r++) {
      const ci = dayBlockMeanInterval(trades(seed + r), 0.95, 'two', { rng: createRng(seed * 7919 + r), replicates: 500 });
      if (ci.lower > 0) rejects++;
    }
    return rejects / reps;
  };
  const sigma0 = bracketSd(0.05);
  const n = nPower(sigma0, 0.05);

  test('false-positive rate is at most α at zero edge with intra-day correlation (ρ = 0.05, 20 a day)', () => {
    const days = Math.ceil((n * designEffect(20, 0.05)) / 20);
    const fpr = rejectRate((s) => bracketTrades(s, 0, days, 20, 0.05), 1000, 2_000);
    expect(fpr).toBeLessThanOrEqual(ALPHA);
  }, SLOW);

  test('treating correlated trades as independent over-rejects (why the bootstrap resamples days)', () => {
    const days = Math.ceil((n * designEffect(20, 0.05)) / 20);
    const asIid = (s: number) => bracketTrades(s, 0, days, 20, 0.05).map((t, i) => ({ day: dayKey(i), rNet: t.rNet }));
    const dayBlock = rejectRate((s) => bracketTrades(s, 0, days, 20, 0.05), 300, 3_000);
    const iid = rejectRate(asIid, 300, 3_000);
    expect(iid).toBeGreaterThan(dayBlock);
  }, SLOW);

  test('power is about 80% at n_power for the design effect (+5%, independent trades)', () => {
    const power = rejectRate((s) => bracketTrades(s, 0.05, n, 1), 400, 4_000);
    expect(power).toBeGreaterThan(0.72);
    expect(power).toBeLessThan(0.88);
  }, SLOW);

  test('power is about 80% at n_power × design effect with intra-day correlation', () => {
    const days = Math.ceil((n * designEffect(20, 0.05)) / 20);
    const power = rejectRate((s) => bracketTrades(s, 0.05, days, 20, 0.05), 400, 5_000);
    expect(power).toBeGreaterThan(0.72);
    expect(power).toBeLessThan(0.9);
  }, SLOW);
});

describe('other interval checks', () => {
  test('90% predictive interval for a future mean covers about 90%', () => {
    const rng = createRng(6);
    let covered = 0;
    const reps = 4000;
    for (let r = 0; r < reps; r++) {
      const ref = Array.from({ length: 40 }, () => 0.05 + 0.3 * nextNormal(rng));
      const fut = Array.from({ length: 15 }, () => 0.05 + 0.3 * nextNormal(rng));
      const pi = meanPredictiveInterval({ n: 40, mean: mean(ref), sd: sd(ref) }, 15, 0.9);
      const fm = mean(fut);
      if (fm >= pi.lower && fm <= pi.upper) covered++;
    }
    expect(covered / reps).toBeGreaterThan(0.88);
    expect(covered / reps).toBeLessThan(0.92);
  });

  test('Clopper–Pearson upper bound covers at least 95% (p = 2%, n = 100)', () => {
    const rng = createRng(7);
    let covered = 0;
    for (let r = 0; r < 4000; r++) {
      let k = 0;
      for (let i = 0; i < 100; i++) if (rng.next() < 0.02) k++;
      if (clopperPearsonUpper(k, 100) >= 0.02) covered++;
    }
    expect(covered / 4000).toBeGreaterThanOrEqual(0.95);
  });

  test('expected max Sharpe of N noise trials matches simulation (quant.md §2.4)', () => {
    const rng = createRng(8);
    for (const trials of [10, 72]) {
      const maxes: number[] = [];
      for (let r = 0; r < 300; r++) {
        let best = -Infinity;
        for (let t = 0; t < trials; t++) best = Math.max(best, sharpeRatio(Array.from({ length: 100 }, () => nextNormal(rng))));
        maxes.push(best);
      }
      expect(mean(maxes)).toBeCloseTo(expectedMaxSharpe(trials, 1 / 100), 1);
      expect(Math.abs(mean(maxes) - expectedMaxSharpe(trials, 1 / 100))).toBeLessThan(0.02);
    }
  }, SLOW);
});
