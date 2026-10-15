// CSCV probability of backtest overfitting (A-M13-03 logic 6) and rank stability (logic 7).
// VERIFY V2 (research/verify-next/RESULTS.md, confirmed): Bailey, Borwein, López de Prado and Zhu, "The Probability of
// Backtest Overfitting", https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf section 2 steps "Second" to "Fifth"
// (Eq. 2.3, steps f and g) and section 3.1. The T × N matrix is cut into S = 16 equal row blocks (T/S rows each); every
// choice of S/2 blocks is the in-sample set, C(16, 8) = 12,870 combinations (the paper's "12, 780" is a typo); the
// in-sample best configuration (by Sharpe, the paper's performance statistic) gets its out-of-sample relative rank
// ω = r / (N + 1), λ = ln(ω / (1 − ω)); PBO is the share of combinations with λ ≤ 0 (the paper does not say how a tie
// at λ = 0 counts; ≤ counts it as overfit). V2 addition: when T is not divisible by S, the oldest rows are dropped.
// Rows are days in time order (oldest first); each inner array is one configuration's daily returns.
import { checkFinite } from './descriptive.ts';

export const CSCV_PARTITIONS = 16;
/** ARCH 3.4 B-4: PBO needs at least 4 configurations; below that, rank stability decides. */
export const PBO_MIN_CONFIGS = 4;

function checkMatrix(m: readonly (readonly number[])[], minConfigs: number): number {
  if (!Array.isArray(m) || m.length < minConfigs) throw new RangeError(`E_INPUT: needs at least ${minConfigs} configurations`);
  const t = (m[0] as readonly number[]).length;
  for (const col of m) {
    checkFinite(col, 'daily returns');
    if (col.length !== t) throw new RangeError('E_INPUT: every configuration needs the same number of days');
  }
  return t;
}

/** Sharpe of a sum and sum of squares over k rows (k ≥ 2); a zero spread scores by the sign of the mean. */
function sharpeOf(sum: number, sumSq: number, k: number): number {
  const m = sum / k;
  const v = Math.max(0, (sumSq - k * m * m) / (k - 1));
  if (v === 0) return m > 0 ? Infinity : m < 0 ? -Infinity : 0;
  return m / Math.sqrt(v);
}

export function cscvPbo(dailyReturnsByConfig: readonly (readonly number[])[], partitions: 16 = CSCV_PARTITIONS): number {
  if (partitions !== CSCV_PARTITIONS) throw new RangeError('E_INPUT: CSCV uses 16 partitions');
  const t = checkMatrix(dailyReturnsByConfig, PBO_MIN_CONFIGS);
  const s = partitions, rows = Math.floor(t / s);
  if (rows < 1) throw new RangeError(`E_INPUT: CSCV needs at least ${s} days`);
  const drop = t - rows * s;                                          // the oldest rows (V2)
  const n = dailyReturnsByConfig.length;
  // Per configuration and block: the sum and the sum of squares.
  const bs = new Float64Array(n * s), bq = new Float64Array(n * s);
  for (let j = 0; j < n; j++) {
    const col = dailyReturnsByConfig[j] as readonly number[];
    for (let b = 0; b < s; b++) {
      let a = 0, q = 0;
      for (let r = drop + b * rows; r < drop + (b + 1) * rows; r++) { const v = col[r] as number; a += v; q += v * v; }
      bs[j * s + b] = a; bq[j * s + b] = q;
    }
  }
  const half = (rows * s) / 2;
  let combos = 0, overfit = 0;
  const pick: number[] = [];
  const isScore = new Float64Array(n), oosScore = new Float64Array(n);
  const visit = (start: number): void => {
    if (pick.length === s / 2) {
      combos++;
      let mask = 0;
      for (const b of pick) mask |= 1 << b;
      for (let j = 0; j < n; j++) {
        let ia = 0, iq = 0, oa = 0, oq = 0;
        for (let b = 0; b < s; b++) {
          if (mask & (1 << b)) { ia += bs[j * s + b] as number; iq += bq[j * s + b] as number; }
          else { oa += bs[j * s + b] as number; oq += bq[j * s + b] as number; }
        }
        isScore[j] = sharpeOf(ia, iq, half); oosScore[j] = sharpeOf(oa, oq, half);
      }
      // The in-sample best; a tie goes to the lowest index (it is then ranked against the others out of sample).
      let best = 0;
      for (let j = 1; j < n; j++) if ((isScore[j] as number) > (isScore[best] as number)) best = j;
      // Rank 1 = worst out of sample. Ties rank the winner at the bottom of its tie group (counts against it).
      let rank = 1;
      for (let j = 0; j < n; j++) if (j !== best && (oosScore[j] as number) < (oosScore[best] as number)) rank++;
      const omega = rank / (n + 1);
      if (Math.log(omega / (1 - omega)) <= 0) overfit++;
      return;
    }
    for (let b = start; b <= s - (s / 2 - pick.length); b++) { pick.push(b); visit(b + 1); pick.pop(); }
  };
  visit(0);
  return overfit / combos;
}

/**
 * B-4 with at most 3 trials: the configuration with the highest mean on the first half of the days must also have the
 * highest mean on the second half. With an odd number of days the oldest is dropped. A tie for best in either half is
 * not stable (`stillBestSecondHalf` false).
 */
export function rankStability(dailyReturnsByConfig: readonly (readonly number[])[]): { selectedFirstHalf: number; stillBestSecondHalf: boolean } {
  const t = checkMatrix(dailyReturnsByConfig, 2);
  const h = Math.floor(t / 2);
  if (h < 1) throw new RangeError('E_INPUT: rank stability needs at least 2 days');
  const start = t - 2 * h;
  const meanOf = (col: readonly number[], from: number): number => { let a = 0; for (let r = from; r < from + h; r++) a += col[r] as number; return a / h; };
  const first = dailyReturnsByConfig.map((c) => meanOf(c, start));
  const second = dailyReturnsByConfig.map((c) => meanOf(c, start + h));
  let sel = 0;
  for (let j = 1; j < first.length; j++) if ((first[j] as number) > (first[sel] as number)) sel = j;
  const tiedFirst = first.some((v, j) => j !== sel && v === first[sel]);
  const strictlyBest = second.every((v, j) => j === sel || v < (second[sel] as number));
  return { selectedFirstHalf: sel, stillBestSecondHalf: !tiedFirst && strictlyBest };
}
