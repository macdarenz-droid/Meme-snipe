// Sharpe-ratio statistics for A-M13-03 (logic 2-5). All Sharpe ratios are per observation (not annualised) unless a
// name says otherwise; kurtosis is non-excess.
//
// DSR (logic 4; VERIFY V1, research/verify-next/RESULTS.md, confirmed): Bailey & López de Prado, "The Deflated Sharpe
// Ratio", J. Portfolio Management 40(5), 2014, https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf pp. 8-10,
// Eq. (2) and "A numerical example" (page 10: SR0 ≈ 0.1132, DSR ≈ 0.9004 < 0.95):
//   DSR = Φ[ (SR − SR0)·√(T − 1) / √(1 − γ3·SR + ((γ4 − 1)/4)·SR²) ],
//   SR0 = √V[{SR_n}] · ((1 − γ)·Φ⁻¹[1 − 1/N] + γ·Φ⁻¹[1 − 1/(N·e)]), γ the Euler-Mascheroni constant.
// That is PSR (logic 4) at the threshold SR0; with one trial SR0 = 0.
// MinBTL (logic 5; VERIFY A-44, research/verify-m0-m1/RESULTS.md row 31, confirmed): Bailey, Borwein, López de Prado and
// Zhu, "Pseudo-Mathematics and Financial Charlatanism", Theorem 3.1, Eq. (3.2) (davidhbailey.com/dhbpapers/
// backtest-pseudo.pdf, version of April 1, 2014): MinBTL ≈ ( [(1 − γ)·Z⁻¹(1 − 1/N) + γ·Z⁻¹(1 − 1/(N·e))] / E[max_N] )²
// years; N = 45 gives 4.998 years and N = 7 gives 1.923 years at E[max_N] = 1.
// MinTRL (logic 2) [ST-32]: 1 + (1 − γ3·SR + ((γ4 − 1)/4)·SR²)·(Z_{1−α} / (SR − SR*))² observations.
// Lo (2002) IID standard error (logic 3) [ST-33]: √((1 + SR²/2) / T), a lower bound on the uncertainty only.
import { checkFinite, sampleVariance } from './descriptive.ts';
import { normalCdf, normalQuantile } from './special.ts';

export const EULER_GAMMA = 0.5772156649015329;
const DAYS_PER_YEAR = 365.25;

function finite(...v: number[]): void {
  for (const x of v) if (typeof x !== 'number' || !Number.isFinite(x)) throw new RangeError('E_INPUT: not a finite number');
}

export function loSharpeSe(sr: number, t: number): number {
  finite(sr, t);
  if (t < 1) throw new RangeError('E_INPUT: T must be >= 1');
  return Math.sqrt((1 + (sr * sr) / 2) / t);
}

/** The PSR denominator √(1 − γ3·SR + ((γ4 − 1)/4)·SR²); `E_INPUT` when the moments make it non-positive. */
function momentScale(sr: number, skew: number, kurt: number): number {
  const d = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  if (!(d > 0)) throw new RangeError('E_INPUT: the moments give a non-positive PSR denominator');
  return Math.sqrt(d);
}

/** Probabilistic Sharpe ratio: P(true SR > srRef) from n observations with the given skewness and kurtosis. */
export function psr(sr: number, srRef: number, n: number, skew: number, kurt: number): number {
  finite(sr, srRef, n, skew, kurt);
  if (!Number.isInteger(n) || n < 2) throw new RangeError('E_INPUT: n must be an integer >= 2');
  return normalCdf(((sr - srRef) * Math.sqrt(n - 1)) / momentScale(sr, skew, kurt));
}

/** The DSR threshold SR0: the expected maximum Sharpe of N trials whose Sharpe ratios have variance `variance`. */
export function expectedMaxSharpe(nTrials: number, variance: number): number {
  finite(nTrials, variance);
  if (!Number.isInteger(nTrials) || nTrials < 1) throw new RangeError('E_INPUT: the number of trials must be an integer >= 1');
  if (variance < 0) throw new RangeError('E_INPUT: variance must be >= 0');
  if (nTrials === 1) return 0;
  return Math.sqrt(variance) * ((1 - EULER_GAMMA) * normalQuantile(1 - 1 / nTrials) + EULER_GAMMA * normalQuantile(1 - 1 / (nTrials * Math.E)));
}

