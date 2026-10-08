// View-model schemas VM-01..VM-21 exactly as UI.md "View-model contract" defines them, with ARCH section 19
// (UC-01..UC-21) applied (B-M28-01 logic 1-3). Objects are strict: an unknown or missing field fails. A field is
// nullable only where UI.md says `| null`. Each top-level payload carries its `schema_version` (UI convention 9);
// entities pushed one by one (`upsert` of VM-05, VM-06, VM-07, VM-16, VM-17, VM-21) are exported on their own and
// carry it in the VM-01 envelope instead.
import { z } from 'zod';
import {
  ActionClass, Actor, At, Bps, Bytes, CodeMessage, Commitment, Count, DecimalStr, Decimals, Flag, Hex64, I64Str, Id, JsonObject, Mode, Ms, Pubkey,
  Seconds, SeriesNumber, Severity, Signature, U64Str, UntrustedName, UntrustedSymbol, Window,
} from './scalars.ts';
import { SCHEMA_VERSIONS, VM_IDS, type VmId } from './versions.ts';

const version = (vm: VmId) => z.literal(SCHEMA_VERSIONS[vm]);
/** The integer a decimal string holds, or null when it is not one (its field's own check reports that; Z02 ruling 5). */
const big = (s: string): bigint | null => (/^-?(0|[1-9][0-9]*)$/.test(s) ? BigInt(s) : null);

// ---- VM-01 Stream envelope, heartbeat and clock ----
export const EnvelopeKind = z.enum(['snapshot', 'upsert', 'remove', 'replace', 'heartbeat', 'reset', 'incompatible']);
export const VM01Envelope = z.strictObject({
  vm: z.enum(VM_IDS),
  schema_version: z.number().int().positive(),
  seq: U64Str,
  kind: EnvelopeKind,
  key: z.string().nullable(),
  emitted_at: At,
  as_of: At,
  clock: z.enum(['wall', 'sim']),
  mode: Mode,
  run_id: Id,
  data: z.record(z.string(), z.unknown()),
  // heartbeat only (every 2 s); `ui_supported` on connect
  server_time: At.optional(),
  state_version: U64Str.optional(),
  topics: z.array(z.string()).optional(),
  ui_supported: z.partialRecord(z.enum(VM_IDS), z.array(z.number().int().positive())).optional(),
}).superRefine((e, ctx) => {
  const heartbeat = e.kind === 'heartbeat';
  for (const f of ['server_time', 'state_version', 'topics'] as const) {
    if (heartbeat !== (e[f] !== undefined)) ctx.addIssue({ code: 'custom', path: [f], message: heartbeat ? 'required on a heartbeat' : 'only on a heartbeat' });
  }
  if (!heartbeat && e.ui_supported !== undefined) ctx.addIssue({ code: 'custom', path: ['ui_supported'], message: 'only on a heartbeat' });
  // UI convention 9: every event carries the VM's current version; only `incompatible` reports a mismatch (Z02 ruling 5).
  if (e.kind !== 'incompatible' && e.schema_version !== SCHEMA_VERSIONS[e.vm]) {
    ctx.addIssue({ code: 'custom', path: ['schema_version'], message: `${e.vm} is at version ${SCHEMA_VERSIONS[e.vm]}` });
  }
});

// ---- VM-02 Session and operator ----
export const Preferences = z.strictObject({
  theme: z.enum(['system', 'dark', 'light']),
  density: z.enum(['compact', 'standard', 'comfortable']),
  polarity: z.enum(['green-red', 'blue-orange']),
  tz: z.enum(['utc', 'local']),
  shortcuts: z.strictObject({ mode: z.enum(['on', 'off', 'remap']), remap: z.record(z.string().max(32), z.string().max(32)) }),
  sound: z.boolean(),
  reduced_motion: z.enum(['system', 'on']),
  default_route: z.string().max(256),
});
export const VM02Session = z.strictObject({
  schema_version: version('VM-02'),
  operator_id: Id,
  display_name: z.string(),
  role: z.enum(['viewer', 'operator']),
  session_expires_at: At,
  idle_timeout_s: Seconds,
  elevated_until: At.nullable(),
  webauthn_available: z.boolean(),
  environment_label: z.string(),
  client_kind: z.enum(['desktop', 'mobile']),
  csrf_token: z.string(),
  login_rate_limited_until: At.nullable(),
  preferences: Preferences,
});

