/**
 * Worker API contract for the dashboard (docs/ARCHITECTURE.md §17, UI-2).
 * The worker is the only data source; until it exists the app is served from
 * fixtures through the same interface (src/dev/dashboardFixtures.ts).
 *
 * Rules every response follows:
 * - Money is a decimal string in US dollars with at most 6 places (`Usd`),
 *   never a JSON number. Prices (fields named `priceUsd` or `...PriceUsd`) and
 *   ratios are decimal strings of any precision (`Dec`).
 * - Every response, and every object inside a list, carries `mode`. A response
 *   holds one mode only; the client rejects a response with any record whose
 *   mode is missing or differs from the one it asked for (src/api/modes.ts),
 *   so totals never mix modes.
 * - Each endpoint's data has a strict schema (src/api/schemas.ts): unknown,
 *   missing or mistyped fields reject the whole response.
 * - Days are Melbourne days (Australia/Melbourne), as YYYY-MM-DD.
 * - Times are ISO 8601 UTC strings.
 */

import type { BacktestReport, Day, Dec, ExitReason, ExitRule, Iso, ReportGroup, ReportResult, ReportTrade, TradeCosts, Universe, Usd, Venue } from '../../../../packages/core/src/report/index.ts';

// Shared with the backtester; types only, erased from the bundle.
export type { BacktestReport, Day, Dec, ExitReason, ExitRule, Iso, ReportGroup, ReportResult, ReportTrade, TradeCosts, Universe, Usd, Venue };

export const MODES = ['backtest', 'paper', 'live'] as const;
export type Mode = (typeof MODES)[number];


export const TIME_ZONE = 'Australia/Melbourne';

export interface Moded {
  mode: Mode;
}

