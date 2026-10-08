// Fixtures for every view model (B-M28-01 logic 4): happy path, empty lists, every nullable field null, maximum-length
// untrusted strings, u64 maximum values, negative PnL, and simulated and live payloads, where the VM has such fields.
// Public keys, signatures and IDs are random test values generated for this file: no real wallet, no real transaction.
// The UI's fixture suite (UI-T08) and the backend's contract tests import them as `@bot/contract/fixtures`.
import { z } from 'zod';
import { SCHEMA_VERSIONS, type VmId } from './versions.ts';
import { VM_SCHEMAS } from './vm.ts';

export type Variant = 'happy' | 'empty' | 'nulls' | 'max_untrusted' | 'u64_max' | 'negative_pnl' | 'simulated' | 'live';
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

export const U64_MAX = '18446744073709551615';
const K = ['5Nq3vnUTN4fbcJzLad4y62qKgc39AwbWFkL1NUqXy5da', 'Di7x3CF65agPCFpLJLN84ZxGjJXpvmZSTxViA3MHB6R5', 'FHSkEDZ1b9WoNn7ewTLDxzF2mVygmNFx3X698dQNywZd',
  '3JFCFk9cA5vB7QZYPSFjwYbNsYJZK1beT5E9v3QiFkRH', '9g7FHnYuLFk9qwn7YwxkjS4mdK82f6LVf2DMBawKhtK1', '9dQHD7prLj8VNNKLZXbYRtBWaETHadviz4qgxnvJ5v2R'] as const;
const SIG = ['2JmmkwxUc4DfJyQD5rLWQAhDwejk7TgCMw8282u1bogoUFTo2VWaFQsEMhDk1yuz233gyZdqDTHPRU45jYR1HzwT',
  '64MagVkReztqbr7gzdAXZ8xdYYEHqFBXcgmdKSAzDYUYh7GA1oLtx3Tkd8uLCFtttX6F4RVQEiFbExDUUWo82EFa'] as const;
const ID = ['01KT46ZEGEGQGH3KEVAAEMZNBM', '01KWR8KYYH9F0X8KTYJZWHBWNG', '01KJTNCVM4RS3D115T3PAY3D21', '01KET3B3N2B3ZX43BCWG9W1FGA',
  '01KHG4WJBJDRMBCYA6DESDHXNV', '01K1RBJS8BN13J5ZNPQBPEF2TA', '01KWZF059A0QCQ4861MYRQVJA1'] as const;
const T0 = '2026-10-06T14:02:11.123Z';
const T1 = '2026-10-06T14:05:00.000Z';
/** Exactly 32 and 64 UTF-8 bytes, with multi-byte characters (UI convention 5). */
export const MAX_SYMBOL = `${'\u20ac'.repeat(10)}ab`;
export const MAX_NAME = `${'\u00e9'.repeat(30)}name`;

/** Deep merge for fixture variants: objects merge, everything else (arrays included) replaces. */
export function merge(base: Json, patch: Json): Json {
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(base[k] as Json, v);   // a key only in the patch: merge(undefined, v) is v
  return out;
}

/** The value with `rule` applied wherever the schema has a nullable field (`nulls`) or an array (`empty`). */
export function derive(schema: z.ZodType, value: Json, rule: 'nulls' | 'empty'): Json {
  if (schema instanceof z.ZodNullable) return rule === 'nulls' ? null : derive(schema.unwrap() as z.ZodType, value, rule);
  if (schema instanceof z.ZodOptional) return derive(schema.unwrap() as z.ZodType, value, rule);
  if (schema instanceof z.ZodArray) return rule === 'empty' ? [] : (value as Json[]).map((v) => derive(schema.element as z.ZodType, v, rule));
  if (schema instanceof z.ZodObject) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value as Obj)) out[k] = derive(schema.shape[k] as z.ZodType, v, rule);
    return out;
  }
  return value;
}

const trigger = (type: string, over: Obj = {}): Obj => ({ type, trigger_price_sol_per_token: null, trigger_pnl_bps: null, trailing_distance_bps: null, armed: true, ...over });
const riskCheck: Obj = { check_id: 'fee_per_side', label: 'Fee per side', status: 'pass', observed: '30', threshold: '125', unit: 'bps', comparator: 'lte',
  message: 'fee within the ceiling', skipped_reason: null };
