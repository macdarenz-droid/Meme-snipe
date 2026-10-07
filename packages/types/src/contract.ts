// ARCH 5.0a shared contract types (B-M19-01), copied verbatim from ARCH 5.0a with `export` added.
// Frozen before tickets start (ARCH 18); changes follow packages/types/CHANGELOG.md and FREEZE.json.
import type {
  BaseUnits, Clock, Commitment, Id, Lamports, Mode, Pubkey, Signature, SignedLamports, Slot, UnixMs,
} from './types.ts';
import type { Features } from './referenced.ts';

// ---- state machine state names (transitions in section 7) ----
export type OrderState = 'created' | 'risk_checking' | 'rejected' | 'reserved' | 'building' | 'signing' | 'in_flight'
                | 'filled' | 'failed' | 'expired_final' | 'cancelled' | 'reconciling' | 'abandoned';           // 7.3
export type PositionState = 'opening' | 'open' | 'partially_closed' | 'closing' | 'close_failed' | 'stuck'
                   | 'closed' | 'open_failed' | 'orphan' | 'written_off';                                      // 7.4
export type CandidateState = 'discovered' | 'prefiltered_out' | 'screening' | 'rejected' | 'eligible' | 'watched'
                    | 'signalled' | 'in_position' | 'cooldown' | 'blacklisted' | 'stale' | 'evicted';          // 7.5
export type TradingState = 'starting' | 'running' | 'halt_requested' | 'halted' | 'halt_partial' | 'resume_requested'
                  | 'exits_only' | 'stopped';                                                                  // 7.7
export type StrategyStage = 'research' | 'coarse_screened' | 'backtest_passed' | 'replay_passed' | 'paper_passed'
                   | 'live_small' | 'live' | 'failed' | 'archived';                                            // 3.4
export type FailureClass = 'slippage' | 'compute_exceeded' | 'insufficient_funds_fee' | 'account_state' | 'balance_mismatch'
                  | 'venue_disabled' | 'token_program_refusal' | 'blockhash_expired' | 'unknown';             // 7.3a

// ---- actors and commands (VM-17, VM-19) ----
export type Actor = { type: 'operator' | 'risk_engine' | 'system' | 'scheduler' | 'sentinel' | 'cli'; id: string; display: string };
export type ActionClass = 'A0' | 'A1' | 'A2' | 'A3';
export type CommandType = 'halt' | 'resume' | 'flatten_all' | 'close_position' | 'set_mode' | 'update_limit' | 'reset_breaker'
                 | 'apply_config' | 'ack_alert' | 'snooze_alert' | 'cancel_scheduled' | 'write_off_position' | 'close_unsolicited';
export interface CommandRequest { commandId: Id; type: CommandType; params: Record<string, unknown> /* big integers as decimal strings */;
  expectedStateVersion: bigint; reasonText: string | null; typedConfirmation: string | null; checklistAck: string[] | null;
  stepUpAssertion: unknown | null; dialogVersion: string; dialogTextHash: string; clientSentAtMs: UnixMs }
export interface PreviewResponse { actionClass: ActionClass; requiresStepUp: boolean; requiredPhrase: string | null; summary: string;
  consequences: Array<{ label: string; value: string; unit: string }>;   // includes typed value AND exact stored value with units (CA-32)
  delayS: 0 | 60; stateVersion: bigint; blockingReasons: Array<{ code: string; message: string }> }
export interface CommandStatus { commandId: Id; status: 'accepted' | 'scheduled' | 'executing' | 'executed' | 'rejected' | 'failed' | 'cancelled';
  actionClass: ActionClass; reasonCode: string | null; message: string | null; effectiveAtMs: UnixMs | null;
  executedAtMs: UnixMs | null; newStateVersion: bigint | null; auditEventId: Id }

// ---- system and limits (VM-03, VM-12) ----
export interface SystemState { mode: Mode; tradingState: TradingState; stateVersion: bigint; modeSinceMs: UnixMs; runId: Id;
  cooldownUntilMs: UnixMs | null; haltedBy: Actor | null; haltReasonCode: string | null; haltReasonText: string | null;
  components: Array<{ name: string; acked: boolean; ackedAtMs: UnixMs | null }>;
  signer: { lock: 'locked' | 'unlocked' | 'exits_only'; latch: 'clear' | 'set'; latchSetBy: 'engine' | 'sentinel' | 'operator_cli' | 'system' | null;
            latchClearRequires: 'dashboard' | 'host_cli' | null; exitLeaseHolder: 'engine' | 'sentinel' | null };
  scheduledCommandId: Id | null }
