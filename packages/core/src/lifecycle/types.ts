import type { Lamports, RawAmount } from '../units/index.ts';
import type { AttemptId, IntentId, PositionId, Signature } from '../domain/index.ts';

/** A refused event. The caller keeps its previous state; nothing is persisted or sent. */
export interface IllegalTransition {
  readonly illegal: true;
  readonly from: string;
  readonly event: string;
  readonly reason: string;
}

export interface Step<S> {
  readonly state: S;
  readonly effects: readonly Effect[];
}

export type Transition<S> = Step<S> | IllegalTransition;

export const isIllegal = <S>(result: Transition<S>): result is IllegalTransition => 'illegal' in result;

export const illegal = (from: string, event: string, reason: string): IllegalTransition => ({ illegal: true, from, event, reason });

export type AlertCode =
  | 'cancel_after_broadcast'
  | 'status_balance_mismatch'
  | 'late_landing'
  | 'exit_blocked'
  | 'restart_recovery';

/**
 * Declarative instructions for the runner. The runner performs them in order and must finish
 * `persist` before any `broadcast` that follows it.
 */
export type Effect =
  | { readonly type: 'persist'; readonly entity: 'intent' | 'position' | 'book'; readonly id: string }
  /** Send exactly the stored signed bytes of this attempt; never re-sign. */
  | { readonly type: 'broadcast'; readonly intentId: IntentId; readonly attemptId: AttemptId; readonly signedBytesRef: string; readonly signature: Signature }
  | { readonly type: 'check_status'; readonly intentId: IntentId; readonly signatures: readonly Signature[]; readonly searchHistory: boolean }
  | { readonly type: 'reconcile_balances'; readonly intentId: IntentId }
  | { readonly type: 'release_reservation'; readonly intentId: IntentId; readonly amount: Lamports }
  | { readonly type: 'keep_reservation'; readonly intentId: IntentId; readonly amount: Lamports }
  | { readonly type: 'request_exit'; readonly positionId: PositionId; readonly intentId: IntentId; readonly quantity: RawAmount }
  | { readonly type: 'alert'; readonly level: 'warn' | 'critical'; readonly code: AlertCode; readonly subject: string };