// ---- VM-03 System state (UC-06, UC-07, UC-12) ----
export const TradingState = z.enum(['starting', 'running', 'halt_requested', 'halted', 'halt_partial', 'resume_requested', 'exits_only', 'stopped']);
export const VM03System = z.strictObject({
  schema_version: version('VM-03'),
  state_version: U64Str,
  mode: Mode,
  simulated: z.boolean(),
  mode_since: At,
  run_id: Id,
  trading_state: TradingState,
  trading_state_changed_at: At,
  kill: z.strictObject({
    halted_by: Actor.nullable(),
    latch_set_by: z.enum(['engine', 'sentinel', 'cli', 'system']).nullable(),
    latch_clear_requires: z.enum(['dashboard', 'host_cli']).nullable(),
    reason_code: z.string().nullable(),
    reason_text: z.string().nullable(),
    components: z.array(z.strictObject({ name: z.string(), acked: z.boolean(), acked_at: At.nullable() })),
  }),
  signer: z.strictObject({ lock: z.enum(['locked', 'unlocked', 'exits_only']), exit_lease_holder: z.enum(['engine', 'sentinel']).nullable() }),
  live_caps: z.strictObject({ max_trade_lamports: U64Str.nullable(), max_open_positions: Count.nullable(), max_daily_loss_lamports: U64Str.nullable() }),
  scheduled_change: z.strictObject({
    command_id: Id, kind: z.enum(['set_mode', 'update_limit', 'apply_config']), summary: z.string(), effective_at: At, cancellable: z.boolean(),
  }).nullable(),
  strategies: z.array(z.strictObject({ strategy_id: z.string(), name: z.string(), enabled: z.boolean(), modes: z.array(Mode) })),
  /** Always null on the live host (UC-12, D29); kept for schema compatibility. */
  sim_clock: z.strictObject({ sim_time: At, speed_x: z.number().positive(), paused: z.boolean() }).nullable(),
  versions: z.strictObject({ bot: z.string(), config: z.string() }),
  trading_wallet_pubkey: Pubkey.nullable(),
});

// ---- VM-04 Wallet balances (UC-13) ----
export const VM04Balances = z.strictObject({
  schema_version: version('VM-04'),
  source: z.enum(['chain', 'paper_ledger', 'sim_ledger']),
  simulated: z.boolean(),
  wallets: z.array(z.strictObject({
    wallet_id: z.string(),
    label: z.string(),
    pubkey: Pubkey,
    role: z.enum(['trading', 'fee_payer', 'reserve']),
    sol_lamports: U64Str,
    sol_commitment: Commitment,
    sol_as_of_slot: U64Str,
    reserved_lamports: U64Str,
    available_lamports: U64Str,
    tokens: z.array(z.strictObject({
      mint: Pubkey, symbol: UntrustedSymbol, decimals: Decimals.nullable(), amount_base: U64Str, token_class: z.enum(['ours', 'unsolicited', 'written_off']),
      value_est_lamports: U64Str.nullable(), value_as_of: At.nullable(),
    })),
  })),
  totals: z.strictObject({
    sol_lamports: U64Str, positions_value_lamports: U64Str, equity_lamports: U64Str, equity_usd_e6: I64Str.nullable(), sol_usd_price_e6: I64Str.nullable(),
    sol_usd_as_of: At.nullable(), sol_usd_source: z.string().nullable(),
  }),
  reconciled_at: At,
  reconcile_diff_lamports: I64Str,
});

// ---- VM-05 Open positions (UC-02, UC-03) ----
export const Trigger = z.strictObject({
  type: z.enum(['price', 'pnl_pct', 'trailing', 'time']),
  trigger_price_sol_per_token: DecimalStr.nullable(),
  trigger_pnl_bps: Bps.nullable(),
  trailing_distance_bps: Bps.nullable(),
  armed: z.boolean(),
});
/** Documented `risk_flags[].code` values: `entry_unconfirmed` (UC-03), `orphan` (M20 `orphan` shown as `open`, B-M28-03). */
export const RISK_FLAG_CODES = ['entry_unconfirmed', 'orphan'] as const;
export const VM05Position = z.strictObject({
  position_id: Id,
  simulated: z.boolean(),
  mode: Mode,
  strategy_id: z.string(),
  mint: Pubkey,
  symbol: UntrustedSymbol,
  name: UntrustedName,
  decimals: Decimals.nullable(),
  venue: z.string(),
  state: z.enum(['opening', 'open', 'partially_closed', 'closing', 'close_failed', 'closed']),
  opened_at: At,
  opened_slot: U64Str,
  entry_signatures: z.array(Signature),
  entry_size_base: U64Str,
  size_base: U64Str,
  entry_price_sol_per_token: DecimalStr,
  entry_cost_lamports: U64Str,
  entry_fees: z.strictObject({ base_fee_lamports: U64Str, priority_fee_lamports: U64Str, tip_lamports: U64Str, venue_fee_lamports: U64Str }),
  mark_price_sol_per_token: DecimalStr.nullable(),
  mark_method: z.enum(['exit_quote', 'mid', 'last_trade']),
  mark_as_of: At,
  mark_slot: U64Str,
  exit_cost_est_lamports: U64Str.nullable(),
  exit_value_est_lamports: U64Str.nullable(),
  price_impact_exit_bps: Bps.nullable(),
  unrealized_pnl_net_lamports: I64Str.nullable(),
  unrealized_pnl_net_bps: Bps.nullable(),
  unrealized_pnl_net_usd_e6: I64Str.nullable(),
  realized_partial_lamports: I64Str,
  stops: z.array(Trigger),
  targets: z.array(Trigger),
  time_stop_at: At.nullable(),
  pending_close: z.strictObject({ command_id: Id, requested_at: At, reason: z.string() }).nullable(),
  close_failed_reason: z.string().nullable(),
  risk_flags: z.array(Flag),
});
export const VM05Positions = z.strictObject({ schema_version: version('VM-05'), items: z.array(VM05Position) });

