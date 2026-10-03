// Known-value tests for the stats math: closed forms and published tables.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  bettingEProcess, betaQuantile, clopperPearsonInterval, clopperPearsonLower, clopperPearsonUpper, createRng,
  dayBlockMeanDiffInterval, dayBlockMeanInterval, deflatedSharpe, designEffect, expectedMaxSharpe, incompleteBeta,
  incompleteGammaUpper, kurtosis, logGamma, mean, meanPredictiveInterval, median, normalCdf, normalQuantile, nPower,
  probabilisticSharpe, probabilityOfBacktestOverfitting, quantileSorted, ratesConsistent, requiredHoldoutTrades,
  reverseEProcess, sd, sharpeRatio, skewness, studentTCdf, studentTQuantile, variance,
} from '../src/stats/index.ts';

describe('special functions', () => {
  test('log-gamma matches closed forms', () => {
    expect(logGamma(0.5)).toBeCloseTo(0.5 * Math.log(Math.PI), 13); // Γ(1/2) = √π
    expect(logGamma(1)).toBeCloseTo(0, 13);
    expect(logGamma(10)).toBeCloseTo(Math.log(362880), 12); // 9!
    expect(logGamma(0.1)).toBeCloseTo(2.252712651734206, 12); // Γ(0.1) = 9.513507698668732
  });
  test('incomplete beta and gamma match closed forms', () => {
    expect(incompleteBeta(0.3, 1, 1)).toBeCloseTo(0.3, 14); // uniform
    expect(incompleteBeta(0.3, 2.5, 1)).toBeCloseTo(0.3 ** 2.5, 14); // I_x(a, 1) = x^a
    expect(incompleteBeta(0.3, 1, 4)).toBeCloseTo(1 - 0.7 ** 4, 14); // I_x(1, b) = 1 − (1 − x)^b
    // Binomial identity: P(X ≥ 3 | n = 10, p = 0.2) = I_0.2(3, 8)
    let tail = 0;
    for (let k = 3; k <= 10; k++) tail += [1, 10, 45, 120, 210, 252, 210, 120, 45, 10, 1][k]! * 0.2 ** k * 0.8 ** (10 - k);
    expect(incompleteBeta(0.2, 3, 8)).toBeCloseTo(tail, 14);
    expect(incompleteGammaUpper(1, 2)).toBeCloseTo(Math.exp(-2), 14); // Q(1, x) = e^−x
    expect(incompleteGammaUpper(3, 5)).toBeCloseTo(Math.exp(-5) * (1 + 5 + 12.5), 14);
  });
  test('normal CDF and quantile match published values', () => {
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 14);
    expect(normalCdf(-1)).toBeCloseTo(0.15865525393145707, 14);
    expect(normalCdf(-8)).toBeCloseTo(6.22096057427178e-16, 25);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 12);
    expect(normalQuantile(0.95)).toBeCloseTo(1.6448536269514722, 12);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212335729143, 12);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.3263478740408408, 12);
    expect(normalQuantile(1e-10)).toBeCloseTo(-6.361340902404056, 10);
    for (const p of [1e-6, 0.02, 0.3, 0.5, 0.77, 0.999]) expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 14);
  });
  test('Student t matches published tables', () => {
    expect(studentTCdf(0, 5)).toBe(0.5);
    expect(studentTCdf(1, 1)).toBeCloseTo(0.75, 14); // Cauchy
    expect(studentTQuantile(0.975, 1)).toBeCloseTo(12.706204736174707, 9);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228138851986274, 11);
    expect(studentTQuantile(0.95, 29)).toBeCloseTo(1.699127026533497, 11);
    expect(studentTQuantile(0.05, 29)).toBeCloseTo(-1.699127026533497, 11);
  });
  test('beta quantile inverts the incomplete beta', () => {
    expect(betaQuantile(0.5, 1, 1)).toBeCloseTo(0.5, 14);
    expect(betaQuantile(0.95, 1, 30)).toBeCloseTo(1 - 0.05 ** (1 / 30), 14);
  });
});

describe('descriptive', () => {
  const xs = [1, 2, 3, 4, 10];
  test('moments and quantiles', () => {
    expect(mean(xs)).toBe(4);
    expect(variance(xs)).toBe(12.5);
    expect(sd(xs)).toBeCloseTo(Math.sqrt(12.5), 15);
    expect(skewness([1, 2, 3])).toBe(0);
    expect(kurtosis([-1, 1, -1, 1])).toBe(1); // two-point distribution
    expect(median(xs)).toBe(3);
    expect(quantileSorted([0, 10], 0.25)).toBe(2.5);
    expect(() => mean([])).toThrow(RangeError);
  });
});