export interface LimitState { limitId: string; shortCode: string; label: string; scope: 'global' | 'strategy' | 'token' | 'position';
  scopeId: string | null; kind: string; unit: 'lamports' | 'bps' | 'count' | 'ms';
  displayUnit: 'sol' | 'bps' | 'pct' | 'count' | 'minutes';             // unit the operator types in (CA-32)
  value: bigint; ceiling: bigint | null; usage: bigint | null; usageBps: number | null;
  state: 'normal' | 'elevated' | 'near' | 'breached' | 'disabled';
  actionOnBreach: 'block_entries' | 'pause_entries' | 'reduce_size' | 'halt' | 'flatten' | 'demote' | 'alert_only';
  lastBreachAtMs: UnixMs | null; editable: boolean; pendingCommandId: Id | null }
export interface BreakerState { breakerId: string; label: string; tripped: boolean; trippedAtMs: UnixMs | null; reason: string | null;
  autoResetAtMs: UnixMs | null; requiresManualReset: boolean }

// ---- money (VM-04) ----
export type WalletRole = 'trading' | 'fee_payer' | 'reserve';                   // sim payer and cold wallet use 'reserve' with a label
export type TokenClass = 'ours' | 'unsolicited' | 'written_off';                 // M22, CA-14
export interface WalletBalances { source: 'chain' | 'paper_ledger' | 'sim_ledger';
  wallets: Array<{ walletId: string; label: string; pubkey: Pubkey; role: WalletRole; solLamports: Lamports; wsolLamports: Lamports;
    commitment: Commitment; asOfSlot: Slot; reservedLamports: Lamports; exitFeeFloatLamports: Lamports; availableLamports: Lamports;
    tokens: Array<{ mint: Pubkey; amountBase: BaseUnits; decimals: number | null; tokenClass: TokenClass; valueEstLamports: Lamports | null }> }>;
  equityLamports: Lamports; equityTradeLamports: Lamports; positionsValueLamports: Lamports;
  reconciledAtMs: UnixMs; reconcileDiffLamports: SignedLamports }
export interface CashFlow { flowId: Id; kind: 'sweep' | 'refill' | 'sim_funding' | 'external_in' | 'external_out'; lamports: Lamports;
  fromPubkey: Pubkey | null; toPubkey: Pubkey | null; signature: Signature | null; slot: Slot | null; atMs: UnixMs; source: 'signer_log' | 'chain_scan' | 'operator' }

// ---- health (VM-13) ----
export interface ProviderHealth { endpointId: string; label: string; role: 'read' | 'send' | 'stream'; latencyMsP50: number | null; latencyMsP95: number | null;
  latencyMsP99: number | null; errorRateBps: number; requestsPerMin: number; slot: Slot | null; slotLag: number | null;
  lastOkAtMs: UnixMs | null; status: 'ok' | 'degraded' | 'down';
  monthlyUsed: number | null; monthlyAllowance: number | null; projectedMonthEnd: number | null }   // burn-rate projection (CB-05)
export interface SourceHealth { streamId: string; label: string; lagMs: number | null; lastEventAtMs: UnixMs | null; reconnects1h: number; status: 'ok' | 'degraded' | 'down' }
export interface HealthSnapshot { overall: 'ok' | 'degraded' | 'down'; rpc: ProviderHealth[]; streams: SourceHealth[];
  tx: { windowS: number; sent: number; landed: number; failed: number; expired: number; landingRateBps: number | null;
        confirmLatencyMsP50: number | null; confirmLatencyMsP95: number | null; avgPriorityFeeMicroLamportsPerCu: bigint | null; avgTipLamports: bigint | null };
  errors: Array<{ category: string; count5m: number; count1h: number; ratePerMin: number; lastMessage: string; lastAtMs: UnixMs | null }>;
  process: { uptimeS: number; rssBytes: number; queueDepths: Array<{ name: string; depth: number }> };
  clock: { serverTimeMs: UnixMs; ntpOffsetMs: number | null };
  safety: Array<{ name: 'sentinel_heartbeat' | 'notifier_last_test' | 'watcher_last_poll' | 'signer_lock' | 'exit_lease'; status: 'ok' | 'degraded' | 'down'; detail: string; atMs: UnixMs | null }> }

