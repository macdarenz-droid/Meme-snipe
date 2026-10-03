// Performs CORE-1's `broadcast` and `check_status` effects through a Transport and reports the answers as lifecycle
// events. An ENG-1 EffectRunner: `run(effect, now)` returns nothing and results come back later as feed events, so
// the engine stays deterministic. The worker routes these two effect types here (`handles`).
import type { AttemptId, IntentId, Signature, TransactionAttempt } from '../../domain/index.ts';
import type { EffectRunner, Moment } from '../../engine/index.ts';
import type { Effect, IntentEvent } from '../../lifecycle/index.ts';
import { type LandingEndpoints, type RpcSignatureStatus, type SendOutcome, LandingError, planBroadcast, planStatusCheck, sendEvent, statusEvents } from '../landing.ts';
import type { Transport } from './http.ts';

export interface SignedStore {
  /** The persisted attempt and its signed bytes; CORE-1 persists both before the first broadcast. */
  attempt(intentId: IntentId, attemptId: AttemptId): { readonly attempt: TransactionAttempt; readonly bytes: Uint8Array } | null;
}

export interface LandingRunnerDeps {
  readonly transport: Transport;
  readonly endpoints: LandingEndpoints;
  readonly store: SignedStore;
  /** Where results go: the live Feed, which delivers them to the engine in order. */
  readonly emit: (intentId: IntentId, event: IntentEvent) => void;
  /** Problems that are not lifecycle events (a mismatched stored attempt, a malformed answer). */
  readonly alert: (intentId: IntentId, message: string) => void;
}

export const LANDING_EFFECTS: ReadonlySet<Effect['type']> = new Set(['broadcast', 'check_status']);

export const landingRunner = (deps: LandingRunnerDeps): EffectRunner & { handles(effect: Effect): boolean } => ({
  handles: (effect: Effect): boolean => LANDING_EFFECTS.has(effect.type),

  run(effect: Effect, _now: Moment): void {
    // A transport that throws is reported, never left as an unhandled rejection; the lifecycle retries on its tick.
    const report = (e: unknown) => deps.alert('intentId' in effect ? effect.intentId : ('' as IntentId), `landing ${effect.type} failed: ${(e as Error).message}`);
    if (effect.type === 'broadcast') broadcast(deps, effect).catch(report);
    else if (effect.type === 'check_status') checkStatus(deps, effect).catch(report);
  },
});

async function broadcast(deps: LandingRunnerDeps, effect: Extract<Effect, { type: 'broadcast' }>): Promise<void> {
  const stored = deps.store.attempt(effect.intentId, effect.attemptId);
  if (!stored) return deps.alert(effect.intentId, `attempt ${effect.attemptId} is not persisted; nothing sent`);
  let calls;
  try {
    calls = planBroadcast(effect, stored.attempt, stored.bytes, deps.endpoints);
  } catch (e) {
    return deps.alert(effect.intentId, (e as Error).message);
  }
  const outcomes: SendOutcome[] = await Promise.all(
    calls.map(async (c): Promise<SendOutcome> => {
      const r = await deps.transport.call(c);
      if (r.kind === 'ok') return typeof r.result === 'string' ? { path: c.path, kind: 'accepted', signature: r.result } : { path: c.path, kind: 'error', message: 'non-string send result' };
      if (r.kind === 'timeout') return { path: c.path, kind: 'timeout' };
      return { path: c.path, kind: 'error', message: r.kind === 'http-error' ? `HTTP ${r.status}` : r.message };
    }),
  );
  deps.emit(effect.intentId, sendEvent(outcomes, effect.signature));
}

async function checkStatus(deps: LandingRunnerDeps, effect: Extract<Effect, { type: 'check_status' }>): Promise<void> {
  const [statusCall, heightCall] = planStatusCheck(effect, deps.endpoints);
  const [statuses, height] = await Promise.all([deps.transport.call(statusCall!), deps.transport.call(heightCall!)]);
  // A failed read changes nothing: the lifecycle asks again on its next tick.
  if (statuses.kind !== 'ok' || height.kind !== 'ok') return;
  try {
    const value = (statuses.result as { value?: unknown } | null)?.value;
    if (!Array.isArray(value)) throw new LandingError('getSignatureStatuses answered without a value list');
    if (typeof height.result !== 'number' || !Number.isSafeInteger(height.result)) throw new LandingError('getBlockHeight answered without an integer');
    const events = statusEvents(effect.signatures as readonly Signature[], value as RpcSignatureStatus[], BigInt(height.result), effect.searchHistory);
    for (const e of events) deps.emit(effect.intentId, e);
  } catch (e) {
    deps.alert(effect.intentId, (e as Error).message);
  }
}