const period = (net: string): Obj => ({ net_pnl_lamports: net, net_pnl_usd_e6: '1530000', trade_count: 3, win_rate_bps: 6_667, costs_lamports: '120000',
  cost_bps_of_volume: 45, fixed_costs_usd_e6: '330000', net_after_fixed_usd_e6: '1200000', equity_change_bps: 12 });
const mode = (m: string): Obj => ({ mode: m, simulated: m !== 'live_small' && m !== 'live' });

const position: Obj = {
  position_id: ID[0], ...mode('live_small'), strategy_id: 'mr01', mint: K[0], symbol: 'BONK', name: 'Bonk', decimals: 6, venue: 'pumpswap', state: 'open',
  opened_at: T0, opened_slot: '372000000', entry_signatures: [SIG[0]], entry_size_base: '1500000000', size_base: '1500000000',
  entry_price_sol_per_token: '0.0000123', entry_cost_lamports: '18460000',
  entry_fees: { base_fee_lamports: '5000', priority_fee_lamports: '20000', tip_lamports: '10000', venue_fee_lamports: '55000' },
  mark_price_sol_per_token: '0.0000125', mark_method: 'exit_quote', mark_as_of: T1, mark_slot: '372000450', exit_cost_est_lamports: '90000',
  exit_value_est_lamports: '18610000', price_impact_exit_bps: 40, unrealized_pnl_net_lamports: '150000', unrealized_pnl_net_bps: 81,
  unrealized_pnl_net_usd_e6: '22500', realized_partial_lamports: '0', stops: [trigger('price', { trigger_price_sol_per_token: '0.0000110' }),
    trigger('trailing', { trailing_distance_bps: 800 })], targets: [trigger('pnl_pct', { trigger_pnl_bps: 600 }), trigger('time', { armed: false })],
  time_stop_at: '2026-10-06T20:02:11.123Z', pending_close: { command_id: ID[1], requested_at: T1, reason: 'manual' }, close_failed_reason: null,
  risk_flags: [{ code: 'entry_unconfirmed', severity: 'warning', message: 'exits armed on first evidence of landing' }],
};
const trade = (gross: string, total: string, net: string): Obj => ({
  trade_id: ID[2], position_id: ID[0], ...mode('live_small'), strategy_id: 'mr01', mint: K[0], symbol: 'BONK', decimals: 6, opened_at: T0, closed_at: T1,
  hold_ms: 168_877, size_base: '1500000000', entry_price_sol_per_token: '0.0000123', exit_price_sol_per_token: '0.0000126', gross_pnl_lamports: gross,
  costs: { network_base_lamports: '10000', priority_lamports: '40000', tips_lamports: '20000', venue_fees_lamports: '110000', failed_tx_lamports: '0' },
  total_costs_lamports: total, implicit_slippage_lamports: '-2000', net_pnl_lamports: net, net_pnl_bps: 147, net_pnl_usd_e6: '40500', exit_reason: 'target',
  source: 'live', shadow: false, entry_signatures: [SIG[0]], exit_signatures: [SIG[1]],
});
const signal: Obj = {
  candidate_id: ID[3], ...mode('paper'), detected_at: T0, detected_slot: '372000000', mint: K[0], symbol: 'BONK', name: 'Bonk', decimals: 6,
  source: 'pumpportal_migration', strategy_id: 'pm01', score: '2.75', score_unit: 'zscore', decision: 'rejected', decided_at: T1, decision_latency_ms: 41.5,
  rejection_reasons: [{ code: 'depth', message: 'effective depth below 85 SOL' }], risk_checks: [riskCheck], intended_size_lamports: '50000000',
  expected_entry_price_sol_per_token: '0.0000123', expected_cost_bps: 180, expected_price_impact_bps: 35, quote_age_ms: 400, liquidity_lamports: '91000000000',
  linked_position_id: ID[0],
};
const alert: Obj = {
  alert_id: ID[4], severity: 'warning', category: 'health', title: 'Provider burn rate', body: 'Projected month-end use is 84% of the allowance.',
  created_at: T0, updated_at: T1, state: 'acknowledged', acked_by: 'operator', acked_at: T1, snoozed_until: T1, occurrences: 3, dedupe_key: 'burn:helius',
  entity: { type: 'rpc', id: 'helius' }, requires_ack: true, snoozable: true,
};
const audit: Obj = {
  event_id: ID[5], at: T0, mode: 'paper', actor: { type: 'sentinel', id: 'sentinel', display: 'Kill sentinel' }, action: 'halt', action_class: 'A1',
  target: { type: 'system', id: 'trading' }, before: { trading_state: 'running', state_version: '41' }, after: { trading_state: 'halted', state_version: '42' },
  reason_text: 'engine heartbeat lost', command_id: ID[1], result: 'executed', dialog_version: 'halt-v1', dialog_text_hash: 'b'.repeat(64),
  session_ref: 'c'.repeat(64), prev_hash: '0'.repeat(64), hash: 'a'.repeat(64),
};
const run: Obj = {
  run_id: ID[6], mode: 'backtest', strategy_id: 'mr01', trial_key: 'tk-mr01-7f3a', from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z',
  imported_at: T1, bundle_signature_ok: true, trades_count: 214, low_coverage: false, gate_ids_evaluated: ['B-1', 'B-2', 'R-6'],
};