// ---- VM-06 Closed-trade journal (UC-01) ----
/** VM-06 `exit_reason` (UC-01); a contract test asserts it equals the backend `ExitReason` union (CB-11). */
export const ExitReason = z.enum(['stop', 'target', 'trailing_stop', 'time_stop', 'manual_close', 'flatten_all', 'risk_breach', 'halt_flatten',
  'liquidity_collapse', 'authority_change', 'venue_disabled', 'sentinel_flatten', 'orphan_close', 'written_off', 'other']);
export const VM06Trade = z.strictObject({
  trade_id: Id,
  position_id: Id,
  mode: Mode,
  simulated: z.boolean(),
  strategy_id: z.string(),
  mint: Pubkey,
  symbol: UntrustedSymbol,
  decimals: Decimals,
  opened_at: At,
  closed_at: At,
  hold_ms: Ms,
  size_base: U64Str,
  entry_price_sol_per_token: DecimalStr,
  exit_price_sol_per_token: DecimalStr,
  gross_pnl_lamports: I64Str,
  costs: z.strictObject({ network_base_lamports: U64Str, priority_lamports: U64Str, tips_lamports: U64Str, venue_fees_lamports: U64Str, failed_tx_lamports: U64Str }),
  total_costs_lamports: U64Str,
  implicit_slippage_lamports: I64Str.nullable(),
  net_pnl_lamports: I64Str,
  net_pnl_bps: Bps,
  net_pnl_usd_e6: I64Str.nullable(),
  exit_reason: ExitReason,
  source: z.enum(['live', 'paper', 'sentinel', 'recovered', 'backtest', 'replay']),
  shadow: z.boolean(),
  entry_signatures: z.array(Signature),
  exit_signatures: z.array(Signature),
}).superRefine((t, ctx) => {
  const c = t.costs;
  const v = [c.network_base_lamports, c.priority_lamports, c.tips_lamports, c.venue_fees_lamports, c.failed_tx_lamports,
    t.total_costs_lamports, t.net_pnl_lamports, t.gross_pnl_lamports].map(big);
  if (v.some((x) => x === null)) return;                                // a malformed amount is already an issue of its field
  const [base, priority, tips, venue, failed, total, net, gross] = v as bigint[];
  const sum = (base as bigint) + (priority as bigint) + (tips as bigint) + (venue as bigint) + (failed as bigint);
  if (total !== sum) ctx.addIssue({ code: 'custom', path: ['total_costs_lamports'], message: 'total_costs_lamports must equal the sum of costs.*' });
  if (net !== (gross as bigint) - (total as bigint)) {
    ctx.addIssue({ code: 'custom', path: ['net_pnl_lamports'], message: 'net_pnl_lamports must equal gross_pnl_lamports - total_costs_lamports' });
  }
});
export const VM06Journal = z.strictObject({
  schema_version: version('VM-06'),
  items: z.array(VM06Trade),
  next_cursor: z.string().nullable(),
  totals: z.strictObject({
    count: Count, win_count: Count, loss_count: Count, gross_pnl_lamports: I64Str, net_pnl_lamports: I64Str, total_costs_lamports: I64Str, win_rate_bps: Bps,
  }),
});

// ---- VM-07 Candidate and signal feed ----
export const CheckUnit = z.enum(['lamports', 'base_units', 'bps', 'ms', 'count', 'slot', 'bool', 'usd_e6', 'sol_per_token']);
export const Comparator = z.enum(['gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'is_true', 'is_false']);
export const RiskCheck = z.strictObject({
  check_id: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'fail', 'warn', 'skipped', 'error']),
  observed: DecimalStr.nullable(),
  threshold: DecimalStr.nullable(),
  unit: CheckUnit,
  comparator: Comparator,
  message: z.string(),
  skipped_reason: z.string().nullable(),
});
export const VM07Signal = z.strictObject({
  candidate_id: Id,
  simulated: z.boolean(),
  mode: Mode,
  detected_at: At,
  detected_slot: U64Str,
  mint: Pubkey,
  symbol: UntrustedSymbol,
  name: UntrustedName,
  decimals: Decimals.nullable(),
  source: z.string(),
  strategy_id: z.string(),
  score: DecimalStr.nullable(),
  score_unit: z.string(),
  decision: z.enum(['pending', 'accepted', 'rejected', 'expired', 'error']),
  decided_at: At.nullable(),
  decision_latency_ms: Ms.nullable(),
  rejection_reasons: z.array(CodeMessage),
  risk_checks: z.array(RiskCheck),
  intended_size_lamports: U64Str.nullable(),
  expected_entry_price_sol_per_token: DecimalStr.nullable(),
  expected_cost_bps: Bps.nullable(),
  expected_price_impact_bps: Bps.nullable(),
  quote_age_ms: Ms.nullable(),
  liquidity_lamports: U64Str.nullable(),
  linked_position_id: Id.nullable(),
});
export const VM07Signals = z.strictObject({ schema_version: version('VM-07'), items: z.array(VM07Signal) });

