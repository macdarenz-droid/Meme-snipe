// Mirrors the engine's decision log into a backtest ledger (LEDGER-1), outside the engine. Every applied book event is
// replayed through the same CORE-1 reducer on a mirror book; the differences become ledger rows (intents and their
// transitions with effects, attempts, fills, reservations, positions). Network fees of every attempt, failed ones
// included, come from the fill model. A record the reducer refuses, or a mirror that ends unlike the engine's book,
// counts as an illegal state.
import { canonical, type LogRecord } from '../../../core/src/engine/index.ts';
import type { Ledger, ReservationLimits } from '../../../core/src/ledger/index.ts';
import { encodeBookDetail, rowEventName, stepRows } from '../../../core/src/ledger/replay/index.ts';
import { applyBookEvent, type Book, type BookConfig, emptyBook, isIllegal, isTerminal, type BookEvent } from '../../../core/src/lifecycle/index.ts';
import type { Lamports } from '../../../core/src/units/index.ts';
import type { AttemptRecord } from './world.ts';

export class LedgerSink {
  readonly #ledger: Ledger | null;
  readonly #limits: ReservationLimits;
  #book: Book;
  #cursor = 0;
  readonly #opened = new Set<string>();
  /** Records the reducer refused on the mirror (should equal the engine's own illegal results: none). */
  divergences = 0;

  constructor(ledger: Ledger | null, config: BookConfig, limits: ReservationLimits) {
    this.#ledger = ledger;
    this.#limits = limits;
    this.#book = emptyBook(config);
  }

  get book(): Book {
    return this.#book;
  }

  /** Consumes the records added since the last call. */
  consume(records: readonly LogRecord[]): void {
    if (this.#cursor >= records.length) return;
    const work = () => {
      for (; this.#cursor < records.length; this.#cursor++) {
        const r = records[this.#cursor]!;
        if (r.type === 'decision' && r.result === 'applied' && r.action !== null) this.#apply(r.action, r.at.receivedAt);
        else if (r.type === 'world' && r.result === 'applied') this.#apply(r.event, r.at.receivedAt);
      }
    };
    if (this.#ledger === null) work();
    else this.#ledger.atomically(work);
  }

  /** Intents not finished and positions not closed, kept from the persist effects: activity without a scan. */
  readonly liveIntents = new Set<string>();
  readonly openPositions = new Set<string>();

  /** An intent not finished or a landing waiting to be booked: the lifecycle needs every block's tick. */
  get inFlight(): boolean {
    return this.liveIntents.size > 0 || Object.keys(this.#book.orphans).length > 0;
  }

  #apply(event: BookEvent, ts: number): void {
    const prev = this.#book;
    const step = applyBookEvent(prev, event);
    if (isIllegal(step)) {
      this.divergences++;
      return;
    }
    const next = step.state;
    this.#book = next;
    // Every state change persists the entity it changed, so the persist effects name everything to diff.
    const intents = new Set<string>();
    const positions = new Set<string>();
    for (const fx of step.effects) {
      if (fx.type !== 'persist') continue;
      if (fx.entity === 'intent') intents.add(fx.id);
      else if (fx.entity === 'position') positions.add(fx.id);
    }
    for (const id of intents) {
      const after = next.intents[id];
      if (after === undefined) continue;
      if (isTerminal(after)) this.liveIntents.delete(id);
      else this.liveIntents.add(id);
    }
    for (const id of positions) {
      const after = next.positions[id];
      if (after === undefined) continue;
      if (after.status === 'closed') this.openPositions.delete(id);
      else this.openPositions.add(id);
    }
    const L = this.#ledger;
    if (L === null) return;
    // The rows LEDGER-REPLAY's check expects (src/ledger/replay, stepRows): one intent row per persisted intent in
    // effect order, the first carrying the versioned book event and the effects; positions after.
    const rows = stepRows(prev, event, step.effects);
    if (rows === null) return;
    const name = rowEventName(event);
    rows.intents.forEach((id, k) => {
      const s = next.intents[id]!;
      const was = prev.intents[id];
      if (was === undefined) {
        const r = L.recordIntent(s.intent, { status: s.status, ts });
        if (!r.ok) throw new RangeError(`ledger refused intent ${id}: duplicate key`);
      } else {
        L.appendIntentTransition({ intentId: s.intent.id, status: s.status, event: name, ts, ...(k === 0 ? { detail: encodeBookDetail(event), effects: step.effects } : {}) });
      }
      const known = new Set((was?.attempts ?? []).map((x) => x.signature));
      for (const x of s.attempts) if (!known.has(x.signature)) L.recordAttempt(x, ts);
      const booked = new Set((was?.fills ?? []).map((f) => f.signature));
      for (const f of s.fills) if (!booked.has(f.signature)) L.recordFill(f, ts);
      const r = s.reservation;
      if (r !== null && was?.reservation == null) {
        const res = L.reserveExposure({ reservationId: r.id, intentId: id, amount: r.amount, limits: this.#limits, ts });
        if (!res.ok) throw new RangeError(`ledger refused reservation ${r.id}: ${res.reason}`);
      }
      if (r !== null && r.status !== 'held' && was?.reservation?.status !== r.status) L.endReservation(r.id, r.status, ts);
    });
    for (const pid of rows.positions) {
      const p = next.positions[pid]!;
      if (!this.#opened.has(pid)) {
        L.openPosition({ positionId: pid, mint: p.mint, venue: p.venue, entryIntentId: p.entryIntentId, ts });
        this.#opened.add(pid);
        if (p.status === 'opening' && p.quantity === 0n && p.cost === 0n) continue;
      }
      L.appendPositionState({ positionId: pid, status: p.status, quantity: p.quantity, cost: p.cost, event: name, ts, ...(event.type === 'trigger_exit' ? { detail: encodeBookDetail(event) } : {}) });
    }
  }

  /** Network fees of a settled attempt, by kind. A dropped or expired attempt cost nothing. */
  fees(a: AttemptRecord, base: bigint, tip: bigint, ts: number): void {
    const L = this.#ledger;
    if (L === null || a.fee === 0n) return;
    L.atomically(() => {
      L.recordFee({ intentId: a.intentId, signature: a.signature, kind: 'network_base', lamports: base as Lamports, ts });
      L.recordFee({ intentId: a.intentId, signature: a.signature, kind: 'priority', lamports: a.priorityFee as Lamports, ts });
      if (a.outcome === 'filled') L.recordFee({ intentId: a.intentId, signature: a.signature, kind: 'tip', lamports: tip as Lamports, ts });
    });
  }

  /** True when the mirror built from the log equals the engine's book. */
  matches(engineBook: Book): boolean {
    return canonical(this.#book) === canonical(engineBook);
  }
}
