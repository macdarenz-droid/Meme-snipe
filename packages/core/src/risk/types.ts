// Inputs and outputs of the risk policy (docs/ARCHITECTURE.md §8). Everything is passed in: no clock, no I/O.
import type { PolicySession } from '../config/index.ts';
import type { NetworkPolicy, RentInputs, RoundTripQuoter } from '../costs/index.ts';
import type { IntentId, Mint, ReservationId } from '../domain/index.ts';
import type { Lamports, MicroUsd } from '../units/index.ts';
import type { ReservationRequest } from './reservation.ts';

export type ControlId =
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10' | 'R11' | 'R12' | 'R13' | 'R14' | 'R15' | 'R16';

export const CONTROL_IDS: readonly ControlId[] = [
  'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16',
];

/** Why an entry is refused. Every code belongs to exactly one control (see CODE_CONTROL). */
export type RiskCode =
  // R1 bankroll and its valuation
  | 'bankroll_invalid' | 'sol_price_unknown' | 'sol_price_stale' | 'mark_unknown' | 'mark_stale'
  // R2 trade size range
  | 'size_below_minimum'
  // R3 open positions
  | 'max_open_positions'
  // R4 SOL operations reserve
  | 'balance_unknown' | 'balance_stale' | 'ops_reserve'
  // R5 planned risk per trade
  | 'stop_invalid' | 'stop_too_wide' | 'planned_risk'
  // R6 full-loss reservation
  | 'full_loss_kill_line' | 'full_loss_week'
  // R7 daily loss
  | 'daily_loss'
  // R8 consecutive losses
  | 'loss_cooldown' | 'loss_day_pause' | 'loss_review'
  // R9 weekly loss
  | 'weekly_loss' | 'weekly_review'
  // R10 kill switch, and the wallet's value below the kill line
  | 'kill_switch' | 'wallet_below_kill_line'
  // R11 entries
  | 'entries_per_day' | 'entries_per_mint' | 'reentry_after_stop'
  // R12 liquidity floor
  | 'liquidity_unknown' | 'liquidity_floor'
  // R13 executable depth
  | 'quote_stale' | 'quote_failed' | 'depth_cap'
  // R14 cost gate and expected net
  | 'cost_gate' | 'median_target_invalid' | 'expected_net_not_positive'
  // R15 no martingale, policy locked
  | 'session_not_running' | 'add_to_position' | 'size_after_loss'
  // R16 regime gate
  | 'regime_off' | 'regime_unknown'
  // Withdrawals (R4: the reserve and free cash)
  | 'withdrawal_queued' | 'withdrawal_unreconciled' | 'withdrawal_over_free_cash' | 'withdrawal_invalid';

export const CODE_CONTROL: Readonly<Record<RiskCode, ControlId>> = {
  bankroll_invalid: 'R1', sol_price_unknown: 'R1', sol_price_stale: 'R1', mark_unknown: 'R1', mark_stale: 'R1',
  size_below_minimum: 'R2',
  max_open_positions: 'R3',
  balance_unknown: 'R4', balance_stale: 'R4', ops_reserve: 'R4',
  stop_invalid: 'R5', stop_too_wide: 'R5', planned_risk: 'R5',
  full_loss_kill_line: 'R6', full_loss_week: 'R6',
  daily_loss: 'R7',
  loss_cooldown: 'R8', loss_day_pause: 'R8', loss_review: 'R8',
  weekly_loss: 'R9', weekly_review: 'R9',
  kill_switch: 'R10', wallet_below_kill_line: 'R10',
  entries_per_day: 'R11', entries_per_mint: 'R11', reentry_after_stop: 'R11',
  liquidity_unknown: 'R12', liquidity_floor: 'R12',
  quote_stale: 'R13', quote_failed: 'R13', depth_cap: 'R13',
  cost_gate: 'R14', median_target_invalid: 'R14', expected_net_not_positive: 'R14',
  session_not_running: 'R15', add_to_position: 'R15', size_after_loss: 'R15',
  regime_off: 'R16', regime_unknown: 'R16',
  withdrawal_queued: 'R4', withdrawal_unreconciled: 'R4', withdrawal_over_free_cash: 'R4', withdrawal_invalid: 'R4',
};

export interface RiskReason {
  readonly control: ControlId;
  readonly code: RiskCode;
  readonly detail: string;
}

/** Live trades count against the R11 caps and the R16 regime gate; paper and backtest evaluation do not (§8 R11, §6.4). */
export type RiskMode = 'live' | 'paper' | 'backtest';

/** Structurally the ENG-1 `Clock`: only `receivedAt` (integer ms since the epoch) is read. */
export interface RiskClock {
  now(): { readonly receivedAt: number };
}

/**
 * A finished trade from the ledger. `notional` is the entry's notional q as decided (`EntryAllowed.notional`), costs
 * excluded, so R15 compares a new q with the last q. `netPnl` is after every fee and cost.
 */
