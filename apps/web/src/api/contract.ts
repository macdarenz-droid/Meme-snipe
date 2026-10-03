/**
 * Worker API contract for the dashboard (docs/ARCHITECTURE.md §17, UI-2).
 * The worker is the only data source; until it exists the app is served from
 * fixtures through the same interface (src/dev/dashboardFixtures.ts).
 *
 * Rules every response follows:
 * - Money is a decimal string in US dollars with at most 6 places (`Usd`),
 *   never a JSON number. Prices (fields named `priceUsd` or `...PriceUsd`) and
 *   ratios are decimal strings of any precision (`Dec`).
 * - Every response and every record carries `mode`. A response holds one
 *   mode only; the client rejects any record whose mode differs from the one
 *   it asked for (src/api/modes.ts), so totals never mix modes.
 * - Days are Melbourne days (Australia/Melbourne), as YYYY-MM-DD.
 * - Times are ISO 8601 UTC strings.
 */

export const MODES = ['backtest', 'paper', 'live'] as const;
export type Mode = (typeof MODES)[number];

/** US dollars, decimal string, at most 6 places: "-12.5", "0.000125". */
export type Usd = string;
/** Any exact decimal string: prices, R multiples, ratios. */
export type Dec = string;
export type Iso = string;
/** YYYY-MM-DD, Melbourne day. */
export type Day = string;

export const TIME_ZONE = 'Australia/Melbourne';

export interface Moded {
  mode: Mode;
}

/** Every response. `asOf` is when the worker produced the data. */
export interface Envelope<T> {
  mode: Mode;
  asOf: Iso;
  data: T;
}

/** Paper and live data older than this shows as stale. A backtest is a finished run and never goes stale. */
export const STALE_AFTER_SECONDS = 15;

/**
 * Smallest sample before a win rate, average or interval is shown (§14).
 * The worker reports the requirement it computed (for a backtest, max(300, n_power));
 * the app never shows statistics below these floors, whatever the worker says.
 * Backtest: G2 floor of 300 out-of-sample trades. Paper: G3, 30 trades. Live: G4, 30 trades.
 */
export const MIN_TRADES: Record<Mode, number> = { backtest: 300, paper: 30, live: 30 };

export type Venue = 'pump-curve' | 'pumpswap';
export type Universe = 'U1' | 'U2' | 'U3';

/** Hard rejects H1–H16 (§7.1). */
export type Gate = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7' | 'H8' | 'H9' | 'H10' | 'H11' | 'H12' | 'H13' | 'H14' | 'H15' | 'H16';
/** Checks after the hard rejects: cost gate (§5.3), sizing and risk (§8), regime (§6.4). */
export type Check = Gate | 'cost' | 'size' | 'risk' | 'regime';

export interface CheckResult {
  check: Check;
  result: 'pass' | 'fail' | 'unknown';
  /** Measured value and limit as the worker printed them, e.g. "12.4%" and "≤ 10%". */
  value: string | null;
  limit: string | null;
}

// Status ---------------------------------------------------------------

/** The visible states from §17. */
export const STATUS_FLAGS = [
  'waiting-for-evidence',
  'no-eligible-candidate',
  'stale-data',
  'rate-limited',
  'unknown-tx-result',
  'exit-pending',
  'exit-blocked',
  'low-fee-reserve',
  'paused',
  'regime-off',
] as const;
export type StatusFlag = (typeof STATUS_FLAGS)[number];

export interface RiskMeter {
  kind: 'open-exposure' | 'daily-loss' | 'weekly-loss' | 'session-loss';
  usedUsd: Usd;
  /** Null until the owner sets the limit. */
  limitUsd: Usd | null;
}

export interface WorkerStatus extends Moded {
  connected: boolean;
  flags: StatusFlag[];
  risk: RiskMeter[];
}

// Funnel ---------------------------------------------------------------

export type FunnelStage = 'seen' | 'hard-rejects' | 'costs' | 'risk' | 'entered';

