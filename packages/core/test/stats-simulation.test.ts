// Simulation checks from quant.md §5: false positives at most α when the true edge is zero, and about 80% power at
// the effect the sample was designed for. All seeded, so every run gives the same numbers.
import { describe, expect, test } from 'vitest';
import {
  bettingEProcess, clopperPearsonUpper, createRng, dayBlockMeanInterval, deflatedSharpeDaily, designEffect, expectedMaxSharpe, mean,
  gateG3, meanPredictiveInterval, median, MIN_DAYS, nextNormal, nPower, reverseEProcess, sd, sharpeRatio, spaTest, type G3Input, type Rng,
} from '../src/stats/index.ts';
import { bracketDraw, bracketSd, bracketTakeProfitShare, bracketTrades, dayKey, SPA_SCENARIOS } from './stats-fixtures.ts';

const ALPHA = 0.05;
const SLOW = 60_000;

/** Independent trades, one per day (the quant.md §5.4 setting). */
const oneADay = (xs: readonly number[]) => xs.map((rNet, i) => ({ day: dayKey(i), rNet }));

const eProcessRun = (seed: number, trueMean: number, reps: number, cap: number) => {
  const rng = createRng(seed);
  const crossings: number[] = [];
  for (let r = 0; r < reps; r++) {
    const xs = Array.from({ length: cap }, () => bracketDraw(rng, trueMean));
    const e = bettingEProcess(oneADay(xs));
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
      if (reverseEProcess(oneADay(Array.from({ length: 3000 }, () => bracketDraw(rng, 0))), { cap: 0.27 }).crossedAt !== null) falseDemotions++;
    }
    for (let r = 0; r < 300; r++) {
      if (reverseEProcess(oneADay(Array.from({ length: 3000 }, () => bracketDraw(rng, -0.05))), { cap: 0.27 }).crossedAt !== null) caught++;
    }
    expect(falseDemotions / 1000).toBeLessThanOrEqual(ALPHA);
    expect(caught / 300).toBeGreaterThanOrEqual(0.99);
  }, SLOW);
});

describe('e-process with intra-day correlation (review of PR #8): one bet per day', () => {
  // Zero edge, 20 trades a day, 150 days (3,000 trades), 1,000 runs per cell. Per-trade betting gave 0.16–0.30 here.
  for (const rho of [0.05, 0.1]) {
    test(`ρ = ${rho}: false promotion and false demotion are at most α`, () => {
      let promote = 0;
      let demote = 0;
      for (let r = 0; r < 1000; r++) {
        const t = bracketTrades(40_000 + r + Math.round(rho * 1e6), 0, 150, 20, rho);
        // A day shock can push a rug below −100%, so the floor is widened to −2 (the bet scales with it).
        if (bettingEProcess(t, { lowerBound: -2 }).crossedAt !== null) promote++;
        // The day shock lifts some returns above the +27% take-profit; a cap below them would bias toward demotion (the
        // intended safe side), so the false-demotion check uses a cap above every return the fixture can produce.
        if (reverseEProcess(t, { cap: 1 }).crossedAt !== null) demote++;
      }
      expect(promote / 1000).toBeLessThanOrEqual(ALPHA);
      expect(demote / 1000).toBeLessThanOrEqual(ALPHA);
    }, SLOW);
  }
  test('still detects +10% and −10% within 150 days at ρ = 0.05', () => {
    let up = 0;
    let down = 0;
    for (let r = 0; r < 200; r++) {
      if (bettingEProcess(bracketTrades(50_000 + r, 0.1, 150, 20, 0.05), { lowerBound: -2 }).crossedAt !== null) up++;
      if (reverseEProcess(bracketTrades(60_000 + r, -0.1, 150, 20, 0.05), { cap: 0.27 }).crossedAt !== null) down++;
    }
    expect(up / 200).toBeGreaterThanOrEqual(0.95);
    expect(down / 200).toBeGreaterThanOrEqual(0.95);
  }, SLOW);
});