export interface ClosedTrade {
  readonly mint: Mint;
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly notional: MicroUsd;
  readonly netPnl: MicroUsd;
  /** Closed by a stop (price, thesis or flow): blocks re-entry on the mint for the policy's re-entry window. */
  readonly stoppedOut: boolean;
}

/** An open position. `mark` is the executable liquidation value of the whole position, net of fees (§9), or null if unknown. */
export interface OpenPosition {
  readonly mint: Mint;
  readonly openedAtMs: number;
  /** Cost basis in micro-dollars, entry costs included. */
  readonly notional: MicroUsd;
  readonly mark: MicroUsd | null;
  readonly markAtMs: number | null;
}

/** A deposit (positive) or withdrawal (negative) of trading capital. Neither counts as profit or loss. */
export interface CashFlow {
  readonly atMs: number;
  readonly amount: MicroUsd;
  /**
   * Executable equity (realized plus open positions at their executable value, the same valuation as `equity`) just
   * before the flow. Units are issued or redeemed at it: the flow scales the high-water mark and the week's base by
   * (navBefore + amount) / navBefore. Must be positive; otherwise the history is refused.
   */
  readonly navBefore: MicroUsd;
}

/** Every entry that reserved exposure, whatever became of it (filled, failed, still unresolved). */
export interface EntryRecord {
  readonly mint: Mint;
  readonly atMs: number;
}

/** The ledger's account history. Loss figures are derived from it here, against Melbourne day and week boundaries. */
export interface AccountHistory {
  /** Trading equity when the ledger started, before any trade (the bankroll put in). */
  readonly openingEquity: MicroUsd;
  readonly openedAtMs: number;
  readonly flows: readonly CashFlow[];
  readonly closedTrades: readonly ClosedTrade[];
  readonly openPositions: readonly OpenPosition[];
  readonly entries: readonly EntryRecord[];
  /** Entry intents not yet resolved (each holds a reservation), by mint. Each counts as an open position (R3). */
  readonly unresolvedEntries: readonly { readonly mint: Mint }[];
  /** Lamports held by those reservations right now (the reservation store's total). */
  readonly heldReservations: Lamports;
  /** Marked equity recorded at the start of today and of this week (same valuation as `equity`); null if not recorded. */
  readonly markedAtDayStart: MicroUsd | null;
  readonly markedAtWeekStart: MicroUsd | null;
  /**
   * The ledger's account version for this snapshot. It advances with every change to the account (reservation, release,
   * fill, position, closed trade, flow); the reservation store refuses a request made from an older version.
   */
  readonly version: bigint;
}

/**
 * Triggers that stay tripped until the owner acts (R9, R10) and the owner's records. Trips are returned by the evaluator
 * as `trips`; the caller stores them (with the evaluation time) and passes them back here.
 */
export interface Latches {
  readonly killTrippedAtMs: number | null;
  /** Owner re-arm after a written review. Also restarts the high-water mark at the equity of that moment. */
  readonly killRearmedAtMs: number | null;
  readonly weeklyTrippedAtMs: number | null;
  readonly weeklyReviewedAtMs: number | null;
  /** R8: owner review after 5 losses in 20. Only trades closed after it count toward the next review. */
  readonly lossReviewedAtMs: number | null;
  /** The owner approved sizes above the minimum (after G5, §14). Until then every trade is at the minimum. */
  readonly sizeStepUpApproved: boolean;
}

export const NO_LATCHES: Latches = {
  killTrippedAtMs: null, killRearmedAtMs: null, weeklyTrippedAtMs: null, weeklyReviewedAtMs: null,
  lossReviewedAtMs: null, sizeStepUpApproved: false,
};

export interface Timed<T> {
  readonly value: T;
  readonly atMs: number;
}

export interface MarketInputs {
  readonly solPrice: Timed<MicroUsd> | null;
  /** Wallet SOL right now. */
  readonly solBalance: Timed<Lamports> | null;
  /** R16 regime gate state from GATE-1. */
  readonly regime: 'on' | 'off' | 'unknown';
}

/** A proposed entry, as the strategy and the quote path describe it. */
export interface EntryRequest {
  readonly intentId: IntentId;
  readonly reservationId: ReservationId;
  readonly mint: Mint;
  /** 'U1' applies the stricter liquidity floor (R12). */
  readonly universe: string;
  /** Planned stop distance in basis points of the entry (R5). */
  readonly stopBps: number;
  /** Conservative gross edge, ppm of notional (§5.2). */
  readonly edgePpm: bigint;
  /** The strategy's median target, in basis points (R14). */
  readonly medianTargetBps: number;
  /** Exact round-trip quote at current reserves (CORE-2). */
  readonly quote: RoundTripQuoter;
  readonly quoteAtMs: number;
  /** Pool liquidity in micro-dollars, from the same snapshot as the quote; null if unknown. */
  readonly poolLiquidity: MicroUsd | null;
  readonly network: NetworkPolicy;
  readonly rent: RentInputs;
  readonly extraPpm?: bigint;
}

