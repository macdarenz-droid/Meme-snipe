// Exact binomial bounds for rare events (blocked exits, failed fills, severe losses) and rate comparisons.
// Clopper & Pearson, Biometrika 26(4):404–413, 1934: the bounds are Beta quantiles.

import { betaQuantile } from './special.ts';

const check = (events: number, trials: number): void => {
  if (!Number.isInteger(events) || !Number.isInteger(trials) || trials < 1 || events < 0 || events > trials) {
    throw new RangeError(`need integers 0 <= events <= trials, trials >= 1; got ${events} of ${trials}`);
  }
};

/** One-sided (1 − α) upper bound on the event probability. */
export const clopperPearsonUpper = (events: number, trials: number, alpha = 0.05): number => {
  check(events, trials);
  return events === trials ? 1 : betaQuantile(1 - alpha, events + 1, trials - events);
};

/** One-sided (1 − α) lower bound on the event probability. */
export const clopperPearsonLower = (events: number, trials: number, alpha = 0.05): number => {
  check(events, trials);
  return events === 0 ? 0 : betaQuantile(alpha, events, trials - events + 1);
};

/** Two-sided (1 − α) interval. */
export const clopperPearsonInterval = (events: number, trials: number, alpha = 0.05): { lower: number; upper: number } => ({
  lower: clopperPearsonLower(events, trials, alpha / 2),
  upper: clopperPearsonUpper(events, trials, alpha / 2),
});

/**
 * Do two Poisson counts share one rate? Conditional on the total, count1 ~ Binomial(count1 + count2,
 * exposure1 / (exposure1 + exposure2)) under equal rates (Przyborowski & Wilenski, Biometrika 31, 1940).
 * Consistent when that proportion lies inside the exact two-sided (1 − α) interval.
 */
export const ratesConsistent = (
  count1: number,
  exposure1: number,
  count2: number,
  exposure2: number,
  alpha = 0.05,
): { consistent: boolean; expectedShare: number; lower: number; upper: number } => {
  if (!(exposure1 > 0) || !(exposure2 > 0)) throw new RangeError('exposures must be > 0');
  const expectedShare = exposure1 / (exposure1 + exposure2);
  const total = count1 + count2;
  if (total === 0) return { consistent: true, expectedShare, lower: 0, upper: 1 };
  const { lower, upper } = clopperPearsonInterval(count1, total, alpha);
  return { consistent: expectedShare >= lower && expectedShare <= upper, expectedShare, lower, upper };
};
