import type { AlertCode, Check, CostKind, HaltCode, RegimeReasonCode, ExitReason, ExitRule, FunnelStage, RiskMeter, StatusFlag, Universe, Venue } from '../api/contract.ts';

export const CHECK_LABEL: Record<Check, string> = {
  H1: 'Token program',
  H2: 'Mint authority',
  H3: 'Freeze authority',
  H4: 'Token extensions',
  H5: 'Venue and pool',
  H6: 'Withdrawable liquidity',
  H7: 'Stuck curve',
  H8: 'Dust pool',
  H9: 'Instant graduation',
  H10: 'Too soon after migration',
  H11: 'Pump chase',
  H12: 'Holder concentration',
  H13: 'Insider supply',
  H14: 'Serial deployer',
  H15: 'Round trip',
  H16: 'Stale or unknown data',
  H17: 'Unsupported trade',
  cost: 'Costs',
  size: 'Size',
  risk: 'Risk limits',
  regime: 'Market regime',
};

/** The visible states from docs/ARCHITECTURE.md §17. */
export const FLAG_LABEL: Record<StatusFlag, string> = {
  'waiting-for-evidence': 'Waiting for evidence',
  'no-eligible-candidate': 'No eligible candidate',
  'stale-data': 'Stale data',
  'rate-limited': 'Rate limited',
  'unknown-tx-result': 'Unknown transaction result',
  'exit-pending': 'Exit pending',
  'exit-blocked': 'Exit blocked',
  'low-fee-reserve': 'Low fee reserve',
  paused: 'Paused',
  'regime-off': 'Regime off',
};

/**
 * A risk halt's rule in words, after "Off:" (APP-TRUTH): the worker sends `risk` with the core rule as its source, so
 * the reason names the rule ("SOL price unknown"), lower-cased after the first word unless that word is an acronym.
 * An unknown rule, or none, reads as the plain risk limit.
 */
export const riskHaltLabel = (source: unknown): string => {
  const words = typeof source === 'string' ? RISK_CODE_LABEL[source] : undefined;
  if (words === undefined) return HALT_LABEL.risk;
  return /^[A-Z]{2}/.test(words) ? words : words.charAt(0).toLowerCase() + words.slice(1);
};

/** Why entries are off, after "Off:" (API-1); `other` has no label, so it adds no reason. */
export const HALT_LABEL: Record<Exclude<HaltCode, 'other'>, string> = {
  starting: 'starting',
  'feed-stale': 'stale data',
  'feed-disconnected': 'feed down',
  'feed-dropped': 'feed drill',
  paused: 'paused',
  seeding: 'seeding',
  divergence: 'ledger mismatch',
  budget: 'request budget',
  'daily-loss': 'daily loss',
  'weekly-loss': 'weekly loss',
  'weekly-review': 'weekly review',
  'kill-switch': 'kill switch',
  'wallet-below-kill-line': 'wallet below kill line',
  'loss-cooldown': 'loss cooldown',
  'loss-day-pause': 'losses today',
  'loss-review': 'loss review',
  'session-ended': 'session ended',
  'max-open-positions': 'open trade limit',
  risk: 'risk limit',
  'risk-unknown': 'risk unknown',
};

export const ALERT_LABEL: Record<AlertCode, string> = {
  cancel_after_broadcast: 'Cancel after send',
  status_balance_mismatch: 'Balance mismatch',
  late_landing: 'Late landing',
  unbooked_landing: 'Unbooked landing',
  double_fill: 'Double fill',
  oversold: 'Oversold',
  orphan_cleared: 'Orphan cleared',
  exit_blocked: 'Exit blocked',
  restart_recovery: 'Restart recovery',
};

/** A regime reason after "Off:"; an `unknown` reason names its missing input instead. */
export const REGIME_REASON_LABEL: Record<Exclude<RegimeReasonCode, 'unknown'>, string> = {
  'regime-off': 'checks failed',
  'exec-health': 'execution health',
  'policy-session-ended': 'session ended',
};
export const REGIME_INPUT_LABEL: Record<string, string> = {
  'curve-volume': 'volume unknown',
  'sol-usd': 'SOL price unknown',
  graduates: 'graduates unknown',
  'exec-health': 'execution health unknown',
};

/** S0 diagnostic parts not judged: the regime's "on" is practice only. */
export const WAIVED_LABEL: Record<string, string> = {
  'regime-volume': 'volume',
  'regime-survival': 'survival',
  'exec-health': 'execution health',
  'h14-creates-coverage': 'creates coverage',
};

/** Flags that need the owner's eye are drawn in the loss colour; the rest stay neutral. */
export const FLAG_ALERT: ReadonlySet<StatusFlag> = new Set(['exit-blocked', 'unknown-tx-result', 'low-fee-reserve', 'stale-data', 'rate-limited']);

export const STAGE_LABEL: Record<FunnelStage, string> = {
  seen: 'Seen',
  'hard-rejects': 'Passed hard rejects',
  costs: 'Passed cost gate',
  risk: 'Passed risk limits',
  entered: 'Entered',
};