describe('Clopper–Pearson', () => {
  test('one-sided 95% upper bounds match quant.md §5.5', () => {
    expect(clopperPearsonUpper(0, 30)).toBeCloseTo(0.095, 3);
    expect(clopperPearsonUpper(0, 100)).toBeCloseTo(0.0295, 4);
    expect(clopperPearsonUpper(1, 100)).toBeCloseTo(0.0466, 4);
    expect(clopperPearsonUpper(0, 300)).toBeCloseTo(0.0099, 4);
    expect(clopperPearsonUpper(3, 300)).toBeCloseTo(0.0256, 4);
  });
  test('closed forms at the edges', () => {
    expect(clopperPearsonUpper(0, 30)).toBeCloseTo(1 - 0.05 ** (1 / 30), 13);
    expect(clopperPearsonLower(30, 30)).toBeCloseTo(0.05 ** (1 / 30), 13);
    expect(clopperPearsonInterval(0, 10)).toEqual({ lower: 0, upper: expect.closeTo(1 - 0.025 ** 0.1, 13) });
    expect(clopperPearsonUpper(5, 5)).toBe(1);
    // Two-sided exact interval for 7/20 (published: 0.1539, 0.5922; Clopper & Pearson charts, also R binom.test)
    const ci = clopperPearsonInterval(7, 20);
    expect(ci.lower).toBeCloseTo(0.1539092, 6);
    expect(ci.upper).toBeCloseTo(0.5921885, 6);
    expect(() => clopperPearsonUpper(4, 3)).toThrow(RangeError);
  });
  test('rate comparison', () => {
    expect(ratesConsistent(100, 48, 2000, 960).consistent).toBe(true); // same rate
    expect(ratesConsistent(200, 48, 2000, 960).consistent).toBe(false); // double the rate
  });
});

describe('sample size', () => {
  test('n_power uses the 80% power correction (empirical.md audit #8)', () => {
    // ((z.975 + z.80)·σ/0.05)²: σ = 0.32 → 321.5 → 322; σ = 0.69 → 1494.6 → 1495 (ARCHITECTURE.md §14: ~321, ~1,500)
    expect(nPower(0.32, 0.05)).toBe(322);
    expect(nPower(0.69, 0.05)).toBe(1495);
    // Never smaller than the rounded (2.8·σ/effect)² the card states.
    for (const s of [0.2, 0.32, 0.5, 0.69, 1.8]) expect(nPower(s, 0.05)).toBeGreaterThanOrEqual(Math.ceil((2.8 * s / 0.05) ** 2));
    // The 1.96-only version has 50% power: about half.
    expect(nPower(0.32, 0.05, { power: 0.5 })).toBe(Math.ceil((1.959963984540054 * 0.32 / 0.05) ** 2));
  });
  test('holdout requirement and design effect', () => {
    expect(requiredHoldoutTrades(0.1)).toBe(300);
    expect(requiredHoldoutTrades(0.69)).toBe(1495);
    expect(designEffect(20, 0.05)).toBeCloseTo(1.95, 15); // quant.md §5.2 example
    expect(() => nPower(0, 0.05)).toThrow(RangeError);
  });
});

describe('predictive interval', () => {
  test('matches the closed form', () => {
    const pi = meanPredictiveInterval({ n: 11, mean: 0.05, sd: 0.3 }, 25, 0.95);
    const half = 2.228138851986274 * 0.3 * Math.sqrt(1 / 11 + 1 / 25);
    expect(pi.lower).toBeCloseTo(0.05 - half, 10);
    expect(pi.upper).toBeCloseTo(0.05 + half, 10);
    const wider = meanPredictiveInterval({ n: 11, mean: 0.05, sd: 0.3 }, 25, 0.95, 2);
    expect(wider.upper - wider.lower).toBeCloseTo((pi.upper - pi.lower) * Math.SQRT2, 10);
  });
});

