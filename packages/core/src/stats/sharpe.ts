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
  /** N used in SR₀: the effective number of independent trials when daily P&L was given, else the registry size. */
  readonly trials: number;
  readonly registeredTrials: number;
  /** Clusters found among the trials (the registry size when no daily P&L was given or no cut was accepted). */
  readonly clusters: number;
  readonly sharpeVariance: number;
}

/**
 * Deflated Sharpe ratio of the selected trial's returns against the whole registry, with
 * SR₀ = √V·[(1 − γ)Φ⁻¹(1 − 1/N) + γΦ⁻¹(1 − 1/(N·e))] (Bailey & López de Prado 2014, Eq. 1) and DSR = PSR(SR₀).
 * With `dailyPnl` (trial id → daily P&L over the same days, exactly the registry's trials) the trials are clustered by
 * correlation (trials.ts): N is the effective number of independent trials and V the variance of the cluster
 * representatives' Sharpe ratios (López de Prado & Lewis 2019), so variants of one rule are not counted as independent
 * trials (RES-3). Without it, N is the registry size and V the variance of every trial's Sharpe ratio. V is floored at
 * 1/(T − 1) either way. Every registered trial counts; none may be left out.
 */
export const deflatedSharpe = (
  selectedReturns: readonly number[],
  registry: readonly TrialRecord[],
  dailyPnl?: Readonly<Record<string, readonly number[]>>,
): DeflatedSharpe => {
  if (registry.length === 0) throw new RangeError('the experiment registry is empty');
  const ids = new Set(registry.map((t) => t.trialId));
  if (ids.size !== registry.length) throw new RangeError('the experiment registry has duplicate trial ids');
  for (const t of registry) if (!Number.isFinite(t.sharpe)) throw new RangeError(`trial ${t.trialId} has no finite Sharpe`);
  // Floor V at the sampling variance of a Sharpe ratio under the null, 1/(T − 1): near-identical trials would otherwise
  // give V ≈ 0 and remove the deflation (review of PR #8). The floor only makes the DSR stricter.
  let trials = registry.length;
  let clusters = registry.length;
  let sharpes = registry.map((t) => t.sharpe);
  if (dailyPnl) {
    const keys = Object.keys(dailyPnl);
    const missing = registry.filter((t) => !Object.hasOwn(dailyPnl, t.trialId)).map((t) => t.trialId);
    const extra = keys.filter((k) => !ids.has(k));
    if (missing.length > 0 || extra.length > 0) {
      throw new RangeError(`daily P&L must hold exactly the registry's trials (missing ${missing.length}, not in registry ${extra.length})`);
    }
    const cl = clusterTrials(dailyPnl);
    const byId = new Map(registry.map((t) => [t.trialId, t.sharpe]));
    trials = cl.effectiveTrials;
    clusters = cl.clusters.length;
    sharpes = cl.representatives.map((id) => byId.get(id)!);
  }
  const sampleVar = sharpes.length > 1 ? variance(sharpes) : 0;
  const sharpeVariance = Math.max(sampleVar, 1 / (selectedReturns.length - 1));
  const benchmarkSharpe = expectedMaxSharpe(trials, sharpeVariance);
  return {
    dsr: probabilisticSharpe(selectedReturns, benchmarkSharpe),
    sharpe: sharpeRatio(selectedReturns),
    benchmarkSharpe,
    trials,
    registeredTrials: registry.length,
    clusters,
    sharpeVariance,
  };
};