// ---- VM-08 Token inspector ----
export const VM08Token = z.strictObject({
  schema_version: version('VM-08'),
  mint: Pubkey,
  symbol: UntrustedSymbol,
  name: UntrustedName,
  symbol_collision_count: Count,
  decimals: Decimals,
  supply_base: U64Str,
  token_program: z.enum(['spl_token', 'token_2022', 'unknown']),
  token_2022_extensions: z.array(z.string()),
  mint_authority: Pubkey.nullable(),
  freeze_authority: Pubkey.nullable(),
  first_seen_at: At,
  pools: z.array(z.strictObject({
    pool_id: Pubkey, venue: z.string(), quote_mint: Pubkey, liquidity_lamports: U64Str.nullable(), price_sol_per_token: DecimalStr.nullable(), as_of: At,
  })),
  holders_top: z.array(z.strictObject({ owner: Pubkey, amount_base: U64Str, pct_bps: Bps })).nullable(),
  flags: z.array(Flag),
  latest_risk_checks: z.array(RiskCheck),
  our_history: z.strictObject({ candidates_count: Count, trades_count: Count, net_pnl_lamports: I64Str }),
  current_position_id: Id.nullable(),
  as_of: At,
});

// ---- VM-09 Strategy performance ----
const nonPositive = (s: string): boolean => { const v = big(s); return v === null || v <= 0n; };
export const VM09Performance = z.strictObject({
  schema_version: version('VM-09'),
  rows: z.array(z.strictObject({
    strategy_id: z.string(),
    name: z.string(),
    mode: Mode,
    simulated: z.boolean(),
    window: Window,
    trade_count: Count,
    win_count: Count,
    loss_count: Count,
    win_rate_bps: Bps,
    win_rate_ci: z.strictObject({ low_bps: Bps, high_bps: Bps, level_bps: Bps, method: z.literal('wilson') }).nullable(),
    gross_pnl_lamports: I64Str,
    total_costs_lamports: I64Str,
    net_pnl_lamports: I64Str,
    expectancy_net_lamports: I64Str,
    expectancy_net_bps: Bps,
    expectancy_ci: z.strictObject({
      low_lamports: I64Str, high_lamports: I64Str, level_bps: Bps, method: z.enum(['bootstrap', 't_dist', 'other']), resamples: Count.nullable(),
    }).nullable(),
    avg_win_lamports: I64Str.nullable(),
    avg_loss_lamports: I64Str.nullable(),
    profit_factor: DecimalStr.nullable(),
    max_drawdown_lamports: I64Str.refine(nonPositive, { message: 'a drawdown is <= 0' }),
    max_drawdown_bps: Bps.max(0),
    current_drawdown_bps: Bps.max(0),
    avg_hold_ms: Ms,
    sample_sufficient: z.boolean(),
    min_trades_required: Count,
    edge_status: z.enum(['unproven', 'positive', 'negative']),
  })),
  as_of: At,
});

// ---- VM-10 Time series (UC-18: no 15 s resolution) ----
export const VM10Series = z.strictObject({
  schema_version: version('VM-10'),
  series: z.enum(['equity', 'drawdown', 'pnl_per_trade', 'pnl_daily', 'cost_daily', 'rpc_latency', 'landing_rate', 'stream_lag', 'price_ohlc']),
  unit: z.enum(['sol', 'bps', 'ms', 'sol_per_token']),
  resolution: z.enum(['trade', '1m', '5m', '1h', '1d']),
  t: z.array(z.number().int().nonnegative()),
  v: z.array(SeriesNumber).optional(),
  o: z.array(SeriesNumber).optional(),
  h: z.array(SeriesNumber).optional(),
  l: z.array(SeriesNumber).optional(),
  c: z.array(SeriesNumber).optional(),
  v_by_category: z.record(z.string(), z.array(SeriesNumber)).nullable(),
  gaps: z.array(z.strictObject({ from_ms: z.number().int().nonnegative(), to_ms: z.number().int().nonnegative(), reason: z.string() })),
  baseline: SeriesNumber.nullable(),
  simulated: z.boolean(),
  as_of: At,
}).superRefine((s, ctx) => {
  const ohlc = s.series === 'price_ohlc';
  const columns = ohlc ? (['o', 'h', 'l', 'c'] as const) : (['v'] as const);
  for (const k of ['v', 'o', 'h', 'l', 'c'] as const) {
    const wanted = (columns as readonly string[]).includes(k);
    const col = s[k];
    if (wanted !== (col !== undefined)) ctx.addIssue({ code: 'custom', path: [k], message: wanted ? `${k}[] is required for ${s.series}` : `${k}[] is not used by ${s.series}` });
    else if (col !== undefined && col.length !== s.t.length) ctx.addIssue({ code: 'custom', path: [k], message: `${k}[] must be as long as t[]` });
  }
});