describe('day-block bootstrap', () => {
  const trades = [
    { day: 'b', rNet: 0.2 }, { day: 'a', rNet: -0.1 }, { day: 'a', rNet: 0.3 }, { day: 'c', rNet: 0.0 }, { day: 'c', rNet: 0.1 },
  ];
  test('is deterministic for a seed and independent of input order', () => {
    const a = dayBlockMeanInterval(trades, 0.9, 'two', { rng: createRng(7), replicates: 500 });
    const b = dayBlockMeanInterval([...trades].reverse(), 0.9, 'two', { rng: createRng(7), replicates: 500 });
    expect(a).toEqual(b);
    expect(a.mean).toBeCloseTo(0.1, 15);
    expect(a.days).toBe(3);
    expect(a.lower).toBeLessThanOrEqual(a.upper);
  });
  test('replicates are rescaled by √(D/(D − 1)) around the estimate (few-days correction)', () => {
    // Two one-trade days, 0 and 1: raw replicate means are 0, 0.5 or 1; rescaled 0.5 ∓ √2·0.5.
    const ci = dayBlockMeanInterval([{ day: 'a', rNet: 0 }, { day: 'b', rNet: 1 }], 0.99, 'two', { rng: createRng(1), replicates: 1000 });
    expect(ci.lower).toBeCloseTo(0.5 - Math.SQRT2 * 0.5, 12);
    expect(ci.upper).toBeCloseTo(0.5 + Math.SQRT2 * 0.5, 12);
  });
  test('a constant difference gives a zero-width paired interval', () => {
    const control = trades.map((t) => ({ day: t.day, rNet: t.rNet - 0.04 }));
    const d = dayBlockMeanDiffInterval(trades, control, 0.95, 'lower', { rng: createRng(3), replicates: 200 });
    expect(d.mean).toBeCloseTo(0.04, 15);
    expect(d.lower).toBeCloseTo(0.04, 12);
  });
  test('needs two days', () => {
    expect(() => dayBlockMeanInterval([{ day: 'a', rNet: 1 }, { day: 'a', rNet: 2 }], 0.95, 'two', { rng: createRng(1) })).toThrow(RangeError);
  });
});

describe('e-process', () => {
  test('wealth follows Π(1 + λ_t·x_t) with a predictable plug-in bet', () => {
    const xs = [0.2, 0.1, -0.1, 0.3];
    const r = bettingEProcess(xs);
    // t = 1, 2: no history → λ = 0. t = 3: μ̂ = 0.15, mean(x²) = 0.025 → λ = 6 → clipped to 0.5.
    // t = 4: μ̂ = 0.0667, mean(x²) = 0.02 → 3.33 → 0.5.
    expect(r.wealth[0]).toBe(1);
    expect(r.wealth[1]).toBe(1);
    expect(r.wealth[2]).toBeCloseTo(0.95, 15);
    expect(r.wealth[3]).toBeCloseTo(0.95 * 1.15, 14);
    expect(r.crossedAt).toBeNull();
  });
  test('never bets on a negative mean and rejects returns below the floor', () => {
    const r = bettingEProcess([-0.1, -0.2, -0.1, -0.3, 0.5]);
    expect(r.finalWealth).toBe(1);
    expect(() => bettingEProcess([-1.2])).toThrow(RangeError);
    expect(bettingEProcess([-1.2], { lowerBound: -1.5 }).finalWealth).toBe(1);
  });
  test('reverse process crosses on persistent losses', () => {
    const r = reverseEProcess(Array.from({ length: 60 }, () => -0.2), { cap: 0.3 });
    expect(r.crossedAt).not.toBeNull();
    expect(r.maxWealth).toBeGreaterThanOrEqual(20);
    expect(bettingEProcess(Array.from({ length: 60 }, () => -0.2)).maxWealth).toBe(1);
  });
});

describe('Sharpe, PSR, DSR', () => {
  test('expected max Sharpe matches the quant.md §2.4 table (V = 1/n)', () => {
    expect(expectedMaxSharpe(10, 1 / 100)).toBeCloseTo(0.157, 3);
    expect(expectedMaxSharpe(72, 1 / 100)).toBeCloseTo(0.241, 3);
    expect(expectedMaxSharpe(500, 1 / 100)).toBeCloseTo(0.305, 3);
    expect(expectedMaxSharpe(72, 1 / 300)).toBeCloseTo(0.139, 3);
    expect(expectedMaxSharpe(500, 1 / 1000)).toBeCloseTo(0.097, 3);
    expect(expectedMaxSharpe(1, 1)).toBe(0);
  });
  test('PSR closed form', () => {
    const xs = [0.1, -0.05, 0.2, 0.0, 0.15, -0.1, 0.05];
    const sr = sharpeRatio(xs);
    const g3 = skewness(xs);
    const g4 = kurtosis(xs);
    const expected = normalCdf(((sr - 0.1) * Math.sqrt(6)) / Math.sqrt(1 - g3 * sr + ((g4 - 1) / 4) * sr * sr));
    expect(probabilisticSharpe(xs, 0.1)).toBeCloseTo(expected, 15);
    expect(probabilisticSharpe(xs, sr)).toBeCloseTo(0.5, 15);
  });
  test('DSR deflates by the registry size', () => {
    const rng = createRng(11);
    const xs = Array.from({ length: 200 }, () => 0.04 + 0.3 * (rng.next() - 0.5) * Math.sqrt(12));
    const small = deflatedSharpe(xs, [{ trialId: 'a', sharpe: 0.1, nTrades: 200 }, { trialId: 'b', sharpe: 0.2, nTrades: 200 }]);
    const registry = Array.from({ length: 100 }, (_, i) => ({ trialId: `t${i}`, sharpe: 0.15 + 0.07 * Math.sin(i), nTrades: 200 }));
    const big = deflatedSharpe(xs, registry);
    expect(big.trials).toBe(100);
    expect(big.benchmarkSharpe).toBeGreaterThan(small.benchmarkSharpe);
    expect(big.dsr).toBeLessThan(small.dsr);
    expect(() => deflatedSharpe(xs, [])).toThrow(RangeError);
    expect(() => deflatedSharpe(xs, [{ trialId: 'a', sharpe: 1, nTrades: 1 }, { trialId: 'a', sharpe: 1, nTrades: 1 }])).toThrow(RangeError);
  });
});

