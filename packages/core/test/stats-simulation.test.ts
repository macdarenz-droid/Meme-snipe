// Simulation checks from quant.md §5: false positives at most α when the true edge is zero, and about 80% power at
// the effect the sample was designed for. All seeded, so every run gives the same numbers.
import { appendFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  bettingEProcess, clopperPearsonUpper, createRng, dayBlockMeanInterval, deflatedSharpe, deflatedSharpeDaily, designEffect, expectedMaxSharpe, mean,
  gateG3, meanPredictiveInterval, sharpeBootstrap, median, MIN_DAYS, nextNormal, nPower, reverseEProcess, sd, sharpeRatio, SPA_STUDENTISATION, spaTest, type G3Input, type Rng, VETO_COMPOSITE_LEVEL, VETO_COMPOSITE_ALPHA, clusterWelchBounds,
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

// STATS-1c: calibration of the joint SPA test (both benchmarks, step-down, stationary blocks 3/5/7, the largest p),
// T = 50 days as the registry's walk-forward (08-03..09-21), S0 at zero edge (least favourable), α = 0.05, 400
// replicates. "Global" is the max-statistic test over all 2K statistics; "a variant passes" is the promotion rule.
// Measured, 300 runs a scenario at zero edge, as fixed ω̂ (global, a variant passes) | re-studentised (global, a variant
// passes): independent 0.177, 0.017 | 0.007, 0 · duplicates 0.13, 0.037 | 0.03, 0.003 · mixture 0.173, 0.033 | 0.01, 0
// · heavy tails 0.16, 0.02 | 0.003, 0 · common shock 0.123, 0.013 | 0.02, 0 · idle days 0.223, 0.017 | 0.007, 0 ·
// unequal lengths 0.133, 0.01 | 0.01, 0 · autocorrelated 0.417, 0.093 | 0.013, 0 · rule grid 0.177, 0.03 | 0.007, 0.003
// · sparse 0.123, 0.007 | 0.003, 0 · regime shift 0.337, 0.08 | 0.013, 0 · unequal volatility 0.143, 0.043 | 0.013, 0.003;
// so the re-studentised form is frozen (SPA_STUDENTISATION). Power, re-studentised, 200 runs (global; a variant passes;
// day-level DSR passes): independent 0.5 SD 0.135; 0.02; 0.185 · 0.8 SD 0.565; 0.15; 0.795 · duplicates 0.475; 0.135; 0
// · mixture 0.485; 0.06; 0.015 · heavy tails 0.195; 0.015; 0.325 · common shock 0.225; 0.04; 0.265 · idle days 0.24;
// 0.03; 0.535 · sparse 0.235; 0.045; 0.69 · regime shift 0.275; 0.075; 0.1 · unequal volatility 0.24; 0.005; 0.23 ·
// autocorrelated 0.065; 0; 0.1 · rule grid +5% a trade 0.285; 0.055; 0.095 · +10% a trade 0.915; 0.6; 0.295.
// CI runs the first 40 seeded runs of each scenario; SPA_FULL_CALIBRATION=1 runs all 300.
describe('joint SPA test calibration (STATS-1c)', () => {
  const T = 50;
  const runs = process.env.SPA_FULL_CALIBRATION ? 300 : 40;
  const run = (name: string, edge: number, reps: number, days = T, seedBase = 77_000, bootBase = 5_000_000, layout?: { from: number; to: number }[]) => {
    let global = 0;
    let pass = 0;
    for (let r = 0; r < reps; r++) {
      const rng = createRng(seedBase + r * 13 + name.length);
      const v = SPA_SCENARIOS[name]!(rng, edge, days);
      const s0 = Array.from({ length: days }, () => nextNormal(rng));
      const activeDays = Object.fromEntries(Object.entries(v).map(([k, s]) => [k, s.filter((x) => x !== 0).length]));
      const regimes = layout ?? (name === 'regimeShift' ? [{ from: 0, to: 20 }, { from: 20, to: 35 }, { from: 35, to: days }] : []);
      const res = spaTest({ variants: v, s0, activeDays, registration: { seFloor: 1e-6, studentisation: SPA_STUDENTISATION, regimes } },
        { rng: createRng(bootBase + r), replicates: 400, alpha: ALPHA });
      if (res.pValue < ALPHA) global++;
      if (res.passing.length > 0) pass++;
    }
    return { global: global / reps, pass: pass / reps, counts: [global, pass] as [number, number] };
  };
  /** Global and promotion-rule rejections per scenario; the full run writes them for the sign-off pack. */
  const record = (label: string, rows: Record<string, [number, number]>) => {
    const out = process.env.SPA_CALIBRATION_OUT;
    if (out) appendFileSync(out, `${JSON.stringify({ label, runs, rows })}\n`);
  };
  // The first 40 seeded runs are deterministic: CI pins their exact counts [global, a variant passes] (review of #96).
  const PINNED_T50: Record<string, [number, number]> = {
    independent: [0, 0], duplicates: [2, 0], mixture: [0, 0], heavyTails: [0, 0], commonShock: [1, 0], idleDays: [0, 0],
    unequalLengths: [0, 0], autocorrelated: [0, 0], sparse: [0, 0], regimeShift: [1, 0], unequalVol: [0, 0], ruleGrid: [0, 0],
  };
  const PINNED_REAL: Record<string, [number, number]> = {
    independent: [0, 0], duplicates: [1, 0], mixture: [1, 1], heavyTails: [1, 0], commonShock: [1, 0], idleDays: [1, 0],
    unequalLengths: [0, 0], autocorrelated: [2, 0], sparse: [0, 0], regimeShift: [0, 0], unequalVol: [0, 0], ruleGrid: [0, 0],
  };
  test('at zero edge neither the global test nor the promotion rule exceeds α, in any scenario', () => {
    const rows: Record<string, [number, number]> = {};
    for (const name of Object.keys(SPA_SCENARIOS)) {
      const r = run(name, 0, runs);
      rows[name] = r.counts;
      expect(r.global, name).toBeLessThanOrEqual(ALPHA);
      expect(r.pass, name).toBeLessThanOrEqual(ALPHA);
    }
    record('T = 50, regime shift at days 20 and 35', rows);
    if (runs === 40) expect(rows).toEqual(PINNED_T50);
  }, 900_000);
  // For the owner's SPA sign-off (STATS-1e ruling): the registry's real T and regime layout, the 64 practice days
  // 2026-07-20 .. 09-21 that G1 reads, with B2 on day 1, B3 on day 51 and B4 on day 54, registered as
  // [0,1) [1,51) [51,54) [54,64); short regimes merge for resampling (mergeShortRegimes) into [0,54) [54,64). Seeds are
  // independent of the runs above (data from 123_000, bootstrap from 12_300_000). The promotion rule's rate (a variant
  // passes) is the gating number; the global rate is reported beside it.
  // Measured (300 runs each; a variant passes, global): independent 0, 0.03 · duplicates 0.007, 0.043 · mixture 0.003,
  // 0.033 · heavy tails 0, 0.017 · common shock 0, 0.027 · idle days 0, 0.01 · unequal lengths 0, 0.003 · autocorrelated
  // 0, 0.043 · sparse 0, 0.013 · regime shift 0, 0.013 · unequal volatility 0, 0.017 · rule grid 0, 0.023. Without the
  // merge (the reviewer's run) the global rate reached 7.0% (common shock); the promotion rule stayed at most 1.3%.
  const REAL_LAYOUT = [{ from: 0, to: 1 }, { from: 1, to: 51 }, { from: 51, to: 54 }, { from: 54, to: 64 }];
  test('on the real 64-day regime layout, on independent seeds, the promotion rule passes a variant in at most α of runs, in every scenario', () => {
    const rows: Record<string, [number, number]> = {};
    for (const name of Object.keys(SPA_SCENARIOS)) {
      const r = run(name, 0, runs, 64, 123_000, 12_300_000, REAL_LAYOUT);
      rows[name] = r.counts;
      expect(r.pass, name).toBeLessThanOrEqual(ALPHA);
    }
    record('T = 64, real practice regime layout (gating: a variant passes)', rows);
    if (runs === 40) expect(rows).toEqual(PINNED_REAL);
  }, 900_000);
  test('power: a +10%-a-trade rule among 8 × 9 variants passes the promotion rule in most runs', () => {
    expect(run('ruleGrid', 1, 60).pass).toBeGreaterThanOrEqual(0.4);
  }, 900_000);
});

// G3 power for the inconsistencies it must catch (supervisor rulings after three reviews and on the qualifying-run
// length). The setting is the G3 fixture's, scaled to the run's length: 20 candidates an hour in the backtest, 60 paper
// trades and 980 rejects per 48 h, 2 fills a trade. If power is short, the remedy is a longer qualifying run, never a
// looser bound. Measured (500 runs): candidate rate halved, one reason's share doubled and a 0.75-point median fill gap
// are caught in every run at 48 h, 7 days and 10 days; a 5-point mean shift in 27.6% at 48 h, 60% at 7 days and 74.2%
// at 10 days.
describe('G3 power at 48 h, 7 days and 10 days (STATS-1b, STATS-1c)', () => {
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
  const bt = { H8: 4300, H9: 14_200, H11: 1500 };
  const btShare = { H8: 4300 / 20_000, H9: 14_200 / 20_000, H11: 1500 / 20_000 };
  const holdoutMean = 0.1;
  const HOUR = 3_600_000;
  // The run at `hours`: every count scales with its length (20 candidates an hour, 60 paper trades and 980 rejects per 48 h).
  const at = (hours: number): G3Input => {
    const f = hours / 48;
    return {
      qualifyingRun: true, liveOnlyVetoes: { vetoed: Math.round(20 * f), eligible: Math.round(1000 * f) }, dryRunHours: hours,
      ...(() => { const xs = bracketTrades(41, holdoutMean, Math.round(2 * f), 30).map((t) => t.rNet); return { dryRunReturns: xs, dryRunClusters: xs.map((_, i) => `k${i}`) }; })(),
      holdout: { n: 500, mean: holdoutMean, sd: bracketSd(holdoutMean) }, holdoutSevereRate: 0.075,
      holdoutLower: { value: 0.06, level: VETO_COMPOSITE_LEVEL },
      candidates: { dryRunCount: Math.round(960 * f), dryRunHours: hours, backtestCount: 20_000, backtestHours: 1000 },
      rejectMix: { dryRun: { H8: Math.round(210 * f), H9: Math.round(700 * f), H11: Math.round(70 * f) }, backtest: bt },
      fillDifferences: Array.from({ length: Math.round(120 * f) }, (_, i) => 0.003 + 0.001 * Math.sin(i)), parityTestPassed: true,
      registration: { registeredAtMs: 0, evaluateAtMs: 1 + hours * HOUR, thresholds: {}, expectedSimulationErrors: [] }, dryRunStartMs: 1,
      simulations: { attempted: Math.round(120 * f), succeeded: Math.round(120 * f), errors: {} },
      vetoCounterfactuals: (() => { const xs = bracketTrades(42, holdoutMean, 1, Math.round(20 * f)).map((t) => t.rNet); return { returns: xs, clusters: xs.map((_, i) => `v${i}`), censored: 0 }; })(), returnCap: 0.3,
    };
  };
  const powerAt = (hours: number) => {
    const base = at(hours);
    const f = hours / 48;
    const caughtAt = (seed: number, make: (rng: Rng) => Partial<G3Input>, check: RegExp) => {
      const rng = createRng(seed);
      let n = 0;
      for (let r = 0; r < 500; r++) if (gateG3({ ...base, ...make(rng) }).reasons.some((x) => check.test(x.split(':')[0]!))) n++;
      return n / 500;
    };
    return {
      rate: caughtAt(1, (rng) => ({ candidates: { ...base.candidates, dryRunCount: poisson(rng, 480 * f) } }), /^candidate rate$/),
      mix: caughtAt(2, (rng) => ({ rejectMix: { dryRun: multinomial(rng, Math.round(980 * f), { H8: 2 * btShare.H8, H9: btShare.H9 - btShare.H8 / 2, H11: btShare.H11 - btShare.H8 / 2 }), backtest: bt } }), /^reject mix/),
      meanShift: caughtAt(3, (rng) => { const xs = Array.from({ length: Math.round(60 * f) }, () => bracketDraw(rng, holdoutMean - 0.05)); return { dryRunReturns: xs, dryRunClusters: xs.map((_, i) => `k${i}`) }; }, /^mean$/),
      fill: caughtAt(4, (rng) => ({ fillDifferences: Array.from({ length: Math.round(120 * f) }, () => Math.abs(0.0075 / 0.6745 * nextNormal(rng))) }), /^fills$/),
    };
  };
  test('power for each registered inconsistency at 48 h, 7 days and 10 days', () => {
    const p48 = powerAt(48);
    const p7 = powerAt(168);
    const p10 = powerAt(240);
    for (const p of [p48, p7, p10]) {
      expect(p.rate).toBeGreaterThanOrEqual(0.99);
      expect(p.mix).toBeGreaterThanOrEqual(0.99);
      expect(p.fill).toBeGreaterThan(0.8);
    }
    // The mean shift needs time: 0.276 at 48 h, 0.6 at 7 days, 0.742 at 10 days.
    expect(p48.meanShift).toBeCloseTo(0.276, 3);
    expect(p7.meanShift).toBeCloseTo(0.6, 3);
    expect(p10.meanShift).toBeCloseTo(0.742, 3);
  }, SLOW);
});

// STATS-1c ruling C: the evidence the owner needs for the SPA sign-off. The gating DSR (per-trade, clamped moments,
// raw N) at a true +5%-a-trade edge on 50 days: one trial with the edge among N, the rest at zero edge, the best
// per-trade Sharpe selected. Measured (200 runs a cell; pass rate / pass on the edge trial): 3 a day N 10 0.005 / 0.005,
// N 72 0.01 / 0.01, N 200 0.02 / 0.005; 10 a day N 10 0.14 / 0.14, N 72 0.095 / 0.095, N 200 0.11 / 0.11.
describe('DSR pass rate at a true +5% edge on 50 days (STATS-1c)', () => {
  test('the gating DSR rarely finds a +5% edge in 50 days', () => {
    const rate = (perDay: number, N: number) => {
      let pass = 0;
      for (let r = 0; r < 200; r++) {
        const rng = createRng(400_000 + r * 7 + N * 13 + perDay);
        const trials = Array.from({ length: N }, (_, k) => Array.from({ length: 50 * perDay }, () => bracketDraw(rng, k === 0 ? 0.05 : 0)));
        const reg = trials.map((t, k) => ({ trialId: `t${k}`, sharpe: sharpeRatio(t), nTrades: t.length }));
        const best = trials.reduce((a, b) => (sharpeRatio(b) > sharpeRatio(a) ? b : a));
        if (deflatedSharpe(best, reg, { clamp: true }).dsr >= 0.95) pass++;
      }
      return pass / 200;
    };
    expect(rate(3, 10)).toBeLessThan(0.05);
    expect(rate(10, 72)).toBeLessThan(0.2);
  }, SLOW);
});

// STATS-1c ruling 2: the block-bootstrap Sharpe of a daily series. Measured (400 runs, 1,000 replicates): the null
// p-value rejects 5.0% at zero Sharpe (D = 50); the percentile interval covers 90–92% (D = 30–50), below its nominal
// 95%, so only the p-value is reported as calibrated.
describe('block-bootstrap Sharpe (STATS-1c)', () => {
  test('the null p-value is calibrated at zero Sharpe', () => {
    let rej = 0;
    for (let r = 0; r < 400; r++) {
      const rng = createRng(1000 + r);
      const x = Array.from({ length: 50 }, () => nextNormal(rng));
      if (sharpeBootstrap(x, { rng: createRng(9_000_000 + r), replicates: 1000 }).pNull < ALPHA) rej++;
    }
    expect(rej / 400).toBeLessThanOrEqual(ALPHA + 2 * Math.sqrt((ALPHA * (1 - ALPHA)) / 400));
  }, SLOW);
});

// External audit S4: G3's veto-gap bound assumed kept and vetoed trades independent within a run. Trades of one creator
// share a shock (ICC 0.5, true gap 0). The classic one-sided Welch upper bound misses the true gap far more often than
// its level; the cluster-robust bound G3 uses (CR2 with Bell–McCaffrey df, STATS-1g review B1) holds it, also when one
// creator makes half the trades, where CR1 with G − 1 df did not. Bounds are the level plus two Monte Carlo standard
// errors. Measured at 2,000 runs, 20 equal creators a side: classic 17.5%, cluster-robust 4.45% at 0.05. Measured at
// 4,000 runs and α/4 = 0.0125 (one creator at 50%): G 10 of 50 trades, CR1 5.35%, CR2 1.23%; G 20 of 100, CR1 8.38%,
// CR2 1.43%; equal sizes, both 1.02% (G 10) and 1.07% (G 20). At α/8 (the two-sided gap's side): CR2 0.50% and 0.63%.
describe('cluster-robust veto gap (STATS-1g, audit S4)', () => {
  /** Trades split over creators: `dominant` of them from the first creator, the rest spread evenly over the others. */
  const sizes = (n: number, creators: number, dominant: number): number[] => {
    const first = dominant > 0 ? Math.round(n * dominant) : Math.floor(n / creators) + (n % creators > 0 ? 1 : 0);
    const k = creators - 1;
    const rest = n - first;
    return [first, ...Array.from({ length: k }, (_, i) => Math.floor(rest / k) + (i < rest % k ? 1 : 0))];
  };
  const side = (rng: Rng, prefix: string, perCreator: readonly number[]) => {
    const xs: number[] = [];
    const cs: string[] = [];
    perCreator.forEach((m, g) => {
      const shock = nextNormal(rng);
      for (let i = 0; i < m; i++) {
        xs.push(shock + nextNormal(rng));
        cs.push(`${prefix}${g}`);
      }
    });
    return { xs, cs };
  };
  const bound = (alpha: number, runs: number) => alpha + 2 * Math.sqrt((alpha * (1 - alpha)) / runs);
  /** Share of runs whose one-sided upper bound at α sits below the true gap 0. */
  const missRate = (perCreator: readonly number[], alpha: number, runs: number, seed: number): number => {
    let miss = 0;
    for (let r = 0; r < runs; r++) {
      const rng = createRng(seed + r);
      const a = side(rng, 'v', perCreator);
      const b = side(rng, 'k', perCreator);
      if (clusterWelchBounds(a.xs, a.cs, b.xs, b.cs, alpha).upper < 0) miss++;
    }
    return miss / runs;
  };
  test('with creator-shared shocks the classic bound under-covers; the cluster-robust bound holds its level', () => {
    const RUNS = 2000;
    const equal = sizes(100, 20, 0);
    expect(equal).toEqual(Array<number>(20).fill(5));
    let iidMiss = 0;
    for (let r = 0; r < RUNS; r++) {
      const rng = createRng(400_000 + r);
      const a = side(rng, 'v', equal);
      const b = side(rng, 'k', equal);
      // Every trade its own creator: the classic Welch bound (independence assumed).
      if (clusterWelchBounds(a.xs, a.xs.map((_, i) => `a${i}`), b.xs, b.xs.map((_, i) => `b${i}`), 0.05).upper < 0) iidMiss++;
    }
    expect(iidMiss / RUNS).toBeGreaterThan(0.12);
    expect(missRate(equal, 0.05, RUNS, 400_000)).toBeLessThanOrEqual(bound(0.05, RUNS));
    expect(missRate(equal, VETO_COMPOSITE_ALPHA, RUNS, 400_000)).toBeLessThanOrEqual(bound(VETO_COMPOSITE_ALPHA, RUNS));
  });
  test('one creator with half the trades: the bound holds α/4 and α/8, with 10 and 20 creators (review B1)', () => {
    const RUNS = 4000;
    const cases = [
      { per: sizes(50, 10, 0.5), seed: 410_000 },
      { per: sizes(100, 20, 0.5), seed: 420_000 },
      { per: sizes(50, 10, 0), seed: 430_000 },
      { per: sizes(100, 20, 0), seed: 440_000 },
    ];
    expect(cases.map((c) => c.per[0])).toEqual([25, 50, 5, 5]);
    for (const { per, seed } of cases) {
      expect(missRate(per, VETO_COMPOSITE_ALPHA, RUNS, seed)).toBeLessThanOrEqual(bound(VETO_COMPOSITE_ALPHA, RUNS));
      expect(missRate(per, VETO_COMPOSITE_ALPHA / 2, RUNS, seed)).toBeLessThanOrEqual(bound(VETO_COMPOSITE_ALPHA / 2, RUNS));
    }
  }, SLOW);
});
