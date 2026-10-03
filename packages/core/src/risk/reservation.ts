// R6 full-loss reservation, as an atomic request. LEDGER-1 implements `ReservationStore` (one BEGIN IMMEDIATE: the
// limit check and the insert together), so two entries decided from the same snapshot can never jointly exceed the limit.
import type { IntentId, ReservationId } from '../domain/index.ts';
import type { Lamports } from '../units/index.ts';

export interface ReservationLimits {
  /** Most lamports held across all open reservations, this one included. */
  readonly maxHeld: Lamports;
  /** Most reservations held at once, this one included. */
  readonly maxCount: number;
}

/** The full possible loss of one entry (spend plus every cost, exit-ladder worst case included) and the limits it must fit. */
export interface ReservationRequest {
  readonly reservationId: ReservationId;
  readonly intentId: IntentId;
  readonly amount: Lamports;
  readonly limits: ReservationLimits;
}

export type ReserveResult =
  | { readonly ok: true; readonly heldAfter: Lamports }
  | { readonly ok: false; readonly reason: 'over_limit' | 'too_many' | 'already_reserved' | 'not_an_entry' | 'unknown_intent' };

/**
 * Atomic storage of reservations. `reserveExposure` must check `held + amount <= maxHeld` and `count + 1 <= maxCount`
 * and insert in one indivisible step; on refusal nothing is stored.
 */
export interface ReservationStore {
  reserveExposure(r: ReservationRequest & { readonly ts: number }): ReserveResult;
}

/** Sends an allowed decision's reservation to the store. Preparing or signing the entry waits for `ok`. */
export const reserve = (store: ReservationStore, request: ReservationRequest, ts: number): ReserveResult => {
  if (request.amount <= 0n) return { ok: false, reason: 'not_an_entry' };
  return store.reserveExposure({ ...request, ts });
};
