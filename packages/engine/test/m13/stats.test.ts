// A-M13-03 statistics library: hand-computed values, the papers' worked examples (V1 DSR, A-44 MinBTL), ARCH 3.4's
// MinTRL and MinBTL tables, Wilson reference values, CSCV/PBO on synthetic matrices, and the edge cases (null on empty or
// constant series, E_INPUT on NaN). Coverage simulations are in coverage-*.test.ts.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { createRng } from '../../src/m10/rng.ts';
import {
  cscvPbo, dayClusterMeanCi, daysToYears, dsr, dsrFromVariance, expectedMaxSharpe, gateMeanCi, kurtosisNonExcess, loSharpeSe,
  maxTrialsForWindow, mean, minBtlYears, minTrl, nonInferiorityLowerBound, normalQuantile, policyMeanBlock, psr, rankStability, skew,
  stationaryBootstrapMeanCi, stationaryBootstrapRuns, stats, studentizedTsBootstrapSharpeDiff, tStatMean, wilson,
} from '../../src/m13/stats/index.ts';

const close = (a: number, b: number, tol: number, what = ''): void => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b}`);
const normals = (seed: number, n: number, mu = 0, sd = 1): number[] => {
  const r = createRng(seed);
  return Array.from({ length: n }, () => mu + sd * Math.sqrt(-2 * Math.log(1 - r.nextFloat())) * Math.cos(2 * Math.PI * r.nextFloat()));
};

describe('descriptive statistics and edge cases', () => {
  it('hand-computed mean and t-statistic', () => {
    assert.equal(mean([1, 2, 3, 4]), 2.5);
    close(tStatMean([1, 2, 3, 4]) as number, 2.5 / Math.sqrt(1.6666666666666667 / 4), 1e-12);
  });

  it('skewness and non-excess kurtosis need 30 observations; constant series give null', () => {
    const x = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 4 : 1));     // 10 fours, 20 ones
    // mean 2, deviations +2 (10×) and −1 (20×): m2 = 2, m3 = 2, m4 = 6 → skew 2/2^1.5, kurtosis 6/4.
    close(skew(x) as number, 2 / 2 ** 1.5, 1e-12);
    close(kurtosisNonExcess(x) as number, 1.5, 1e-12);
    assert.equal(skew(x.slice(0, 29)), null);
    assert.equal(kurtosisNonExcess(x.slice(0, 29)), null);
    assert.equal(skew(Array(40).fill(3)), null);
    assert.equal(tStatMean(Array(5).fill(3)), null);
    assert.equal(tStatMean([1]), null);
  });

  it('NaN or infinite input throws E_INPUT; an empty mean throws', () => {
    for (const bad of [[1, Number.NaN], [Infinity, 1]]) {
      assert.throws(() => mean(bad), /E_INPUT/);
      assert.throws(() => skew(bad), /E_INPUT/);
      assert.throws(() => stationaryBootstrapMeanCi(bad, { resamples: 10_000, level: 0.95, rng: createRng(1) }), /E_INPUT/);
      assert.throws(() => dayClusterMeanCi(bad, ['a', 'b']), /E_INPUT/);
    }
    assert.throws(() => mean([]), /E_INPUT/);
  });

  it('normInv matches tabulated values (logic 11)', () => {
    close(normalQuantile(0.95), 1.6448536, 1e-7);
    close(normalQuantile(0.975), 1.959964, 1e-6);
    close(normalQuantile(0.8), 0.8416212, 1e-7);
    assert.equal(normalQuantile(0.5), 0);
    close(normalQuantile(0.05), -1.6448536, 1e-7);
    assert.equal(stats.normInv, normalQuantile);
  });
});

describe('Sharpe statistics', () => {
  it("Lo's IID standard error √((1 + SR²/2)/T)", () => {
    close(loSharpeSe(0.1, 100), Math.sqrt(1.005 / 100), 1e-15);
  });

  it('PSR hand-computed', () => {
    // SR 0.1, ref 0, n 101, normal moments: Φ(0.1·10 / √(1 + 0.5·0.01)) = Φ(0.997509...)
    close(psr(0.1, 0, 101, 0, 3), 0.8407, 1e-4);
    assert.throws(() => psr(1, 0, 10, 5, 1), /E_INPUT/);                 // 1 − 5 + 0 ≤ 0
  });

  it('DSR reproduces the paper (V1): 0.9004 at N = 100, 0.9505 at N = 46, 0.9505 at N = 88 with normal returns; SR0 ≈ 0.1132', () => {
    const sr = 2.5 / Math.sqrt(250), v = 0.5 / 250;
    close(expectedMaxSharpe(100, v), 0.1132, 5e-5, 'SR0');
    close(dsrFromVariance(sr, 100, v, 1_250, -3, 10), 0.9004, 5e-5, 'N=100');
    close(dsrFromVariance(sr, 46, v, 1_250, -3, 10), 0.9505, 5e-5, 'N=46');
    close(dsrFromVariance(sr, 88, v, 1_250, 0, 3), 0.9505, 5e-5, 'N=88');
  });

  it('dsr from trial Sharpe ratios uses their sample variance when it is above 1/(T − 1); one trial gives SR0 = 0', () => {
    const trials = [0.05, 0.1, 0.15];                                  // sample variance 0.0025 > 1/499
    close(dsr(0.15, trials, 500, 0, 3), dsrFromVariance(0.15, 3, 0.0025, 500, 0, 3), 1e-15);
    close(dsr(0.15, [0.15], 500, 0, 3), psr(0.15, 0, 500, 0, 3), 1e-15);
    assert.throws(() => dsr(0.1, [], 10, 0, 3), /E_INPUT/);
  });

  it('ruling Z06-1: V is floored at 1/(T − 1), so near-identical trials cannot remove the deflation', () => {
    const trials = [0.1, 0.1001, 0.1002, 0.1003];                    // sample variance ≈ 1.7e-8, far below 1/499
    const floored = dsrFromVariance(0.1003, 4, 1 / 499, 500, 0, 3);
    const unfloored = dsrFromVariance(0.1003, 4, 1.6666666666666667e-8, 500, 0, 3);
    close(dsr(0.1003, trials, 500, 0, 3), floored, 1e-15);
    assert.ok(floored < unfloored - 0.05, `${floored} vs ${unfloored}`);   // without the floor the DSR would be far higher
  });

  it('MinTRL reproduces ARCH: 1,085 / 273 / 70 trades at per-trade Sharpe 0.05 / 0.10 / 0.20 (skew 0, kurtosis 3), ±1', () => {
    close(minTrl(0.05, 0, 0, 3) as number, 1_085, 1);
    close(minTrl(0.1, 0, 0, 3) as number, 273, 1);
    close(minTrl(0.2, 0, 0, 3) as number, 70, 1);
    assert.equal(minTrl(0.1, 0.1, 0, 3), null);
  });

  it('MinBTL reproduces the paper (A-44): 4.998 years for N = 45 and 1.923 for N = 7 at E[max] = 1; N = 1 needs none', () => {
    close(minBtlYears(45, 1), 4.998, 5e-4);
    close(minBtlYears(7, 1), 1.923, 5e-4);
    assert.equal(minBtlYears(1, 2), 0);
  });

  it('the ARCH 3.4 trial budget table (largest N with MinBTL ≤ window)', () => {
    const table: Array<[number, number, number, number]> = [[14, 1, 2, 3], [30, 2, 3, 7], [60, 2, 5, 26], [91, 3, 8, 90]];
    for (const [days, s2, s3, s5] of table) {
      assert.deepEqual([2, 3, 5].map((s) => maxTrialsForWindow(daysToYears(days), s)), [s2, s3, s5], `${days} days`);
    }
  });
});

describe('Wilson interval', () => {
  // Newcombe (1998), "Two-sided confidence intervals for the single proportion: comparison of seven methods",
  // Statistics in Medicine 17:857-872, the score method's worked examples (values recalled, not re-read from the paper
  // in this session; all eight reproduce to four decimals).
  const refs: Array<[number, number, number, number]> = [[81, 263, 0.2553, 0.3662], [15, 148, 0.0624, 0.1605], [0, 20, 0, 0.1611], [1, 29, 0.0061, 0.1718]];
  for (const [k, n, lo, hi] of refs) {
    it(`${k}/${n} gives ${lo}-${hi}`, () => {
      const w = wilson(k, n);
      close(w.low, lo, 5e-5);
      close(w.high, hi, 5e-5);
    });
  }
  it('refuses k > n and n = 0', () => {
    assert.throws(() => wilson(3, 2), /E_INPUT/);
    assert.throws(() => wilson(0, 0), /E_INPUT/);
  });
});

describe('CSCV probability of backtest overfitting', () => {
  const matrix = (seed: number, configs: number, days: number, edge: (j: number) => number): number[][] => {
    const r = createRng(seed);
    return Array.from({ length: configs }, (_, j) => normals(r.nextU32(), days, edge(j), 1));
  };

  it('one configuration dominating both halves gives PBO near 0', () => {
    assert.ok(cscvPbo(matrix(1, 6, 160, (j) => (j === 0 ? 1 : 0)), 16) < 0.05);
  });

  it('pure noise gives PBO near 0.5 (mean over 20 noise matrices; one matrix alone varies widely)', () => {
    const runs = Array.from({ length: 20 }, (_, k) => cscvPbo(matrix(100 + k, 20, 320, () => 0), 16));
    const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
    assert.ok(avg > 0.4 && avg < 0.6, String(avg));
  });

  it('needs at least 4 configurations and 16 days; extra oldest rows are dropped (V2)', () => {
    assert.throws(() => cscvPbo(matrix(3, 3, 64, () => 0), 16), /at least 4/);
    assert.throws(() => cscvPbo(matrix(3, 4, 15, () => 0), 16), /16 days/);
    const m = matrix(4, 5, 64, (j) => j * 0.05);
    const withOld = m.map((col, j) => [j === 0 ? 1_000 : -1_000, ...col]);
    assert.equal(cscvPbo(withOld, 16), cscvPbo(m, 16));
  });

  it('rank stability: the first-half winner must also win the second half', () => {
    assert.deepEqual(rankStability([[1, 1, 1, 1], [0, 0, 0, 0]]), { selectedFirstHalf: 0, stillBestSecondHalf: true });
    assert.deepEqual(rankStability([[1, 1, 0, 0], [0, 0, 1, 1]]), { selectedFirstHalf: 0, stillBestSecondHalf: false });
    assert.deepEqual(rankStability([[1, 1, 1, 1], [1, 1, 0, 0]]).stillBestSecondHalf, false);   // a first-half tie is not stable
    assert.deepEqual(rankStability([[9, 1, 1, 0, 0], [9, 0, 0, 1, 1]]), { selectedFirstHalf: 0, stillBestSecondHalf: false });   // oldest dropped
  });
});

describe('intervals', () => {
  it('stationary bootstrap: reproducible, b = round(n^(1/3)), the reported run is one of b/2, b, 2b; POLICY enforced', () => {
    const x = normals(5, 125, 0.1);
    assert.equal(policyMeanBlock(125), 5);
    const a = stationaryBootstrapMeanCi(x, { resamples: 10_000, level: 0.95, rng: createRng(1) });
    const b = stationaryBootstrapMeanCi(x, { resamples: 10_000, level: 0.95, rng: createRng(1) });
    assert.deepEqual(a, b);
    assert.ok(a !== null && [2.5, 5, 10].includes(a.meanBlockUsed));
    assert.ok(a !== null && a.low < mean(x) && mean(x) < a.high);
    assert.equal(stationaryBootstrapMeanCi(Array(50).fill(1), { resamples: 10_000, level: 0.95, rng: createRng(1) }), null);
    assert.throws(() => stationaryBootstrapMeanCi(x, { resamples: 2_000 as 10_000, level: 0.95, rng: createRng(1) }), /POLICY/);
  });

  it('the reported bootstrap interval has the lowest lower bound of the three runs (C-34)', () => {
    const x = normals(6, 200, 0.05);
    const runs = stationaryBootstrapRuns(x, { resamples: 10_000, level: 0.95, rng: createRng(2) });
    const pick = stationaryBootstrapMeanCi(x, { resamples: 10_000, level: 0.95, rng: createRng(2) });
    assert.ok(runs !== null && pick !== null);
    if (runs !== null && pick !== null) {
      assert.deepEqual(runs.map((r) => r.meanBlockUsed), [3, 6, 12]);
      assert.equal(pick.low, Math.min(...runs.map((r) => r.low)));
      assert.deepEqual(pick, runs.find((r) => r.low === pick.low));
    }
  });

  it('day-cluster t-interval, hand-computed: x = 1..6 on three days', () => {
    const c = dayClusterMeanCi([1, 2, 3, 4, 5, 6], ['a', 'a', 'b', 'b', 'c', 'c']);
    assert.ok(c !== null);
    if (c !== null) {
      close(c.estimate, 3.5, 1e-15);
      close(c.se, Math.sqrt(4 / 3), 1e-12);
      close(c.low, 3.5 - 4.302653 * Math.sqrt(4 / 3), 1e-5);
      close(c.high, 3.5 + 4.302653 * Math.sqrt(4 / 3), 1e-5);
      close(c.deff, (4 / 3) / (3.5 / 6), 1e-12);
    }
    assert.equal(dayClusterMeanCi([1, 2, 3], ['a', 'a', 'a']), null);   // one day
    assert.throws(() => dayClusterMeanCi([1, 2], ['a']), /one day key/);
  });

  it('the gate interval is the one with the lower lower bound, and reports DEFF', () => {
    const r = createRng(8), x: number[] = [], days: string[] = [];
    for (let d = 0; d < 20; d++) { const e = normals(r.nextU32(), 1)[0] as number; for (let i = 0; i < 6; i++) { x.push(e + (normals(r.nextU32(), 1)[0] as number)); days.push(`d${d}`); } }
    const g = gateMeanCi(x, days, { rng: createRng(9) });
    assert.ok(g !== null);
    if (g !== null) {
      assert.equal(g.low, Math.min(g.bootstrap.low, g.cluster.low));
      assert.equal(g.chosen, g.cluster.low <= g.bootstrap.low ? 'day_cluster_t' : 'stationary_bootstrap');
      assert.equal(g.deff, g.cluster.deff);
      assert.ok(g.deff > 1);
    }
    assert.equal(gateMeanCi([1, 2, 3], ['a', 'a', 'a'], { rng: createRng(1) }), null);
  });

  it('non-inferiority lower bound: near the true difference, reproducible, null for constant series', () => {
    const paper = normals(10, 300, 0.02, 0.1), live = normals(11, 120, 0.02, 0.1);
    const lb = nonInferiorityLowerBound(live, paper, { level: 0.95, rng: createRng(3) });
    assert.ok(lb !== null && lb < mean(live) - mean(paper) && lb > mean(live) - mean(paper) - 0.1, String(lb));
    assert.equal(lb, nonInferiorityLowerBound(live, paper, { level: 0.95, rng: createRng(3) }));
    assert.equal(nonInferiorityLowerBound(Array(10).fill(0), paper, { level: 0.95, rng: createRng(3) }), null);
  });

  it('studentized Sharpe-difference interval: excludes 0 for a clearly better series, contains 0 for equal ones', () => {
    const base = normals(20, 400, 0, 1), noise = normals(21, 400, 0, 0.3);
    const better = base.map((v, i) => v + 0.5 + (noise[i] as number));
    const same = base.map((v, i) => v + (noise[i] as number));
    const d1 = studentizedTsBootstrapSharpeDiff(better, base, { resamples: 2_000, rng: createRng(4) });
    const d0 = studentizedTsBootstrapSharpeDiff(same, base, { resamples: 2_000, rng: createRng(4) });
    assert.ok(d1 !== null && d1.low > 0, JSON.stringify(d1));
    assert.ok(d0 !== null && d0.low < 0 && d0.high > 0, JSON.stringify(d0));
    assert.throws(() => studentizedTsBootstrapSharpeDiff([1, 2, 3], [1, 2], { resamples: 2_000, rng: createRng(1) }), /paired/);
    assert.equal(studentizedTsBootstrapSharpeDiff([1, 2, 3], [1, 2, 4], { resamples: 2_000, rng: createRng(1) }), null);
  });
});
