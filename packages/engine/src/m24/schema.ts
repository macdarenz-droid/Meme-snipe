// Table descriptors (B-M24-02): every table of ARCH 15 with the CL-44/CL-50 columns and tables, the group A tables of
// C-14 and C-32, and the candidate and watchlist state that must survive a restart (owner lesson, card C02).
//
// The descriptors are the typed view the repositories, the ERD and the schema tests use. The database itself is built
// only by the numbered migrations in migrations.ts, whose SQL text is frozen; a test checks that migrating an empty
// database yields exactly the tables, columns, keys, indexes and triggers these descriptors describe.
//
// Column kinds and their CHECK constraints (ddl.ts): money is INTEGER lamports (`lamports` >= 0, `slamports` signed);
// token base units are TEXT decimal strings (`u64` within u64, `i128` signed); prices and ratios are `decimal` TEXT
// without exponent; IDs are ULIDs; times are UTC epoch milliseconds (`ms`, at least 10^12, 2001-09-09, so a time
// given in seconds is refused instead of reading as 1970 and expiring at once; below 10^14, year 5138, so a time given
// in microseconds is refused instead of never expiring); every table has `created_at`.
// Retention (ARCH 15): an append-only table rejects every UPDATE and any DELETE of a row younger than its horizon,
// measured on `created_at` by both the time the retention job writes into `retention_clock` for its own transaction
// (retention.ts) and SQLite's wall clock (CL-51; Z02 rulings 10 and 14). Outside that transaction the job's time reads 0,
// so every DELETE is refused; `forever` rejects every DELETE.
export type Kind =
  | 'ulid' | 'text' | 'pubkey' | 'signature' | 'sha256' | 'json' | 'bool' | 'int' | 'ms' | 'real'
  | 'lamports' | 'slamports' | 'i64' | 'u64' | 'i128' | 'decimal' | 'enum' | 'blob';

export interface ColumnDef {
  readonly kind: Kind;
  readonly nullable?: boolean;
  readonly values?: readonly string[];
  /** Upper bound in UTF-8 bytes for text (untrusted strings: symbol 32, name 64). */
  readonly maxBytes?: number;
  /** SQL default (literal SQL). */
  readonly default?: string;
}

/** Days a row is kept; `forever` rows are never deleted. `byColumn` selects per-row horizons by an enum column's value. */
export type Retention = { readonly days: number } | 'forever'
  | { readonly byColumn: string; readonly days: Readonly<Record<string, number>> };

export interface TableDef {
  readonly columns: Readonly<Record<string, ColumnDef>>;
  /** Primary key columns (camelCase names). */
  readonly key: readonly string[];
  readonly appendOnly: boolean;
  readonly retention: Retention;
  /** Unique constraints (each a column list) and plain indexes; partial indexes have a WHERE clause (SQL). */
  readonly unique?: ReadonlyArray<readonly string[]>;
  readonly indexes?: ReadonlyArray<{ readonly name: string; readonly columns: readonly string[]; readonly unique?: boolean; readonly where?: string }>;
  /** Columns a row may still change once, while `whileNull` is null (`signal`: "decision fields updated once"). */
  readonly updateOnce?: { readonly whileNull: string; readonly columns: readonly string[] };
  /** A single INTEGER key that SQLite assigns and never reuses (`outbox.seq`). */
  readonly autoincrement?: boolean;
  /** Table-level CHECK expressions (SQL over snake_case columns). */
  readonly checks?: readonly string[];
  /** Stored in its primary key's B-tree, with no separate rowid and key index (`metric_rollup_1m`: 3 times smaller). */
  readonly withoutRowid?: boolean;
}

const c = {
  ulid: { kind: 'ulid' }, text: { kind: 'text' }, pubkey: { kind: 'pubkey' }, signature: { kind: 'signature' }, sha256: { kind: 'sha256' },
  json: { kind: 'json' }, bool: { kind: 'bool' }, int: { kind: 'int' }, ms: { kind: 'ms' }, real: { kind: 'real' },
  lamports: { kind: 'lamports' }, slamports: { kind: 'slamports' }, i64: { kind: 'i64' }, u64: { kind: 'u64' }, i128: { kind: 'i128' },
  decimal: { kind: 'decimal' }, blob: { kind: 'blob' },
} as const;
const opt = <C extends ColumnDef>(col: C): C & { readonly nullable: true } => ({ ...col, nullable: true });
const oneOf = <const V extends readonly string[]>(...values: V) => ({ kind: 'enum', values }) as const;
const bytes = (maxBytes: number) => ({ kind: 'text', maxBytes }) as const;

