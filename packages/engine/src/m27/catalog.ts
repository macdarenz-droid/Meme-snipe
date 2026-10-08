// Metric catalog (B-M27-01 logic 1): every metric named in SPEC-B and ARCH 13.1, with its kind and label names.
// A module registers its handles by name; a name or label set that is not here is a programmer error (the types
// below reject it at compile time, the registry at run time). Group A tickets add the metrics of their SPEC-A
// observability sections here when they are built, in review.
//
// Kinds: `*_total` are counters; latencies, durations and per-event sizes are histograms (rolled up with p50, p95 and
// p99 per minute); everything else is a gauge. Signer and sentinel "status counters" and status fields (SPEC-B
// B-M17-05, B-M17-07, B-M29-03) live in those processes' status replies, not in this registry.

/** Histogram bucket upper bounds, ascending. A value above the last bound falls in the overflow (+Inf) bucket. */
export const BUCKETS = {
  latencyMs: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 300_000],
  slots: [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128, 256],
  bps: [-1_000, -500, -200, -100, -50, -20, -10, 0, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000],
  cu: [10_000, 25_000, 50_000, 100_000, 200_000, 300_000, 400_000, 600_000, 800_000, 1_000_000, 1_400_000],
  microLamportsPerCu: [0, 1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000],
  lamports: [0, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000],
  count: [0, 1, 2, 3, 4, 5, 8, 10, 20, 50],
  bytes: [200, 400, 600, 800, 1_000, 1_100, 1_232, 1_500, 2_000, 4_096],
} as const;

type Buckets = (typeof BUCKETS)[keyof typeof BUCKETS];

interface Counter<L extends readonly string[]> { kind: 'counter'; labels: L }
interface Gauge<L extends readonly string[]> { kind: 'gauge'; labels: L }
interface Histogram<L extends readonly string[]> { kind: 'histogram'; labels: L; buckets: Buckets }

const counter = <const L extends readonly string[] = []>(...labels: L): Counter<L> => ({ kind: 'counter', labels });
const gauge = <const L extends readonly string[] = []>(...labels: L): Gauge<L> => ({ kind: 'gauge', labels });
const histogram = <const L extends readonly string[] = []>(buckets: Buckets, ...labels: L): Histogram<L> => ({ kind: 'histogram', labels, buckets });

