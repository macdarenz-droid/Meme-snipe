// Sample size for the holdout. The interval that must exclude zero is a two-sided 95% CI, sized for 80% power:
// n = ⌈((z₀.₉₇₅ + z₀.₈₀) · σ / effect)²⌉ ≈ ⌈(2.80 · σ / effect)²⌉ (ARCHITECTURE.md §14; empirical.md audit #8:
// the 1.96-only version sizes a CI half-width and has only 50% power). Exact normal quantiles are used, which
// gives a slightly larger (safer) n than the rounded 2.8.

import { normalQuantile } from './special.ts';

export interface PowerOptions {
  /** Two-sided significance level of the CI that must exclude zero (default 0.05). */
  readonly alpha?: number;
  /** Probability of excluding zero when the true edge equals `effect` (default 0.80). */
  readonly power?: number;
}

/** Trades needed so a two-sided (1 − α) CI of the mean excludes zero with the given power at the given edge. */
export const nPower = (sigma: number, effect: number, opts: PowerOptions = {}): number => {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  if (!(sigma > 0) || !Number.isFinite(sigma)) throw new RangeError(`sigma must be a finite number > 0, got ${sigma}`);
  if (!(effect > 0)) throw new RangeError(`effect must be > 0, got ${effect}`);
  if (!(alpha > 0 && alpha < 1) || !(power > 0 && power < 1)) throw new RangeError('alpha and power must be in (0, 1)');
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return Math.ceil(((z * sigma) / effect) ** 2);
};

/**
 * Variance inflation from intra-day correlation: 1 + (m − 1)ρ, with m trades per day and ρ the intra-day
 * correlation (quant.md §5.2). Multiply n by it when trades are clustered by day.
 */
export const designEffect = (tradesPerDay: number, rho: number): number => {
  if (!(tradesPerDay >= 1)) throw new RangeError(`tradesPerDay must be >= 1, got ${tradesPerDay}`);
  if (!(rho >= 0 && rho <= 1)) throw new RangeError(`rho must be in [0, 1], got ${rho}`);
  return 1 + (tradesPerDay - 1) * rho;
};

/** Out-of-sample trades the holdout must hold: max(floor, n_power(σ̂)). σ̂ comes from the walk-forward folds. */
export const requiredHoldoutTrades = (sigmaHat: number, effect = 0.05, floor = 300, opts: PowerOptions = {}): number =>
  Math.max(floor, nPower(sigmaHat, effect, opts));
