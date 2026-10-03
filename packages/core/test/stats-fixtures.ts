// Shared generators for the stats tests: the stylised bracket model of quant.md §5.1, net of a 3% round-trip cost.
// Outcomes: take profit +30% (net +27%), stop −15% (net −18%), 8% gapped stops uniform on [−60%, −30%] (net −63%..−33%),
// 4% rug or blocked exit (−100%), 10% time exits uniform on [−10%, +10%] (net −13%..+7%).
// The take-profit share p is solved so the true mean equals the target exactly: mean = 0.45·p − 0.2218.
import { createRng, nextNormal, type Rng } from '../src/stats/index.ts';

export const bracketTakeProfitShare = (trueMean: number): number => (trueMean + 0.2218) / 0.45;

export const bracketDraw = (rng: Rng, trueMean: number): number => {
  const p = bracketTakeProfitShare(trueMean);
  const u = rng.next();
  if (u < 0.04) return -1;
  if (u < 0.12) return -0.63 + 0.3 * rng.next();
  if (u < 0.22) return -0.13 + 0.2 * rng.next();
  if (u < 0.22 + p) return 0.27;
  return -0.18;
};

/** Exact SD of the bracket model at a given true mean. */
export const bracketSd = (trueMean: number): number => {
  const p = bracketTakeProfitShare(trueMean);
  // E[X²]: rug 0.04·1; gap 0.08·E[U²] on [−0.63, −0.33]; time 0.10·E[U²] on [−0.13, 0.07]; TP p·0.27²; SL (0.78 − p)·0.18².
  const u2 = (a: number, b: number): number => (a * a + a * b + b * b) / 3;
  const m2 = 0.04 + 0.08 * u2(-0.63, -0.33) + 0.1 * u2(-0.13, 0.07) + p * 0.27 ** 2 + (0.78 - p) * 0.18 ** 2;
  return Math.sqrt(m2 - trueMean ** 2);
};

export interface DayTrade {
  readonly day: string;
  readonly rNet: number;
  readonly ySevere: boolean;
  readonly blocked: boolean;
}

export const dayKey = (d: number): string => `d${String(d).padStart(4, '0')}`;

/**
 * Trades over `days` days, `perDay` a day. With rho > 0 every trade of a day shares a normal day shock chosen so the
 * intra-day correlation is rho (the mean is unchanged).
 */
export const bracketTrades = (seed: number, trueMean: number, days: number, perDay: number, rho = 0): DayTrade[] => {
  const rng = createRng(seed);
  const s = bracketSd(trueMean);
  const tau = rho > 0 ? s * Math.sqrt(rho / (1 - rho)) : 0;
  const out: DayTrade[] = [];
  for (let d = 0; d < days; d++) {
    const shock = tau * nextNormal(rng);
    for (let i = 0; i < perDay; i++) {
      const x = bracketDraw(rng, trueMean);
      out.push({ day: dayKey(d), rNet: x + shock, ySevere: x <= -0.5, blocked: false });
    }
  }
  return out;
};

export interface GridTrial {
  readonly id: string;
  /** Per-trade net returns, in order. */
  readonly trades: number[];
  /** Daily P&L (sum of the day's trades). */
  readonly daily: number[];
}

/**
 * A realistic experiment registry for the DSR: `families` rules × `variants` each. Every family draws one stream of
 * candidate trades (`perDay` a day over `days` days, bracket model at `edge` for family 0 and 0 for the others; a day
 * shock shared by all families gives intra-day correlation `rho`). Each variant keeps its own fixed 60–90% of its
 * family's candidates (a threshold moved) with a small return change (a barrier moved), so variants of one rule correlate
 * at about 0.6–0.9, as walk-forward variants over overlapping folds do.
 */
export const trialGrid = (seed: number, families: number, variants: number, edge: number, days = 40, perDay = 15, rho = 0.05): GridTrial[] => {
  const rng = createRng(seed);
  const tau = bracketSd(0) * Math.sqrt(rho / (1 - rho));
  const shock = Array.from({ length: days }, () => tau * nextNormal(rng));
  const out: GridTrial[] = [];
  for (let f = 0; f < families; f++) {
    const mu = f === 0 ? edge : 0;
    const base = Array.from({ length: days }, (_, d) => Array.from({ length: perDay }, () => bracketDraw(rng, mu) + shock[d]!));
    for (let v = 0; v < variants; v++) {
      const keep = 0.6 + 0.3 * rng.next();
      const trades: number[] = [];
      const daily: number[] = [];
      for (let d = 0; d < days; d++) {
        let s = 0;
        for (const x of base[d]!) {
          if (rng.next() < keep) {
            const y = x + 0.02 * nextNormal(rng);
            trades.push(y);
            s += y;
          }
        }
        daily.push(s);
      }
      out.push({ id: `f${f}v${v}`, trades, daily });
    }
  }
  return out;
};
