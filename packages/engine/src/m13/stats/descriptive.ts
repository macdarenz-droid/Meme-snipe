// Descriptive statistics for A-M13-03. Edge cases (A-M13-03): an empty or constant series gives `null` statistics,
// never 0 or Infinity; a NaN or infinite input throws `E_INPUT`. Moments are the sample moment ratios the Sharpe
// papers use: skewness m3 / m2^1.5 and non-excess kurtosis m4 / m2² (central moments over n), and they need at least
// 30 observations [ST-32].

/** Observations the third and fourth moments need [ST-32]. */
export const MIN_MOMENT_N = 30;

/** Throws `E_INPUT` unless every value is a finite number. */
export function checkFinite(x: readonly number[], what = 'input'): void {
  if (!Array.isArray(x)) throw new TypeError(`E_INPUT: ${what} must be an array`);
  for (const v of x) if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError(`E_INPUT: ${what} holds a value that is not a finite number`);
}

/** The arithmetic mean; `E_INPUT` on an empty series (a mean of nothing is not a statistic). */
export function mean(x: readonly number[]): number {
  checkFinite(x);
  if (x.length === 0) throw new RangeError('E_INPUT: mean of an empty series');
  let s = 0;
  for (const v of x) s += v;
  return s / x.length;
}

/** Central moment of order k over n. */
function central(x: readonly number[], m: number, k: number): number {
  let s = 0;
  for (const v of x) s += (v - m) ** k;
  return s / x.length;
}

/** Sample variance (n − 1); null below 2 observations or for a constant series. */
export function sampleVariance(x: readonly number[]): number | null {
  checkFinite(x);
  if (x.length < 2) return null;
  const m = mean(x);
  let s = 0;
  for (const v of x) s += (v - m) ** 2;
  const v = s / (x.length - 1);
  return v > 0 ? v : null;
}

export function skew(x: readonly number[]): number | null {
  checkFinite(x);
  if (x.length < MIN_MOMENT_N) return null;
  const m = mean(x), m2 = central(x, m, 2);
  return m2 > 0 ? central(x, m, 3) / m2 ** 1.5 : null;
}

export function kurtosisNonExcess(x: readonly number[]): number | null {
  checkFinite(x);
  if (x.length < MIN_MOMENT_N) return null;
  const m = mean(x), m2 = central(x, m, 2);
  return m2 > 0 ? central(x, m, 4) / (m2 * m2) : null;
}

/** t-statistic of the mean, mean / (s / √n) (B-6 threshold 3.0 [ST-34]); null below 2 observations or when constant. */
export function tStatMean(x: readonly number[]): number | null {
  const v = sampleVariance(x);
  return v === null ? null : mean(x) / Math.sqrt(v / x.length);
}

/** Quantile by linear interpolation between order statistics (Hyndman-Fan type 7) of an ascending array. */
export function quantileSorted(sorted: Float64Array | readonly number[], p: number): number {
  const n = sorted.length;
  const h = (n - 1) * p, lo = Math.floor(h), hi = Math.min(lo + 1, n - 1);
  return (sorted[lo] as number) + (h - lo) * ((sorted[hi] as number) - (sorted[lo] as number));
}
