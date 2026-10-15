// Z01-COV: every remaining branch of the pure statistics files (SPEC-B Common DoD #8, ARCH 16.1: 100% branch coverage for
// pure functions). Input-validation throws, the edge cases the main suite leaves out, and both sides of each selection.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { createRng } from '../../src/m10/rng.ts';
import { checkFinite, kurtosisNonExcess, mean, quantileSorted, sampleVariance, skew, tStatMean } from '../../src/m13/stats/descriptive.ts';
import {
  dayClusterMeanCi, gateMeanCi, nonInferiorityLowerBound, policyMeanBlock, stationaryBootstrapMeanCi, stationaryBootstrapRuns,
  studentizedTsBootstrapSharpeDiff, wilson,
} from '../../src/m13/stats/intervals.ts';
import { cscvPbo, rankStability } from '../../src/m13/stats/pbo.ts';
import {
  daysToYears, dsr, expectedMaxSharpe, loSharpeSe, maxTrialsForWindow, minBtlYears, minTrl, psr,
} from '../../src/m13/stats/sharpe.ts';
import {
  incompleteBeta, incompleteGammaUpper, logGamma, normalCdf, normalPdf, normalQuantile, studentTCdf, studentTQuantile,
} from '../../src/m13/stats/special.ts';

const close = (a: number, b: number, tol: number): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const normals = (seed: number, n: number, mu = 0, sd = 1): number[] => {
  const r = createRng(seed);
  return Array.from({ length: n }, () => mu + sd * Math.sqrt(-2 * Math.log(1 - r.nextFloat())) * Math.cos(2 * Math.PI * r.nextFloat()));
};
const O = (seed = 1) => ({ resamples: 10_000 as const, level: 0.95 as const, rng: createRng(seed) });
const DAYS = (n: number, per: number): string[] => Array.from({ length: n }, (_, i) => `2026-10-${String(1 + Math.floor(i / per)).padStart(2, '0')}`);

