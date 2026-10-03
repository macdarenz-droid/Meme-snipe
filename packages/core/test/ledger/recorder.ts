// Test writer for the ledger replay check: applies book events through the CORE-1 reducer and writes what
// each one changed, following the storage rules in src/ledger/replay (stepRows decides the rows). The engine
// tests produce the events; BT-1 and the worker will write the same rows from their effect runner.
import { lamports } from '../../src/units/index.ts';
import type { LogRecord } from '../../src/engine/index.ts';
import { applyBookEvent, emptyBook, isIllegal, type Book, type BookConfig, type BookEvent } from '../../src/lifecycle/index.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import { rowEventName, stepRows } from '../../src/ledger/replay/index.ts';

export interface Timed {
  readonly event: BookEvent;
  readonly ts: number;
}

const LIMITS = { maxHeld: lamports(10n ** 30n), maxCount: Number.MAX_SAFE_INTEGER };

/** The events the engine applied, in order, with their receipt time. Refused events change nothing and are left out. */
export const appliedEvents = (records: readonly LogRecord[]): Timed[] => records.flatMap((r) => {
  if (r.type === 'decision' && r.result === 'applied' && r.action !== null) return [{ event: r.action, ts: r.at.receivedAt }];
  if (r.type === 'world' && r.result === 'applied') return [{ event: r.event, ts: r.at.receivedAt }];
  return [];
});

/** Writes every applied event to the ledger. Returns the final book. Throws on an event the reducer refuses. */
export const recordEvents = (ledger: Ledger, events: readonly Timed[], config: BookConfig): Book => {
  let book = emptyBook(config);
  const opened = new Set<string>();
  for (const { event, ts } of events) {
    const step = applyBookEvent(book, event);
    if (isIllegal(step)) throw new Error(`recorder: ${event.type} refused: ${step.reason}`);
    const rows = stepRows(book, event, step.effects);
    const before = book;
    book = step.state;
    if (rows === null) continue;
    const name = rowEventName(event);
    ledger.atomically(() => {
      rows.intents.forEach((id, k) => {
        const s = book.intents[id]!;
        const was = before.intents[id];
        if (was === undefined) {
          const r = ledger.recordIntent(s.intent, { status: s.status, ts });
          if (!r.ok) throw new Error(`recorder: duplicate key ${s.intent.key}`);
        } else {
          ledger.appendIntentTransition({
            intentId: s.intent.id, status: s.status, event: name, ts,
            ...(k === 0 ? { detail: { book: event }, effects: step.effects } : {}),
          });
        }
        const known = new Set((was?.attempts ?? []).map((a) => a.signature));
        for (const a of s.attempts) if (!known.has(a.signature)) ledger.recordAttempt(a, ts);
        const booked = new Set((was?.fills ?? []).map((f) => f.signature));
        for (const f of s.fills) if (!booked.has(f.signature)) ledger.recordFill(f, ts);
        const r = s.reservation;
        if (r !== null && was?.reservation == null) {
          const res = ledger.reserveExposure({ reservationId: r.id, intentId: id, amount: r.amount, limits: LIMITS, ts });
          if (!res.ok) throw new Error(`recorder: reservation refused: ${res.reason}`);
        }
        if (r !== null && r.status !== 'held' && was?.reservation?.status !== r.status) ledger.endReservation(r.id, r.status, ts);
      });
      for (const pid of rows.positions) {
        const p = book.positions[pid]!;
        if (!opened.has(pid)) {
          ledger.openPosition({ positionId: pid, mint: p.mint, venue: p.venue, entryIntentId: p.entryIntentId, ts });
          opened.add(pid);
          if (p.status === 'opening' && p.quantity === 0n && p.cost === 0n) continue;
        }
        ledger.appendPositionState({
          positionId: pid, status: p.status, quantity: p.quantity, cost: p.cost, event: name, ts,
          ...(event.type === 'trigger_exit' ? { detail: { book: event } } : {}),
        });
      }
    });
  }
  return book;
};
