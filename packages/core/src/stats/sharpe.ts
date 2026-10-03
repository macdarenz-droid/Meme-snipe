// Probabilistic and deflated Sharpe ratios on per-trade returns (quant.md §2.4).
// PSR: Bailey & López de Prado, "The Sharpe Ratio Efficient Frontier", J. Risk 15(2), 2012.
// DSR and the expected maximum Sharpe of N trials: Bailey & López de Prado, "The Deflated Sharpe Ratio",
// J. Portfolio Management 40(5):94–107, 2014 (https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf).

import { kurtosis, mean, sd, skewness, variance } from './descriptive.ts';
import { DEFAULT_REPLICATES } from './bootstrap.ts';
import { nextInt, type Rng } from './rng.ts';
import { normalCdf, normalQuantile } from './special.ts';
import { clusterTrials } from './trials.ts';

const EULER_GAMMA = 0.5772156649015329;

/** Per-trade Sharpe ratio: mean / sample SD. */
export const sharpeRatio = (returns: readonly number[]): number => {
  const s = sd(returns);
  if (s === 0) throw new RangeError('Sharpe ratio is undefined when every return is equal');
  return mean(returns) / s;
};

/** The moments PSR reads: the Sharpe ratio of n returns, their skewness and (non-excess) kurtosis. */
export interface SharpeMoments {
  readonly sharpe: number;
  readonly n: number;
  readonly skewness: number;
  readonly kurtosis: number;
}

/**
 * Kurtosis floor for the clamped PSR, registered before any data (STATS-1c, ruling C): the normal distribution's 3.
 * Raising it is stricter.
 */
export const DSR_KURTOSIS_FLOOR = 3;

/**
 * Clamp the moments while the DSR gates G1 (tighten-only, ruling C): skewness to min(sample, 0) and kurtosis to
 * max(sample, DSR_KURTOSIS_FLOOR). For a positive Sharpe both can only widen the PSR denominator, so a pass can only
 * become harder; a PSR below 0.5 stays below 0.5.
 */
export const clampMoments = (m: SharpeMoments, kurtosisFloor = DSR_KURTOSIS_FLOOR): SharpeMoments => ({
  ...m, skewness: Math.min(m.skewness, 0), kurtosis: Math.max(m.kurtosis, kurtosisFloor),
});

export const sharpeMoments = (returns: readonly number[]): SharpeMoments => {
  if (returns.length < 3) throw new RangeError('PSR needs at least three returns');
  return { sharpe: sharpeRatio(returns), n: returns.length, skewness: skewness(returns), kurtosis: kurtosis(returns) };
};

/**
 * PSR(SR*) = Φ( (SR̂ − SR*)·√(T − 1) / √(1 − γ₃·SR̂ + (γ₄ − 1)/4 · SR̂²) ), with γ₃ the skewness and γ₄ the
 * (non-excess) kurtosis of the T returns.
 */
export const psrFromMoments = (m: SharpeMoments, benchmarkSharpe: number): number => {
  const sr = m.sharpe;
  const denom = 1 - m.skewness * sr + ((m.kurtosis - 1) / 4) * sr * sr;
  if (!(denom > 0)) throw new RangeError('PSR denominator is not positive');
  return normalCdf(((sr - benchmarkSharpe) * Math.sqrt(m.n - 1)) / Math.sqrt(denom));
};

export const probabilisticSharpe = (returns: readonly number[], benchmarkSharpe: number, opts: { readonly clamp?: boolean } = {}): number => {
  const m = sharpeMoments(returns);
  return psrFromMoments(opts.clamp ? clampMoments(m) : m, benchmarkSharpe);
};

/**
 * Expected maximum Sharpe ratio among N independent trials whose Sharpe ratios have variance V, when every
 * true Sharpe is zero: SR* = √V · ((1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))). With one trial there is no selection.
 */
export const expectedMaxSharpe = (trials: number, sharpeVariance: number): number => {
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError(`trials must be an integer >= 1, got ${trials}`);
  if (!(sharpeVariance >= 0)) throw new RangeError('sharpeVariance must be >= 0');
  if (trials === 1) return 0;
  return (
    Math.sqrt(sharpeVariance) *
    ((1 - EULER_GAMMA) * normalQuantile(1 - 1 / trials) + EULER_GAMMA * normalQuantile(1 - 1 / (trials * Math.E)))
  );
};