describe('descriptive: remaining branches', () => {
  it('checkFinite refuses a non-array and a non-number', () => {
    assert.throws(() => checkFinite('abc' as unknown as number[]), TypeError);
    assert.throws(() => checkFinite(['1'] as unknown as number[], 'x'), /E_INPUT: x holds/);
    assert.throws(() => mean(Number.NaN as unknown as number[]), TypeError);
  });
  it('a constant series of 30 or more gives null kurtosis', () => {
    assert.equal(kurtosisNonExcess(Array(30).fill(2)), null);
    assert.equal(skew(Array(30).fill(2)), null);
  });
  it('sampleVariance is null for one value and a constant, a number otherwise', () => {
    assert.equal(sampleVariance([1]), null);
    assert.equal(sampleVariance([2, 2, 2]), null);
    assert.equal(sampleVariance([1, 3]), 2);
    assert.equal(tStatMean([1, 3]), 2 / Math.sqrt(2 / 2));
  });
  it('quantileSorted at the ends and between order statistics', () => {
    assert.equal(quantileSorted([1, 2, 3, 4], 0), 1);
    assert.equal(quantileSorted([1, 2, 3, 4], 1), 4);
    assert.equal(quantileSorted([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(quantileSorted([7], 0.5), 7);
  });
});

describe('special functions: remaining branches', () => {
  it('logGamma: Lanczos on both sides of 0.5, and a refusal outside x > 0', () => {
    close(logGamma(1), 0, 1e-12);
    close(logGamma(5), Math.log(24), 1e-12);
    close(logGamma(0.25), Math.log(3.625609908221908), 1e-12);        // reflection branch, Γ(1/4) = 3.6256…
    for (const bad of [0, -1, Number.NaN]) assert.throws(() => logGamma(bad), RangeError);
  });
  it('incompleteBeta: parameter checks, the 0 and 1 ends, and both continued-fraction sides', () => {
    for (const [a, b] of [[0, 1], [1, 0], [-1, 1], [Number.NaN, 1]] as const) assert.throws(() => incompleteBeta(0.5, a, b), RangeError);
    assert.equal(incompleteBeta(0, 2, 3), 0);
    assert.equal(incompleteBeta(-1, 2, 3), 0);
    assert.equal(incompleteBeta(1, 2, 3), 1);
    assert.equal(incompleteBeta(2, 2, 3), 1);
    close(incompleteBeta(0.5, 2, 2), 0.5, 1e-12);                     // symmetric
    close(incompleteBeta(0.2, 2, 3), 0.1808, 1e-12);                  // x below (a+1)/(a+b+2): direct side
    close(incompleteBeta(0.9, 2, 3), 0.9963, 1e-12);                  // above: complement side
  });
  it('incompleteBeta refuses to return a value it did not converge to', () => {
    assert.throws(() => incompleteBeta(0.5, 1e7, 1e7), /did not converge/);           // direct side
    assert.throws(() => incompleteBeta(0.6000001, 1.5e7, 1e7), /did not converge/);   // complement side
  });
  it('incompleteGammaUpper: parameter check, x ≤ 0, the series side and the fraction side', () => {
    assert.throws(() => incompleteGammaUpper(0, 1), RangeError);
    assert.throws(() => incompleteGammaUpper(Number.NaN, 1), RangeError);
    assert.equal(incompleteGammaUpper(2, 0), 1);
    assert.equal(incompleteGammaUpper(2, -3), 1);
    close(incompleteGammaUpper(1, 0.5), Math.exp(-0.5), 1e-12);       // series: x < a + 1
    close(incompleteGammaUpper(1, 3), Math.exp(-3), 1e-12);           // fraction: x ≥ a + 1
  });
  it('incompleteGammaUpper refuses to return a value it did not converge to', () => {
    assert.throws(() => incompleteGammaUpper(1e8, 1e8), /series did not converge/);
    assert.throws(() => incompleteGammaUpper(1e8, 1e8 + 2), /fraction did not converge/);
  });
  it('normalPdf and normalCdf: centre, tails, NaN and the infinities', () => {
    close(normalPdf(0), 1 / Math.sqrt(2 * Math.PI), 1e-15);
    close(normalCdf(0), 0.5, 1e-15);
    close(normalCdf(1.96), 0.9750021, 1e-7);
    close(normalCdf(-1.96), 0.0249979, 1e-7);
    assert.ok(Number.isNaN(normalCdf(Number.NaN)));
    assert.equal(normalCdf(Infinity), 1);
    assert.equal(normalCdf(-Infinity), 0);
  });
  it('normalQuantile: ends, a refusal, the lower tail, the central region and the reflected upper half', () => {
    for (const bad of [-0.1, 1.1, Number.NaN]) assert.throws(() => normalQuantile(bad), RangeError);
    assert.equal(normalQuantile(0), -Infinity);
    assert.equal(normalQuantile(1), Infinity);
    close(normalQuantile(0.01), -2.3263479, 1e-7);                    // p below 0.02425
    close(normalQuantile(0.3), -0.5244005, 1e-7);                     // central
    close(normalQuantile(0.99), 2.3263479, 1e-7);
  });
  it('studentTCdf and studentTQuantile: refusals, symmetry, the median and both halves', () => {
    for (const df of [0, -1, Number.NaN]) assert.throws(() => studentTCdf(1, df), RangeError);
    close(studentTCdf(0, 5), 0.5, 1e-15);
    close(studentTCdf(2.015, 5) + studentTCdf(-2.015, 5), 1, 1e-12);
    for (const p of [0, 1, -1, 2, Number.NaN]) assert.throws(() => studentTQuantile(p, 5), RangeError);
    assert.equal(studentTQuantile(0.5, 5), 0);
    close(studentTQuantile(0.95, 5), 2.015048, 1e-5);
    close(studentTQuantile(0.05, 5), -2.015048, 1e-5);
    close(studentTQuantile(0.975, 1), 12.7062047, 1e-5);              // heavy tail: the bracket doubles several times
  });
});

describe('sharpe: remaining branches', () => {
  it('loSharpeSe refuses a non-number, a non-finite value and T below 1', () => {
    assert.throws(() => loSharpeSe(Number.NaN, 10), /E_INPUT/);
    assert.throws(() => loSharpeSe(1, Infinity), /E_INPUT/);
    assert.throws(() => loSharpeSe('1' as unknown as number, 10), /E_INPUT/);
    assert.throws(() => loSharpeSe(1, 0.5), /T must be >= 1/);
    close(loSharpeSe(0, 4), 0.5, 1e-15);
  });
  it('psr refuses a bad n and moments with a non-positive denominator', () => {
    assert.throws(() => psr(0.1, 0, 1, 0, 3), /integer >= 2/);
    assert.throws(() => psr(0.1, 0, 2.5, 0, 3), /integer >= 2/);
    assert.throws(() => psr(2, 0, 30, 5, 1), /non-positive PSR denominator/);
    close(psr(0.1, 0.1, 30, 0, 3), 0.5, 1e-12);
  });
  it('expectedMaxSharpe: refusals, one trial is zero, many trials are positive', () => {
    assert.throws(() => expectedMaxSharpe(0, 1), /integer >= 1/);
    assert.throws(() => expectedMaxSharpe(2.5, 1), /integer >= 1/);
    assert.throws(() => expectedMaxSharpe(5, -1), /variance must be >= 0/);
    assert.equal(expectedMaxSharpe(1, 4), 0);
    assert.ok(expectedMaxSharpe(10, 1) > 0);
  });
  it('dsr: refusals, one trial, and the 1/(n − 1) variance floor', () => {
    assert.throws(() => dsr(0.1, [], 30, 0, 3), /no trials/);
    assert.throws(() => dsr(0.1, [0.1], 1, 0, 3), /integer >= 2/);
    assert.throws(() => dsr(0.1, [Number.NaN], 30, 0, 3), /E_INPUT/);
    const one = dsr(0.1, [0.1], 30, 0, 3);                            // SR0 = 0
    close(one, psr(0.1, 0, 30, 0, 3), 1e-15);
    const flat = dsr(0.1, [0.5, 0.5, 0.5], 30, 0, 3);                 // sample variance null → floored
    assert.ok(flat < one);
    const spread = dsr(0.1, [0.1, 0.5, -0.4, 0.3], 30, 0, 3);        // sample variance above the floor
    assert.ok(spread < flat);
  });
  it('minTrl: refusals, null when sr ≤ srRef, a length otherwise', () => {
    assert.throws(() => minTrl(0.2, 0, 0, 3, 0 as unknown as 0.05), /alpha/);
    assert.throws(() => minTrl(0.2, 0, 0, 3, 1 as unknown as 0.05), /alpha/);
    assert.equal(minTrl(0.1, 0.1, 0, 3), null);
    assert.equal(minTrl(0.05, 0.1, 0, 3), null);
    assert.ok((minTrl(0.2, 0, 0, 3) as number) > 1);
  });
  it('minBtlYears and maxTrialsForWindow: refusals, N = 1, the window search and its floor', () => {
    assert.throws(() => minBtlYears(0, 1), /integer >= 1/);
    assert.throws(() => minBtlYears(1.5, 1), /integer >= 1/);
    assert.throws(() => minBtlYears(5, 0), /must be > 0/);
    assert.throws(() => minBtlYears(5, Number.NaN), /E_INPUT/);
    assert.equal(minBtlYears(1, 1), 0);
    close(minBtlYears(45, 1), 4.998, 1e-3);
    assert.throws(() => maxTrialsForWindow(-1, 1), /window must be >= 0/);
    assert.equal(maxTrialsForWindow(0, 1), 1);
    assert.equal(maxTrialsForWindow(5, 1), 45);
    close(daysToYears(365.25), 1, 1e-15);
  });
});

describe('pbo and rank stability: remaining branches', () => {
  const matrix = (cols: number, days: number, seed = 5): number[][] => Array.from({ length: cols }, (_, j) => normals(seed + j, days, 0, 0.01));
  it('cscvPbo refuses the wrong partition count, too few configurations, ragged and short matrices', () => {
    assert.throws(() => cscvPbo(matrix(4, 32), 8 as unknown as 16), /16 partitions/);
    assert.throws(() => cscvPbo(matrix(3, 32)), /at least 4 configurations/);
    assert.throws(() => cscvPbo('x' as unknown as number[][]), /at least 4 configurations/);
    assert.throws(() => cscvPbo([...matrix(3, 32), normals(9, 31)]), /same number of days/);
    assert.throws(() => cscvPbo([...matrix(3, 32), [...normals(9, 31), Number.NaN]]), /E_INPUT/);
    assert.throws(() => cscvPbo(matrix(4, 15)), /at least 16 days/);
  });
  it('cscvPbo scores zero-spread configurations by the sign of their mean', () => {
    const t = 16;
    const m = [Array(t).fill(0.5), Array(t).fill(-0.5), Array(t).fill(0), normals(3, t, 0, 0.01)];
    const p = cscvPbo(m);
    assert.ok(p >= 0 && p <= 1);
    // A lone best configuration that is also best out of sample is not overfit (ω high → λ > 0).
    const winners = [Array(t).fill(0.01), Array(t).fill(0.005), Array(t).fill(0.004), Array(t).fill(0.003)];
    assert.equal(cscvPbo(winners), 0);
  });
  it('cscvPbo drops the oldest rows when T is not a multiple of 16', () => {
    const a = matrix(4, 32), b = a.map((c) => [9, 9, 9, ...c]);        // three extra old rows
    assert.equal(cscvPbo(b), cscvPbo(a));
  });
  it('rankStability: refusals, a stable best, an unstable best, ties, and an odd number of days', () => {
    assert.throws(() => rankStability([[1]]), /at least 2 configurations/);
    assert.throws(() => rankStability([[1], [2]]), /at least 2 days/);
    assert.throws(() => rankStability([[1, 2], [1]]), /same number of days/);
    assert.deepEqual(rankStability([[3, 3, 3, 3], [1, 1, 1, 1], [2, 2, 2, 2]]), { selectedFirstHalf: 0, stillBestSecondHalf: true });
    assert.deepEqual(rankStability([[3, 3, 0, 0], [1, 1, 1, 1]]), { selectedFirstHalf: 0, stillBestSecondHalf: false });
    assert.deepEqual(rankStability([[1, 1, 1, 1], [1, 1, 0, 0]]), { selectedFirstHalf: 0, stillBestSecondHalf: false });   // first-half tie
    assert.deepEqual(rankStability([[0, 2, 2], [0, 1, 1]]), { selectedFirstHalf: 0, stillBestSecondHalf: true });         // odd: oldest dropped
    assert.deepEqual(rankStability([[0, 1, 1, 5], [2, 1, 1, 1]]), { selectedFirstHalf: 1, stillBestSecondHalf: false });
    assert.deepEqual(rankStability([[1, 1, 2, 2], [1, 1, 2, 2]]), { selectedFirstHalf: 0, stillBestSecondHalf: false });   // tie in both halves
  });
});

describe('intervals: remaining branches', () => {
  it('policyMeanBlock is at least 1 and follows the cube root', () => {
    assert.equal(policyMeanBlock(1), 1);
    assert.equal(policyMeanBlock(8), 2);
    assert.equal(policyMeanBlock(1000), 10);
  });
  it('stationaryBootstrapRuns refuses non-POLICY options and a mean block below 1; constant series are null', () => {
    const x = normals(2, 20);
    assert.throws(() => stationaryBootstrapRuns(x, { ...O(), resamples: 5 as unknown as 10_000 }), /POLICY/);
    assert.throws(() => stationaryBootstrapRuns(x, { ...O(), level: 0.9 as unknown as 0.95 }), /POLICY/);
    assert.throws(() => stationaryBootstrapRuns(x, { ...O(), meanBlock: 0.5 }), /mean block length/);
    assert.throws(() => stationaryBootstrapRuns(x, { ...O(), meanBlock: Number.NaN }), /mean block length/);
    assert.equal(stationaryBootstrapRuns(Array(10).fill(1), O()), null);
    assert.equal(stationaryBootstrapMeanCi([1], O()), null);
  });
  it('stationaryBootstrapRuns returns the b/2, b and 2b runs; a block of 1 is not halved below 1', () => {
    const runs = stationaryBootstrapRuns(normals(3, 30), { ...O(), meanBlock: 1 }) as { meanBlockUsed: number }[];
    assert.deepEqual(runs.map((r) => r.meanBlockUsed), [1, 1, 2]);
    const ci = stationaryBootstrapMeanCi(normals(3, 30), { ...O(), meanBlock: 4 });
    assert.ok(ci !== null && ci.low < ci.high && [2, 4, 8].includes(ci.meanBlockUsed));
  });
  it('dayClusterMeanCi: refusals and the null cases', () => {
    const x = normals(4, 8);
    assert.throws(() => dayClusterMeanCi(x, 'x' as unknown as string[]), /one day key per observation/);
    assert.throws(() => dayClusterMeanCi(x, DAYS(7, 1)), /one day key per observation/);
    assert.throws(() => dayClusterMeanCi(x, [...DAYS(7, 1), '2026-10-8']), /YYYY-MM-DD/);
    assert.throws(() => dayClusterMeanCi(x, [...DAYS(7, 1), 5 as unknown as string]), /YYYY-MM-DD/);
    assert.throws(() => dayClusterMeanCi(x, DAYS(8, 2), 0.9 as unknown as 0.95), /level is 0.95/);
    assert.equal(dayClusterMeanCi(Array(8).fill(1), DAYS(8, 2)), null);        // constant
    assert.equal(dayClusterMeanCi(x, DAYS(8, 8)), null);                       // one day
    assert.equal(dayClusterMeanCi([1, -1, 1, -1], ['2026-10-01', '2026-10-01', '2026-10-02', '2026-10-02']), null);   // day sums all equal θ·k
  });
  it('dayClusterMeanCi returns the CR1 interval for several days', () => {
    const r = dayClusterMeanCi(normals(5, 40, 0.1, 1), DAYS(40, 4)) as NonNullable<ReturnType<typeof dayClusterMeanCi>>;
    assert.equal(r.days, 10);
    assert.ok(r.low < r.estimate && r.estimate < r.high && r.se > 0 && r.deff > 0);
  });
  it('gateMeanCi: null when either interval is, and it picks the lower lower bound', () => {
    assert.equal(gateMeanCi(Array(8).fill(1), DAYS(8, 2), { rng: createRng(1) }), null);
    assert.equal(gateMeanCi(normals(4, 8), DAYS(8, 8), { rng: createRng(1) }), null);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12 && seen.size < 2; seed++) {
      const x = normals(seed, 60, 0.05, 1);
      const days = seed % 2 ? DAYS(60, 20) : DAYS(60, 1).map((_d, i) => `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`);
      const g = gateMeanCi(x, days, { rng: createRng(seed) }) as NonNullable<ReturnType<typeof gateMeanCi>>;
      assert.equal(g.low, g.chosen === 'day_cluster_t' ? g.cluster.low : g.bootstrap.low);
      assert.ok(g.low <= g.cluster.low && g.low <= g.bootstrap.low);
      seen.add(g.chosen);
    }
    assert.equal(seen.size, 2, 'both selections were exercised');
  });
  it('wilson: refusals and the clamped ends', () => {
    for (const [k, n] of [[1.5, 10], [1, 10.5], [1, 0], [-1, 10], [11, 10]] as const) assert.throws(() => wilson(k, n), /E_INPUT/);
    assert.throws(() => wilson(1, 10, 0.9 as unknown as 0.95), /level is 0.95/);
    assert.equal(wilson(0, 10).low, 0);
    assert.equal(wilson(10, 10).high, 1);
    const w = wilson(5, 10);
    assert.ok(w.low > 0 && w.high < 1);
  });
  it('nonInferiorityLowerBound: refusals, nulls, and a bound below the observed difference', () => {
    const live = normals(6, 30, 0.1), paper = normals(7, 30, 0.1);
    assert.throws(() => nonInferiorityLowerBound(live, paper, { level: 0.9 as unknown as 0.95, rng: createRng(1) }), /level is 0.95/);
    assert.throws(() => nonInferiorityLowerBound([Number.NaN], paper, { level: 0.95, rng: createRng(1) }), /E_INPUT/);
    assert.throws(() => nonInferiorityLowerBound(live, [Infinity], { level: 0.95, rng: createRng(1) }), /E_INPUT/);
    assert.equal(nonInferiorityLowerBound(Array(5).fill(1), paper, { level: 0.95, rng: createRng(1) }), null);
    assert.equal(nonInferiorityLowerBound(live, [1], { level: 0.95, rng: createRng(1) }), null);
    const lb = nonInferiorityLowerBound(live, paper, { level: 0.95, rng: createRng(1) }) as number;
    assert.ok(lb < mean(live) - mean(paper));
  });
  it('studentizedTsBootstrapSharpeDiff: refusals, nulls and an interval around the true difference', () => {
    const a = normals(8, 60, 0.2), b = normals(9, 60, 0);
    const o = { resamples: 1_000, rng: createRng(2) };
    assert.throws(() => studentizedTsBootstrapSharpeDiff([Number.NaN], b, o), /E_INPUT/);
    assert.throws(() => studentizedTsBootstrapSharpeDiff(a, [Infinity], o), /E_INPUT/);
    assert.throws(() => studentizedTsBootstrapSharpeDiff(a, b.slice(1), o), /paired/);
    for (const resamples of [999, 1000.5, Number.NaN]) assert.throws(() => studentizedTsBootstrapSharpeDiff(a, b, { ...o, resamples }), /resamples/);
    assert.equal(studentizedTsBootstrapSharpeDiff([1, 2, 3], [1, 2, 4], o), null);                // fewer than 4 rows
    assert.equal(studentizedTsBootstrapSharpeDiff(Array(8).fill(1), normals(1, 8), o), null);      // constant a
    assert.equal(studentizedTsBootstrapSharpeDiff(normals(1, 8), Array(8).fill(1), o), null);      // constant b
    // Rounding: the variance is positive but E[x²] − μ² is not (the full sample is degenerate) → null.
    const big = [1e9, 1e9 + 1, 1e9, 1e9 + 1, 1e9, 1e9 + 2];
    assert.equal(studentizedTsBootstrapSharpeDiff(big, normals(3, 6), o), null);
    assert.equal(studentizedTsBootstrapSharpeDiff(normals(3, 6), big, o), null);
    // More than 1% of the resamples are constant → null.
    assert.equal(studentizedTsBootstrapSharpeDiff([0, 0, 0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0, 0, 1, 0], o), null);
    // Extreme magnitudes: the standard error is not a positive number.
    assert.equal(studentizedTsBootstrapSharpeDiff([1e160, -1e160, 1e160, -1e160, 2e160, 1e160], normals(3, 6), o), null);
    const r = studentizedTsBootstrapSharpeDiff(a, b, o) as NonNullable<ReturnType<typeof studentizedTsBootstrapSharpeDiff>>;
    assert.ok(r.low < r.high);
  });
});
