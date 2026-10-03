// An exit decision as CORE-1 book events. The book's single exit owner is what stops two triggers overselling: a
// merge adds reasons to the owner in place, and a new owner can only start from an open or blocked position.
import type { IntentId, PositionId } from '../domain/index.ts';
import type { Book, BookEvent } from '../lifecycle/index.ts';
import { raw } from '../units/index.ts';
import type { ExitDecision } from './rules.ts';

/**
 * Book events for one decision. `intentId` names the new exit owner; for a merge it is ignored by the book. When the
 * exit has no executable quote it is booked blocked in the same step: an exit with nothing to sell into never pretends
 * to be in flight; nor does one whose position has used its whole ladder.
 */
export const exitBookEvents = (positionId: PositionId, decision: ExitDecision, intentId: IntentId): BookEvent[] => {
  if (decision.kind === 'hold') return [];
  if (decision.kind === 'merge') return [{ type: 'trigger_exit', positionId, reasons: decision.reasons, intentId }];
  const trigger: BookEvent = { type: 'trigger_exit', positionId, reasons: decision.reasons, intentId, quantity: raw(decision.quantity) };
  if (decision.blocked !== null) return [trigger, { type: 'exit_blocked', positionId, reason: decision.blocked }];
  return decision.value.ok ? [trigger] : [trigger, { type: 'exit_blocked', positionId, reason: `no executable quote: ${decision.value.detail}` }];
};

/** Signed attempts of every exit intent of this position: the per-position ladder budget, rebuilt from the book. */
export const exitAttemptsOf = (intents: Book['intents'], positionId: PositionId): number =>
  Object.values(intents).reduce((n, i) => (i.intent.purpose === 'exit' && i.intent.positionId === positionId ? n + i.attempts.length : n), 0);