/** One row of the experiment registry: every rule, threshold, barrier and feature set ever evaluated. */
export interface TrialRecord {
  readonly trialId: string;
  /** The executable configuration the trial ran (default: its trial id). Repeated runs of one configuration share it. */
  readonly configId?: string;
  /** Per-trade Sharpe ratio the trial reached on the data it was evaluated on. */
  readonly sharpe: number;
  readonly nTrades: number;
}

export interface DeflatedSharpe {
  readonly dsr: number;
  readonly sharpe: number;
  readonly benchmarkSharpe: number;
  readonly trials: number;
  readonly sharpeVariance: number;
}

/**
 * Deflated Sharpe ratio of the selected trial's returns against the whole registry: N is the registry size and V
 * the variance of the registry's Sharpe ratios, floored at 1/(T − 1). Every registered trial counts; none may be left out.
 */
export const deflatedSharpe = (
  selectedReturns: readonly number[],
  registry: readonly TrialRecord[],
  opts: { readonly clamp?: boolean } = {},
): DeflatedSharpe => {
  if (registry.length === 0) throw new RangeError('the experiment registry is empty');
  const ids = new Set(registry.map((t) => t.trialId));
  if (ids.size !== registry.length) throw new RangeError('the experiment registry has duplicate trial ids');
  for (const t of registry) if (!Number.isFinite(t.sharpe)) throw new RangeError(`trial ${t.trialId} has no finite Sharpe`);
  // Floor V at the sampling variance of a Sharpe ratio under the null, 1/(T − 1): near-identical trials would otherwise
  // give V ≈ 0 and remove the deflation (review of PR #8). The floor only makes the DSR stricter.
  const sampleVar = registry.length > 1 ? variance(registry.map((t) => t.sharpe)) : 0;
  const sharpeVariance = Math.max(sampleVar, 1 / (selectedReturns.length - 1));
  const benchmarkSharpe = expectedMaxSharpe(registry.length, sharpeVariance);
  return {
    dsr: probabilisticSharpe(selectedReturns, benchmarkSharpe, opts),
    sharpe: sharpeRatio(selectedReturns),
    benchmarkSharpe,
    trials: registry.length,
    sharpeVariance,
  };
};

/** DSR from summary moments (for the paper's worked example and for reports): SR₀ from N and V, then PSR(SR₀). */
export const deflatedSharpeFromMoments = (m: SharpeMoments, trials: number, sharpeVariance: number): number =>
  psrFromMoments(m, expectedMaxSharpe(trials, sharpeVariance));

/** One DSR line: N trials, V across the given Sharpe ratios floored at 1/(T − 1), T the number of days. */
export interface DsrLine {
  readonly dsr: number;
  readonly benchmarkSharpe: number;
  readonly trials: number;
  readonly sharpeVariance: number;
}

export interface DailyDeflatedSharpe {
  /** Day-level Sharpe of the selected trial (mean / SD of its daily P&L). */
  readonly sharpe: number;
  readonly days: number;
  /** The gate's line: N = every registered trial. */
  readonly raw: DsrLine;
  /**
   * Diagnostic: repeated runs of one executable configuration (same config id) count once. Different configurations
   * stay distinct hypotheses even when their returns are identical or perfectly correlated.
   */
  readonly deduplicated: DsrLine;
  /** Diagnostic: the effective-N sensitivity line (trials.ts); never the gate. */
  readonly effective: DsrLine & { readonly clusters: number };
}

/** Day-level Sharpe; a constant series (a trial that never moved) has Sharpe 0. */
const dailySharpe = (xs: readonly number[]): number => (sd(xs) > 0 ? sharpeRatio(xs) : 0);

const line = (selected: readonly number[], trials: number, sharpes: readonly number[]): DsrLine => {
  const sharpeVariance = Math.max(sharpes.length > 1 ? variance(sharpes) : 0, 1 / (selected.length - 1));
  const benchmarkSharpe = expectedMaxSharpe(trials, sharpeVariance);
  return { dsr: probabilisticSharpe(selected, benchmarkSharpe), benchmarkSharpe, trials, sharpeVariance };
};

