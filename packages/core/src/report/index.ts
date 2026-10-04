// Backtest report file, version 1: what BT-1 writes and the app reads (docs/ARCHITECTURE.md §14, §17).
// Types only. The web app imports this module with `import type`, so nothing here may be runtime code;
// apps/web/test/report-schema.test.ts fails if a value export appears.
//
// Rules for the file:
// - Profit is counted in SOL (owner rule): every money figure has an exact lamport twin (`...Lamports`, an integer
//   decimal string) and returns are on lamports (net ÷ entry lamports). The dollar figures (a decimal string in US
//   dollars with at most 6 places, each flow at its own SOL/USD price) stay as the secondary view; prices
//   (`...PriceUsd`) are exact decimals.
// - Every object inside an array carries `mode: "backtest"`; the app refuses the file otherwise.
// - The report covers walk-forward or research runs only. It has no field for the sealed holdout:
//   holdout fills and P&L never leave the sealed ledger (§14), so they cannot be shown by mistake.
// - The app validates strictly: an unknown field, a missing field or a wrong type rejects the whole file.

import type { Venue } from '../domain/index.ts';

export type { Venue };

/** US dollars, decimal string, at most 6 places: "-12.5", "0.000125". */
export type Usd = string;
/** Lamports, an exact integer decimal string: "-180000000". */
export type Lamports = string;
/** Any exact decimal string: prices, R multiples, ratios. */
export type Dec = string;
/** ISO 8601 UTC time. */
export type Iso = string;
/** YYYY-MM-DD, Melbourne day. */
export type Day = string;

export type Universe = 'U1' | 'U2' | 'U3';
/** A tested universe, or S0, the random control run on the same eligible candidates. */
export type ReportGroup = Universe | 'S0';

export type ExitRule = 'price-stop' | 'thesis-stop' | 'time-stop' | 'take-profit' | 'trail';
export type ExitReason = ExitRule | 'liquidity-drop' | 'flow-stop' | 'owner-close' | 'blocked';

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

/** The same costs in lamports, exact. */
export interface TradeCostsLamports {
  venueFeeLamports: Lamports;
  creatorFeeLamports: Lamports;
  priorityFeeLamports: Lamports;
  tipLamports: Lamports;
  networkFeeLamports: Lamports;
  slippageLamports: Lamports;
  rentPaidLamports: Lamports;
  rentReturnedLamports: Lamports;
  totalLamports: Lamports;
}

export type BacktestPart = 'walk-forward' | 'research';

export interface ReportEquityPoint {
  mode: 'backtest';
  at: Iso;
  cumNetUsd: Usd;
  cumNetLamports: Lamports;
}

export interface ReportDay {
  mode: 'backtest';
  date: Day;
  netUsd: Usd;
  netLamports: Lamports;
  trades: number;
}

/** Results for one universe or for S0. */
export interface ReportResult {
  mode: 'backtest';
  group: ReportGroup;
  trades: number;
  wins: number;
  netUsd: Usd;
  maxDrawdownUsd: Usd;
  /** Null when there are no trades. */
  meanNetUsd: Usd | null;
  netLamports: Lamports;
  maxDrawdownLamports: Lamports;
  /** Null when there are no trades. */
  meanNetLamports: Lamports | null;
  /** Mean of the trades' net returns on lamports (net ÷ entry lamports); null when there are no trades. */
  meanReturn: Dec | null;
  /** 95% interval of mean net return per trade (day-block bootstrap); null when not computed. */
  ci95: { lowUsd: Usd; highUsd: Usd } | null;
  equity: ReportEquityPoint[];
  days: ReportDay[];
}

export interface ReportTrade {
  mode: 'backtest';
  id: string;
  group: ReportGroup;
  mint: string;
  symbol: string;
  venue: Venue;
  openedAt: Iso;
  closedAt: Iso;
  holdSeconds: number;
  entryPriceUsd: Dec;
  exitPriceUsd: Dec;
  sizeUsd: Usd;
  grossUsd: Usd;
  costs: TradeCosts;
  netUsd: Usd;
  sizeLamports: Lamports;
  grossLamports: Lamports;
  costsLamports: TradeCostsLamports;
  netLamports: Lamports;
  /** Net return on lamports: net ÷ entry lamports, 9 places, rounded toward zero. */
  netReturn: Dec;
  realizedR: Dec | null;
  exitReason: ExitReason;
}

export interface ReportGateCheck {
  mode: 'backtest';
  label: string;
  value: string;
  limit: string;
  pass: boolean;
}

export interface ReportGate {
  mode: 'backtest';
  /** G2 (the holdout) is never in this file. */
  gate: 'G0' | 'G1';
  state: 'pass' | 'fail' | 'not-run';
  checks: ReportGateCheck[];
}

export interface ReportFold {
  mode: 'backtest';
  id: string;
  from: Iso;
  to: Iso;
  trades: number;
  meanNetUsd: Usd;
  lowUsd: Usd;
}

export interface BacktestReportV1 {
  schemaVersion: 1;
  mode: 'backtest';
  part: BacktestPart;
  generatedAt: Iso;
  runId: string;
  /** Git commit of the engine code that ran, 40 hex characters. */
  codeCommit: string;
  /** Hash of the policy file, "sha256:" and 64 hex characters. */
  policyHash: string;
  dataset: { id: string; from: Iso; to: Iso };
  engine: { replays: number; identicalReplays: boolean; crashes: number; illegalStates: number; unreconciledIntents: number };
  candidates: number;
  entries: number;
  gates: ReportGate[];
  folds: ReportFold[];
  results: ReportResult[];
  trades: ReportTrade[];
}

export type BacktestReport = BacktestReportV1;
