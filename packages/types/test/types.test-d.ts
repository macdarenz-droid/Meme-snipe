// Compile-time assertions (B-M19-01 "type tests", tsd style). `npm run typecheck` fails if an assertion is false
// or if an `@ts-expect-error` line stops being an error. No extra tool: TypeScript's own checker (VERIFY.md).
import type {
  Actor, AttemptHandle, AttemptRequest, AttemptResult, AttemptState, AttemptStatus, BaseUnits, BlockHeight, Bps, Clock,
  CommandRequest, Config, Cu, DecodedEvent, ExecutionPort, ExitLadder, ExitReason, FailureClass, FillRecord,
  GateEvaluation, HealthSnapshot, Lamports, LandingPath, MicroLamportsPerCu, OrderIntent, OrderState, PositionState,
  Result, RungParams, SignedLamports, Slot, StrategyContext, SystemState, UnixMs, UnsignedTx, VenueId, WalletBalances,
} from '@bot/types';
import { EXIT_REASONS } from '@bot/types';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<T extends true>(): T | undefined { return undefined; }

// ---- ExitReason: the runtime list and the union hold the same members ----
assertType<Equal<(typeof EXIT_REASONS)[number], ExitReason>>();

// ---- CL-04: LandingPath has exactly four members, including 'jupiter_execute' ----
assertType<Equal<LandingPath, 'sender' | 'jito_tx' | 'rpc' | 'jupiter_execute'>>();

// ---- CL-27: AttemptState is the full ARCH 7.3 attempt list ----
assertType<Equal<AttemptStatus, 'sending' | 'sent' | 'landed_processed' | 'confirmed_success' | 'confirmed_failed' | 'expired' | 'unknown'>>();
assertType<Equal<AttemptState, 'building' | 'build_failed' | 'signing' | 'sign_refused' | 'sending' | 'sent' | 'landed_processed'
  | 'confirmed_success' | 'confirmed_failed' | 'expired' | 'unknown'>>();
assertType<Equal<ReturnType<ExecutionPort['status']>, AttemptState>>();
assertType<Equal<ReturnType<ExecutionPort['submit']>, Promise<AttemptHandle>>>();
assertType<Equal<Parameters<Parameters<ExecutionPort['onResult']>[0]>[0], AttemptResult>>();
assertType<Equal<Parameters<Parameters<ExecutionPort['onNotLanded']>[0]>[0], { attemptId: string; slotsSinceFirstSend: number }>>();

// ---- AttemptRequest carries no amounts (integration note on ExecutionPort) ----
assertType<Equal<keyof AttemptRequest, 'intentId' | 'attemptNo' | 'rung' | 'unsigned'>>();

// ---- CL-28: the ladder types ----
assertType<Equal<RungParams['rung'], 1 | 2 | 3 | 4 | 5>>();
assertType<Equal<ReturnType<ExitLadder['next']>, 1 | 2 | 3 | 4 | 5 | null>>();
// @ts-expect-error rung 6 does not exist
const badRung: RungParams['rung'] = 6;

// ---- 7.3 / 7.3a unions ----
assertType<Equal<FailureClass, 'slippage' | 'compute_exceeded' | 'insufficient_funds_fee' | 'account_state' | 'balance_mismatch'
  | 'venue_disabled' | 'token_program_refusal' | 'blockhash_expired' | 'unknown'>>();
assertType<Equal<OrderIntent['reason'], 'entry' | ExitReason>>();
assertType<Equal<OrderIntent['state'], OrderState>>();
assertType<Equal<OrderIntent['venue'], VenueId>>();

// ---- unit guards at compile time ----
const plainLamports: Lamports = 5n;          // plain values are accepted (ARCH-shaped code compiles)
const plainBps: Bps = -400;
const aSlot: Slot = 10n;
const aCu: Cu = 200_000;
const aHeight: BlockHeight = 1n;
const aPrice: MicroLamportsPerCu = 1n;
const aBase: BaseUnits = 1n;
const aSigned: SignedLamports = -1n;
const aTime: UnixMs = 0;
// @ts-expect-error a Slot is not Lamports
const slotAsLamports: Lamports = aSlot;
// @ts-expect-error Cu is not Bps
const cuAsBps: Bps = aCu;
// @ts-expect-error a block height is not a slot
const heightAsSlot: Slot = aHeight;
// @ts-expect-error signed lamports are not lamports
const signedAsLamports: Lamports = aSigned;
// @ts-expect-error base units are not lamports
const baseAsLamports: Lamports = aBase;
// @ts-expect-error a CU price is not lamports
const priceAsLamports: Lamports = aPrice;
// @ts-expect-error lamports are bigint, never number
const numberLamports: Lamports = 5;
// @ts-expect-error a time is not basis points
const timeAsBps: Bps = aTime;
const widened: bigint = plainLamports;       // every unit is still its base type
const arithmetic: Lamports = plainLamports + 1n;

// ---- Result and Clock shapes (ARCH 5.0) ----
const failed: Result<number, { code: 'E_X' }> = { ok: false, error: { code: 'E_X' } };
// @ts-expect-error an ok result has no error
const mixed: Result<number, { code: 'E_X' }> = { ok: true, error: { code: 'E_X' } };
const clock: Clock = { nowMs: () => 0, kind: 'sim' };

// ---- every ARCH 5.0a type used in a value compiles ----
const actor: Actor = { type: 'scheduler', id: 'x', display: 'x' };
const config: Config = { version: 'v1', key: 1 };
const decoded: DecodedEvent = { kind: 'pump_complete', mint: 'm', slot: 1n, signature: 's' };
type Uses = [CommandRequest, SystemState, WalletBalances, HealthSnapshot, GateEvaluation, StrategyContext, PositionState,
  FillRecord, UnsignedTx];
const uses: Uses | undefined = undefined;

export {
  actor, aHeight, arithmetic, aTime, badRung, baseAsLamports, clock, config, cuAsBps, decoded, failed, heightAsSlot,
  mixed, numberLamports, plainBps, priceAsLamports, signedAsLamports, slotAsLamports, timeAsBps, uses, widened,
};