export interface RiskInput {
  readonly session: PolicySession;
  readonly mode: RiskMode;
  readonly clock: RiskClock;
  readonly account: AccountHistory;
  readonly latches: Latches;
  readonly market: MarketInputs;
}

/** Figures the decision was made on, for the decision log. */
export interface RiskSnapshot {
  readonly nowMs: number;
  readonly dayStartMs: number;
  readonly weekStartMs: number;
  /** Realized equity plus marked losses (unrealized gains are not counted), net of deposits and withdrawals. */
  readonly equity: MicroUsd;
  readonly highWaterMark: MicroUsd;
  readonly dayLoss: MicroUsd;
  readonly weekLoss: MicroUsd;
  readonly weekStartEquity: MicroUsd;
  /** Week-start equity scaled by every deposit and withdrawal since (time-weighted). */
  readonly weekBase: MicroUsd;
  /** Loss this week measured against `weekBase` (zero if none). */
  readonly weekBaseLoss: MicroUsd;
  /** Remaining full loss of open positions (mark or cost, whichever is lower). */
  readonly openExposure: MicroUsd;
  readonly lossStreak: number;
  /**
   * Change since the start of today and of this week at one valuation: equity now − marked equity at the boundary − net
   * flows since. Reported next to `dayLoss` / `weekLoss`, which measure from realized equity at the boundary and so
   * count an open loss carried over the boundary again (stricter; kept until the owner changes it). Null when the
   * boundary valuation was not recorded.
   */
  readonly dayChangeMarked: MicroUsd | null;
  readonly weekChangeMarked: MicroUsd | null;
  /**
   * Wallet-marked equity: wallet SOL above the operations floor at the fresh SOL/USD price, plus open positions at the
   * same marks as `equity`. Null without a fresh price and balance (then no entry is allowed anyway).
   */
  readonly walletEquity: MicroUsd | null;
  /** Capital every size and limit that scales with equity uses: the lower of `equity` and `walletEquity`. */
  readonly capital: MicroUsd;
}

export type Trip = 'kill_switch' | 'weekly_loss';

export interface SizeCapEntry {
  readonly control: ControlId;
  readonly name: string;
  readonly notional: MicroUsd;
}

export interface EntryAllowed {
  readonly allow: true;
  readonly reasons: readonly [];
  readonly trips: readonly Trip[];
  readonly snapshot: RiskSnapshot;
  readonly notional: MicroUsd;
  readonly spendLamports: bigint;
  /** C: every cost the trade can incur, exit-ladder worst case included. */
  readonly maxCostsLamports: Lamports;
  readonly caps: readonly SizeCapEntry[];
  /** Round-trip cost at the chosen size, ppm of notional (R14). */
  readonly roundTripPpm: bigint;
  /**
   * Three loss figures, smallest to largest (RISK-1b). Planned R (R5): q × (stop + cost-gate ceiling) + F. Stressed
   * executable loss: the stop is hit and the exit fills at the emergency rung's min-out below the trigger, so
   * q × (1 − (1 − stop)(1 − emergency slippage)) + C. Reserved loss (R6): q + C, the whole notional plus every cost,
   * which is what sizing and the reservation are bounded by.
   */
  readonly loss: { readonly plannedRisk: MicroUsd; readonly stressed: MicroUsd; readonly reserved: MicroUsd };
  /** Hand this to the reservation store before preparing the transaction. */
  readonly reservation: ReservationRequest;
}

export interface EntryRefused {
  readonly allow: false;
  readonly reasons: readonly RiskReason[];
  readonly trips: readonly Trip[];
  readonly snapshot: RiskSnapshot | null;
}

export type EntryDecision = EntryAllowed | EntryRefused;

/** A withdrawal of SOL from the bot wallet to the owner's saved wallet (RISK-1b; first release). */
export interface WithdrawalRequest {
  readonly amount: Lamports;
  /** For the live operations reserve (R4): exit attempts and rent at current rates. */
  readonly network: NetworkPolicy;
  readonly rent: RentInputs;
  /** The wallet's balances and the ledger agree (the last reconcile found no difference and nothing is pending). */
  readonly reconciled: boolean;
}

export interface WithdrawalDecision {
  readonly allow: boolean;
  readonly reasons: readonly RiskReason[];
  /** Most lamports that may leave now: the balance less the operations reserve (0 while anything is open). */
  readonly maxAmount: bigint;
}

export interface ExitDecision {
  readonly allow: true;
  /** Entry controls that are tripped right now, for the log. They never block an exit. */
  readonly tripped: readonly RiskReason[];
  /** Triggers that tripped now and are not latched yet (R9, R10): the caller stores them, as for an entry. */
  readonly trips: readonly Trip[];
}