// ---- research (VM-18) ----
export interface CoverageReport { dayUtc: string; streams: Array<{ stream: string; expected: number; recorded: number; gaps: Array<{ fromMs: UnixMs; toMs: UnixMs; reason: string }> }>;
  universeManifestSha256: string; lowCoverage: boolean }
export interface GateResult { gateId: string; label: string; metric: string; unit: 'lamports' | 'base_units' | 'bps' | 'ms' | 'count' | 'slot' | 'bool' | 'usd_e6' | 'sol_per_token' | 'ratio';
  comparator: 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'neq' | 'is_true' | 'is_false'; requiredValue: string | null; actualValue: string | null;
  window: { fromMs: UnixMs; toMs: UnixMs } | null; sampleSize: number | null; pass: boolean; asOfMs: UnixMs; evidenceRoute: string }
export interface GateEvaluation { evalId: Id; strategyId: string; stage: StrategyStage; stageEnteredAtMs: UnixMs; targetMode: Mode;
  trialKey: string; gates: GateResult[]; allPass: boolean; blockingReasons: Array<{ code: string; message: string }>;
  cooldownUntilMs: UnixMs | null; minDwellUntilMs: UnixMs | null; atMs: UnixMs }

// ---- config (VM-15) ----
export interface ConfigFieldSchema { key: string; type: 'int' | 'decimal' | 'bool' | 'enum' | 'duration_ms' | 'lamports' | 'bps' | 'base_units' | 'string' | 'list';
  unit: string | null; displayUnit: string | null; min: string | null; max: string | null; step: string | null; enumValues: string[] | null;
  secret: boolean; requiresRestart: boolean; riskDirectionOnIncrease: 'increases_risk' | 'decreases_risk' | 'neutral';
  affectsReturns: boolean;                                                   // part of the trial key (CA-24)
  modeScope: Mode[] }
export type Config = Readonly<Record<string, unknown>> & { readonly version: string };   // validated against ConfigFieldSchema[]
export interface ConfigVersion { configVersion: string /* sha256 of canonical JSON */; appliedAtMs: UnixMs; appliedBy: Actor; json: string }
export interface ValidateResult { errors: Array<{ key: string; code: string; message: string }>; warnings: Array<{ key: string; code: string; message: string }>;
  diff: Array<{ key: string; old: unknown; new: unknown; direction: 'increases_risk' | 'decreases_risk' | 'neutral' }>;
  derivedActionClass: ActionClass; requiresFlatBook: boolean /* any requiresRestart key changed (CA-32) */ }

// ---- infrastructure ----
export interface HttpReq { method: 'GET' | 'POST'; path: string /* no host; the gateway adds the configured base URL */; query?: Record<string, string>;
  body?: unknown; headers?: Record<string, string> /* never secrets; M14 adds keys from the secret store */ }
export interface Rng { nextU32(): number; nextFloat(): number /* [0,1) */; seed: number }     // deterministic; seeded per run
export interface RawTransaction { signature: Signature; slot: Slot; blockTimeS: number | null; version: 'legacy' | 0 | 1;
  message: { accountKeys: Pubkey[]; loadedAddresses: { writable: Pubkey[]; readonly: Pubkey[] };
             instructions: Array<{ programIdIndex: number; accounts: number[]; dataB64: string }> };
  meta: { err: unknown | null; feeLamports: Lamports; preBalances: Lamports[]; postBalances: Lamports[];
          preTokenBalances: unknown[]; postTokenBalances: unknown[];
          innerInstructions: Array<{ index: number; instructions: Array<{ programIdIndex: number; accounts: number[]; dataB64: string }> }>;
          logMessages: string[] | null; computeUnitsConsumed: number | null } }   // fetched with maxSupportedTransactionVersion: 1 [LD-05]
export interface StrategyContext { clock: Clock; rng: Rng; mode: Mode; runId: Id; config: Config;
  features: Features; position(poolId: Pubkey): { open: boolean; sizeBase: BaseUnits } | null;
  edgeEstimate: { lowerCiNetBps: number | null; varianceBps2: number | null } }   // M13, live sizing only