// ---- VM-11 PnL summary ----
const Period = z.strictObject({
  net_pnl_lamports: I64Str,
  net_pnl_usd_e6: I64Str.nullable(),
  trade_count: Count,
  win_rate_bps: Bps.nullable(),
  costs_lamports: U64Str,
  cost_bps_of_volume: Bps.nullable(),
  fixed_costs_usd_e6: I64Str,
  net_after_fixed_usd_e6: I64Str.nullable(),
  equity_change_bps: Bps.nullable(),
});
export const VM11PnlSummary = z.strictObject({
  schema_version: version('VM-11'),
  simulated: z.boolean(),
  mode: Mode,
  periods: z.strictObject({ today_utc: Period, d7: Period, d30: Period, since_live_start: Period, all: Period }),
  unrealized_net_lamports: I64Str,
  open_positions_count: Count,
});

// ---- VM-12 Risk limits and breakers (UC-04, UC-05) ----
/** VM-12 `limits[].limit_value`, `usage_value`, `hard_ceiling`: "`U64Str` or integer as string" (UI.md); `limit_def.value` is a signed i64. */
const LimitInt = z.union([U64Str, I64Str]);
export const VM12Risk = z.strictObject({
  schema_version: version('VM-12'),
  limits: z.array(z.strictObject({
    limit_id: z.string(),
    label: z.string(),
    short_code: z.string(),
    scope: z.enum(['global', 'strategy', 'token', 'position']),
    scope_id: z.string().nullable(),
    kind: z.string(),
    unit: z.enum(['lamports', 'bps', 'count', 'ms']),
    display_unit: z.enum(['sol', 'bps', 'pct', 'count', 'minutes']),
    limit_value_display: DecimalStr,
    limit_value: LimitInt,
    usage_value: LimitInt.nullable(),
    usage_bps: Bps.nullable(),
    state: z.enum(['normal', 'elevated', 'near', 'breached', 'disabled']),
    action_on_breach: z.enum(['block_entries', 'pause_entries', 'reduce_size', 'halt', 'flatten', 'demote', 'alert_only']),
    last_breach_at: At.nullable(),
    editable: z.boolean(),
    hard_ceiling: LimitInt.nullable(),
    pending_change: z.strictObject({ command_id: Id, new_value: z.string(), effective_at: At }).nullable(),
  })),
  breakers: z.array(z.strictObject({
    breaker_id: z.string(), label: z.string(), tripped: z.boolean(), tripped_at: At.nullable(), reason: z.string().nullable(), auto_reset_at: At.nullable(),
    requires_manual_reset: z.boolean(),
  })),
  daily_loss: z.strictObject({ used_lamports: U64Str, limit_lamports: U64Str, resets_at: At }),
  as_of: At,
});

// ---- VM-13 System health (UC-17) ----
const Status = z.enum(['ok', 'degraded', 'down']);
export const VM13Health = z.strictObject({
  schema_version: version('VM-13'),
  overall_status: Status,
  rpc: z.array(z.strictObject({
    endpoint_id: z.string(),
    label: z.string(),
    role: z.enum(['read', 'send', 'stream']),
    latency_ms_p50: Ms,
    latency_ms_p95: Ms,
    latency_ms_p99: Ms,
    error_rate_bps: Bps,
    requests_per_min: z.number().nonnegative(),
    slot: U64Str,
    slot_lag: z.number().int(),
    last_ok_at: At,
    status: Status,
    projected_month_end_bps: Bps.nullable(),
  })),
  streams: z.array(z.strictObject({ stream_id: z.string(), label: z.string(), lag_ms: Ms, last_event_at: At, reconnects_1h: Count, status: Status })),
  tx: z.strictObject({
    window_s: Seconds, sent_count: Count, landed_count: Count, failed_count: Count, expired_count: Count, landing_rate_bps: Bps.nullable(),
    landing_definition: z.string(), confirm_latency_ms_p50: Ms.nullable(), confirm_latency_ms_p95: Ms.nullable(),
    avg_priority_fee_micro_lamports_per_cu: U64Str.nullable(), avg_tip_lamports: U64Str.nullable(),
  }),
  errors: z.array(z.strictObject({
    category: z.string(), count_5m: Count, count_1h: Count, rate_per_min: z.number().nonnegative(), last_message: z.string(), last_at: At.nullable(),
  })),
  process: z.strictObject({ uptime_s: Seconds, rss_bytes: Bytes, queue_depths: z.array(z.strictObject({ name: z.string(), depth: Count })) }),
  /** `ntp_offset_ms` is a signed offset (the clock-offset alert compares its absolute value with 500 ms). */
  clock: z.strictObject({ server_time: At, ntp_offset_ms: z.number().nullable() }),
  safety: z.array(z.strictObject({
    name: z.enum(['sentinel_heartbeat', 'notifier_last_test', 'watcher_last_poll', 'signer_lock', 'exit_lease']), status: Status, detail: z.string(), at: At.nullable(),
  })),
});

