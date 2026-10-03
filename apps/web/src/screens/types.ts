/** Rows for the discovered-token table, filled by the worker API later. */
export interface TokenRowView {
  mint: string;
  symbol: string;
  ageSeconds: number;
  venue: string;
  liquidityUsd: number;
  volume24hUsd: number;
  holders: number;
  topHolderShare: number;
  security: 'passed' | 'failed' | 'missing';
  promoted: boolean;
  dataAgeSeconds: number;
}

/**
 * Session settings and wallet balances come from the worker API. Nothing is
 * hard-coded: the trial bankroll and trade sizes will change. Null means not
 * set or not reported, and shows as such.
 */
export interface SessionView {
  mode: 'paper' | 'live';
  state: 'not-started' | 'running' | 'paused' | 'ended';
  bankrollUsd: number | null;
  entryUsd: number | null;
  maxEntryUsd: number | null;
  maxOpenPositions: number | null;
  dailyLossLimitUsd: number | null;
  sessionLossLimitUsd: number | null;
  workerConnected: boolean;
}

export interface WalletView {
  botAddress: string | null;
  savedWallet: string | null;
  availableUsd: number | null;
  /** Bot wallet SOL balance, an exact decimal string with up to 9 places. */
  balanceSol: string | null;
  /** SOL/AUD price as a decimal string, for the A$ line next to SOL amounts. */
  solAud: string | null;
  /** Protected SOL reserve (docs/ARCHITECTURE.md §8 R4) and locked deposits, exact decimal strings. */
  reserveSol: string | null;
  lockedSol: string | null;
  openExposureUsd: number | null;
  feesPaidUsd: number | null;
}

export const EMPTY_SESSION: SessionView = {
  mode: 'paper',
  state: 'not-started',
  bankrollUsd: null,
  entryUsd: null,
  maxEntryUsd: null,
  maxOpenPositions: null,
  dailyLossLimitUsd: null,
  sessionLossLimitUsd: null,
  workerConnected: false,
};

export const EMPTY_WALLET: WalletView = {
  botAddress: null,
  savedWallet: null,
  availableUsd: null,
  balanceSol: null,
  solAud: null,
  reserveSol: null,
  lockedSol: null,
  openExposureUsd: null,
  feesPaidUsd: null,
};