export interface FunnelDay extends Moded {
  date: Day;
  seen: number;
  entered: number;
}

export interface FunnelView extends Moded {
  from: Iso;
  to: Iso;
  /** Candidates left after each stage, in order. */
  stages: { stage: FunnelStage; count: number }[];
  /** Rejections by the first check that failed. */
  rejects: { check: Check; count: number }[];
  perDay: FunnelDay[];
}

// Decisions ------------------------------------------------------------

export interface DecisionRecord extends Moded {
  id: string;
  at: Iso;
  mint: string;
  symbol: string;
  venue: Venue;
  outcome: 'entered' | 'rejected' | 'no-trade';
  checks: CheckResult[];
  /** Before calibration, a rule score with its reasons; never a probability (§7.2). */
  ruleScore: Dec | null;
  reasons: string[];
  tradeId: string | null;
}

// Open position ---------------------------------------------------------

export type ExitRule = 'price-stop' | 'thesis-stop' | 'time-stop' | 'take-profit' | 'trail';

export interface PositionRecord extends Moded {
  id: string;
  mint: string;
  symbol: string;
  venue: Venue;
  openedAt: Iso;
  entryPriceUsd: Dec;
  sizeUsd: Usd;
  /** Our size sold into current pool state, net of fees (§9). */
  liquidationValueUsd: Usd;
  unrealizedUsd: Usd;
  costsSoFarUsd: Usd;
  exitRules: { rule: ExitRule; trigger: string; state: 'armed' | 'triggered' }[];
  exit: 'none' | 'pending' | 'blocked';
  worker: 'watching' | 'exiting' | 'reconciling';
}

// Calendar -------------------------------------------------------------

export interface DayRecord extends Moded {
  date: Day;
  netUsd: Usd;
  trades: number;
  /** Times entries paused that day (daily trigger, cooldown, owner pause). */
  pauses: number;
  tradeIds: string[];
}

export interface CalendarMonth extends Moded {
  /** YYYY-MM */
  month: string;
  timeZone: typeof TIME_ZONE;
  days: DayRecord[];
}

// Trades ---------------------------------------------------------------

export interface Fill extends Moded {
  side: 'buy' | 'sell';
  at: Iso;
  /** Null in paper; the slot of the simulated event in a backtest. */
  slot: number | null;
  /** Live only. */
  signature: string | null;
  priceUsd: Dec;
  quotedUsd: Usd;
  filledUsd: Usd;
  /** Fill against the local quote; positive is worse for us. */
  slippageBps: number;
  attempts: number;
}

export interface TradeCosts {
  venueFeeUsd: Usd;
  creatorFeeUsd: Usd;
  priorityFeeUsd: Usd;
  tipUsd: Usd;
  networkFeeUsd: Usd;
  slippageUsd: Usd;
  /** Token-account rent paid at entry and returned when the account closed. */
  rentPaidUsd: Usd;
  rentReturnedUsd: Usd;
  totalUsd: Usd;
}

export type CostKind = Exclude<keyof TradeCosts, 'totalUsd' | 'rentPaidUsd' | 'rentReturnedUsd'> | 'rentKeptUsd';

export type ExitReason = ExitRule | 'liquidity-drop' | 'flow-stop' | 'owner-close' | 'blocked';

export interface TradeRecord extends Moded {
  id: string;
  mint: string;
  symbol: string;
  venue: Venue;
  universe: Universe;
  strategyVersion: string;
  policyVersion: string;
  openedAt: Iso;
  closedAt: Iso;
  holdSeconds: number;
  entryPriceUsd: Dec;
  exitPriceUsd: Dec;
  sizeUsd: Usd;
  grossUsd: Usd;
  costs: TradeCosts;
  netUsd: Usd;
  plannedR: Dec | null;
  realizedR: Dec | null;
  /** Best and worst marks while open, in R. */
  mfeR: Dec | null;
  maeR: Dec | null;
  exitReason: ExitReason;
  reasons: string[];
  checks: CheckResult[];
  fills: Fill[];
}