export const METRICS = {
  // ---- ARCH 13.1: data ----
  observation_lag_slots: histogram(BUCKETS.slots, 'pool', 'provider'),
  pool_snapshot_age_ms: gauge('pool'),
  poll_batch_latency_ms: histogram(BUCKETS.latencyMs, 'provider'),
  provider_slot_lag: gauge('provider'),
  stream_lag_ms: gauge('source'),
  stream_reconnects_total: counter('source'),
  bar_missing_ratio: gauge('pool'),
  recorder_queue_depth: gauge(),
  recorder_gap_seconds_total: counter(),
  // ---- ARCH 13.1: screening ----
  screen_duration_ms: histogram(BUCKETS.latencyMs, 'purpose'),
  screen_verdict_total: counter('verdict', 'check_id'),
  blacklist_size: gauge(),
  // ---- ARCH 13.1: decision ----
  signals_total: counter('strategy'),
  decisions_total: counter('decision', 'reason'),
  decision_latency_ms: histogram(BUCKETS.latencyMs),
  // ---- ARCH 13.1: execution ----
  attempts_total: counter('side', 'path', 'status'),
  failure_class_total: counter('class'),
  landing_rate_bps: gauge('window'),
  slots_to_confirm: histogram(BUCKETS.slots, 'path'),
  confirm_latency_ms: histogram(BUCKETS.latencyMs),
  send_bucket_wait_ms: histogram(BUCKETS.latencyMs, 'path'),
  send_429_total: counter('path'),
  exit_supersede_total: counter(),
  cu_used: histogram(BUCKETS.cu, 'route'),
  cu_price_micro_lamports: histogram(BUCKETS.microLamportsPerCu, 'side'),
  tip_lamports: histogram(BUCKETS.lamports, 'path'),
  quote_drift_bps: histogram(BUCKETS.bps),
  exit_rung_total: counter('rung'),
  signer_refusals_total: counter('code'),
  signer_latency_ms: histogram(BUCKETS.latencyMs),
  expiry_proofs_total: counter('method'),
  // ---- ARCH 13.1: money ----
  equity_lamports: gauge('mode'),
  exposure_lamports: gauge(),
  stressed_risk_lamports: gauge(),
  daily_loss_used_lamports: gauge(),
  fee_spend_today_lamports: gauge(),
  exit_fee_float_lamports: gauge(),
  reconcile_diff_lamports: gauge(),
  hot_balance_lamports: gauge(),
  sim_payer_balance_lamports: gauge(),
  cash_flow_lamports_total: counter('kind'),
  // ---- ARCH 13.1: safety ----
  signer_lock_state: gauge(),
  signer_latch_state: gauge(),
  exit_lease_holder: gauge(),
  sentinel_heartbeat_age_ms: gauge(),
  notifier_last_success_age_s: gauge(),
  rpc_projected_month_end_bps: gauge('provider'),
  // ---- ARCH 13.1: costs ----
  cost_lamports_total: counter('kind'),
  cost_model_error_bps: histogram(BUCKETS.bps, 'kind'),
  // ---- ARCH 13.1: system ----
  event_loop_lag_ms: histogram(BUCKETS.latencyMs),
  rss_bytes: gauge(),
  db_write_latency_ms: histogram(BUCKETS.latencyMs),
  disk_free_bytes: gauge(),
  ntp_offset_ms: gauge(),
  rpc_requests_total: counter('provider', 'method', 'status'),
  rpc_credits_used: gauge('provider'),
  // ---- SPEC-B observability sections (names not already above) ----
  highest_seen_slot: gauge(),                                   // B-M15-01
  slot_duration_ms_estimate: gauge(),
  height_reading_age_ms: gauge(),
  blockhash_age_ms: gauge(),                                    // B-M15-02
  blockhash_refresh_failures_total: counter(),
  rent_lamports_per_byte: gauge(),                              // B-M15-03
  priority_fee_estimate_micro_lamports: gauge('level', 'source'),
  priority_fee_fallback_total: counter('reason'),
  cu_limit_requested: histogram(BUCKETS.cu, 'route'),           // B-M16-01
  tx_size_bytes: histogram(BUCKETS.bytes, 'route'),
  wsol_preexisting_total: counter(),                            // B-M16-02
  adapter_build_total: counter('venue', 'ix', 'result'),        // B-M16-03, -08, -09
  build_latency_ms: histogram(BUCKETS.latencyMs, 'route', 'side'), // B-M16-04
  build_result_total: counter('code'),
  sim_build_total: counter('shape'),                            // B-M16-05
  jupiter_build_total: counter('result'),                       // B-M16-06
  rung4_orders_total: counter('result'),                        // B-M16-07
  rung4_fee_bps: gauge(),
  janitor_closes_total: counter('result'),                      // B-M16-10, B-M22-04
  rent_refund_lamports_total: counter(),
  sweeps_total: counter(),
  send_latency_ms: histogram(BUCKETS.latencyMs, 'path'),        // B-M18-02
  send_result_total: counter('path', 'result'),
  intents_total: counter('side', 'terminal_state'),             // B-M19-02
  intent_state_duration_ms: histogram(BUCKETS.latencyMs, 'state'),
  build_sign_segment_ms: histogram(BUCKETS.latencyMs, 'route'), // B-M19-03 (D05 trigger, CL-14)
  entry_evidence_latency_ms: histogram(BUCKETS.latencyMs, 'evidence'), // B-M19-04
  reconciling_intents: gauge(),
  exit_attempts_per_position: histogram(BUCKETS.count),         // B-M19-05
  positions_open: gauge(),                                      // B-M20-01
  position_state_total: counter('state'),
  mark_age_ms: gauge(),                                         // B-M20-02
  trigger_fired_total: counter('kind'),
  snapshot_to_trigger_ms: histogram(BUCKETS.latencyMs),
  universal_exit_total: counter('reason'),                      // B-M20-03
  cannot_sell_total: counter('cause'),                          // B-M20-04
  sentinel_fills_imported_total: counter(),                     // B-M20-05
  lease_holder: gauge(),
  limit_usage_bps: gauge('limit'),                              // B-M21-01
  breaker_tripped: gauge('breaker'),
  regime_blocked: gauge('source'),                              // B-M21-03
  entryrate_blocked_total: counter(),
  drawdown_bps: gauge(),                                        // B-M21-04
  fixed_cost_burden_bps: gauge(),                               // B-M21-05
  entry_pipeline_ms: histogram(BUCKETS.latencyMs, 'segment'),   // B-M21-06
  proposals_total: counter('decision'),
  reserved_lamports: gauge(),                                   // B-M22-01
  ata_balance_latency_ms: histogram(BUCKETS.latencyMs),         // B-M22-02
  unsolicited_mints: gauge(),                                   // B-M22-03
  rebuild_signatures_total: counter(),                          // B-M22-06
  rebuild_unresolved: gauge(),
  trades_closed_total: counter('mode', 'exit_reason'),          // B-M23-02
  price_age_ms: gauge(),                                        // B-M23-03
  price_source: gauge('source'),
  cost_model_ratio_x100: gauge(),
  export_rows_total: counter(),                                 // B-M23-04
  sandwich_checks_total: counter('result'),                     // B-M23-05
  sandwich_rate_bps: gauge(),
  outbox_backlog: gauge(),                                      // B-M24-01
  audit_events_total: counter('actor_type'),                    // B-M24-03
  backup_age_s: gauge(),                                        // B-M24-04
  config_version_info: gauge('version'),                        // B-M25-01
  trading_state: gauge(),                                       // B-M26-01
  halt_ack_ms: histogram(BUCKETS.latencyMs, 'component'),
  commands_total: counter('type', 'class', 'result'),           // B-M26-02
  a3_scheduled_total: counter('result'),                        // B-M26-03
  mode: gauge(),                                                // B-M26-04
  promotions_total: counter('result'),
  demotions_total: counter('cause'),
  recovery_duration_ms: histogram(BUCKETS.latencyMs),           // B-M26-05
  rearm_ms: histogram(BUCKETS.latencyMs),
  metrics_series: gauge(),                                      // B-M27-01 self-metrics
  log_dropped_total: counter('level'),                          // B-M27-01 logic 5: debug and info shed when the sink is full
  log_lost_total: counter('level'),                             // B-M27-01: lines with no file, or warn+ at the queue's memory bound
  metrics_series_dropped_total: counter(),                      // B-M27-01 logic 1: series over the cap
  metrics_ring_evicted_total: counter(),                        // B-M27-01: 1 s history dropped for the memory budget
  metrics_rollup_failed_total: counter(),                       // B-M27-01: a minute's rollups the database refused
  alerts_open: gauge('severity'),                               // B-M27-02
  alerts_forwarded_total: counter(),
  logins_total: counter('result'),                              // B-M28-02
  http_requests_total: counter('route', 'status'),              // B-M28-02, B-M28-05
  http_latency_ms: histogram(BUCKETS.latencyMs, 'route'),       // B-M28-05
  projection_errors_total: counter('vm'),                       // B-M28-03
  projection_ms: histogram(BUCKETS.latencyMs, 'vm'),
  sse_clients: gauge(),                                         // B-M28-04
  sse_emit_lag_ms: histogram(BUCKETS.latencyMs),
  sse_replays_total: counter(),
  sse_resets_total: counter(),
  // ---- SPEC-A observability sections (group A tickets, added in review) ----
  rpc_latency_ms: histogram(BUCKETS.latencyMs, 'provider', 'method'), // A-M14-01
  rpc_queue_depth: gauge('provider', 'priority'),               // A-M14-02
  rpc_wait_ms: histogram(BUCKETS.latencyMs, 'priority'),
  rpc_failover_total: counter('from', 'to'),
  rpc_429_total: counter('provider'),
  rpc_byte_budget_refused_total: counter('provider', 'method'), // A-M14-02 owner byte rule (C03 red team R6-1)
  decode_accounts_total: counter('kind', 'result'),             // A-M02-02
  decode_events_total: counter('kind'),                         // A-M02-03
  decode_gap_total: counter('reason'),
  decode_layout_extended_total: counter('kind'),                // A-M02-03, Z03 ruling 2
} as const;

export type MetricName = keyof typeof METRICS;
export type MetricDef = (typeof METRICS)[MetricName];
type KindOf<K extends string> = { [N in MetricName]: (typeof METRICS)[N]['kind'] extends K ? N : never }[MetricName];
export type CounterName = KindOf<'counter'>;
export type GaugeName = KindOf<'gauge'>;
export type HistogramName = KindOf<'histogram'>;
/** The label object a metric takes: exactly its catalog label names, each a string. */
export type LabelsOf<N extends MetricName> = { readonly [L in (typeof METRICS)[N]['labels'][number]]: string };