const MODES = ['backtest', 'replay', 'paper', 'live_small', 'live'] as const;
const ORDER_STATES = ['created', 'risk_checking', 'rejected', 'reserved', 'building', 'signing', 'in_flight', 'filled', 'failed',
  'expired_final', 'cancelled', 'reconciling', 'abandoned'] as const;
const POSITION_STATES = ['opening', 'open', 'partially_closed', 'closing', 'close_failed', 'stuck', 'closed', 'open_failed', 'orphan', 'written_off'] as const;
const CANDIDATE_STATES = ['discovered', 'prefiltered_out', 'screening', 'rejected', 'eligible', 'watched', 'signalled', 'in_position', 'cooldown',
  'blacklisted', 'stale', 'evicted'] as const;
const TRADING_STATES = ['starting', 'running', 'halt_requested', 'halted', 'halt_partial', 'resume_requested', 'exits_only', 'stopped'] as const;
const STAGES = ['research', 'coarse_screened', 'backtest_passed', 'replay_passed', 'paper_passed', 'live_small', 'live', 'failed', 'archived'] as const;
const FAILURE_CLASSES = ['slippage', 'compute_exceeded', 'insufficient_funds_fee', 'account_state', 'balance_mismatch', 'venue_disabled',
  'token_program_refusal', 'blockhash_expired', 'unknown'] as const;
const ATTEMPT_STATES = ['building', 'build_failed', 'signing', 'sign_refused', 'sending', 'sent', 'landed_processed', 'confirmed_success',
  'confirmed_failed', 'expired', 'unknown'] as const;
const EXIT_REASONS = ['stop', 'target', 'trailing_stop', 'time_stop', 'manual_close', 'flatten_all', 'risk_breach', 'halt_flatten',
  'liquidity_collapse', 'authority_change', 'venue_disabled', 'sentinel_flatten', 'orphan_close', 'written_off', 'other'] as const;
const COMMAND_TYPES = ['halt', 'resume', 'flatten_all', 'close_position', 'set_mode', 'update_limit', 'reset_breaker', 'apply_config', 'ack_alert',
  'snooze_alert', 'cancel_scheduled', 'write_off_position', 'close_unsolicited'] as const;
const ACTION_CLASSES = ['A0', 'A1', 'A2', 'A3'] as const;
const VENUES = ['pump_curve', 'pumpswap', 'raydium_amm_v4', 'raydium_cpmm'] as const;
const Y1 = { days: 366 } as const;
const Y7 = { days: 2_557 } as const;

