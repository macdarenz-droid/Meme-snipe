/**
 * View models for the results components. The worker API will fill these;
 * until then the app passes empty values and the components show empty states.
 * All money is in US dollars.
 */

export interface TradeView {
  id: string;
  symbol: string;
  mint: string;
  venue: string;
  openedAt: string;
  closedAt: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  sizeUsd: number;
  feesUsd: number;
  /** Net result after every cost. */
  netUsd: number;
  reasonIn: string;
  reasonOut: string;
  holdSeconds: number;
  /** Null for paper trades, which send no transaction. */
  entryTx: string | null;
  exitTx: string | null;
}

/** One calendar day of closed trades, keyed by local date (YYYY-MM-DD). */
export interface DayResultView {
  date: string;
  netUsd: number;
  tradeIds: string[];
}

export interface EquityPointView {
  at: string;
  equityUsd: number;
}

export interface CostItemView {
  label: string;
  usd: number;
}

export interface RiskMeterView {
  label: string;
  usedUsd: number;
  /** Null until the owner sets the limit. */
  limitUsd: number | null;
}

export interface ResultsStatsView {
  /** Closed trades in the sample. Always shown. */
  sample: number;
  /** Trades needed before a statistic is shown; null until the evaluation plan sets it. */
  minSample: number | null;
  netUsd: number;
  winRate: number;
  expectancyUsd: number;
  maxDrawdownUsd: number;
}

export interface ResultsView {
  month: string;
  days: DayResultView[];
  trades: TradeView[];
  equity: EquityPointView[];
  costs: CostItemView[];
  risk: RiskMeterView[];
  stats: ResultsStatsView;
}

/** What the app shows before the worker reports anything. */
export function emptyResults(month: string): ResultsView {
  return {
    month,
    days: [],
    trades: [],
    equity: [],
    costs: [],
    risk: [
      { label: 'Open exposure', usedUsd: 0, limitUsd: null },
      { label: 'Daily loss', usedUsd: 0, limitUsd: null },
      { label: 'Session loss', usedUsd: 0, limitUsd: null },
    ],
    stats: { sample: 0, minSample: null, netUsd: 0, winRate: 0, expectancyUsd: 0, maxDrawdownUsd: 0 },
  };
}