const hotWallet: Obj = {
  wallet_id: 'hot', label: 'Trading', pubkey: K[1], role: 'trading', sol_lamports: '2000000000', sol_commitment: 'confirmed', sol_as_of_slot: '372000000',
  reserved_lamports: '150000000', available_lamports: '1850000000',
  tokens: [{ mint: K[0], symbol: 'BONK', decimals: 6, amount_base: '1500000000', token_class: 'ours', value_est_lamports: '18610000', value_as_of: T1 },
    { mint: K[2], symbol: 'GIFT', decimals: 9, amount_base: '1', token_class: 'unsolicited', value_est_lamports: '0', value_as_of: T1 }],
};
const perfRow: Obj = {
  strategy_id: 'mr01', name: 'MR-01', ...mode('paper'), window: { from: T0, to: T1 }, trade_count: 40, win_count: 22, loss_count: 18, win_rate_bps: 5_500,
  win_rate_ci: { low_bps: 4_000, high_bps: 6_900, level_bps: 9_500, method: 'wilson' }, gross_pnl_lamports: '9000000', total_costs_lamports: '6000000',
  net_pnl_lamports: '3000000', expectancy_net_lamports: '75000', expectancy_net_bps: 15,
  expectancy_ci: { low_lamports: '-20000', high_lamports: '170000', level_bps: 9_500, method: 'bootstrap', resamples: 10_000 },
  avg_win_lamports: '400000', avg_loss_lamports: '-322222', profit_factor: '1.52', max_drawdown_lamports: '-1200000', max_drawdown_bps: -310,
  current_drawdown_bps: -40, avg_hold_ms: 5_400_000.5, sample_sufficient: false, min_trades_required: 100, edge_status: 'unproven',
};

