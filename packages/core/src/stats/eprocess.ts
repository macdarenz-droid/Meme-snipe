// Test-by-betting e-process for sequential, anytime-valid promotion and demotion (quant.md §5.4).
// Wealth K_t = Π (1 + λ_t · Y_t) with Y_t ≥ −1 and a predictable bet λ_t ∈ [0, maxBet] (it uses only Y_1..Y_{t−1}).
// Under H₀: E[Y_t | past] ≤ 0, K is a nonnegative supermartingale, so by Ville's inequality
// P(sup_t K_t ≥ 1/α) ≤ α: the wealth can be checked after every trade without inflating the false-positive rate
// (Waudby-Smith & Ramdas, JRSS-B 86(1), 2024; Ramdas, Grünwald, Vovk & Shafer, Statistical Science 38(4), 2023).
// Bet: the plug-in λ_t = clip(μ̂/(σ̂² + μ̂²), 0, maxBet) = clip(μ̂ / mean(Y²), 0, maxBet) from past data (quant.md §5.4).

export interface EProcessOptions {
  /** Wealth that counts as evidence (default 20, i.e. α = 0.05). */
  readonly threshold?: number;
  /** Largest bet (default 0.5, the cap used in quant.md §5.4). */
  readonly maxBet?: number;
  /** Past observations needed before the first non-zero bet (default 2). */
  readonly minHistory?: number;
}

export interface EProcessResult {
  /** Wealth after each observation. */
  readonly wealth: readonly number[];
  readonly finalWealth: number;
  readonly maxWealth: number;
  /** 1-based count of observations at which wealth first reached the threshold, or null. */
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

/**
 * Evidence that the mean net return is above zero. Returns must be ≥ `lowerBound` (default −1: a net return
 * cannot lose more than the notional); they are scaled by 1/|lowerBound| so Y ≥ −1.
 */
export const bettingEProcess = (
  returns: readonly number[],
  opts: EProcessOptions & { readonly lowerBound?: number } = {},
): EProcessResult => {
  const lowerBound = opts.lowerBound ?? -1;
  if (!(lowerBound < 0)) throw new RangeError(`lowerBound must be < 0, got ${lowerBound}`);
  return run(returns.map((x) => x / -lowerBound), opts);
};

/**
 * Evidence that the mean net return has fallen below zero (decay detector for demotion; quant.md §5.4).
 * Bets on −X, which needs an upper bound: returns are capped at `cap` (default +3, the +300% cap of quant.md §5.3).
 * Capping can only lower the returns, so it makes demotion more likely, never less.
 */
export const reverseEProcess = (
  returns: readonly number[],
  opts: EProcessOptions & { readonly cap?: number } = {},
): EProcessResult => {
  const cap = opts.cap ?? 3;
  if (!(cap > 0) || !Number.isFinite(cap)) throw new RangeError(`cap must be a finite number > 0, got ${cap}`);
  return run(
    returns.map((x) => {
      if (!Number.isFinite(x)) throw new RangeError(`return must be finite, got ${x}`);
      return -Math.min(x, cap) / cap;
    }),
    opts,
  );
};
