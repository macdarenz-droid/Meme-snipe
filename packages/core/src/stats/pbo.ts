// Probability of backtest overfitting by combinatorially symmetric cross-validation (CSCV).
// Bailey, Borwein, López de Prado & Zhu, "The Probability of Backtest Overfitting", J. Computational Finance 20(4),
// 2017 (rev. Feb 2015, https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf); quant.md §2.3.
// The T×N matrix (T time rows, e.g. days, by N trials) is cut into S contiguous blocks. For every choice of S/2
// blocks as in-sample, the in-sample best trial n* is ranked out of sample; ω = rank/(N + 1), λ = ln(ω/(1 − ω)).
// PBO is the share of splits with λ ≤ 0 (the in-sample winner at or below the out-of-sample median).

export interface PboOptions {
  /** Number of blocks S, even, 2..T (default 16 when T ≥ 16, else the largest even number ≤ T). */
  readonly blocks?: number;
  /** Performance statistic per trial and sample (default 'sharpe', as in the paper). */
  readonly metric?: 'sharpe' | 'mean';
}

export interface PboResult {
  readonly pbo: number;
  readonly combinations: number;
  readonly blocks: number;
  /** λ for each split, in combination order. */
  readonly logits: readonly number[];
}

const score = (col: readonly number[], rows: readonly number[], metric: 'sharpe' | 'mean'): number => {
  let s = 0;
  for (const r of rows) s += col[r]!;
  const m = s / rows.length;
  if (metric === 'mean') return m;
  let v = 0;
  for (const r of rows) v += (col[r]! - m) ** 2;
  const sdv = Math.sqrt(v / (rows.length - 1));
  if (sdv === 0) return m > 0 ? Infinity : m < 0 ? -Infinity : 0;
  return m / sdv;
};

const combinations = (n: number, k: number): number[][] => {
  const out: number[][] = [];
  const pick: number[] = [];
  const rec = (start: number): void => {
    if (pick.length === k) {
      out.push([...pick]);
      return;
    }
    for (let i = start; i <= n - (k - pick.length); i++) {
      pick.push(i);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(0);
  return out;
};

/**
 * @param trials one array per trial, each the same length T, holding that trial's return per time row (row i is
 * the same period for every trial).
 */
export const probabilityOfBacktestOverfitting = (trials: readonly (readonly number[])[], opts: PboOptions = {}): PboResult => {
  const n = trials.length;
  if (n < 2) throw new RangeError('PBO needs at least two trials');
  const t = trials[0]!.length;
  for (const col of trials) {
    if (col.length !== t) throw new RangeError('every trial needs the same number of time rows');
    for (const x of col) if (!Number.isFinite(x)) throw new RangeError('returns must be finite');
  }
  const s = opts.blocks ?? Math.min(16, t - (t % 2));
  if (!Number.isInteger(s) || s < 2 || s % 2 !== 0 || s > t) throw new RangeError(`blocks must be even and in 2..${t}, got ${s}`);
  const metric = opts.metric ?? 'sharpe';
  if (metric === 'sharpe' && Math.floor(t / s) * (s / 2) < 2) throw new RangeError('too few rows per half for a Sharpe ratio');
  // Contiguous blocks whose sizes differ by at most one row (the first T mod S blocks get the extra row).
  const blockRows: number[][] = [];
  let row = 0;
  for (let b = 0; b < s; b++) {
    const size = Math.floor(t / s) + (b < t % s ? 1 : 0);
    blockRows.push(Array.from({ length: size }, (_, i) => row + i));
    row += size;
  }
  const logits: number[] = [];
  let overfit = 0;
  for (const inBlocks of combinations(s, s / 2)) {
    const inSet = new Set(inBlocks);
    const isRows: number[] = [];
    const oosRows: number[] = [];
    for (let b = 0; b < s; b++) (inSet.has(b) ? isRows : oosRows).push(...blockRows[b]!);
    let best = 0;
    let bestPerf = -Infinity;
    for (let j = 0; j < n; j++) {
      const p = score(trials[j]!, isRows, metric);
      if (p > bestPerf) {
        bestPerf = p;
        best = j;
      }
    }
    const oos = trials.map((col) => score(col, oosRows, metric));
    const target = oos[best]!;
    // Rank 1 = worst. Ties rank the winner at the bottom of its tie group (counts against it).
    let rank = 1;
    for (let j = 0; j < n; j++) if (j !== best && oos[j]! < target) rank++;
    const omega = rank / (n + 1);
    const lambda = Math.log(omega / (1 - omega));
    logits.push(lambda);
    if (lambda <= 0) overfit++;
  }
  return { pbo: overfit / logits.length, combinations: logits.length, blocks: s, logits };
};
