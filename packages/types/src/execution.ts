// Execution contract (B-M19-01): verbatim copies of ARCH M18 `AttemptStatus`/`AttemptResult`,
// M19 `OrderIntent`/`AttemptRequest`/`AttemptHandle`/`FillRecord` and M20 `ExitReason`, plus the additions
// CL-04 (`LandingPath` gains 'jupiter_execute'), CL-27/C-29 (`AttemptState`, `ExecutionPort`) and
// CL-28 (`RungParams`, `ExitLadder`), as bound by ARCH 5.0b I-01, I-03 and I-04.
import type { FailureClass, OrderState } from './contract.ts';
import type { DecodedEvent, UnsignedTx, VenueId } from './referenced.ts';
import type { Bps, BlockHeight, Id, Lamports, Mode, Pubkey, Signature, SignedLamports, Slot, UnixMs } from './types.ts';

// ---- M18 sender and confirmation tracker ----
// CL-04: rung 4 lands through Jupiter /execute
export type LandingPath = 'sender' | 'jito_tx' | 'rpc' | 'jupiter_execute';   // 'sender' = keyed HTTPS global endpoint (D02); 'jupiter_execute' = rung-4 landing via Jupiter /execute, never rebroadcast (integration, CL-04)
export type AttemptStatus = 'sending' | 'sent' | 'landed_processed' | 'confirmed_success' | 'confirmed_failed' | 'expired' | 'unknown';
export interface AttemptResult { attemptId: Id; status: AttemptStatus; signature: Signature; slot: Slot | null; err: string | null;
  failureClass: FailureClass | null;                     // section 7.3a, from meta: failing instruction index + error code
  feeLamports: Lamports | null;                          // from transaction meta (base + priority)
  balanceDeltas: { solLamports: SignedLamports; wsolLamports: SignedLamports; token: Array<{ mint: Pubkey; deltaBase: bigint }> } | null;
  events: DecodedEvent[]; firstSentMs: UnixMs; confirmedMs: UnixMs | null; slotsToConfirm: number | null;
  expiryProof: { providers: string[]; heightSeen: BlockHeight; statusContextSlot: Slot; balanceCheckSlot: Slot | null } | null }

// ---- M20 position and exit manager ----
export type ExitReason = 'stop' | 'target' | 'trailing_stop' | 'time_stop' | 'manual_close' | 'flatten_all' | 'risk_breach' | 'halt_flatten'
                | 'liquidity_collapse' | 'authority_change' | 'venue_disabled' | 'sentinel_flatten' | 'orphan_close' | 'written_off' | 'other';
                // equals the VM-06 exit_reason enum after the change in section 19 (contract test: the two sets are equal)

/** Every `ExitReason`, in ARCH M20 order. The type tests prove the array and the union hold the same values. */
export const EXIT_REASONS = [
  'stop', 'target', 'trailing_stop', 'time_stop', 'manual_close', 'flatten_all', 'risk_breach', 'halt_flatten',
  'liquidity_collapse', 'authority_change', 'venue_disabled', 'sentinel_flatten', 'orphan_close', 'written_off', 'other',
] as const satisfies readonly ExitReason[];

// ---- M19 order manager ----
export interface OrderIntent { intentId: Id; idempotencyKey: string /* sha256(strategyId|positionId|side|decisionSeq) */;
  positionId: Id; side: 'buy' | 'sell'; mint: Pubkey; poolId: Pubkey; venue: VenueId;
  amountIn: bigint | null /* buys: lamports; sells: from the on-chain balance at build */; minOutBps: Bps; maxSlippageBps: Bps;
  reason: 'entry' | ExitReason; urgency: 'normal' | 'emergency'; createdMs: UnixMs; mode: Mode; state: OrderState; version: number }
export interface AttemptRequest { intentId: Id; attemptNo: number; rung: 1 | 2 | 3 | 4 | 5; unsigned?: UnsignedTx }
export interface AttemptHandle { attemptId: Id; signature: Signature | null }
export interface FillRecord { fillId: Id; intentId: Id; attemptId: Id; positionId: Id; side: 'buy' | 'sell'; signature: Signature | null;
  slot: Slot | null; solDeltaLamports: SignedLamports; tokenDeltaBase: bigint; venueFeeLamports: Lamports;
  networkFeeLamports: Lamports; tipLamports: Lamports; simulated: boolean; source: 'live' | 'paper' | 'sentinel' | 'recovered'; atMs: UnixMs }

// ---- B-M19-01 additions (ARCH 5.0b I-01, I-03) ----
// CL-27: the port must deliver results; paper (M12) emits the same events as live
export type AttemptState = 'building' | 'build_failed' | 'signing' | 'sign_refused' | AttemptStatus;   // full list of ARCH 7.3
export interface ExecutionPort {
  submit(a: AttemptRequest): Promise<AttemptHandle>;      // returns immediately with attemptId (ARCH M12)
  status(attemptId: Id): AttemptState;                    // ARCH: "same states as live (section 7.3)"
  onResult(h: (r: AttemptResult) => void): () => void;    // added: final and intermediate results (landed_processed, confirmed_*, expired, unknown)
  onNotLanded(h: (e: { attemptId: Id; slotsSinceFirstSend: number }) => void): () => void;   // integration (C-29): drives exit supersession in every mode
}
// Integration (C-29/CL-27 merged): this is the single ExecutionPort for live (B-M19-03), paper (A-M12-01) and sim (A-M11-02).
// Ports read an attempt's intent through OrderManager.intent(intentId) (B-M19-02, CL-29); AttemptRequest carries no amounts.
// CL-28: ladder parameters shared by M19 (executes attempts) and M20 (owns the ladder), so neither imports the other
export interface RungParams { rung: 1 | 2 | 3 | 4 | 5; route: 'direct' | 'jupiter_order'; slippageBps: Bps; cuPriceMultiplier: 1 | 2 | 3;
  paths: LandingPath[]; tips: Array<{ path: LandingPath; lamports: Lamports }>; chunkFractionBps: Bps | null /* rung 5: 2,500 */ }
export interface ExitLadder { params(rung: RungParams['rung'], feeMode: 'normal' | 'minimum'): RungParams; next(rung: RungParams['rung']): RungParams['rung'] | null }
