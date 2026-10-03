// An exit decision as CORE-1 book events. The book's single exit owner is what stops two triggers overselling: a
// merge adds reasons to the owner in place, and a new owner can only start from an open or blocked position.
import type { IntentId, PositionId } from '../domain/index.ts';
import type { BookEvent } from '../lifecycle/index.ts';
import { raw } from '../units/index.ts';
import type { ExitDecision } from './rules.ts';

/**
 * Book events for one decision. `intentId` names the new exit owner; for a merge it is ignored by the book. When the
 * exit has no executable quote it is booked blocked in the same step: an exit with nothing to sell into never pretends
 * to be in flight.
 */
export const exitBookEvents = (positionId: PositionId, decision: ExitDecision, intentId: IntentId): BookEvent[] => {
  if (decision.kind === 'hold') return [];
  if (decision.kind === 'merge') return [{ type: 'trigger_exit', positionId, reasons: decision.reasons, intentId }];
  const trigger: BookEvent = { type: 'trigger_exit', positionId, reasons: decision.reasons, intentId, quantity: raw(decision.quantity) };
  return decision.value.ok ? [trigger] : [trigger, { type: 'exit_blocked', positionId, reason: `no executable quote: ${decision.value.detail}` }];
};
