// Prediction interval for the mean of m future trades, given a reference sample of n trades with mean x̄ and
// SD s: x̄ ± t_{n−1, 1−α/2} · s · √(1/n + 1/m) (Hahn & Meeker, Statistical Intervals, Wiley 1991, §4.4).
// Used for G2 (holdout mean vs walk-forward) and G3 (live dry-run mean vs holdout).

import { studentTQuantile } from './special.ts';

export interface SampleSummary {
  readonly n: number;
  readonly mean: number;
  readonly sd: number;
}

export interface PredictiveInterval {
  readonly lower: number;
  readonly upper: number;
}

/**
 * @param varianceInflation design effect for day-clustered trades (≥ 1). The default 1 assumes independent trades,
 * which gives the narrowest interval, so a gate using it fails more often, never less.
 */
export const meanPredictiveInterval = (
  reference: SampleSummary,
  futureTrades: number,
  level = 0.9,
  varianceInflation = 1,
): PredictiveInterval => {
  if (!Number.isInteger(reference.n) || reference.n < 2) throw new RangeError('reference sample needs n >= 2');
  if (!Number.isInteger(futureTrades) || futureTrades < 1) throw new RangeError('futureTrades must be an integer >= 1');
  if (!(level > 0 && level < 1)) throw new RangeError(`level must be in (0, 1), got ${level}`);
  if (!(varianceInflation >= 1)) throw new RangeError('varianceInflation must be >= 1');
  if (!(reference.sd >= 0)) throw new RangeError('sd must be >= 0');
  const t = studentTQuantile(1 - (1 - level) / 2, reference.n - 1);
  const half = t * reference.sd * Math.sqrt(varianceInflation * (1 / reference.n + 1 / futureTrades));
  return { lower: reference.mean - half, upper: reference.mean + half };
};
