// Mirrors the engine's decision log into a backtest ledger (LEDGER-1), outside the engine. Every applied book event is
// replayed through the same CORE-1 reducer on a mirror book and written by Ledger.recordBookEvent, the writer the
// ledger replay check is built for. Network fees of every attempt, failed ones
// included, come from the fill model. A record the reducer refuses, or a mirror that ends unlike the engine's book,
// counts as an illegal state.
import { canonical, type LogRecord } from '../../../core/src/engine/index.ts';
import { type Ledger, LedgerError, type ReservationLimits } from '../../../core/src/ledger/index.ts';
import { applyBookEvent, type Book, type BookConfig, emptyBook, isIllegal, isTerminal, type BookEvent, type Effect } from '../../../core/src/lifecycle/index.ts';
import type { Lamports } from '../../../core/src/units/index.ts';
import type { AttemptRecord } from './world.ts';

export class LedgerSink {
  readonly #ledger: Ledger | null;
  readonly #limits: ReservationLimits;
  #book: Book;
  #cursor = 0;
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
    // One reduction per event: the ledger's writer applies the reducer and returns its step (Ledger.recordBookEvent);
    // without a ledger the sink applies it itself. A refused event counts as a divergence and changes nothing.
    let step: { readonly book: Book; readonly effects: readonly Effect[] };
    if (this.#ledger === null) {
      const r = applyBookEvent(prev, event);
      if (isIllegal(r)) {
        this.divergences++;
        return;
      }
      step = { book: r.state, effects: r.effects };
    } else {
      try {
        step = this.#ledger.recordBookEvent(prev, event, { ts, limits: this.#limits });
      } catch (err) {
        if (err instanceof LedgerError && err.code === 'reducer_refused') {
          this.divergences++;
          return;
        }
        throw err;
      }
    }
    const next = step.book;
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