describe('day-block bootstrap: minimum days (review of PR #8)', () => {
  // Zero edge, 20 trades a day; per-tail false-positive rates of the studentized interval at MIN_DAYS.
  for (const rho of [0.05, 0.1]) {
    test(`ρ = ${rho}, D = ${MIN_DAYS}: one-sided and per-tail two-sided rates within Monte Carlo error of nominal`, () => {
      const reps = 2000;
      let one = 0;
      let low = 0;
      let high = 0;
      for (let r = 0; r < reps; r++) {
        const t = bracketTrades(80_000 + r + Math.round(rho * 1e6), 0, MIN_DAYS, 20, rho);
        if (dayBlockMeanInterval(t, 0.95, 'lower', { rng: createRng(r), replicates: 500 }).lower > 0) one++;
        const two = dayBlockMeanInterval(t, 0.95, 'two', { rng: createRng(r + 1), replicates: 500 });
        if (two.lower > 0) low++;
        if (two.upper < 0) high++;
      }
      // Two Monte Carlo standard errors above nominal: 0.05 + 2·0.0049, 0.025 + 2·0.0035.
      expect(one / reps).toBeLessThanOrEqual(0.0598);
      expect(low / reps).toBeLessThanOrEqual(0.032);
      expect(high / reps).toBeLessThanOrEqual(0.032);
    }, SLOW);
  }
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

  test('the closed-form n gives under 80% power with the conservative G2 interval (why G2 simulates n_power)', () => {
    // At the textbook n (+5%, independent trades) the studentized/t interval reaches ~72%, not 80%;
    // simulateG2Power (stats-g2.test.ts) finds the n that does reach 80%.
    const power = rejectRate((s) => bracketTrades(s, 0.05, n, 1), 400, 4_000);
    expect(power).toBeGreaterThan(0.6);
    expect(power).toBeLessThan(0.8);
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

// STATS-1c (d): calibration of the joint day-block bootstrap SPA test against the day-level DSR. 40 days, every
// scenario of SPA_SCENARIOS, 400 runs at zero edge, 500 bootstrap replicates; the SPA rejects at p < α, the DSR passes
// at ≥ 0.95 on the best day-level Sharpe. Measured with these seeds (SPA / DSR): independent 0.0475 / 0, duplicates
// 0.035 / 0, mixture 0.0325 / 0.0025, heavy tails 0.015 / 0.0075, common shock 0.0325 / 0.0075, idle days 0.0225 /
// 0.0025, unequal lengths 0.005 / 0, autocorrelated 0.045 / 0.0025, rule grid 0.01 / 0.0025.
describe('joint bootstrap SPA test calibration (STATS-1c)', () => {
  const run = (name: string, edge: number, reps: number) => {
    let spa = 0;
    let dsr = 0;
    for (let r = 0; r < reps; r++) {
      const rng = createRng(77_000 + r * 13 + name.length);
      const s = SPA_SCENARIOS[name]!(rng, edge, 40);
      if (spaTest(s, { rng: createRng(5_000_000 + r), replicates: 500 }).pValue < ALPHA) spa++;
      const ids = Object.keys(s);
      const best = ids.reduce((a, b) => (sharpeRatio(s[b]!) > sharpeRatio(s[a]!) ? b : a));
      if (deflatedSharpeDaily(s, best).raw.dsr >= 0.95) dsr++;
    }
    return { spa: spa / reps, dsr: dsr / reps };
  };
  test('false-positive rate ≤ α at zero edge in every scenario (400 runs each)', () => {
    for (const name of Object.keys(SPA_SCENARIOS)) expect(run(name, 0, 400).spa, name).toBeLessThanOrEqual(ALPHA);
  }, 900_000);
  // Power (200 runs, daily edge 0.5 SD unless stated; SPA / DSR): independent 0.22 / 0.135 (0.8 SD: 0.64 / 0.62),
  // duplicates 0.435 / 0.005, mixture 0.51 / 0.02, heavy tails 0.2 / 0.255, common shock 0.24 / 0.19, idle days 0.275 /
  // 0.365, unequal lengths 0.015 / 0.075, autocorrelated 0.1 / 0.065, rule grid +5% a trade 0.3 / 0.055, +10% a trade
  // 0.925 / 0.28.
  test('power on a planted edge: a +10%-a-trade rule among 8 × 9 variants', () => {
    const p = run('ruleGrid', 1, 200);
    expect(p.spa).toBeGreaterThanOrEqual(0.85);
    expect(p.dsr).toBeLessThan(0.4);
  }, 900_000);
});

// G3 power at 48 h for the inconsistencies it must catch (supervisor ruling after three reviews). The setting is the
// G3 fixture's: 20 candidates an hour in the backtest, about 60 paper trades, about 980 rejects, 2 fills a trade. If
// power is short, the remedy is a longer qualifying run, never a looser bound. Measured (500 runs): candidate rate
// halved 1.0; reject mix with H8 doubled 1.0; mean shifted −5 points 0.276; median fill gap 0.75 points 1.0.
describe('G3 power at 48 h (STATS-1b)', () => {
  const poisson = (rng: Rng, lambda: number) => Math.max(0, Math.round(lambda + Math.sqrt(lambda) * nextNormal(rng)));
  const multinomial = (rng: Rng, n: number, p: Record<string, number>) => {
    const keys = Object.keys(p);
    const out: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
    for (let i = 0; i < n; i++) {
      let u = rng.next();
      for (const k of keys) {
        u -= p[k]!;
        if (u <= 0 || k === keys[keys.length - 1]) {
          out[k]!++;
          break;
        }
      }
    }
    return out;
  };
  const caught = (reps: number, seed: number, make: (rng: Rng) => Partial<G3Input>, check: RegExp) => {
    const rng = createRng(seed);
    let n = 0;
    for (let r = 0; r < reps; r++) if (gateG3({ ...G3_BASE, ...make(rng) }).reasons.some((x) => check.test(x.split(':')[0]!))) n++;
    return n / reps;
  };
  const bt = { H8: 4300, H9: 14_200, H11: 1500 };
  const btShare = { H8: 4300 / 20_000, H9: 14_200 / 20_000, H11: 1500 / 20_000 };
  const holdoutMean = 0.1;
  const G3_BASE: G3Input = {
    qualifyingRun: true, liveOnlyVetoes: { vetoed: 20, eligible: 1000 }, dryRunHours: 48,
    dryRunReturns: bracketTrades(41, holdoutMean, 2, 30).map((t) => t.rNet),
    holdout: { n: 500, mean: holdoutMean, sd: bracketSd(holdoutMean) }, holdoutSevereRate: 0.075,
    holdoutLower: { value: 0.06, level: 1 - 0.05 / 3 },
    candidates: { dryRunCount: 960, dryRunHours: 48, backtestCount: 20_000, backtestHours: 1000 },
    rejectMix: { dryRun: { H8: 210, H9: 700, H11: 70 }, backtest: bt },
    fillDifferences: Array.from({ length: 120 }, (_, i) => 0.003 + 0.001 * Math.sin(i)), parityTestPassed: true,
    registration: { registeredAtMs: 0, thresholds: {}, expectedSimulationErrors: [] }, dryRunStartMs: 1,
    simulations: { attempted: 120, succeeded: 120, errors: {} },
    vetoCounterfactuals: { returns: bracketTrades(42, holdoutMean, 1, 20).map((t) => t.rNet), censored: 0 }, returnCap: 0.3,
  };
  test('power for each registered inconsistency is reported; rate and reject mix are caught almost surely', () => {
    const rate = caught(500, 1, (rng) => ({ candidates: { ...G3_BASE.candidates, dryRunCount: poisson(rng, 480) } }), /^candidate rate$/);
    const mix = caught(500, 2, (rng) => ({ rejectMix: { dryRun: multinomial(rng, 980, { H8: 2 * btShare.H8, H9: btShare.H9 - btShare.H8 / 2, H11: btShare.H11 - btShare.H8 / 2 }), backtest: bt } }), /^reject mix/);
    const meanShift = caught(500, 3, (rng) => ({ dryRunReturns: Array.from({ length: 60 }, () => bracketDraw(rng, holdoutMean - 0.05)) }), /^mean$/);
    const fill = caught(500, 4, (rng) => ({ fillDifferences: Array.from({ length: 120 }, () => Math.abs(0.0075 / 0.6745 * nextNormal(rng))) }), /^fills$/);
    expect(rate).toBeGreaterThanOrEqual(0.99);
    expect(mix).toBeGreaterThanOrEqual(0.99);
    // A 5-point mean shift is hard to see in about 60 trades: reported, and the remedy is a longer run.
    expect(meanShift).toBeGreaterThan(0.1);
    expect(meanShift).toBeLessThan(0.6);
    expect(fill).toBeGreaterThan(0.8);
  }, SLOW);
});
