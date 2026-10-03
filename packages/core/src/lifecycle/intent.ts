// Order intent lifecycle:
// candidate → eligible → risk_approved → exposure_reserved → prepared → signed → submitted
//   → pending | unknown → confirmed_fill | failed | expired_unfilled → reconciled
// plus the end states rejected (refused before reservation), cancelled (stopped before broadcast)
// and abandoned (resolved without a fill and not replaced).

import type { Lamports } from '../units/index.ts';
import type { ExposureReservation, Fill, QuoteContext, Signature, TradeIntent, TransactionAttempt } from '../domain/index.ts';
import { illegal, type Effect, type Step, type Transition } from './types.ts';

export type IntentStatus =
  | 'candidate'
  | 'eligible'
  | 'risk_approved'
  | 'exposure_reserved'
  | 'prepared'
  | 'signed'
  | 'submitted'
  | 'pending'
  | 'unknown'
  | 'confirmed_fill'
  | 'failed'
  | 'expired_unfilled'
  | 'reconciled'
  | 'rejected'
  | 'cancelled'
  | 'abandoned';

export const INTENT_STATUSES: readonly IntentStatus[] = [
  'candidate', 'eligible', 'risk_approved', 'exposure_reserved', 'prepared', 'signed', 'submitted', 'pending', 'unknown',
  'confirmed_fill', 'failed', 'expired_unfilled', 'reconciled', 'rejected', 'cancelled', 'abandoned',
];

export interface IntentState {
  readonly intent: TradeIntent;
  readonly status: IntentStatus;
  /** Entries only. Exits are bounded by the position's exit owner instead. */
  readonly reservation: ExposureReservation | null;
  readonly quote: QuoteContext | null;
  /** Every signed attempt, oldest first. The last one is current. */
  readonly attempts: readonly TransactionAttempt[];
  /** False when the current attempt may never have been sent (restart while signed): wait for expiry, never send it. */
  readonly rebroadcast: boolean;
  readonly cancelRequested: boolean;
  readonly outcome: 'filled' | 'failed' | 'expired' | null;
  readonly fill: Fill | null;
  readonly rejectReason: string | null;
}

export type SignatureResult = 'processed' | 'confirmed' | 'finalized' | 'failed' | 'not_found';

export type IntentEvent =
  | { readonly type: 'mark_eligible' }
  | { readonly type: 'reject'; readonly reason: string }
  | { readonly type: 'approve_risk' }
  | { readonly type: 'reserve_exposure'; readonly reservation: ExposureReservation }
  | { readonly type: 'prepare'; readonly quote: QuoteContext }
  | { readonly type: 'sign'; readonly attempt: TransactionAttempt }
  /** Hand the current attempt to the network. Persist first, then broadcast. */
  | { readonly type: 'submit' }
  | { readonly type: 'send_accepted' }
  | { readonly type: 'send_timeout' }
  | { readonly type: 'send_error'; readonly message: string }
  /** The latest confirmed block height. Drives rebroadcast and the expiry check. */
  | { readonly type: 'tick'; readonly blockHeight: bigint }
  /** A signature status read. `blockHeight` is the confirmed height at the time of the read. */
  | { readonly type: 'status'; readonly signature: Signature; readonly result: SignatureResult; readonly blockHeight: bigint; readonly searchedHistory: boolean }
  /** Actual balance changes for this intent: a fill, or proof that nothing changed. */
  | { readonly type: 'reconcile'; readonly fill: Fill | null }
  | { readonly type: 'sign_replacement'; readonly attempt: TransactionAttempt }
  | { readonly type: 'abandon' }
  | { readonly type: 'cancel' }
  | { readonly type: 'restart' };

const UNSENT: ReadonlySet<IntentStatus> = new Set(['candidate', 'eligible', 'risk_approved', 'exposure_reserved', 'prepared', 'signed']);
const IN_FLIGHT: ReadonlySet<IntentStatus> = new Set(['submitted', 'pending', 'unknown']);
const OUTCOME_KNOWN: ReadonlySet<IntentStatus> = new Set(['confirmed_fill', 'failed', 'expired_unfilled']);

/** Reached the network (or may have) and not yet reconciled against balances. */
export const isUnresolved = (s: IntentState): boolean => IN_FLIGHT.has(s.status) || OUTCOME_KNOWN.has(s.status);

/** Nothing more can happen to this intent. */
export const isTerminal = (s: IntentState): boolean =>
  s.status === 'rejected' || s.status === 'cancelled' || s.status === 'abandoned' || (s.status === 'reconciled' && s.fill !== null);

/** Resolved without a fill: may be replaced (after expiry or failure) or abandoned. */
export const isResolvedUnfilled = (s: IntentState): boolean => s.status === 'reconciled' && s.fill === null;

/** Reserved SOL still counting against limits. */
export const heldReservation = (s: IntentState): Lamports | null => (s.reservation?.status === 'held' ? s.reservation.amount : null);