// Charts ---------------------------------------------------------------

export interface ChartsView extends Moded {
  /** Cumulative net P&L after each closed trade. */
  cumulative: { at: Iso; cumNetUsd: Usd }[];
  daily: { date: Day; netUsd: Usd }[];
  /** Realized R per trade, bucketed; counts are trades. */
  rBuckets: { fromR: Dec; toR: Dec; count: number }[];
  costsDaily: { date: Day; totalUsd: Usd }[];
  /** Costs by type over the whole view; rent counts only what was not returned. They add up to the total cost. */
  costsByKind: { kind: CostKind; usd: Usd }[];
}

// Statistics -----------------------------------------------------------

export interface StatsView extends Moded {
  trades: number;
  /** The worker's own requirement (§14); the app applies MIN_TRADES as a floor. */
  requiredTrades: number | null;
  netUsd: Usd;
  maxDrawdownUsd: Usd;
  winRate: Dec | null;
  meanNetUsd: Usd | null;
  meanR: Dec | null;
  /** 95% interval of mean net return per trade (day-block bootstrap). */
  ci95: { lowUsd: Usd; highUsd: Usd } | null;
}

// Backtest report ------------------------------------------------------

export interface GateCheck {
  label: string;
  value: string;
  limit: string;
  pass: boolean;
}

export interface BacktestReport extends Moded {
  runId: string;
  engineVersion: string;
  policyVersion: string;
  datasetHash: string;
  window: { from: Iso; to: Iso };
  holdoutWindow: { from: Iso; to: Iso };
  replays: { runs: number; identical: boolean };
  crashes: number;
  illegalStates: number;
  unreconciledIntents: number;
  candidates: number;
  entries: number;
  folds: { id: string; from: Iso; to: Iso; trades: number; meanNetUsd: Usd; lowUsd: Usd }[];
  gates: { gate: 'G0' | 'G1' | 'G2'; state: 'pass' | 'fail' | 'not-run'; checks: GateCheck[] }[];
  /**
   * The holdout is sealed until its counts are met (§14). While it is not
   * `opened`, the app shows counts only and ignores any result fields.
   */
  holdout: {
    state: 'sealed' | 'opened' | 'burned' | 'not-run';
    entries: Partial<Record<Universe, number>>;
    required: number | null;
    meanNetUsd: Usd | null;
    ci95: { lowUsd: Usd; highUsd: Usd } | null;
  };
}

// Endpoints ------------------------------------------------------------

export interface DashboardApi {
  status(mode: Mode): Promise<Envelope<WorkerStatus>>;
  funnel(mode: Mode): Promise<Envelope<FunnelView>>;
  decisions(mode: Mode): Promise<Envelope<DecisionRecord[]>>;
  position(mode: Mode): Promise<Envelope<PositionRecord | null>>;
  calendar(mode: Mode, month: string): Promise<Envelope<CalendarMonth>>;
  trades(mode: Mode): Promise<Envelope<TradeRecord[]>>;
  charts(mode: Mode): Promise<Envelope<ChartsView>>;
  stats(mode: Mode): Promise<Envelope<StatsView>>;
  /** The latest finished run; null before the first one. */
  backtestReport(): Promise<Envelope<BacktestReport | null>>;
}

/** GET paths on the worker. */
export const PATHS = {
  status: (m: Mode) => `/api/v1/${m}/status`,
  funnel: (m: Mode) => `/api/v1/${m}/funnel`,
  decisions: (m: Mode) => `/api/v1/${m}/decisions`,
  position: (m: Mode) => `/api/v1/${m}/position`,
  calendar: (m: Mode, month: string) => `/api/v1/${m}/calendar/${month}`,
  trades: (m: Mode) => `/api/v1/${m}/trades`,
  charts: (m: Mode) => `/api/v1/${m}/charts`,
  stats: (m: Mode) => `/api/v1/${m}/stats`,
  backtestReport: () => '/api/v1/backtest/report',
} as const;