/** Every response. `asOf` is when the worker produced the data. */
export interface Envelope<T> {
  mode: Mode;
  asOf: Iso;
  data: T;
  /** API-1: the server does not run this mode (data is null); the reason, for the record. Never shown as an error. */
  notRunning?: string;
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


/** Hard rejects H1–H17 (§7.1). */
export type Gate = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7' | 'H8' | 'H9' | 'H10' | 'H11' | 'H12' | 'H13' | 'H14' | 'H15' | 'H16' | 'H17';
/** Checks after the hard rejects: cost gate (§5.3), sizing and risk (§8), regime (§6.4). */
export type Check = Gate | 'cost' | 'size' | 'risk' | 'regime';

export interface CheckResult extends Moded {
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

export interface RiskMeter extends Moded {
  kind: 'open-exposure' | 'daily-loss' | 'weekly-loss' | 'session-loss';
  usedUsd: Usd;
  /** Null until the owner sets the limit. */
  limitUsd: Usd | null;
}

/** Why entries are off (API-1); `other` is a reason this app does not name. */
export const HALT_CODES = [
  'starting', 'feed-stale', 'feed-disconnected', 'feed-dropped', 'paused', 'seeding', 'divergence', 'budget',
  // The account's risk stops (core risk's tripped entry controls); 'risk' is any other, its code the source.
  'daily-loss', 'weekly-loss', 'weekly-review', 'kill-switch', 'wallet-below-kill-line', 'loss-cooldown', 'loss-day-pause',
  'loss-review', 'session-ended', 'max-open-positions', 'risk', 'risk-unknown',
  'other',
] as const;
export type HaltCode = (typeof HALT_CODES)[number];

/** The engine's alert codes (AlertCode in the core lifecycle types). */
export const ALERT_CODES = [
  'cancel_after_broadcast',
  'status_balance_mismatch',
  'late_landing',
  'unbooked_landing',
  'double_fill',
  'oversold',
  'orphan_cleared',
  'exit_blocked',
  'restart_recovery',
] as const;
export type AlertCode = (typeof ALERT_CODES)[number];

/** Parts the S0 diagnostic set does not judge (WORKER-1e, S0DiagnosticPart in core's regime gate). */
export const WAIVED_PARTS = ['regime-volume', 'regime-survival', 'exec-health', 'h14-creates-coverage'] as const;
export type WaivedPart = (typeof WAIVED_PARTS)[number];

export const REGIME_REASON_CODES = ['regime-off', 'unknown', 'exec-health', 'policy-session-ended'] as const;
export type RegimeReasonCode = (typeof REGIME_REASON_CODES)[number];

export interface WorkerStatus extends Moded {
  connected: boolean;
  flags: StatusFlag[];
  risk: RiskMeter[];
  /** API-1. Absent from a worker that does not serve them: the app then shows nothing for them. */
  haltReasons?: (Moded & { code: HaltCode; source: string | null })[];
  exitCapable?: boolean;
  /** Critical alerts since the worker started. */
  alerts?: (Moded & { code: AlertCode; subject: string; at: Iso })[];
  /** The latest regime evaluation; null before the first candidate. */
  /** The session the worker runs (APP-HOME): its state and the policy's limits; `startable` false when it runs its own. */
  session?: { state: 'running' | 'paused' | 'ended'; bankrollUsd: Usd; entryUsd: Usd; maxEntryUsd: Usd; maxOpenPositions: number; dailyLossLimitUsd: Usd; weeklyLossLimitUsd: Usd; sessionLossLimitUsd: Usd | null; startable: boolean };
  regime?: { state: 'on' | 'off'; at: Iso; /** At most two candidate evaluation steps old as of asOf. */ current: boolean; reasons: (Moded & { code: RegimeReasonCode; input: string | null })[]; /** Not judged (S0 diagnostic): an "on" with any is practice only. */ waived: WaivedPart[] } | null;
}

// Discovered -----------------------------------------------------------

/** One token the bot is watching (APP-HOME): public market data and the bot's own checks only. */
export interface DiscoveredToken extends Moded {
  mint: string;
  /** Null until the token's symbol is read. */
  symbol: string | null;
  migratedAt: Iso;
  venue: 'PumpSwap';
  /** Both sides of the pool at its price; null until the pool and the SOL price are read. */
  liquidityUsd: Usd | null;
  /** The last evaluation's token checks (the hard gates): missing before one or while evidence is missing. */
  checks: 'passed' | 'failed' | 'missing';
  checkedAt: Iso | null;
}

export interface DiscoveredView extends Moded {
  tokens: DiscoveredToken[];
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
  stages: (Moded & { stage: FunnelStage; count: number })[];
  /** Rejections by the first check that failed. */
  rejects: (Moded & { check: Check; count: number })[];
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
  /** P&L so far: liquidation value plus exits sold, less the entry and every fee paid (APP-TRADE); null without a SOL price. */
  pnlUsd?: Usd | null;
  /** Our rest's executable price now, $/token, the price the stops judge; null when it cannot be quoted. */
  markPriceUsd?: Dec | null;
  /** When the pool behind that price was read. */
  markedAt?: Iso | null;
  exitRules: (Moded & { rule: ExitRule; trigger: string; state: 'armed' | 'triggered' })[];
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


export type CostKind = Exclude<keyof TradeCosts, 'totalUsd' | 'rentPaidUsd' | 'rentReturnedUsd'> | 'rentKeptUsd';


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
  /** Each cash flow at its own SOL price (entry at the entry, exit at the close). */
  netUsd: Usd;
  /** The result in SOL, with no exchange rate. */
  netSol: Dec;
  /** netUsd in two parts: the SOL result at the close's SOL price, and SOL's own price move over the trade. */
  tradingUsd: Usd;
  solMoveUsd: Usd;
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
  cumulative: (Moded & { at: Iso; cumNetUsd: Usd })[];
  daily: (Moded & { date: Day; netUsd: Usd })[];
  /** Realized R per trade, bucketed; counts are trades. */
  rBuckets: (Moded & { fromR: Dec; toR: Dec; count: number })[];
  costsDaily: (Moded & { date: Day; totalUsd: Usd })[];
  /** Costs by type over the whole view; rent counts only what was not returned. They add up to the total cost. */
  costsByKind: (Moded & { kind: CostKind; amountUsd: Usd })[];
}

// Statistics -----------------------------------------------------------

export interface StatsView extends Moded {
  trades: number;
  /** The worker's own requirement (§14); the app applies MIN_TRADES as a floor. */
  requiredTrades: number | null;
  netUsd: Usd;
  /** The closed trades' result in SOL, and the part of netUsd that is SOL's own price move. */
  netSol: Dec;
  solMoveUsd: Usd;
  maxDrawdownUsd: Usd;
  winRate: Dec | null;
  meanNetUsd: Usd | null;
  meanR: Dec | null;
  /** 95% interval of mean net return per trade (day-block bootstrap). */
  ci95: { lowUsd: Usd; highUsd: Usd } | null;
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
  discovered(mode: Mode): Promise<Envelope<DiscoveredView>>;
  /** The newest backtest report file; null before the first one. */
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
  discovered: (m: Mode) => `/api/v1/${m}/discovered`,
  backtestReport: () => '/api/v1/backtest/report',
} as const;
