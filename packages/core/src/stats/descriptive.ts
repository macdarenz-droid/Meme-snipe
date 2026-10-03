// Descriptive statistics on per-trade net returns (fractions of notional).

const nonEmpty = (xs: readonly number[], what: string): void => {
  if (xs.length === 0) throw new RangeError(`${what} needs at least one value`);
};

export const sum = (xs: readonly number[]): number => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};

export const mean = (xs: readonly number[]): number => {
  nonEmpty(xs, 'mean');
  return sum(xs) / xs.length;
};

/** Sample variance (divisor n − 1). */
export const variance = (xs: readonly number[]): number => {
  if (xs.length < 2) throw new RangeError('variance needs at least two values');
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
};

/** Sample standard deviation (divisor n − 1). */
export const sd = (xs: readonly number[]): number => Math.sqrt(variance(xs));

const centralMoment = (xs: readonly number[], k: number): number => {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** k;
  return s / xs.length;
};

/** Skewness γ₃ = m₃ / m₂^1.5 (moment estimator, as in the PSR formula). */
export const skewness = (xs: readonly number[]): number => {
  const m2 = centralMoment(xs, 2);
  return m2 === 0 ? 0 : centralMoment(xs, 3) / m2 ** 1.5;
};

/** Kurtosis γ₄ = m₄ / m₂² (not excess: 3 for a normal distribution). */
export const kurtosis = (xs: readonly number[]): number => {
  const m2 = centralMoment(xs, 2);
  return m2 === 0 ? 3 : centralMoment(xs, 4) / m2 ** 2;
};

/** Quantile of already sorted values, linear interpolation (Hyndman & Fan type 7). */
export const quantileSorted = (sorted: readonly number[], p: number): number => {
  nonEmpty(sorted, 'quantile');
  if (!(p >= 0 && p <= 1)) throw new RangeError(`p must be in [0, 1], got ${p}`);
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
};

export const median = (xs: readonly number[]): number => quantileSorted([...xs].sort((a, b) => a - b), 0.5);