// ---- VM-14 Cost tracker ----
export const VM14Costs = z.strictObject({
  schema_version: version('VM-14'),
  period: z.enum(['today', 'd7', 'd30', 'mtd']),
  from: At,
  to: At,
  simulated: z.boolean(),
  network_base_lamports: U64Str,
  priority_lamports: U64Str,
  tips_lamports: U64Str,
  venue_fees_lamports: U64Str,
  slippage_lamports: I64Str,
  failed_tx_lamports: U64Str,
  rent_deposits_lamports: I64Str,
  variable_lamports: U64Str,
  variable_usd_e6: I64Str.nullable(),
  fixed_items: z.array(z.strictObject({ item_id: Id, label: z.string(), monthly_usd_e6: I64Str, prorated_period_usd_e6: I64Str, source: z.enum(['manual', 'invoice']) })),
  fixed_usd_e6: I64Str,
  total_usd_e6: I64Str.nullable(),
  traded_volume_lamports: U64Str,
  cost_per_trade_lamports: U64Str.nullable(),
  cost_bps_of_volume: Bps.nullable(),
  fixed_cost_bps_of_equity_per_month: Bps.nullable(),
  break_even_monthly_return_bps: Bps.nullable(),
});

// ---- VM-15 Configuration ----
const RiskDirection = z.enum(['increases_risk', 'decreases_risk', 'neutral']);
export const VM15Field = z.strictObject({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  type: z.enum(['int', 'decimal', 'bool', 'enum', 'duration_ms', 'lamports', 'bps', 'base_units', 'string', 'list']),
  unit: z.string().nullable(),
  min: z.string().nullable(),
  max: z.string().nullable(),
  step: z.string().nullable(),
  enum_values: z.array(z.string()).nullable(),
  default: z.json().nullable(),
  current: z.json().nullable(),
  secret: z.boolean(),
  is_set: z.boolean(),
  requires_restart: z.boolean(),
  risk_direction_on_increase: RiskDirection,
  mode_scope: z.array(Mode),
}).superRefine((f, ctx) => {
  if (f.secret && (f.default !== null || f.current !== null)) ctx.addIssue({ code: 'custom', path: ['current'], message: 'a secret field never carries a value (VM-15 is_set only)' });
});
export const VM15Config = z.strictObject({
  schema_version: version('VM-15'),
  config_version: z.string(),
  applied_at: At,
  applied_by: z.string(),
  sections: z.array(z.strictObject({ section_id: z.string(), label: z.string(), fields: z.array(VM15Field) })),
});
export const VM15ValidateResponse = z.strictObject({
  schema_version: version('VM-15'),
  errors: z.array(z.strictObject({ key: z.string(), code: z.string(), message: z.string() })),
  warnings: z.array(z.strictObject({ key: z.string(), code: z.string(), message: z.string() })),
  diff: z.array(z.strictObject({ key: z.string(), old: z.json(), new: z.json(), direction: RiskDirection })),
  derived_action_class: ActionClass,
});

// ---- VM-16 Alerts ----
export const VM16Alert = z.strictObject({
  alert_id: Id,
  severity: Severity,
  category: z.enum(['risk', 'execution', 'health', 'cost', 'config', 'security', 'mode', 'reconciliation']),
  title: z.string(),
  body: z.string(),
  created_at: At,
  updated_at: At,
  state: z.enum(['open', 'acknowledged', 'snoozed', 'resolved']),
  acked_by: z.string().nullable(),
  acked_at: At.nullable(),
  snoozed_until: At.nullable(),
  occurrences: Count,
  dedupe_key: z.string(),
  entity: z.strictObject({ type: z.enum(['position', 'token', 'limit', 'breaker', 'rpc', 'command', 'config']), id: z.string() }).nullable(),
  requires_ack: z.boolean(),
  snoozable: z.boolean(),
}).superRefine((a, ctx) => {
  if (a.severity === 'critical' && a.snoozable) ctx.addIssue({ code: 'custom', path: ['snoozable'], message: 'a critical alert is not snoozable' });
});
export const VM16Alerts = z.strictObject({ schema_version: version('VM-16'), items: z.array(VM16Alert), next_cursor: z.string().nullable() });

// ---- VM-17 Audit log (UC-06) ----
export const VM17AuditEvent = z.strictObject({
  event_id: Id,
  at: At,
  mode: Mode,
  actor: Actor,
  action: z.string(),
  action_class: ActionClass,
  target: z.strictObject({ type: z.string(), id: z.string() }).nullable(),
  before: JsonObject.nullable(),
  after: JsonObject.nullable(),
  reason_text: z.string().nullable(),
  command_id: Id.nullable(),
  result: z.enum(['accepted', 'scheduled', 'executed', 'rejected', 'failed', 'cancelled']),
  dialog_version: z.string().nullable(),
  dialog_text_hash: z.string().nullable(),
  session_ref: z.string(),
  prev_hash: Hex64,
  hash: Hex64,
});
export const VM17Audit = z.strictObject({ schema_version: version('VM-17'), items: z.array(VM17AuditEvent), next_cursor: z.string().nullable() });

