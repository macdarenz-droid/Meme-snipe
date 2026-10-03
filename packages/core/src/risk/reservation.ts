// R6 full-loss reservation, as an atomic request. LEDGER-1 implements `ReservationStore` in one BEGIN IMMEDIATE: the
// version check, the limit check and the insert together. The limits in a request come from an account snapshot (open
// positions, equity, held reservations), which the store cannot recompute; so the request carries the snapshot's account
// version and the store refuses it if anything in the account changed since (another reservation, a release, a fill, a
// position or a closed trade). Two entries decided from one snapshot can therefore never both be stored.
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
  /** `AccountHistory.version` of the snapshot the decision was made on. */
  readonly accountVersion: bigint;
}

export type ReserveResult =
  | { readonly ok: true; readonly heldAfter: Lamports }
  | { readonly ok: false; readonly reason: 'stale_snapshot' | 'over_limit' | 'too_many' | 'already_reserved' | 'not_an_entry' | 'unknown_intent' };

/**
 * Atomic storage of reservations. In one indivisible step `reserveExposure` must refuse with `stale_snapshot` unless the
 * account's current version equals `accountVersion`, check `held + amount <= maxHeld` and `count + 1 <= maxCount`,
 * insert, and advance the version. Every other account change (release, fill, position, closed trade, flow) also
 * advances it. On refusal nothing is stored.
 */
export interface ReservationStore {
  reserveExposure(r: ReservationRequest & { readonly ts: number }): ReserveResult;
}

/** Sends an allowed decision's reservation to the store. Preparing or signing the entry waits for `ok`. */
export const reserve = (store: ReservationStore, request: ReservationRequest, ts: number): ReserveResult => {
  if (request.amount <= 0n) return { ok: false, reason: 'not_an_entry' };
  return store.reserveExposure({ ...request, ts });
};
