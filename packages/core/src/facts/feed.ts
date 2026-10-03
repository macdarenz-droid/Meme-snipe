// The fact feed: wraps any Feed (live or backtest) and releases, after each market event, the facts the producers
// derive from it. A fact event sits at its source's moment, and its id is the source id plus `~` and the fact key, so it
// sorts right after its source and before any later event: event ids are base58, digits and ASCII punctuation, all
// below `~` (0x7e). The engine records it in the as-of store like any other event, so the gates read it unchanged
// and the decision log names the fact's source.
import type { Feed, FeedEvent, MarketEvent } from '../engine/feed.ts';
import type { FactProducer } from './producer.ts';

export const FACT_ID_SEPARATOR = '~';

export class FactFeed implements Feed {
  readonly #inner: Feed;
  readonly #producer: FactProducer;
  readonly #queue: MarketEvent[] = [];
  /** Facts released so far. */
  released = 0;

  constructor(inner: Feed, producer: FactProducer) {
    this.#inner = inner;
    this.#producer = producer;
  }

  next(): FeedEvent | null {
    const q = this.#queue.shift();
    if (q !== undefined) {
      this.released++;
      return q;
    }
    const e = this.#inner.next();
    if (e === null || e.kind !== 'market') return e;
    for (const w of this.#producer.observe(e)) {
      this.#queue.push({ kind: 'market', id: `${e.id}${FACT_ID_SEPARATOR}${w.key}`, moment: e.moment, key: w.key, value: w.value });
    }
    // Facts of one event go out in key order, so the release order never depends on the producers' internal order.
    this.#queue.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return e;
  }
}
