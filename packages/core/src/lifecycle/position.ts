// Position lifecycle:
// opening → open → exit_requested → exit_pending → open (reduced quantity) | closed | exit_blocked
// One exit owner at a time holds the quantity being sold, so simultaneous triggers cannot oversell.

import type { Lamports, RawAmount } from '../units/index.ts';
import type { IntentId, Mint, PositionId, Venue } from '../domain/index.ts';
import { illegal, type Effect, type Step, type Transition } from './types.ts';

export type PositionStatus = 'opening' | 'open' | 'exit_requested' | 'exit_pending' | 'exit_blocked' | 'closed';

export const POSITION_STATUSES: readonly PositionStatus[] = ['opening', 'open', 'exit_requested', 'exit_pending', 'exit_blocked', 'closed'];

export type ExitReason = 'stop' | 'trailing_stop' | 'take_profit' | 'max_hold' | 'thesis_lost' | 'liquidity' | 'emergency';

export interface ExitOwner {
  readonly intentId: IntentId;
  readonly quantity: RawAmount;
  readonly reasons: readonly ExitReason[];
}

export interface PositionState {
  readonly id: PositionId;
  readonly mint: Mint;
  readonly venue: Venue;
  readonly entryIntentId: IntentId;
  readonly status: PositionStatus;
  /** Confirmed tokens held, from balances. Always max(0, bought - sold). */
  readonly quantity: RawAmount;
  readonly cost: Lamports;
  readonly bought: RawAmount;
  readonly sold: RawAmount;
  readonly exitOwner: ExitOwner | null;
  /** Exit owners created so far; the next exit key uses exitSeq + 1. */
  readonly exitSeq: number;
  readonly blockedReason: string | null;
}

export type PositionEvent =
  | { readonly type: 'entry_filled'; readonly quantity: RawAmount; readonly cost: Lamports }
  | { readonly type: 'entry_unfilled' }
  /** One or more exit rules fired. `quantity` defaults to everything held. */
  | { readonly type: 'exit_triggered'; readonly reasons: readonly ExitReason[]; readonly intentId: IntentId; readonly quantity?: RawAmount }
  | { readonly type: 'exit_submitted' }
  | { readonly type: 'exit_filled'; readonly sold: RawAmount }
  /** Tokens sold outside the current exit owner (a late landing of an ended exit), proven by balances. */
  | { readonly type: 'external_sale'; readonly sold: RawAmount }
  | { readonly type: 'exit_unfilled' }
  /** The exit cannot execute (for example no liquidity). Quantity stays as held; nothing is assumed sold. */
  | { readonly type: 'exit_blocked'; readonly reason: string };

export const newPosition = (p: { id: PositionId; mint: Mint; venue: Venue; entryIntentId: IntentId }): PositionState => ({
  ...p, status: 'opening', quantity: 0n as RawAmount, cost: 0n as Lamports, bought: 0n as RawAmount, sold: 0n as RawAmount,
  exitOwner: null, exitSeq: 0, blockedReason: null,
});

const mergeReasons = (a: readonly ExitReason[], b: readonly ExitReason[]): ExitReason[] => [...new Set([...a, ...b])];

export const applyPositionEvent = (s: PositionState, e: PositionEvent): Transition<PositionState> => {
  const no = (reason: string) => illegal(s.status, e.type, reason);
  const to = (patch: Partial<PositionState>, ...effects: Effect[]): Step<PositionState> => ({
    state: { ...s, ...patch },
    effects: [{ type: 'persist', entity: 'position', id: s.id }, ...effects],
  });

  switch (e.type) {
    case 'entry_filled':
      if (s.status !== 'opening') return no('entry fill needs an opening position');
      if (e.quantity <= 0n) return no('a fill has a quantity');
      return to({ status: 'open', quantity: e.quantity, bought: e.quantity, cost: e.cost });

    case 'entry_unfilled':
      return s.status === 'opening' ? to({ status: 'closed' }) : no('only an opening position can end unfilled');

    case 'exit_triggered': {
      if (e.reasons.length === 0) return no('an exit needs a reason');
      if (s.status === 'exit_requested' || s.status === 'exit_pending') {
        // The current owner already holds the quantity: record the reason, create nothing.
        const owner = s.exitOwner;
        if (owner === null) return no('exit in progress without an owner');
        return to({ exitOwner: { ...owner, reasons: mergeReasons(owner.reasons, e.reasons) } });
      }
      if (s.status !== 'open' && s.status !== 'exit_blocked') return no('nothing to exit');
      if (s.quantity <= 0n) return no('nothing held');
      const requested = e.quantity ?? s.quantity;
      if (requested <= 0n) return no('exit quantity must be positive');
      const quantity = (requested < s.quantity ? requested : s.quantity) as RawAmount;
      return to(
        { status: 'exit_requested', exitOwner: { intentId: e.intentId, quantity, reasons: [...new Set(e.reasons)] }, exitSeq: s.exitSeq + 1, blockedReason: null },
        { type: 'request_exit', positionId: s.id, intentId: e.intentId, quantity },
      );
    }

    case 'exit_submitted':
      return s.status === 'exit_requested' ? to({ status: 'exit_pending' }) : no('only a requested exit can be submitted');

    case 'exit_filled': {
      if (s.status !== 'exit_pending' && s.status !== 'exit_requested') return no('no exit in progress');
      const owner = s.exitOwner;
      if (owner === null) return no('exit in progress without an owner');
      if (e.sold <= 0n) return no('a fill has a quantity');
      // Balances are the truth: a sale beyond the owner's quantity is booked, never refused, and alerted.
      const over = e.sold > owner.quantity || e.sold > s.quantity;
      const quantity = (e.sold >= s.quantity ? 0n : s.quantity - e.sold) as RawAmount;
      return to(
        { status: quantity === 0n ? 'closed' : 'open', quantity, sold: (s.sold + e.sold) as RawAmount, exitOwner: null },
        ...(over ? [{ type: 'alert', level: 'critical', code: 'oversold', subject: s.id } as const] : []),
      );
    }

    case 'external_sale': {
      if (s.status === 'opening') return no('no confirmed holdings');
      if (e.sold <= 0n) return no('a sale has a quantity');
      const quantity = (e.sold >= s.quantity ? 0n : s.quantity - e.sold) as RawAmount;
      const effects: Effect[] = e.sold > s.quantity ? [{ type: 'alert', level: 'critical', code: 'oversold', subject: s.id }] : [];
      // With an exit in progress the owner keeps control; its sale fails on chain if nothing is left.
      const status = quantity === 0n && s.exitOwner === null ? 'closed' : s.status;
      return to({ status, quantity, sold: (s.sold + e.sold) as RawAmount }, ...effects);
    }

    case 'exit_unfilled':
      return s.status === 'exit_requested' || s.status === 'exit_pending'
        ? to({ status: 'open', exitOwner: null })
        : no('no exit in progress');

    case 'exit_blocked':
      if (s.status !== 'exit_requested' && s.status !== 'exit_pending') return no('no exit in progress');
      return to(
        { status: 'exit_blocked', exitOwner: null, blockedReason: e.reason },
        { type: 'alert', level: 'critical', code: 'exit_blocked', subject: s.id },
      );
  }
};
