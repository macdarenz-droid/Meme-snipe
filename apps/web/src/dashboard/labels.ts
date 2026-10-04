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