export const EXIT_RULE_LABEL: Record<ExitRule, string> = {
  'price-stop': 'Price stop',
  'thesis-stop': 'Thesis stop',
  'time-stop': 'Time stop',
  'take-profit': 'Take profit',
  trail: 'Trailing stop',
};

export const EXIT_LABEL: Record<ExitReason, string> = {
  ...EXIT_RULE_LABEL,
  'liquidity-drop': 'Liquidity dropped',
  'flow-stop': 'Flow turned',
  'owner-close': 'Closed by owner',
  blocked: 'Exit blocked',
};

/**
 * A trade's reasons as the worker serves them, the book's exit codes (core lifecycle BookExitReason), in the exit
 * labels above (APP-WORDS a). A code this app does not know has no label and is not shown: never a raw code on screen.
 */
export const TRADE_REASON_LABEL: Record<string, string> = {
  stop: EXIT_LABEL['price-stop'],
  trailing_stop: EXIT_LABEL.trail,
  take_profit: EXIT_LABEL['take-profit'],
  max_hold: EXIT_LABEL['time-stop'],
  thesis_lost: EXIT_LABEL['thesis-stop'],
  liquidity: EXIT_LABEL['liquidity-drop'],
  emergency: 'Emergency exit',
};

/** Core risk's entry codes (RiskCode) in words, for a decision's reasons (APP-WORDS a). */
export const RISK_CODE_LABEL: Record<string, string> = {
  bankroll_invalid: 'Bankroll invalid',
  sol_price_unknown: 'SOL price unknown',
  sol_price_stale: 'SOL price stale',
  mark_unknown: 'Position value unknown',
  mark_stale: 'Position value stale',
  risk_fault: 'Risk check failed',
  size_below_minimum: 'Size below minimum',
  max_open_positions: 'Open trade limit',
  balance_unknown: 'Balance unknown',
  balance_stale: 'Balance stale',
  ops_reserve: 'SOL reserve',
  stop_invalid: 'Stop invalid',
  stop_too_wide: 'Stop too wide',
  planned_risk: 'Risk per trade',
  full_loss_kill_line: 'Kill line room',
  full_loss_week: 'Weekly loss room',
  daily_loss: 'Daily loss',
  loss_cooldown: 'Loss cooldown',
  loss_day_pause: 'Losses today',
  loss_review: 'Loss review',
  weekly_loss: 'Weekly loss',
  weekly_review: 'Weekly review',
  kill_switch: 'Kill switch',
  wallet_below_kill_line: 'Wallet below kill line',
  entries_per_day: 'Entries today',
  entries_per_mint: 'Entries in this token',
  reentry_after_stop: 'Re-entry after stop',
  liquidity_unknown: 'Liquidity unknown',
  liquidity_floor: 'Liquidity floor',
  quote_stale: 'Quote stale',
  quote_failed: 'Quote failed',
  depth_cap: 'Pool depth',
  cost_gate: 'Costs',
  median_target_invalid: 'Target invalid',
  expected_net_not_positive: 'Expected net not positive',
  session_not_running: 'Session ended',
  add_to_position: 'Already holding',
  size_after_loss: 'Size after a loss',
  regime_off: 'Market regime off',
  regime_unknown: 'Market regime unknown',
};

/** The worker's own reasons for a decision (gate `worker`, and the stop's), in words. */
export const WORKER_CODE_LABEL: Record<string, string> = {
  'no-sol-price': 'SOL price unknown',
  'no-market': 'No pool data',
  'no-pool-state': 'No pool data (not read)',
  'pool-malformed': 'No pool data (unreadable)',
  'pool-flagged': 'No pool data (swap gap)',
  'no-fee-context': 'No pool data (fee terms)',
  'no-account': 'Account unknown',
  'no-round-trip': 'No quote',
  'risk-mark-failed': 'Position value unknown',
  'size-mismatch': 'Size mismatch',
  'hard-incomplete': 'Checks incomplete',
  'no-atr': 'Not enough price bars',
  unreadable: 'Reasons unreadable',
};

export const VENUE_LABEL: Record<Venue, string> = { 'pump-curve': 'Pump curve', pumpswap: 'PumpSwap' };

export const UNIVERSES: Universe[] = ['U1', 'U2', 'U3'];

export const COST_LABEL: Record<CostKind, string> = {
  venueFeeUsd: 'Venue fees',
  creatorFeeUsd: 'Creator fees',
  priorityFeeUsd: 'Priority fees',
  tipUsd: 'Tips',
  networkFeeUsd: 'Network fees',
  slippageUsd: 'Slippage',
  rentKeptUsd: 'Rent not returned',
};

export const RISK_LABEL: Record<RiskMeter['kind'], string> = {
  'open-exposure': 'Open exposure',
  'daily-loss': 'Daily loss',
  'weekly-loss': 'Weekly loss',
  'session-loss': 'Session loss',
};
