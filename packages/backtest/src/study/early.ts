// BT-2e, an early look (owner request, 2026-10-04): the bot's own backtest, the same engine, gates and blind-to-the-future
// guards, on one or two free practice days, so a first funnel count and a rough result exist before the full data. U2
// only (U1 needs a 14-day lead-in), each U2 configuration run on its own (RES-4's U2 hypotheses with BT-2's U2), with
// S0 beside them. Labelled "early look, not proof": nothing is chosen, frozen, registered or recorded from it. It reports
// engine validity, the funnel and descriptive figures only (supervisor and 01FHfb rulings): no G1 or SPA under 10 days,
// no interval or test of any kind, and no wording that implies one.
import { mean, median } from '../../../core/src/stats/index.ts';
import type { FillConfig } from '../../../core/src/config/index.ts';
import { configTag, type StudyConfig, type UniverseConfig } from '../strategy/config.ts';
import type { StudyStrategy } from '../strategy/study.ts';
import type { FunnelSummary } from './funnel.ts';
import { runStudy, type StudyRunOptions } from './run.ts';
import { scoreRun, type ScoredTrade } from './score.ts';

export const EARLY_LABEL = 'early look, not proof';

/** Descriptive figures of a set of trades: no interval, no test. */
export interface TradeStats {
  readonly trades: number;
  readonly tradesPerDay: number;
  readonly winRate: number | null;
  /** Net return per trade after every cost (r_net). */
  readonly meanNet: number | null;
  readonly medianNet: number | null;
  /** Sum of winning net returns over the absolute sum of losing ones; null without a losing trade. */
  readonly profitFactor: number | null;
  readonly worstNet: number | null;
  /** Most losing trades in a row, in close order. */
  readonly longestLosingStreak: number;
}

/** The early look's trade figures. */
export const tradeStats = (trades: readonly ScoredTrade[], days: number): TradeStats => {
  const r = [...trades].sort((a, b) => a.closedAt - b.closedAt || (a.mint < b.mint ? -1 : 1)).map((t) => t.rNet);
  if (r.length === 0) return { trades: 0, tradesPerDay: 0, winRate: null, meanNet: null, medianNet: null, profitFactor: null, worstNet: null, longestLosingStreak: 0 };
  const wins = r.filter((x) => x > 0);
  const losses = r.filter((x) => x < 0);
  let streak = 0;
  let longest = 0;
  for (const x of r) {
    streak = x < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  const lossSum = -losses.reduce((a, b) => a + b, 0);
  return {
    trades: r.length, tradesPerDay: r.length / days, winRate: wins.length / r.length,
    meanNet: mean(r), medianNet: median(r), profitFactor: lossSum > 0 ? wins.reduce((a, b) => a + b, 0) / lossSum : null,
    worstNet: Math.min(...r), longestLosingStreak: longest,
  };
};

export interface EarlyVariant {
  readonly tag: string;
  readonly configId: string;
  readonly funnel: FunnelSummary | null;
  readonly stats: TradeStats;
  readonly crashes: number;
  readonly illegalStates: number;
  readonly unreconciledIntents: number;
}

export interface EarlyDay {
  readonly label: typeof EARLY_LABEL;
  readonly day: string;
  readonly variants: readonly EarlyVariant[];
  /** S0 (a random eligible check, same gates, costs and exits) for each configuration's universe, all seeds pooled. */
  readonly s0: { readonly seeds: number; readonly stats: TradeStats };
  readonly notes: readonly string[];
}

/**
 * One day of the early look: every configuration on its own run, then S0 under the same gates. `base` holds the day's
 * rows (with whatever lead-in the dataset has), its entry window and inputs; `ids` names each configuration's id.
 */
export const earlyDay = (day: string, configs: readonly UniverseConfig[], study: StudyConfig, base: Omit<StudyRunOptions, 'mode' | 'study'>, ids: (c: UniverseConfig) => string, s0Seeds: number, fills: FillConfig): EarlyDay => {
  if (configs.length === 0 || configs.some((c) => c.universe !== 'U2')) throw new RangeError('the early look runs U2 configurations only');
  const variants = configs.map((c) => {
    let strategy: StudyStrategy | null = null;
    const r = runStudy({ ...base, study: { ...study, universes: [c] }, mode: 'strategy', onStrategy: (x) => { strategy = x; } });
    const tag = configTag(c);
    const funnel = (strategy as StudyStrategy | null)?.funnel.summary()[tag] ?? null;
    return { tag, configId: ids(c), funnel, stats: tradeStats(scoreRun(r, fills).filter((t) => t.tag === tag), 1), crashes: r.stats.crashes, illegalStates: r.stats.illegalStates, unreconciledIntents: r.stats.unreconciledIntents };
  });
  // S0 needs one U2 configuration for its universe (its gates and stop); any of them gives the same S0 universe.
  const s0Trades = Array.from({ length: s0Seeds }, (_, k) => {
    const r = runStudy({ ...base, study: { ...study, universes: [configs[0]!] }, mode: 's0', seed: `${base.seed}:early-s0:${k}` });
    return scoreRun(r, fills).filter((t) => t.tag === 'S0-U2');
  }).flat();
  return {
    label: EARLY_LABEL, day, variants, s0: { seeds: s0Seeds, stats: tradeStats(s0Trades, s0Seeds) },
    notes: [
      'Early look, not proof: one day, few trades. Nothing here is proven, and no configuration is chosen or frozen from it.',
      'Engine checks, the funnel and plain trade figures only: with one or two days no statistical test is run or implied.',
      'No daily trade cap applies in the backtest. S0 is pooled over its seeds; its trades per day are per seed.',
      'The full study uses every practice day later; these days count again there.',
    ],
  };
};
