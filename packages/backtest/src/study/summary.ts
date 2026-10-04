// The holdout summary G3 reads next to the sealed holdout result (shape fixed by the G3 builder, `HoldoutSummary` in
// packages/worker/src/research/g3.ts). Written by the scoring stage only, once a universe's seal is opened.
import type { LogRecord } from '../../../core/src/engine/index.ts';
import { createRng, dayBlockMeanInterval, mean, sd, VETO_COMPOSITE_LEVEL } from '../../../core/src/stats/index.ts';
import type { ScoredTrade } from './score.ts';

export interface HoldoutSummary {
  readonly holdout: { readonly n: number; readonly mean: number; readonly sd: number };
  /** Share of y_severe trades: blocked, or net at or below −50%. */
  readonly severeRate: number;
  /** One-sided lower bound of the mean net return, day-block bootstrap, at G3's composite level. */
  readonly lower: { readonly value: number; readonly level: number };
  readonly candidates: { readonly count: number; readonly hours: number };
  /** One count per never-entered candidate, keyed `gate:code` by the first typed reason of its last abstention. */
  readonly rejectMix: Readonly<Record<string, number>>;
  /** Largest net return one trade can make (0 < cap ≤ 3). */
  readonly returnCap: number;
}

/**
 * The study's exits have no structural ceiling on one trade's return (a trailing stop rides a winner until it turns or
 * T_max), so the cap is G3's own upper bound: the widest, which only widens G3's veto-bias bound (the safe side).
 */
export const RETURN_CAP = 3;

/** The typed `gate:code` of one abstention log line (the study strategy's reason kinds). */
export const typedReason = (reasons: readonly string[]): string | null => {
  const [kind, , , first = ''] = reasons;
  switch (kind) {
    case 'reject':
    case 'risk refused':
      return first;
    case 'regime off':
      return `regime:${first.split(':')[0] || 'off'}`;
    case 'no setup':
      return 'setup:no-setup';
    case 'not evaluated':
      return 'worker:not-evaluated';
    case 'no entry': {
      const stop = /^stop ([a-z-]+)/.exec(first);
      if (stop !== null) return `stop:${stop[1]}`;
      if (first.startsWith('book busy')) return 'worker:book-busy';
      if (first.startsWith('no quote')) return 'worker:no-quote';
      return 'worker:market-data';
    }
    default:
      return null;
  }
};

/** The reject mix of one universe tag from a run's decision log, as the dry run counts it. */
export const rejectMixOf = (records: readonly LogRecord[], tag: string): Record<string, number> => {
  const last = new Map<string, string>();
  const entered = new Set<string>();
  for (const r of records) {
    if (r.type !== 'decision' || r.reasons[1] !== tag) continue;
    const mint = r.reasons[2];
    if (mint === undefined) continue;
    if (r.reasons[0] === 'enter') entered.add(mint);
    const t = typedReason(r.reasons);
    if (t !== null) last.set(mint, t);
  }
  const out: Record<string, number> = {};
  for (const [mint, t] of last) if (!entered.has(mint)) out[t] = (out[t] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
};

export const holdoutSummary = (trades: readonly ScoredTrade[], candidates: number, hours: number, rejectMix: Readonly<Record<string, number>>, seed: number, replicates?: number): HoldoutSummary => {
  if (trades.length < 2) throw new RangeError('a holdout summary needs at least two trades');
  const r = trades.map((t) => t.rNet);
  const lower = dayBlockMeanInterval(trades, VETO_COMPOSITE_LEVEL, 'lower', { rng: createRng(seed), ...(replicates === undefined ? {} : { replicates }) });
  return {
    holdout: { n: trades.length, mean: mean(r), sd: sd(r) },
    severeRate: trades.filter((t) => t.ySevere).length / trades.length,
    lower: { value: lower.lower, level: VETO_COMPOSITE_LEVEL },
    candidates: { count: candidates, hours },
    rejectMix,
    returnCap: RETURN_CAP,
  };
};
