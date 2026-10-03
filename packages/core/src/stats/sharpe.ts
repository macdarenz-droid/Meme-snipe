// Probabilistic and deflated Sharpe ratios on per-trade returns (quant.md §2.4).
// PSR: Bailey & López de Prado, "The Sharpe Ratio Efficient Frontier", J. Risk 15(2), 2012.
// DSR and the expected maximum Sharpe of N trials: Bailey & López de Prado, "The Deflated Sharpe Ratio",
// J. Portfolio Management 40(5):94–107, 2014 (https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf).

import { kurtosis, mean, sd, skewness, variance } from './descriptive.ts';
import { normalCdf, normalQuantile } from './special.ts';
import { clusterTrials } from './trials.ts';

const EULER_GAMMA = 0.5772156649015329;

/** Per-trade Sharpe ratio: mean / sample SD. */
export const sharpeRatio = (returns: readonly number[]): number => {
  const s = sd(returns);
  if (s === 0) throw new RangeError('Sharpe ratio is undefined when every return is equal');
  return mean(returns) / s;
};

/**
 * PSR(SR*) = Φ( (SR̂ − SR*)·√(T − 1) / √(1 − γ₃·SR̂ + (γ₄ − 1)/4 · SR̂²) ), with γ₃ the skewness and γ₄ the
 * (non-excess) kurtosis of the T returns.
 */
export const probabilisticSharpe = (returns: readonly number[], benchmarkSharpe: number): number => {
  if (returns.length < 3) throw new RangeError('PSR needs at least three returns');
  const sr = sharpeRatio(returns);
  const g3 = skewness(returns);
  const g4 = kurtosis(returns);
  const denom = 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr;
  if (!(denom > 0)) throw new RangeError('PSR denominator is not positive');
  return normalCdf(((sr - benchmarkSharpe) * Math.sqrt(returns.length - 1)) / Math.sqrt(denom));
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
export const deflatedSharpe = (selectedReturns: readonly number[], registry: readonly TrialRecord[]): DeflatedSharpe => {
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
    dsr: probabilisticSharpe(selectedReturns, benchmarkSharpe),
    sharpe: sharpeRatio(selectedReturns),
    benchmarkSharpe,
    trials: registry.length,
    sharpeVariance,
  };
};

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
  /** Diagnostic: trials whose daily vectors are exactly equal count once (exact equality, never a similarity). */
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
 * DSR on day-level returns (supervisor ruling, STATS-1c (a)). Trades on one day move together, so counting trades as
 * independent observations inflates PSR; here every series is the trial's daily P&L over one calendar (idle days as 0,
 * with their costs), T is the number of days, and each trial's Sharpe is its day-level Sharpe. `series` holds every
 * registered trial (trial id → daily P&L, same days in the same order).
 */
export const deflatedSharpeDaily = (series: Readonly<Record<string, readonly number[]>>, selectedId: string): DailyDeflatedSharpe => {
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
    const key = series[id]!.join(',');
    if (!unique.has(key)) unique.set(key, id);
  }
  const deduplicated = line(selected, unique.size, [...unique.values()].map((id) => sharpes.get(id)!));
  const cl = clusterTrials(series);
  const effective = { ...line(selected, cl.effectiveTrials, cl.representatives.map((id) => sharpes.get(id)!)), clusters: cl.clusters.length };
  return { sharpe: sharpeRatio(selected), days, raw, deduplicated, effective };
};
