// The engine's feed at start: events put ahead of the live Feed (the deployer index's seed and the saved and seeded
// coverage history, SEED-1) are released first, then the live Feed's. The clock is the later of the two, so the
// engine never sees a released event as dated after now.
import type { Clock, Feed, FeedEvent, Moment } from '../../../core/src/engine/index.ts';
import { compareMoments, GENESIS } from '../../../core/src/engine/index.ts';
import type { LiveFeed } from '../providers/index.ts';

export class StartFeed implements Feed {
  readonly #live: LiveFeed;
  readonly #queue: FeedEvent[] = [];
  #head = 0;
  #at: Moment = GENESIS;
  readonly clock: Clock;

  constructor(live: LiveFeed) {
    this.#live = live;
    this.clock = { now: () => (compareMoments(this.#at, live.clock.now()) > 0 ? this.#at : live.clock.now()) };
  }

  /** Puts events ahead of every live event not yet released. They must sort after everything released so far. */
  ahead(events: readonly FeedEvent[]): void {
    this.#queue.push(...events);
  }

  get pending(): number {
    return this.#queue.length - this.#head;
  }

  next(): FeedEvent | null {
    const e = this.#queue[this.#head];
    if (e !== undefined) {
      this.#head++;
      if (compareMoments(e.moment, this.#at) > 0) this.#at = e.moment;
      return e;
    }
    return this.#live.next();
  }
}