// ---- VM-18 Mode readiness (UC-09) ----
export const StrategyStage = z.enum(['research', 'coarse_screened', 'backtest_passed', 'replay_passed', 'paper_passed', 'live_small', 'live', 'failed', 'archived']);
export const VM18Readiness = z.strictObject({
  schema_version: version('VM-18'),
  current_mode: Mode,
  target_mode: Mode,
  strategy_id: z.string(),
  strategy_stage: StrategyStage,
  stage_entered_at: At,
  trial_key: z.string(),
  gates: z.array(z.strictObject({
    gate_id: z.string(),
    label: z.string(),
    metric: z.string(),
    unit: z.enum([...CheckUnit.options, 'ratio']),
    comparator: Comparator,
    required_value: z.string().nullable(),
    actual_value: z.string().nullable(),
    window: Window.nullable(),
    sample_size: Count.nullable(),
    pass: z.boolean(),
    as_of: At,
    evidence_route: z.string(),
  })),
  all_pass: z.boolean(),
  blocking_reasons: z.array(CodeMessage),
  cooldown_until: At.nullable(),
  min_dwell_until: At.nullable(),
  caps_after_promotion: z.strictObject({ max_trade_lamports: U64Str, max_open_positions: Count, max_daily_loss_lamports: U64Str }),
  checklist: z.array(z.strictObject({ item_id: z.string(), text: z.string() })),
  required_phrase: z.string(),
});

// ---- VM-19 Command contract (UC-14) ----
const params = <T extends string, S extends z.ZodType>(type: T, shape: S) => z.strictObject({ type: z.literal(type), params: shape });
export const CommandParams = z.discriminatedUnion('type', [
  params('halt', z.strictObject({})),
  params('resume', z.strictObject({})),
  params('flatten_all', z.strictObject({ max_slippage_bps: Bps })),
  params('close_position', z.strictObject({ position_id: Id, max_slippage_bps: Bps })),
  params('set_mode', z.strictObject({ target_mode: Mode, open_positions_policy: z.enum(['keep_managing', 'flatten']) })),
  params('update_limit', z.strictObject({ limit_id: z.string(), new_value: DecimalStr })),
  params('reset_breaker', z.strictObject({ breaker_id: z.string() })),
  params('apply_config', z.strictObject({ config_version: z.string(), changes: z.array(z.strictObject({ key: z.string(), new: z.json() })) })),
  params('ack_alert', z.strictObject({ alert_id: Id })),
  params('snooze_alert', z.strictObject({ alert_id: Id, until: At })),
  params('cancel_scheduled', z.strictObject({ target_command_id: Id })),
  params('write_off_position', z.strictObject({ position_id: Id })),
  params('close_unsolicited', z.strictObject({ mint: Pubkey })),
]);
export const CommandType = z.enum(['halt', 'resume', 'flatten_all', 'close_position', 'set_mode', 'update_limit', 'reset_breaker', 'apply_config', 'ack_alert',
  'snooze_alert', 'cancel_scheduled', 'write_off_position', 'close_unsolicited']);