const blank = (intent: TradeIntent, status: IntentStatus): IntentState => ({
  intent, status, reservation: null, quote: null, attempts: [], rebroadcast: false,
  cancelRequested: false, outcome: null, fill: null, rejectReason: null,
});

export const newEntryIntent = (intent: TradeIntent & { purpose: 'entry' }): IntentState => blank(intent, 'candidate');

/**
 * Exits skip eligibility, risk approval and SOL reservation: a protective exit never waits on an entry gate.
 * The position's exit owner holds the quantity, which is the exit's reservation.
 */
export const newExitIntent = (intent: TradeIntent & { purpose: 'exit' }): IntentState => blank(intent, 'exposure_reserved');

export const applyIntentEvent = (s: IntentState, e: IntentEvent): Transition<IntentState> => {
  const id = s.intent.id;
  const no = (reason: string) => illegal(s.status, e.type, reason);
  const to = (patch: Partial<IntentState>, ...effects: Effect[]): Step<IntentState> => ({
    state: { ...s, ...patch },
    effects: [{ type: 'persist', entity: 'intent', id }, ...effects],
  });
  const stay = (...effects: Effect[]): Step<IntentState> => ({ state: s, effects });
  const current = s.attempts[s.attempts.length - 1];
  const signatures = s.attempts.map((a) => a.signature);
  const checkStatus = (searchHistory: boolean): Effect => ({ type: 'check_status', intentId: id, signatures, searchHistory });
  const reconcileBalances: Effect = { type: 'reconcile_balances', intentId: id };
  const release = (): { patch: Partial<IntentState>; effects: Effect[] } => {
    const r = s.reservation;
    if (r === null || r.status !== 'held') return { patch: {}, effects: [] };
    return { patch: { reservation: { ...r, status: 'released' } }, effects: [{ type: 'release_reservation', intentId: id, amount: r.amount }] };
  };
  const endWithRelease = (status: IntentStatus): Step<IntentState> => {
    const r = release();
    return to({ status, ...r.patch }, ...r.effects);
  };
  const checkAttempt = (a: TransactionAttempt): string | null => {
    if (a.intentId !== id) return 'attempt belongs to another intent';
    if (signatures.includes(a.signature)) return 'attempt reuses a known signature';
    if (s.attempts.some((x) => x.id === a.id)) return 'attempt id already used';
    return null;
  };

  switch (e.type) {
    case 'mark_eligible':
      return s.status === 'candidate' ? to({ status: 'eligible' }) : no('only a candidate can become eligible');

    case 'reject':
      return s.status === 'candidate' || s.status === 'eligible' || s.status === 'risk_approved'
        ? to({ status: 'rejected', rejectReason: e.reason })
        : no('only an intent without a reservation can be rejected');

    case 'approve_risk':
      return s.status === 'eligible' ? to({ status: 'risk_approved' }) : no('risk approval needs an eligible intent');

    case 'reserve_exposure': {
      if (s.status !== 'risk_approved') return no('exposure is reserved only after risk approval');
      if (s.intent.purpose !== 'entry') return no('exits do not reserve SOL');
      const r = e.reservation;
      if (r.intentId !== id || r.status !== 'held') return no('reservation must be held and belong to this intent');
      if (r.amount <= 0n || r.amount < s.intent.spend) return no('reservation must cover the full spend');
      return to({ status: 'exposure_reserved', reservation: r });
    }

    case 'prepare':
      return s.status === 'exposure_reserved' ? to({ status: 'prepared', quote: e.quote }) : no('prepare needs reserved exposure');

    case 'sign': {
      if (s.status !== 'prepared') return no('only a prepared intent can be signed');
      const bad = checkAttempt(e.attempt);
      return bad ? no(bad) : to({ status: 'signed', attempts: [...s.attempts, e.attempt], rebroadcast: false });
    }

    case 'submit': {
      if (s.status !== 'signed' || current === undefined) return no('only a signed intent can be submitted');
      if (s.cancelRequested) return no('cancel was requested');
      return to(
        { status: 'submitted', rebroadcast: true },
        { type: 'broadcast', intentId: id, attemptId: current.id, signedBytesRef: current.signedBytesRef, signature: current.signature },
      );
    }

    case 'send_accepted':
      // Acceptance for processing, not a fill.
      if (s.status === 'submitted') return to({ status: 'pending' }, checkStatus(false));
      return IN_FLIGHT.has(s.status) ? stay() : no('nothing was sent');

    case 'send_timeout':
    case 'send_error':
      if (s.status === 'submitted' || s.status === 'pending') return to({ status: 'unknown' }, checkStatus(false));
      return s.status === 'unknown' ? stay() : no('nothing was sent');

    case 'tick': {
      if (!IN_FLIGHT.has(s.status) || current === undefined) return stay();
      // Earlier attempts are already settled (expired or landed with an error); only the current one can land.
      if (e.blockHeight > current.lastValidBlockHeight) return stay(checkStatus(true));
      if (!s.rebroadcast) return stay();
      // Identical bytes only: the same signature can land at most once.
      return stay({ type: 'broadcast', intentId: id, attemptId: current.id, signedBytesRef: current.signedBytesRef, signature: current.signature });
    }

    case 'status': {
      if (UNSENT.has(s.status)) return no('nothing was sent');
      if (!signatures.includes(e.signature)) return no('signature does not belong to this intent');
      switch (e.result) {
        case 'processed':
          return stay();
        case 'confirmed':
        case 'finalized':
          if (IN_FLIGHT.has(s.status)) return to({ status: 'confirmed_fill', outcome: 'filled' }, reconcileBalances);
          if (s.status === 'expired_unfilled') {
            return to(
              { status: 'confirmed_fill', outcome: 'filled' },
              reconcileBalances,
              { type: 'alert', level: 'critical', code: 'late_landing', subject: id },
            );
          }
          return s.status === 'confirmed_fill' || s.status === 'reconciled' ? stay() : no('outcome already recorded');
        case 'failed':
          if (IN_FLIGHT.has(s.status)) return to({ status: 'failed', outcome: 'failed' }, reconcileBalances);
          return s.status === 'failed' || s.status === 'reconciled' ? stay() : no('outcome already recorded');
        case 'not_found':
          // Expired only when a history search finds nothing after the current attempt's last valid height.
          if (IN_FLIGHT.has(s.status) && current !== undefined && e.searchedHistory && e.blockHeight > current.lastValidBlockHeight) {
            return to({ status: 'expired_unfilled', outcome: 'expired' }, reconcileBalances);
          }
          return stay();
      }
    }

    case 'reconcile': {
      if (!OUTCOME_KNOWN.has(s.status)) return no('reconcile follows a confirmed, failed or expired outcome');
      const f = e.fill;
      if (f === null) {
        if (s.status === 'confirmed_fill') return no('signature confirmed but balances show no change; reconcile again');
        if (s.cancelRequested) return endWithRelease('cancelled');
        return to({ status: 'reconciled' });
      }
      if (f.intentId !== id) return no('fill belongs to another intent');
      if (!signatures.includes(f.signature)) return no('fill signature does not belong to this intent');
      if (f.tokens <= 0n) return no('a fill moves tokens');
      if (s.intent.purpose === 'exit' && f.tokens > s.intent.quantity) return no('sold more than the exit quantity');
      const effects: Effect[] = [];
      let reservation = s.reservation;
      if (reservation !== null && reservation.status === 'held') {
        effects.push({ type: 'keep_reservation', intentId: id, amount: reservation.amount });
        reservation = { ...reservation, status: 'kept' };
      }
      if (s.status !== 'confirmed_fill') effects.push({ type: 'alert', level: 'critical', code: 'status_balance_mismatch', subject: id });
      // Balances are the truth: a fill found after a failed or expired status still counts.
      return to({ status: 'reconciled', outcome: 'filled', fill: f, reservation }, ...effects);
    }

    case 'sign_replacement': {
      // A new signature is a new trade. Only after expiry or failure is established and balances are reconciled.
      if (!isResolvedUnfilled(s)) return no('replacement needs a reconciled intent without a fill');
      if (s.cancelRequested) return no('cancel was requested');
      const bad = checkAttempt(e.attempt);
      return bad ? no(bad) : to({ status: 'signed', attempts: [...s.attempts, e.attempt], outcome: null, rebroadcast: false });
    }

    case 'abandon':
      return isResolvedUnfilled(s) ? endWithRelease('abandoned') : no('only a reconciled intent without a fill can be abandoned');

    case 'cancel':
      if (UNSENT.has(s.status) || isResolvedUnfilled(s)) return endWithRelease('cancelled');
      if (IN_FLIGHT.has(s.status) || OUTCOME_KNOWN.has(s.status)) {
        // A broadcast transaction cannot be recalled. Record the wish; it ends as cancelled only if nothing filled.
        return to({ cancelRequested: true }, { type: 'alert', level: 'warn', code: 'cancel_after_broadcast', subject: id });
      }
      return no('intent already finished');

    case 'restart':
      if (s.status === 'signed') {
        // The bytes may or may not have left before the restart. Never send them now; wait for expiry.
        return to({ status: 'unknown', rebroadcast: false }, checkStatus(true), reconcileBalances);
      }
      if (s.status === 'submitted' || s.status === 'pending') return to({ status: 'unknown' }, checkStatus(true), reconcileBalances);
      if (s.status === 'unknown') return stay(checkStatus(true), reconcileBalances);
      if (OUTCOME_KNOWN.has(s.status)) return stay(reconcileBalances);
      return stay();
  }
};