/** DSR from the number of trials and the variance of their Sharpe ratios (the paper's own inputs). */
export function dsrFromVariance(sr: number, nTrials: number, variance: number, n: number, skew: number, kurt: number): number {
  return psr(sr, expectedMaxSharpe(nTrials, variance), n, skew, kurt);
}

/**
 * Deflated Sharpe ratio of the selected trial (Sharpe `sr` over `n` observations) against every trial's Sharpe ratio,
 * the selected one included. V = max(sample variance (N − 1) of `trialSrs`, 1/(n − 1)): the floor is the sampling
 * variance of one Sharpe ratio under the null, so near-identical trials cannot remove the deflation (supervisor ruling
 * Z06-1, the safest reading; carried from Zeroed `stats/sharpe.ts`). It only raises SR0, so it only lowers the DSR.
 * One trial gives SR0 = 0. `dsrFromVariance` stays the paper's raw formula (worked-example reproduction).
 */
export function dsr(sr: number, trialSrs: readonly number[], n: number, skew: number, kurt: number): number {
  checkFinite(trialSrs, 'trialSrs');
  if (trialSrs.length === 0) throw new RangeError('E_INPUT: no trials');
  if (!Number.isInteger(n) || n < 2) throw new RangeError('E_INPUT: n must be an integer >= 2');
  const sample = trialSrs.length === 1 ? 0 : sampleVariance(trialSrs) ?? 0;
  return dsrFromVariance(sr, trialSrs.length, Math.max(sample, 1 / (n - 1)), n, skew, kurt);
}

/** Minimum track record length in observations; null when sr ≤ srRef (no track record is long enough). */
export function minTrl(sr: number, srRef: number, skew: number, kurt: number, alpha: 0.05 = 0.05): number | null {
  finite(sr, srRef, skew, kurt, alpha);
  if (!(alpha > 0 && alpha < 1)) throw new RangeError('E_INPUT: alpha must be in (0, 1)');
  if (sr <= srRef) return null;
  const s = momentScale(sr, skew, kurt);
  return 1 + s * s * (normalQuantile(1 - alpha) / (sr - srRef)) ** 2;
}

/** MinBTL in years for N trials at an expected best annualised Sharpe of `eMaxAnnualSharpe`; N = 1 needs none. */
export function minBtlYears(nTrials: number, eMaxAnnualSharpe: number): number {
  finite(nTrials, eMaxAnnualSharpe);
  if (!Number.isInteger(nTrials) || nTrials < 1) throw new RangeError('E_INPUT: the number of trials must be an integer >= 1');
  if (!(eMaxAnnualSharpe > 0)) throw new RangeError('E_INPUT: the expected maximum Sharpe must be > 0');
  if (nTrials === 1) return 0;
  return (expectedMaxSharpe(nTrials, 1) / eMaxAnnualSharpe) ** 2;
}

/** Largest N with MinBTL(N) ≤ the window (years); at least 1 (one trial has no multiple-testing penalty). */
export function maxTrialsForWindow(windowYears: number, eMaxAnnualSharpe: number): number {
  finite(windowYears, eMaxAnnualSharpe);
  if (!(windowYears >= 0)) throw new RangeError('E_INPUT: the window must be >= 0 years');
  let n = 1;
  // MinBTL rises with N; the cap keeps a nonsense input from looping (10^6 trials is far past any budget here).
  while (n < 1_000_000 && minBtlYears(n + 1, eMaxAnnualSharpe) <= windowYears) n++;
  return n;
}

/** Days to years for MinBTL windows (365.25 days a year). */
export const daysToYears = (days: number): number => days / DAYS_PER_YEAR;