const HAPPY: Record<VmId, Obj> = {
  'VM-01': {
    vm: 'VM-01', schema_version: SCHEMA_VERSIONS['VM-01'], seq: '1042', kind: 'heartbeat', key: null, emitted_at: T1, as_of: T1, clock: 'wall',
    mode: 'live_small', run_id: ID[6], data: {}, server_time: T1, state_version: '42', topics: ['system', 'positions'],
    ui_supported: { 'VM-05': [1, 2], 'VM-06': [2] },
  },
  'VM-02': {
    schema_version: 1, operator_id: ID[0], display_name: 'op', role: 'operator', session_expires_at: T1, idle_timeout_s: 1_800, elevated_until: T1,
    webauthn_available: true, environment_label: 'bot-host \u00b7 tailnet', client_kind: 'desktop', csrf_token: 'csrf-test-value', login_rate_limited_until: T1,
    preferences: { theme: 'system', density: 'standard', polarity: 'green-red', tz: 'utc', shortcuts: { mode: 'remap', remap: { g: 'h' } }, sound: true,
      reduced_motion: 'system', default_route: '/overview' },
  },
  'VM-03': {
    schema_version: 2, state_version: '42', ...mode('live_small'), mode_since: T0, run_id: ID[6], trading_state: 'halted', trading_state_changed_at: T1,
    kill: { halted_by: { type: 'cli', id: 'botctl', display: 'botctl over SSH' }, latch_set_by: 'cli', latch_clear_requires: 'host_cli', reason_code: 'manual',
      reason_text: 'maintenance', components: [{ name: 'M19', acked: true, acked_at: T1 }, { name: 'signer_latch', acked: false, acked_at: T1 }] },
    signer: { lock: 'unlocked', exit_lease_holder: 'engine' },
    live_caps: { max_trade_lamports: '66666667', max_open_positions: 3, max_daily_loss_lamports: '200000000' },
    scheduled_change: { command_id: ID[1], kind: 'set_mode', summary: 'Promote to live', effective_at: T1, cancellable: true },
    strategies: [{ strategy_id: 'mr01', name: 'MR-01', enabled: true, modes: ['paper', 'live_small'] }],
    sim_clock: { sim_time: T0, speed_x: 1, paused: false }, versions: { bot: '0.1.0', config: 'a'.repeat(64) }, trading_wallet_pubkey: K[1],
  },
  'VM-04': {
    schema_version: 2, source: 'chain', simulated: false,
    wallets: [
      hotWallet,
      { wallet_id: 'simpayer', label: 'Simulation payer', pubkey: K[3], role: 'reserve', sol_lamports: '50000000', sol_commitment: 'confirmed',
        sol_as_of_slot: '372000000', reserved_lamports: '0', available_lamports: '50000000', tokens: [] },
    ],
    totals: { sol_lamports: '2050000000', positions_value_lamports: '18610000', equity_lamports: '2068610000', equity_usd_e6: '310291500',
      sol_usd_price_e6: '150000000', sol_usd_as_of: T1, sol_usd_source: 'jupiter_price_v3' },
    reconciled_at: T1, reconcile_diff_lamports: '0',
  },
  'VM-05': { schema_version: 2, items: [position] },
  'VM-06': { schema_version: 2, items: [trade('450000', '180000', '270000')], next_cursor: 'c2',
    totals: { count: 1, win_count: 1, loss_count: 0, gross_pnl_lamports: '450000', net_pnl_lamports: '270000', total_costs_lamports: '180000', win_rate_bps: 10_000 } },
  'VM-07': { schema_version: 1, items: [signal] },
  'VM-08': {
    schema_version: 1, mint: K[0], symbol: 'BONK', name: 'Bonk', symbol_collision_count: 2, decimals: 6, supply_base: '999999999000000',
    token_program: 'token_2022', token_2022_extensions: ['metadata_pointer'], mint_authority: K[4], freeze_authority: K[5], first_seen_at: T0,
    pools: [{ pool_id: K[2], venue: 'pumpswap', quote_mint: K[3], liquidity_lamports: '91000000000', price_sol_per_token: '0.0000125', as_of: T1 }],
    holders_top: [{ owner: K[4], amount_base: '100000000000', pct_bps: 1_000 }], flags: [{ code: 'mint_authority_present', severity: 'critical', message: 'can mint' }],
    latest_risk_checks: [riskCheck], our_history: { candidates_count: 2, trades_count: 1, net_pnl_lamports: '270000' }, current_position_id: ID[0], as_of: T1,
  },
  'VM-09': {
    schema_version: 1,
    rows: [perfRow],
    as_of: T1,
  },
  'VM-10': {
    schema_version: 1, series: 'equity', unit: 'sol', resolution: '1m', t: [1_759_759_200_000, 1_759_759_260_000], v: [2.0681, 2.0686],
    v_by_category: { network: [0.001, 0.002] }, gaps: [{ from_ms: 1_759_759_200_000, to_ms: 1_759_759_230_000, reason: 'process_down' }], baseline: 2,
    simulated: false, as_of: T1,
  },
  'VM-11': { schema_version: 1, ...mode('live_small'), periods: { today_utc: period('270000'), d7: period('900000'), d30: period('2700000'),
    since_live_start: period('2700000'), all: period('3000000') }, unrealized_net_lamports: '150000', open_positions_count: 1 },
  'VM-12': {
    schema_version: 2,
    limits: [{ limit_id: 'maxpos', label: 'Max position size', short_code: 'MAXPOS', scope: 'global', scope_id: 'all', kind: 'max_position_size', unit: 'lamports',
      display_unit: 'sol', limit_value_display: '0.0667', limit_value: '66666667', usage_value: '18460000', usage_bps: 2_769, state: 'normal',
      action_on_breach: 'pause_entries', last_breach_at: T0, editable: true, hard_ceiling: '100000000',
      pending_change: { command_id: ID[1], new_value: '0.08', effective_at: T1 } }],
    breakers: [{ breaker_id: 'LOSSRUN', label: 'Loss run', tripped: true, tripped_at: T0, reason: '5 losses in a row', auto_reset_at: T1, requires_manual_reset: false }],
    daily_loss: { used_lamports: '0', limit_lamports: '200000000', resets_at: T1 }, as_of: T1,
  },
  'VM-13': {
    schema_version: 2, overall_status: 'degraded',
    rpc: [{ endpoint_id: 'helius-1', label: 'Helius free', role: 'read', latency_ms_p50: 41, latency_ms_p95: 120.5, latency_ms_p99: 300, error_rate_bps: 12,
      requests_per_min: 55.5, slot: '372000450', slot_lag: 1, last_ok_at: T1, status: 'ok', projected_month_end_bps: 8_400 }],
    streams: [{ stream_id: 'pumpportal', label: 'PumpPortal', lag_ms: 350, last_event_at: T1, reconnects_1h: 1, status: 'degraded' }],
    tx: { window_s: 3_600, sent_count: 20, landed_count: 18, failed_count: 1, expired_count: 1, landing_rate_bps: 9_000,
      landing_definition: 'confirmed within 20 slots of first send', confirm_latency_ms_p50: 900, confirm_latency_ms_p95: 2_100,
      avg_priority_fee_micro_lamports_per_cu: '25000', avg_tip_lamports: '10000' },
    errors: [{ category: 'rpc', count_5m: 2, count_1h: 9, rate_per_min: 0.4, last_message: 'timeout', last_at: T1 }],
    process: { uptime_s: 86_400, rss_bytes: 420_000_000, queue_depths: [{ name: 'recorder', depth: 12 }] },
    clock: { server_time: T1, ntp_offset_ms: -3.5 },
    safety: [{ name: 'sentinel_heartbeat', status: 'ok', detail: 'age 1 s', at: T1 }, { name: 'exit_lease', status: 'ok', detail: 'engine', at: T1 }],
  },
  'VM-14': {
    schema_version: 1, period: 'd7', from: T0, to: T1, simulated: false, network_base_lamports: '50000', priority_lamports: '200000', tips_lamports: '100000',
    venue_fees_lamports: '550000', slippage_lamports: '-10000', failed_tx_lamports: '15000', rent_deposits_lamports: '2039280', variable_lamports: '915000',
    variable_usd_e6: '137250', fixed_items: [{ item_id: ID[2], label: 'Vultr vc2-1c-2gb', monthly_usd_e6: '10000000', prorated_period_usd_e6: '2333333', source: 'invoice' }],
    fixed_usd_e6: '2333333', total_usd_e6: '2470583', traded_volume_lamports: '400000000', cost_per_trade_lamports: '91500', cost_bps_of_volume: 228,
    fixed_cost_bps_of_equity_per_month: 322, break_even_monthly_return_bps: 380,
  },
  'VM-15': {
    schema_version: 1, config_version: 'a'.repeat(64), applied_at: T0, applied_by: 'config bootstrap',
    sections: [{ section_id: 'm27', label: 'Observability', fields: [
      { key: 'm27.series_cap', label: 'Metric series cap', description: 'Series beyond this are dropped.', type: 'int', unit: 'count', min: '100', max: '5000',
        step: '1', enum_values: null, default: 5_000, current: 2_000, secret: false, is_set: true, requires_restart: true,
        risk_direction_on_increase: 'neutral', mode_scope: ['paper', 'live_small', 'live'] },
      { key: 'm14.helius_api_key', label: 'Helius API key', description: 'From the secret store.', type: 'string', unit: null, min: null, max: null, step: null,
        enum_values: null, default: null, current: null, secret: true, is_set: true, requires_restart: true, risk_direction_on_increase: 'neutral',
        mode_scope: ['live'] },
    ] }],
  },
  'VM-16': { schema_version: 1, items: [alert], next_cursor: 'c2' },
  'VM-17': { schema_version: 2, items: [audit], next_cursor: 'c2' },
  'VM-18': {
    schema_version: 2, current_mode: 'paper', target_mode: 'live_small', strategy_id: 'mr01', strategy_stage: 'paper_passed', stage_entered_at: T0,
    trial_key: 'tk-mr01-7f3a',
    gates: [{ gate_id: 'P-2b', label: 'Net after fixed costs', metric: 'dsr', unit: 'ratio', comparator: 'gte', required_value: '0.95', actual_value: '0.97',
      window: { from: T0, to: T1 }, sample_size: 120, pass: true, as_of: T1, evidence_route: '/performance?mode=paper&window=30d' }],
    all_pass: true, blocking_reasons: [{ code: 'cooldown', message: 'cooldown until tomorrow' }], cooldown_until: T1, min_dwell_until: T1,
    caps_after_promotion: { max_trade_lamports: '66666667', max_open_positions: 3, max_daily_loss_lamports: '200000000' },
    checklist: [{ item_id: 'restart_drill', text: 'Restart drill passed' }], required_phrase: 'LIVE-SMALL 0.0667',
  },
  'VM-19': { schema_version: 2, command_id: ID[1], status: 'scheduled', action_class: 'A3', reason_code: 'ok', message: 'applies in 60 s', effective_at: T1,
    executed_at: T1, new_state_version: '43', audit_event_id: ID[5] },
  'VM-20': {
    schema_version: 1, ...mode('live_small'), trading_state: 'running', equity_lamports: '2068610000', today_net_pnl_lamports: '270000', open_positions_count: 1,
    open_unrealized_net_lamports: '150000', worst_position: { position_id: ID[0], symbol: 'BONK', unrealized_pnl_net_bps: 81 }, limits_near_count: 0,
    limits_breached_count: 0, breakers_tripped_count: 1, open_alerts: { critical: 0, warning: 2 }, health_status: 'ok', landing_rate_bps: 9_000, as_of: T1,
  },
  'VM-21': { schema_version: 1, items: [run], as_of: T1 },
};