describe('PBO (CSCV)', () => {
  test('C(16, 8) = 12,870 splits (paper example)', () => {
    const rng = createRng(5);
    const trials = Array.from({ length: 3 }, () => Array.from({ length: 32 }, () => rng.next() - 0.5));
    expect(probabilityOfBacktestOverfitting(trials, { blocks: 16 }).combinations).toBe(12870);
  });
  test('a trial that is best in every block has PBO 0', () => {
    const rng = createRng(6);
    const base = Array.from({ length: 40 }, () => rng.next() - 0.5);
    const trials = [base.map((x) => x + 1), base, base.map((x) => x - 0.5), base.map((x) => x * 0.5 - 1)];
    expect(probabilityOfBacktestOverfitting(trials, { blocks: 8, metric: 'mean' }).pbo).toBe(0);
  });
  test('a winner that always reverses has PBO 1', () => {
    // Trial A wins the first half of blocks and loses the second; B the opposite. Every IS winner loses OOS
    // when the IS set is drawn from one side; balanced splits tie and count against the winner.
    const a = [...Array(8).fill(1), ...Array(8).fill(-1)];
    const b = a.map((x) => -x);
    const r = probabilityOfBacktestOverfitting([a, b], { blocks: 2, metric: 'mean' });
    expect(r.pbo).toBe(1);
  });
  test('noise gives PBO near 0.5', () => {
    const rng = createRng(8);
    const trials = Array.from({ length: 20 }, () => Array.from({ length: 64 }, () => rng.next() - 0.5));
    const r = probabilityOfBacktestOverfitting(trials, { blocks: 16 });
    expect(r.pbo).toBeGreaterThan(0.3);
    expect(r.pbo).toBeLessThan(0.7);
  });
});

describe('rng', () => {
  test('same seed, same sequence; values in [0, 1)', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const xa = Array.from({ length: 1000 }, () => a.next());
    expect(Array.from({ length: 1000 }, () => b.next())).toEqual(xa);
    expect(Array.from({ length: 1000 }, () => c.next())).not.toEqual(xa);
    expect(Math.min(...xa)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xa)).toBeLessThan(1);
    expect(Math.abs(mean(xa) - 0.5)).toBeLessThan(0.03);
  });
});

describe('purity and isolation', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const statsDir = join(here, '../src/stats');
  const coreSrc = join(here, '../src');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

  test('stats code has no I/O, clock, global randomness or outside imports', () => {
    const files = walk(statsDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/Date\.now|new Date|Math\.random|performance\.now|\bprocess\.|globalThis|fetch\(|require\(/);
      for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) expect(m[1], `${f} imports ${m[1]}`).toMatch(/^\.\/[\w-]+\.ts$/);
      expect(src, f).not.toMatch(/\bimport\s*\(/);
    }
  });

  test('no core module outside stats and the ledger imports the labels or gates', () => {
    // The engine decides blind; labels are scored after it (CLAUDE.md "Backtests are blind").
    const files = walk(coreSrc).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const rel = relative(coreSrc, f);
      if (rel.startsWith('stats/') || rel.startsWith('ledger/')) continue;
      const src = readFileSync(f, 'utf8');
      expect(src, rel).not.toMatch(/from\s+['"][^'"]*stats[^'"]*['"]/);
    }
  });
});