/**
 * DSR on day-level returns: a DIAGNOSTIC (supervisor ruling, STATS-1c). Moving from trades to days can raise or lower
 * PSR and DSR (aggregation changes the moments), so it is not "only stricter" and does not gate; G1 keeps the clamped
 * per-trade DSR until the owner signs off. Every series is the trial's daily P&L over one calendar (idle days as 0,
 * with their costs), T is the number of days, and each trial's Sharpe is its day-level Sharpe. `series` holds every
 * registered trial (trial id → daily P&L, same days in the same order).
 */
export const deflatedSharpeDaily = (
  series: Readonly<Record<string, readonly number[]>>,
  selectedId: string,
  /** Trial id → configuration id (a trial missing here is its own configuration). */
  configOf: Readonly<Record<string, string>> = {},
): DailyDeflatedSharpe => {
  const ids = Object.keys(series).sort();
  if (ids.length === 0) throw new RangeError('the experiment registry is empty');
  const selected = series[selectedId];
  if (!selected) throw new RangeError(`selected trial "${selectedId}" has no daily P&L`);
  const days = selected.length;
  for (const id of ids) {
    const s = series[id]!;
    if (s.length !== days) throw new RangeError(`trial ${id} has ${s.length} days, expected ${days}`);
    for (const x of s) if (!Number.isFinite(x)) throw new RangeError(`trial ${id} has a non-finite daily P&L`);
  }
  if (days < 3) throw new RangeError('day-level DSR needs at least three days');
  const sharpes = new Map(ids.map((id) => [id, dailySharpe(series[id]!)]));
  const raw = line(selected, ids.length, ids.map((id) => sharpes.get(id)!));
  const unique = new Map<string, string>();
  for (const id of ids) {
    const key = configOf[id] ?? id;
    if (!unique.has(key)) unique.set(key, id);
  }
  const deduplicated = line(selected, unique.size, [...unique.values()].map((id) => sharpes.get(id)!));
  const cl = clusterTrials(series);
  const effective = { ...line(selected, cl.effectiveTrials, cl.representatives.map((id) => sharpes.get(id)!)), clusters: cl.clusters.length };
  return { sharpe: sharpeRatio(selected), days, raw, deduplicated, effective };
};

export interface SharpeInterval {
  readonly sharpe: number;
  readonly lower: number;
  readonly upper: number;
  /** One-sided p-value for "the Sharpe ratio is 0 or less", from the recentred bootstrap: (1 + k) / (1 + B). */
  readonly pNull: number;
  readonly blockLength: number;
}

/**
 * Sharpe uncertainty by block bootstrap of the daily series (STATS-1c, ruling 2): circular blocks of ⌈D^(1/3)⌉ days,
 * the full Sharpe statistic recomputed on every replicate (never bootstrapped skewness or kurtosis plugged into a
 * formula). Two-sided (level) percentile interval and the null p-value. A diagnostic and a candidate, not a gate; its
 * coverage is measured in stats-simulation.test.ts.
 */
export const sharpeBootstrap = (
  daily: readonly number[],
  opts: { readonly rng: Rng; readonly replicates?: number; readonly level?: number },
): SharpeInterval => {
  const D = daily.length;
  if (D < 10) throw new RangeError('the Sharpe bootstrap needs at least 10 days');
  const B = opts.replicates ?? DEFAULT_REPLICATES;
  const level = opts.level ?? 0.95;
  const sr = sharpeRatio(daily);
  const L = Math.max(1, Math.ceil(D ** (1 / 3) - 1e-9));
  const m = Math.ceil(D / L);
  const reps: number[] = [];
  const x = new Array<number>(D);
  for (let b = 0; b < B; b++) {
    for (let j = 0; j < m; j++) {
      const start = nextInt(opts.rng, D);
      for (let i = j * L; i < Math.min(D, (j + 1) * L); i++) x[i] = daily[(start + i - j * L) % D]!;
    }
    const s = sd(x);
    if (s > 0) reps.push(mean(x) / s);
  }
  reps.sort((a, b) => a - b);
  const q = (p: number) => reps[Math.min(reps.length - 1, Math.max(0, Math.floor(p * reps.length)))]!;
  let k = 0;
  for (const r of reps) if (r - sr >= sr) k++;
  return { sharpe: sr, lower: q((1 - level) / 2), upper: q(1 - (1 - level) / 2), pNull: (1 + k) / (1 + reps.length), blockLength: L };
};