/** Hand-written variants per VM (merged onto the happy payload). */
const PATCHES: Partial<Record<VmId, Partial<Record<Exclude<Variant, 'happy' | 'empty' | 'nulls'>, Json>>>> = {
  'VM-01': { u64_max: { seq: U64_MAX, state_version: U64_MAX }, simulated: { mode: 'paper' }, live: { mode: 'live' } },
  'VM-03': { u64_max: { state_version: U64_MAX, live_caps: { max_trade_lamports: U64_MAX, max_daily_loss_lamports: U64_MAX } }, simulated: mode('paper'), live: mode('live') },
  'VM-04': {
    max_untrusted: { wallets: [merge(hotWallet, { tokens: [{ mint: K[0], symbol: MAX_SYMBOL, decimals: null, amount_base: '1',
      token_class: 'ours', value_est_lamports: null, value_as_of: null }] })] },
    u64_max: { totals: { sol_lamports: U64_MAX, equity_lamports: U64_MAX } },
    simulated: { source: 'paper_ledger', simulated: true },
  },
  'VM-05': {
    max_untrusted: { items: [merge(position, { symbol: MAX_SYMBOL, name: MAX_NAME })] },
    u64_max: { items: [merge(position, { size_base: U64_MAX, entry_size_base: U64_MAX, opened_slot: U64_MAX })] },
    negative_pnl: { items: [merge(position, { unrealized_pnl_net_lamports: '-9223372036854775808', unrealized_pnl_net_bps: -10_000, realized_partial_lamports: '-1' })] },
    simulated: { items: [merge(position, mode('paper'))] },
    live: { items: [merge(position, mode('live'))] },
  },
  'VM-06': {
    max_untrusted: { items: [merge(trade('450000', '180000', '270000'), { symbol: MAX_SYMBOL })] },
    u64_max: { items: [merge(trade('450000', '180000', '270000'), { size_base: U64_MAX })] },
    negative_pnl: { items: [merge(trade('-300000', '180000', '-480000'), { net_pnl_bps: -260, exit_reason: 'stop' })],
      totals: { gross_pnl_lamports: '-300000', net_pnl_lamports: '-480000', win_count: 0, loss_count: 1, win_rate_bps: 0 } },
    simulated: { items: [merge(trade('450000', '180000', '270000'), { ...mode('paper'), source: 'paper', shadow: true, entry_signatures: [], exit_signatures: [] })] },
    live: { items: [merge(trade('450000', '180000', '270000'), mode('live'))] },
  },
  'VM-07': { max_untrusted: { items: [merge(signal, { symbol: MAX_SYMBOL, name: MAX_NAME })] }, live: { items: [merge(signal, mode('live'))] } },
  'VM-08': { max_untrusted: { symbol: MAX_SYMBOL, name: MAX_NAME }, u64_max: { supply_base: U64_MAX }, negative_pnl: { our_history: { net_pnl_lamports: '-5000' } } },
  'VM-09': { negative_pnl: { rows: [merge(perfRow, { net_pnl_lamports: '-3000000', expectancy_net_lamports: '-75000', expectancy_net_bps: -15,
    edge_status: 'negative' })] }, live: { rows: [merge(perfRow, mode('live'))] } },
  'VM-10': { simulated: { simulated: true } },
  'VM-11': { negative_pnl: { periods: { today_utc: period('-270000') }, unrealized_net_lamports: '-150000' }, simulated: mode('paper'), live: mode('live') },
  'VM-12': { u64_max: { daily_loss: { used_lamports: U64_MAX, limit_lamports: U64_MAX } } },
  'VM-13': { u64_max: { tx: { avg_priority_fee_micro_lamports_per_cu: U64_MAX, avg_tip_lamports: U64_MAX } } },
  'VM-14': { u64_max: { traded_volume_lamports: U64_MAX }, simulated: { simulated: true } },
  'VM-19': { u64_max: { new_state_version: U64_MAX } },
  'VM-20': {
    max_untrusted: { worst_position: { symbol: MAX_SYMBOL } }, u64_max: { equity_lamports: U64_MAX },
    negative_pnl: { today_net_pnl_lamports: '-270000', open_unrealized_net_lamports: '-150000', worst_position: { unrealized_pnl_net_bps: -900 } },
    simulated: mode('paper'), live: mode('live'),
  },
};

