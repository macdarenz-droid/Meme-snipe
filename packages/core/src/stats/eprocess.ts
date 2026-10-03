// Test-by-betting e-process for sequential, anytime-valid promotion and demotion (quant.md §5.4).
// Wealth K_t = Π (1 + λ_t · Y_t) with Y_t ≥ −1 and a predictable bet λ_t ∈ [0, maxBet] (it uses only Y_1..Y_{t−1}).
// Under H₀: E[Y_t | past] ≤ 0, K is a nonnegative supermartingale, so by Ville's inequality
// P(sup_t K_t ≥ 1/α) ≤ α: the wealth can be checked after every trade without inflating the false-positive rate
// (Waudby-Smith & Ramdas, JRSS-B 86(1), 2024; Ramdas, Grünwald, Vovk & Shafer, Statistical Science 38(4), 2023).
// Bet: the plug-in λ_t = clip(μ̂/(σ̂² + μ̂²), 0, maxBet) = clip(μ̂ / mean(Y²), 0, maxBet) from past data (quant.md §5.4).
//
// One bet per calendar day, on the day's mean return (review of PR #8). Trades on the same day share a market shock,
// so an earlier trade predicts a later one that day and E[Y_t | past trades] ≤ 0 fails for per-trade bets: at zero edge
// with intra-day ρ = 0.05 and 20 trades a day the per-trade process crossed 20 in 16% of runs. With one bet per day the
// condition needed is E[day mean | previous days] ≤ 0, which holds under H₀ when days are independent of each other.
// A day mean of returns ≥ −1 is itself ≥ −1, so the bound carries over.

import type { DayReturn } from './bootstrap.ts';

export interface EProcessOptions {
  /** Wealth that counts as evidence (default 20, i.e. α = 0.05). */
  readonly threshold?: number;
  /** Largest bet (default 0.5, the cap used in quant.md §5.4). */
  readonly maxBet?: number;
  /** Past observations needed before the first non-zero bet (default 2). */
  readonly minHistory?: number;
}

export interface EProcessResult {
  /** Wealth after each day. */
  readonly wealth: readonly number[];
  readonly finalWealth: number;
  readonly maxWealth: number;
  /** 1-based count of days at which wealth first reached the threshold, or null. */
  readonly crossedAt: number | null;
  readonly threshold: number;
}

const run = (ys: readonly number[], opts: EProcessOptions): EProcessResult => {
  const threshold = opts.threshold ?? 20;
  const maxBet = opts.maxBet ?? 0.5;
  const minHistory = opts.minHistory ?? 2;
  if (!(threshold > 1)) throw new RangeError(`threshold must be > 1, got ${threshold}`);
  if (!(maxBet > 0 && maxBet <= 1)) throw new RangeError(`maxBet must be in (0, 1], got ${maxBet}`);
  if (!Number.isInteger(minHistory) || minHistory < 1) throw new RangeError('minHistory must be an integer >= 1');
  const wealth: number[] = [];
  let logW = 0;
  let maxLogW = 0;
  let crossedAt: number | null = null;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i]!;
    if (!Number.isFinite(y) || y < -1) throw new RangeError(`observation ${i} is below the bound or not finite: ${y}`);
    let lambda = 0;
    if (i >= minHistory && s2 > 0) lambda = Math.min(maxBet, Math.max(0, s1 / i / (s2 / i)));
    logW += Math.log1p(lambda * y);
    s1 += y;
    s2 += y * y;
    if (logW > maxLogW) maxLogW = logW;
    const w = Math.exp(logW);
    wealth.push(w);
    if (crossedAt === null && w >= threshold) crossedAt = i + 1;
  }
  return { wealth, finalWealth: Math.exp(logW), maxWealth: Math.exp(maxLogW), crossedAt, threshold };
};

/** Day means in order. Days must arrive grouped and in non-decreasing key order (the order trades happened). */
const dayMeans = (trades: readonly DayReturn[], map: (x: number) => number): number[] => {
  const out: number[] = [];
  let day: string | null = null;
  let s = 0;
  let n = 0;
  for (const t of trades) {
    if (!Number.isFinite(t.rNet)) throw new RangeError(`return must be finite, got ${t.rNet}`);
    if (day !== null && t.day < day) throw new RangeError(`trades must be in day order: ${t.day} after ${day}`);
    if (t.day !== day) {
      if (n > 0) out.push(s / n);
      day = t.day;
      s = 0;
      n = 0;
    }
    s += map(t.rNet);
    n++;
  }
  if (n > 0) out.push(s / n);
  return out;
};

/**
 * Evidence that the mean net return is above zero. Returns must be ≥ `lowerBound` (default −1: a net return
 * cannot lose more than the notional); they are scaled by 1/|lowerBound| so Y ≥ −1. One bet per day.
 */
export const bettingEProcess = (
  trades: readonly DayReturn[],
  opts: EProcessOptions & { readonly lowerBound?: number } = {},
): EProcessResult => {
  const lowerBound = opts.lowerBound ?? -1;
  if (!(lowerBound < 0)) throw new RangeError(`lowerBound must be < 0, got ${lowerBound}`);
  return run(
    dayMeans(trades, (x) => {
      if (x < lowerBound) throw new RangeError(`a return of ${x} is below the bound ${lowerBound}`);
      return x / -lowerBound;
    }),
    opts,
  );
};

/** Largest cap the reverse e-process accepts (+300%, quant.md §5.3). A larger cap would make demotion almost blind. */
export const MAX_RETURN_CAP = 3;

/**
 * Evidence that the mean net return has fallen below zero (decay detector for demotion; quant.md §5.4).
 * Bets on −X, which needs an upper bound: returns are capped at `cap`, which the caller must set to the configured
 * take-profit (0 < cap ≤ 3; no default: at cap 3 a −10% decay went undetected for 50 days, review of PR #8). Capping
 * can only lower the returns, so it makes demotion more likely, never less. One bet per day.
 */
export const reverseEProcess = (
  trades: readonly DayReturn[],
  opts: EProcessOptions & { readonly cap: number },
): EProcessResult => {
  const cap = opts.cap;
  if (!(cap > 0 && cap <= MAX_RETURN_CAP)) throw new RangeError(`cap must be in (0, ${MAX_RETURN_CAP}], got ${cap}`);
  return run(dayMeans(trades, (x) => -Math.min(x, cap) / cap), opts);
};