const RequestBase = z.strictObject({
  command_id: Id,
  type: CommandType,
  params: z.unknown(),
  expected_state_version: U64Str,
  reason_text: z.string().nullable(),
  typed_confirmation: z.string().nullable(),
  checklist_ack: z.array(z.string()).nullable(),
  step_up_assertion: JsonObject.nullable(),
  dialog_version: z.string(),
  dialog_text_hash: z.string(),
  client_sent_at: At,
});
export const VM19CommandRequest = RequestBase.superRefine((r, ctx) => {
  const p = CommandParams.safeParse({ type: r.type, params: r.params });
  if (!p.success) for (const issue of p.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
});
/** Documented `blocking_reasons[].code` values: `book_not_flat` (UC-14), `latch_requires_host_cli` (UC-08). */
export const BLOCKING_REASON_CODES = ['book_not_flat', 'latch_requires_host_cli'] as const;
export const VM19PreviewResponse = z.strictObject({
  schema_version: version('VM-19'),
  action_class: ActionClass,
  requires_step_up: z.boolean(),
  required_phrase: z.string().nullable(),
  summary: z.string(),
  consequences: z.array(z.strictObject({ label: z.string(), value: z.string(), unit: z.string() })),
  delay_s: z.union([z.literal(0), z.literal(60)]),
  state_version: U64Str,
  blocking_reasons: z.array(CodeMessage),
}).superRefine((p, ctx) => {
  if ((p.action_class === 'A3') !== (p.delay_s === 60)) ctx.addIssue({ code: 'custom', path: ['delay_s'], message: 'delay_s is 60 for A3 and 0 otherwise' });
});
export const VM19CommandStatus = z.strictObject({
  schema_version: version('VM-19'),
  command_id: Id,
  status: z.enum(['accepted', 'scheduled', 'executing', 'executed', 'rejected', 'failed', 'cancelled']),
  action_class: ActionClass,
  reason_code: z.string().nullable(),
  message: z.string().nullable(),
  effective_at: At.nullable(),
  executed_at: At.nullable(),
  new_state_version: U64Str.nullable(),
  audit_event_id: Id,
});

// ---- VM-20 Mobile digest ----
export const VM20Digest = z.strictObject({
  schema_version: version('VM-20'),
  mode: Mode,
  simulated: z.boolean(),
  trading_state: TradingState,
  equity_lamports: U64Str,
  today_net_pnl_lamports: I64Str,
  open_positions_count: Count,
  open_unrealized_net_lamports: I64Str,
  worst_position: z.strictObject({ position_id: Id, symbol: UntrustedSymbol, unrealized_pnl_net_bps: Bps }).nullable(),
  limits_near_count: Count,
  limits_breached_count: Count,
  breakers_tripped_count: Count,
  open_alerts: z.strictObject({ critical: Count, warning: Count }),
  health_status: Status,
  landing_rate_bps: Bps.nullable(),
  as_of: At,
});

// ---- VM-21 Imported runs (UC-12) ----
export const VM21Run = z.strictObject({
  run_id: Id,
  mode: z.enum(['backtest', 'replay', 'coarse_screen']),
  strategy_id: z.string(),
  trial_key: z.string(),
  from: At,
  to: At,
  imported_at: At,
  bundle_signature_ok: z.boolean(),
  trades_count: Count,
  low_coverage: z.boolean(),
  gate_ids_evaluated: z.array(z.string()),
});
export const VM21Runs = z.strictObject({ schema_version: version('VM-21'), items: z.array(VM21Run), as_of: At });

/** The top-level payload schema of each VM (VM-19: the command status pushed on `commands`). */
export const VM_SCHEMAS = {
  'VM-01': VM01Envelope, 'VM-02': VM02Session, 'VM-03': VM03System, 'VM-04': VM04Balances, 'VM-05': VM05Positions, 'VM-06': VM06Journal,
  'VM-07': VM07Signals, 'VM-08': VM08Token, 'VM-09': VM09Performance, 'VM-10': VM10Series, 'VM-11': VM11PnlSummary, 'VM-12': VM12Risk,
  'VM-13': VM13Health, 'VM-14': VM14Costs, 'VM-15': VM15Config, 'VM-16': VM16Alerts, 'VM-17': VM17Audit, 'VM-18': VM18Readiness,
  'VM-19': VM19CommandStatus, 'VM-20': VM20Digest, 'VM-21': VM21Runs,
} as const satisfies Record<VmId, z.ZodType>;

/** The entity pushed by `upsert` (and named by `key` in `remove`) for each collection VM. */
export const VM_ENTITY_SCHEMAS = {
  'VM-05': VM05Position, 'VM-06': VM06Trade, 'VM-07': VM07Signal, 'VM-16': VM16Alert, 'VM-17': VM17AuditEvent, 'VM-21': VM21Run,
} as const satisfies Partial<Record<VmId, z.ZodType>>;

const EmptyData = z.strictObject({});
export type ParsedEnvelope = z.infer<typeof VM01Envelope>;
export type EnvelopeResult = { ok: true; value: ParsedEnvelope } | { ok: false; issues: string[] };

const issues = (e: z.ZodError, prefix: string): string[] => e.issues.map((i) => `${prefix}${i.path.map(String).join('.')}: ${i.message}`);

/**
 * Parses a VM-01 envelope and its `data` for its kind (Z02 round 2 ruling 5): `snapshot` and `replace` carry the VM's
 * payload; `upsert` carries one entity of a collection VM with its `key`; `remove` carries only the `key`; `heartbeat`,
 * `reset` and `incompatible` carry no data. A payload is never accepted unchecked.
 */
export function parseEnvelope(raw: unknown): EnvelopeResult {
  const env = VM01Envelope.safeParse(raw);
  if (!env.success) return { ok: false, issues: issues(env.error, '') };
  const e = env.data;
  const entity = (VM_ENTITY_SCHEMAS as Partial<Record<VmId, z.ZodType>>)[e.vm];
  let data: z.ZodType;
  switch (e.kind) {
    case 'snapshot':
    case 'replace':
      if (e.vm === 'VM-01') return { ok: false, issues: ['vm: VM-01 has no payload of its own'] };
      data = VM_SCHEMAS[e.vm];
      break;
    case 'upsert':
    case 'remove':
      if (entity === undefined) return { ok: false, issues: [`kind: ${e.kind} needs a collection VM, not ${e.vm}`] };
      if (e.key === null || e.key === '') return { ok: false, issues: [`key: required on ${e.kind}`] };
      data = e.kind === 'upsert' ? entity : EmptyData;
      break;
    case 'heartbeat':
      if (e.vm !== 'VM-01') return { ok: false, issues: ['vm: a heartbeat is VM-01'] };
      data = EmptyData;
      break;
    default:
      data = EmptyData;
  }
  const d = data.safeParse(e.data);
  return d.success ? { ok: true, value: e } : { ok: false, issues: issues(d.error, 'data.') };
}