function build(): Record<VmId, Partial<Record<Variant, unknown>>> {
  const out = {} as Record<VmId, Partial<Record<Variant, unknown>>>;
  for (const [vm, happy] of Object.entries(HAPPY) as Array<[VmId, Obj]>) {
    const schema = VM_SCHEMAS[vm] as z.ZodType;
    const set: Partial<Record<Variant, unknown>> = { happy, empty: derive(schema, happy, 'empty'), nulls: derive(schema, happy, 'nulls') };
    for (const [variant, patch] of Object.entries(PATCHES[vm] ?? {})) set[variant as Variant] = merge(happy, patch as Json);
    out[vm] = set;
  }
  return out;
}

/** Every fixture, by VM and variant. Each one parses with `VM_SCHEMAS[vm]` (contract test). */
export const FIXTURES = build();
/** Single entities pushed by `upsert` (VM-01 `data` of VM-05, VM-06, VM-07, VM-16, VM-17, VM-21). */
export const ENTITY_FIXTURES = { 'VM-05': position, 'VM-06': trade('450000', '180000', '270000'), 'VM-07': signal, 'VM-16': alert, 'VM-17': audit, 'VM-21': run };
/** VM-19 request and preview fixtures (the server answers with VM19CommandStatus, in FIXTURES). */
export const COMMAND_FIXTURES = {
  request: { command_id: ID[1], type: 'set_mode', params: { target_mode: 'live_small', open_positions_policy: 'keep_managing' }, expected_state_version: '42',
    reason_text: 'promote after the paper gates', typed_confirmation: 'LIVE-SMALL 0.0667', checklist_ack: ['restart_drill'], step_up_assertion: { id: 'cred', sig: 'x' },
    dialog_version: 'set-mode-v1', dialog_text_hash: 'd'.repeat(64), client_sent_at: T0 },
  preview: { schema_version: SCHEMA_VERSIONS['VM-19'], action_class: 'A3', requires_step_up: true, required_phrase: 'LIVE-SMALL 0.0667', summary: 'Promote MR-01 to live-small',
    consequences: [{ label: 'Max trade', value: '0.0667 SOL = 66666667 lamports', unit: 'lamports' }], delay_s: 60, state_version: '42',
    blocking_reasons: [{ code: 'book_not_flat', message: 'positions are open' }] },
};