export const TABLES = {
  // ---- ARCH 15 ----
  run: {
    columns: {
      runId: c.ulid, mode: oneOf('backtest', 'replay', 'coarse_screen', 'paper', 'live_small', 'live'), strategyId: c.text, trialKey: c.text,
      datasetHashes: c.json, gitCommit: c.text, seed: c.i64, status: c.text, startedAt: c.ms, endedAt: opt(c.ms),
      bundleSha256: opt(c.sha256), bundleSignatureOk: opt(c.bool), importedAt: opt(c.ms),
      // VM-21 (UC-12) fields of an imported run, filled by A-M13-08.
      dataFrom: opt(c.ms), dataTo: opt(c.ms), tradesCount: opt(c.int), lowCoverage: opt(c.bool), gateIdsEvaluated: opt(c.json),
      createdAt: c.ms,
    },
    key: ['runId'], appendOnly: false, retention: 'forever',
  },
  system_state: {
    columns: {
      id: c.int, mode: oneOf(...MODES), tradingState: oneOf(...TRADING_STATES), stateVersion: c.i64, modeSince: c.ms, cooldownUntil: opt(c.ms),
      createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['id'], appendOnly: false, retention: 'forever',
  },
  config_version: {
    columns: { configVersion: c.sha256, versionNo: c.int, json: c.json, appliedAt: c.ms, appliedBy: c.json, createdAt: c.ms },
    key: ['configVersion'], appendOnly: true, retention: 'forever', unique: [['versionNo']],
  },
  strategy: {
    columns: { strategyId: c.text, version: c.int, paramsHash: c.sha256, enabledModes: c.json, createdAt: c.ms, updatedAt: c.ms },
    key: ['strategyId', 'version'], appendOnly: false, retention: 'forever',
  },
  token: {
    columns: {
      mint: c.pubkey, tokenProgram: oneOf('spl_token', 'token_2022', 'unknown'), decimals: c.int, symbol: opt(bytes(32)), name: opt(bytes(64)),
      metadataUpdateAuthority: opt(c.pubkey), firstSeenAt: c.ms, symbolCollisionCount: c.int, refreshedAt: c.ms, createdAt: c.ms,
    },
    key: ['mint'], appendOnly: false, retention: 'forever',
  },
  mint_class: {
    columns: { mint: c.pubkey, class: oneOf('ours', 'unsolicited', 'written_off'), since: c.ms, setBy: c.text, createdAt: c.ms },
    key: ['mint'], appendOnly: false, retention: 'forever',
  },
  pool: {
    columns: {
      poolId: c.pubkey, venue: oneOf(...VENUES), baseMint: c.pubkey, quoteMint: c.pubkey, isCanonical: c.bool, createdSlot: opt(c.i64),
      quarantinedAt: opt(c.ms), quarantineReason: opt(c.text), createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['poolId'], appendOnly: false, retention: 'forever',
  },
  screen_result: {
    columns: {
      screenId: c.ulid, mint: c.pubkey, poolId: c.pubkey, asOfSlot: c.i64, verdict: c.text, checksJson: c.json, purpose: c.text, createdAt: c.ms,
    },
    key: ['screenId'], appendOnly: true, retention: Y1, indexes: [{ name: 'screen_result_mint_pool_slot', columns: ['mint', 'poolId', 'asOfSlot'] }],
  },
  candidate: {
    columns: {
      candidateId: c.ulid, mint: c.pubkey, poolId: c.pubkey, venue: oneOf(...VENUES), state: oneOf(...CANDIDATE_STATES), reasons: c.json,
      cooldownUntil: opt(c.ms), firstSeenAt: c.ms, lastScreenId: opt(c.ulid), version: c.int, createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['candidateId'], appendOnly: false, retention: Y1, unique: [['mint', 'poolId']],
    indexes: [{ name: 'candidate_state', columns: ['state'] }],
  },
  signal: {
    columns: {
      candidateId: c.ulid, strategyId: c.text, score: opt(c.decimal), scoreUnit: c.text,
      decision: oneOf('pending', 'accepted', 'rejected', 'expired', 'error'), decidedAt: opt(c.ms), decisionLatencyMs: opt(c.real),
      riskChecksJson: opt(c.json), intendedSizeLamports: opt(c.lamports), expectedCostBps: opt(c.int), quoteAgeMs: opt(c.real), createdAt: c.ms,
    },
    key: ['candidateId'], appendOnly: false, retention: Y1,
    updateOnce: { whileNull: 'decidedAt', columns: ['decision', 'decidedAt', 'decisionLatencyMs', 'riskChecksJson', 'intendedSizeLamports', 'expectedCostBps', 'quoteAgeMs'] },
  },
  order_intent: {
    columns: {
      intentId: c.ulid, idempotencyKey: c.text, positionId: opt(c.ulid), side: oneOf('buy', 'sell'), mint: c.pubkey, poolId: c.pubkey,
      amountIn: c.u64, minOutBps: c.int, maxSlippageBps: c.int, reason: c.text, urgency: c.text, state: oneOf(...ORDER_STATES),
      version: c.int, mode: oneOf(...MODES), purpose: { ...oneOf('trade', 'janitor', 'sweep', 'close_unsolicited'), default: "'trade'" },
      createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['intentId'], appendOnly: false, retention: Y7, unique: [['idempotencyKey']],
    indexes: [
      { name: 'order_intent_pertoken', columns: ['mint'], unique: true,
        where: "side = 'buy' AND state NOT IN ('rejected','filled','expired_final','cancelled','abandoned','failed')" },
      { name: 'order_intent_position', columns: ['positionId'] },
    ],
  },
  tx_attempt: {
    columns: {
      attemptId: c.ulid, intentId: c.ulid, attemptNo: c.int, rung: c.int, path: c.text, cuLimit: c.int, cuPrice: c.i64, tipsJson: c.json,
      sellAmountBase: opt(c.u64), balanceReadSlot: opt(c.i64), lastValidBlockHeight: opt(c.i64), status: oneOf(...ATTEMPT_STATES),
      failureClass: opt(oneOf(...FAILURE_CLASSES)), signature: opt(c.signature), slot: opt(c.i64), err: opt(c.text), feeLamports: opt(c.lamports),
      expiryProofJson: opt(c.json), firstSentAt: opt(c.ms), confirmedAt: opt(c.ms),
      signedTxB64: opt(c.text), classificationJson: opt(c.json), lvbhSource: opt(oneOf('blockhash', 'derived_upper_bound')), route: opt(c.text),
      jupiterFeeBps: opt(c.int), version: c.int, createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['attemptId'], appendOnly: false, retention: Y7, unique: [['signature']],
    indexes: [{ name: 'tx_attempt_intent', columns: ['intentId'] }],
  },
  fill: {
    columns: {
      fillId: c.ulid, attemptId: opt(c.ulid), intentId: opt(c.ulid), positionId: c.ulid, side: oneOf('buy', 'sell'), signature: opt(c.signature),
      solDeltaLamports: c.slamports, tokenDeltaBase: c.i128, venueFeeLamports: c.lamports, networkFeeLamports: c.lamports, tipLamports: c.lamports,
      simulated: c.bool, source: oneOf('live', 'paper', 'sentinel', 'recovered'), slot: opt(c.i64), blockTime: opt(c.ms), at: c.ms, createdAt: c.ms,
    },
    key: ['fillId'], appendOnly: true, retention: Y7, indexes: [{ name: 'fill_position', columns: ['positionId'] }],
  },
  position: {
    columns: {
      positionId: c.ulid, mode: oneOf(...MODES), strategyId: c.text, mint: c.pubkey, poolId: c.pubkey, state: oneOf(...POSITION_STATES),
      sizeBase: c.u64, entryCostLamports: c.lamports, entryPriceSolPerToken: opt(c.decimal), exitPlanJson: c.json, triggersJson: c.json,
      highWater: opt(c.decimal), closeFailedReason: opt(c.text), source: c.text, openedAt: opt(c.ms), closedAt: opt(c.ms), version: c.int,
      createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['positionId'], appendOnly: false, retention: Y7,
    indexes: [{ name: 'position_pertoken', columns: ['mint'], unique: true, where: "state NOT IN ('closed','open_failed','written_off')" }],
  },
  position_event: {
    columns: { eventId: c.ulid, positionId: c.ulid, fromState: opt(oneOf(...POSITION_STATES)), toState: oneOf(...POSITION_STATES), cause: c.text, at: c.ms, createdAt: c.ms },
    key: ['eventId'], appendOnly: true, retention: Y7, indexes: [{ name: 'position_event_position', columns: ['positionId'] }],
  },
  trade: {
    columns: {
      tradeId: c.ulid, positionId: c.ulid, runId: opt(c.ulid), mode: oneOf(...MODES), simulated: c.bool, strategyId: c.text, mint: c.pubkey,
      symbol: opt(bytes(32)), decimals: opt(c.int), openedAt: c.ms, closedAt: c.ms, holdMs: c.real, sizeBase: c.u64,
      entryPriceSolPerToken: c.decimal, exitPriceSolPerToken: c.decimal, grossPnlLamports: c.slamports,
      costNetworkBaseLamports: c.lamports, costPriorityLamports: c.lamports, costTipsLamports: c.lamports, costVenueFeesLamports: c.lamports,
      costFailedTxLamports: c.lamports, totalCostsLamports: c.lamports, implicitSlippageLamports: opt(c.slamports), netPnlLamports: c.slamports,
      netPnlBps: c.int, netPnlUsdE6: opt(c.i64), exitReason: oneOf(...EXIT_REASONS),
      source: oneOf('live', 'paper', 'sentinel', 'recovered', 'backtest', 'replay'), label: oneOf('normal', 'shadow'),
      entrySignatures: c.json, exitSignatures: c.json, solUsdAtCloseE6: opt(c.i64), priceSource: opt(c.text), walletPubkey: opt(c.pubkey),
      supersedesTradeId: opt(c.ulid), createdAt: c.ms,
    },
    key: ['tradeId'], appendOnly: true, retention: Y7,
    indexes: [{ name: 'trade_closed_at', columns: ['closedAt'] }, { name: 'trade_position', columns: ['positionId'] }],
    // VM-06 invariants (UI-T18, B-M23-02): net = gross - total costs; total = the sum of the explicit costs.
    checks: [
      '"net_pnl_lamports" = "gross_pnl_lamports" - "total_costs_lamports"',
      '"total_costs_lamports" = "cost_network_base_lamports" + "cost_priority_lamports" + "cost_tips_lamports" + "cost_venue_fees_lamports" + "cost_failed_tx_lamports"',
    ],
  },
  cash_flow: {
    columns: {
      flowId: c.ulid, kind: oneOf('sweep', 'refill', 'sim_funding', 'external_in', 'external_out'), lamports: c.lamports,
      fromPubkey: opt(c.pubkey), toPubkey: opt(c.pubkey), signature: opt(c.signature), slot: opt(c.i64), at: c.ms,
      source: oneOf('signer_log', 'chain_scan', 'operator'), createdAt: c.ms,
    },
    key: ['flowId'], appendOnly: true, retention: Y7,
  },
  sandwich_check: {
    columns: { fillId: c.ulid, slot: c.i64, sandwiched: c.bool, samePoolBefore: c.int, samePoolAfter: c.int, reason: opt(c.text), createdAt: c.ms },
    key: ['fillId'], appendOnly: true, retention: Y1,
  },
  cost_item: {
    columns: { costId: c.ulid, attemptId: c.ulid, kind: c.text, lamports: c.lamports, source: c.text, createdAt: c.ms },
    key: ['costId'], appendOnly: true, retention: Y7, unique: [['attemptId', 'kind']],
  },
  fixed_cost_item: {
    columns: {
      itemId: c.ulid, label: c.text, monthlyUsdE6: c.i64, source: oneOf('manual', 'invoice'), activeFrom: c.ms, activeTo: opt(c.ms),
      createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['itemId'], appendOnly: false, retention: Y7,
  },
  price_reference: {
    columns: { asset: c.text, at: c.ms, usdE6: c.i64, source: c.text, createdAt: c.ms },
    key: ['asset', 'at'], appendOnly: true, retention: Y7,
  },
  reservation: {
    columns: { reservationId: c.ulid, intentId: c.ulid, lamports: c.lamports, releasedAt: opt(c.ms), actualLamports: opt(c.lamports), createdAt: c.ms },
    key: ['reservationId'], appendOnly: false, retention: { days: 90 }, unique: [['intentId']],
  },
  token_account: {
    columns: {
      owner: c.pubkey, mint: c.pubkey, tokenProgram: c.pubkey, ata: c.pubkey, exists: c.bool, rentLamports: c.lamports, closedAt: opt(c.ms),
      janitorAttempts: c.int, createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['owner', 'mint', 'tokenProgram'], appendOnly: false, retention: 'forever',
  },
  wallet_snapshot: {
    columns: {
      wallet: c.pubkey, at: c.ms, granularity: oneOf('daily', '30s'), solLamports: c.lamports, tokensJson: c.json, slot: c.i64, createdAt: c.ms,
    },
    key: ['wallet', 'at'], appendOnly: true, retention: { byColumn: 'granularity', days: { daily: 2_557, '30s': 30 } },
  },
  reconcile_run: {
    columns: { runAt: c.ms, solDiffLamports: c.slamports, tokenDiffsJson: c.json, orphansJson: c.json, createdAt: c.ms },
    key: ['runAt'], appendOnly: true, retention: Y1,
  },
  limit_def: {
    columns: {
      limitId: c.text, shortCode: c.text, label: c.text, scope: oneOf('global', 'strategy', 'token', 'position'), scopeId: opt(c.text), kind: c.text,
      unit: oneOf('lamports', 'bps', 'count', 'ms'), displayUnit: oneOf('sol', 'bps', 'pct', 'count', 'minutes'), value: c.i64, ceiling: opt(c.i64),
      actionOnBreach: oneOf('block_entries', 'pause_entries', 'reduce_size', 'halt', 'flatten', 'demote', 'alert_only'), editable: c.bool,
      createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['limitId'], appendOnly: false, retention: 'forever', unique: [['shortCode']],
  },
  limit_state: {
    columns: {
      limitId: c.text, state: oneOf('normal', 'elevated', 'near', 'breached', 'disabled'), usage: opt(c.i64), lastBreachAt: opt(c.ms),
      createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['limitId'], appendOnly: false, retention: 'forever',
  },
  breaker_event: {
    columns: { eventId: c.ulid, breakerId: c.text, tripped: c.bool, reason: opt(c.text), at: c.ms, createdAt: c.ms },
    key: ['eventId'], appendOnly: true, retention: Y7,
  },
  command: {
    columns: {
      commandId: c.ulid, type: oneOf(...COMMAND_TYPES), paramsJson: c.json,
      status: oneOf('accepted', 'scheduled', 'executing', 'executed', 'rejected', 'failed', 'cancelled'), actionClass: oneOf(...ACTION_CLASSES),
      effectiveAt: opt(c.ms), actor: c.json, stateVersionBefore: c.i64, stateVersionAfter: opt(c.i64), reasonCode: opt(c.text), createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['commandId'], appendOnly: false, retention: Y7, indexes: [{ name: 'command_status', columns: ['status'] }],
  },
  audit_event: {
    columns: {
      eventId: c.ulid, seq: c.int, at: c.ms, mode: oneOf(...MODES), actorJson: c.json, action: c.text, actionClass: oneOf(...ACTION_CLASSES),
      target: opt(c.json), before: opt(c.json), after: opt(c.json), reasonText: opt(c.text), commandId: opt(c.ulid),
      result: oneOf('accepted', 'scheduled', 'executed', 'rejected', 'failed', 'cancelled'), dialogVersion: opt(c.text), dialogTextHash: opt(c.text),
      sessionRef: c.text, prevHash: c.sha256, hash: c.sha256, createdAt: c.ms,
    },
    key: ['eventId'], appendOnly: true, retention: Y7, unique: [['hash'], ['seq']],
  },
  alert: {
    columns: {
      alertId: c.ulid, dedupeKey: c.text, severity: oneOf('info', 'warning', 'critical'),
      category: oneOf('risk', 'execution', 'health', 'cost', 'config', 'security', 'mode', 'reconciliation'), title: c.text, body: c.text,
      state: oneOf('open', 'acknowledged', 'snoozed', 'resolved'), occurrences: c.int, entity: opt(c.json), ackedBy: opt(c.text), ackedAt: opt(c.ms),
      snoozedUntil: opt(c.ms), requiresAck: c.bool, createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['alertId'], appendOnly: false, retention: Y1,
    indexes: [{ name: 'alert_open_dedupe', columns: ['dedupeKey'], unique: true, where: "state != 'resolved'" }],
  },
  // operator, webauthn_credential, session and operator_preferences (ARCH 15, M28 login) are not here: they hold login
  // credentials, which need the owner's approval (CLAUDE.md "Stored data"). B-M28-02 adds them in its own migration
  // once the owner approves (Z02 round 2 ruling 1).
  trial_registry: {
    columns: {
      trialId: c.ulid, trialKey: c.text, kind: oneOf('gate', 'coarse_screen'), strategyId: c.text, affectsReturnsJson: c.json, datasetHashes: c.json,
      returnsPerDayJson: c.json, returnsPerTradeJson: c.json, metricsJson: c.json, runId: opt(c.ulid), createdAt: c.ms,
    },
    key: ['trialId'], appendOnly: true, retention: 'forever', unique: [['trialKey', 'kind']],
  },
  strategy_stage: {
    columns: {
      strategyId: c.text, stageEnteredAt: c.ms, stage: oneOf(...STAGES), strategyVersion: c.int, trialKey: c.text, windowsUsedJson: c.json,
      enteredBy: c.text, reason: opt(c.text), createdAt: c.ms,
    },
    key: ['strategyId', 'stageEnteredAt'], appendOnly: true, retention: 'forever',
  },
  gate_evaluation: {
    columns: {
      evalId: c.ulid, strategyId: c.text, stage: oneOf(...STAGES), targetMode: oneOf(...MODES), trialKey: c.text, gatesJson: c.json, windowsJson: c.json,
      allPass: c.bool, at: c.ms, createdAt: c.ms,
    },
    key: ['evalId'], appendOnly: true, retention: Y7,
  },
  bar_1m: {
    columns: {
      poolId: c.pubkey, minute: c.ms, open: c.decimal, high: c.decimal, low: c.decimal, close: c.decimal, closeDepthLamports: c.lamports,
      snapshots: c.int, createdAt: c.ms,
    },
    key: ['poolId', 'minute'], appendOnly: false, retention: { days: 90 },
  },
  equity_point: {
    columns: { minute: c.ms, mode: oneOf(...MODES), equityLamports: c.lamports, flowAdjustedIndex: c.decimal, drawdownBps: c.int, createdAt: c.ms },
    key: ['minute', 'mode'], appendOnly: true, retention: Y7,
  },
  quarantine: {
    columns: { id: c.ulid, programId: c.pubkey, discriminator: c.text, rawB64: c.text, signature: opt(c.signature), firstSeen: c.ms, createdAt: c.ms },
    key: ['id'], appendOnly: true, retention: Y1, unique: [['programId', 'discriminator']],
  },
  // Disk (review R2, measured by the `metric_rollup_1m` disk test in schema.test.ts: 200 pools x 3 series x 120 minutes,
  // 72,000 rows): 87 bytes a row with the 8-byte integer hash WITHOUT ROWID (259 with a hex hash in a rowid table). A
  // series written every minute is about 125 kB a day. Series labelled by pool or mint keep 7 days, aggregate series
  // 1 year (Z02 round 2 ruling 7; deviation from ARCH 15's 1 year for all, docs/DECISIONS.md), and the sink stops
  // writing pool rows at its byte cap (m27.rollup_max_bytes) with an error log.
  metric_rollup_1m: {
    columns: {
      metric: c.text, labelsHash: c.i64, minute: c.ms, scope: oneOf('aggregate', 'pool'), count: c.int, sum: c.real,
      p50: opt(c.real), p95: opt(c.real), p99: opt(c.real), createdAt: c.ms,
    },
    key: ['metric', 'labelsHash', 'minute'], appendOnly: true, retention: { byColumn: 'scope', days: { aggregate: 366, pool: 7 } }, withoutRowid: true,
  },
  outbox: {
    columns: { seq: c.i64, topic: bytes(128), payloadJson: c.json, createdAt: c.ms, publishedAt: opt(c.ms) },
    key: ['seq'], appendOnly: false, retention: { days: 7 }, autoincrement: true,
    indexes: [
      { name: 'outbox_unpublished', columns: ['seq'], where: 'published_at IS NULL' },
      { name: 'outbox_published_at', columns: ['publishedAt'], where: 'published_at IS NOT NULL' },
    ],
  },
  // ---- CL-50 ----
  cost_item_correction: {
    columns: { correctionId: c.ulid, costId: c.ulid, lamports: c.lamports, source: c.text, at: c.ms, createdAt: c.ms },
    key: ['correctionId'], appendOnly: true, retention: Y7, indexes: [{ name: 'cost_item_correction_cost', columns: ['costId'] }],
  },
  kv_state: {
    columns: { key: c.text, valueJson: c.json, createdAt: c.ms, updatedAt: c.ms },
    key: ['key'], appendOnly: false, retention: 'forever',
  },
  // The time the retention job deletes against, set and reset inside its own transaction (retention.ts; rulings 10, 14).
  retention_clock: {
    columns: { id: c.int, nowMs: c.i64 },
    key: ['id'], appendOnly: false, retention: 'forever', checks: ['"id" = 1', '"now_ms" >= 0'],
  },
  schema_migrations: {
    columns: { version: c.int, sha256: c.sha256, appliedAt: c.ms },
    key: ['version'], appendOnly: false, retention: 'forever',
  },
  audit_import_cursor: {
    columns: { source: oneOf('signer', 'sentinel'), lastSeq: c.i64, createdAt: c.ms, updatedAt: c.ms },
    key: ['source'], appendOnly: false, retention: 'forever',
  },
  // ---- C-14 (group A, M03, M05, M07, M14) ----
  enumerated_pool: {
    columns: {
      poolId: c.pubkey, baseMint: c.pubkey, isCanonical: opt(c.bool), firstEnumeratedAt: c.ms, lastRefreshAt: opt(c.ms),
      lastQuoteRealLamports: opt(c.lamports), lastQuoteVirtual: opt(c.u64), lastBaseReserveBase: opt(c.u64), lastSupplyBase: opt(c.u64),
      lastMarketCapLamports: opt(c.lamports), lastRefreshSlot: opt(c.i64), createdAt: c.ms, updatedAt: c.ms,
    },
    key: ['poolId'], appendOnly: false, retention: 'forever',
  },
  discovery_cursor: {
    columns: { source: c.text, cursor: c.text, createdAt: c.ms, updatedAt: c.ms },
    key: ['source'], appendOnly: false, retention: 'forever',
  },
  coverage_report: {
    columns: { dayUtc: c.text, json: c.json, lowCoverage: c.bool, manifestSha256: c.sha256, createdAt: c.ms },
    key: ['dayUtc'], appendOnly: true, retention: 'forever',
  },
  rpc_usage: {
    columns: { provider: c.text, month: c.text, unitsUsed: c.i64, createdAt: c.ms, updatedAt: c.ms },
    key: ['provider', 'month'], appendOnly: false, retention: 'forever',
  },
  universe_manifest: {
    columns: { dayUtc: c.text, sha256: c.sha256, path: c.text, createdAt: c.ms },
    key: ['dayUtc'], appendOnly: true, retention: 'forever',
  },
  // ---- C-32 (A-M12-02) ----
  shadow_result: {
    columns: {
      shadowId: c.ulid, attemptId: c.ulid, kind: oneOf('buy', 'round_trip'), poolId: c.pubkey, notionalLamports: c.lamports, modelOut: c.u64,
      simulatedOut: opt(c.u64), errorBps: opt(c.real), contextSlot: opt(c.i64), status: oneOf('ok', 'sim_error', 'payer_underfunded', 'skipped'),
      at: c.ms, createdAt: c.ms,
    },
    key: ['shadowId'], appendOnly: true, retention: Y7,
  },
  // ---- Candidate and watchlist state across restarts (owner lesson; A-M05-01, A-M05-02, A-M05-03) ----
  candidate_event: {
    columns: {
      eventId: c.ulid, candidateId: c.ulid, poolId: c.pubkey, mint: c.pubkey, fromState: opt(oneOf(...CANDIDATE_STATES)),
      toState: oneOf(...CANDIDATE_STATES), reason: c.text, at: c.ms, createdAt: c.ms,
    },
    key: ['eventId'], appendOnly: true, retention: Y1,
    indexes: [{ name: 'candidate_event_candidate', columns: ['candidateId'] }, { name: 'candidate_event_at', columns: ['at'] }],
  },
  blacklist: {
    columns: { mint: c.pubkey, reason: c.text, until: opt(c.ms), setBy: c.text, createdAt: c.ms, updatedAt: c.ms },
    key: ['mint'], appendOnly: false, retention: 'forever',
  },
  watch_tail: {
    columns: { poolId: c.pubkey, until: c.ms, reason: c.text, evictedAt: c.ms, createdAt: c.ms, updatedAt: c.ms },
    key: ['poolId'], appendOnly: false, retention: 'forever',
  },
} as const satisfies Readonly<Record<string, TableDef>>;

export type TableName = keyof typeof TABLES;
export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

/** camelCase to snake_case column name: `amountIn` is `amount_in`, `bundleSha256` is `bundle_sha256`, `p50` stays `p50`. */
export function snake(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}
