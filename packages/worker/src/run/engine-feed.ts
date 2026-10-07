// FACTS-1b: the feed the engine reads, live and in a replay of the recording alike. Core's FactFeed wraps the inner
// feed, so raw reads and chain events become gate facts by the same producer the backtest runs; facts are derived,
// never recorded on their own, and a replay rebuilds them from the recorded inputs.
import type { Policy } from '../../../core/src/config/index.ts';
import type { Feed, MarketEvent } from '../../../core/src/engine/index.ts';
import { FACT_ID_SEPARATOR, FactFeed, FactProducer, producerOptions } from '../../../core/src/facts/index.ts';

export interface EngineFeed {
  readonly feed: Feed;
  /** Facts released so far. */
  readonly released: () => number;
  /** MEM-PROBE: the producer's counts and the facts queued for release. */
  readonly sizes: () => Record<string, number>;
}

/**
 * `onFact` sees every fact the producer releases, before the engine does. `onRetire` sees the mints and pools the
 * strategy let go (`Strategy.retired`), after the producer dropped them (MEM-FIXES: the worker forgets its own copies).
 * `note` gets the producer's notes on what it let go for memory (MEM-FIXES).
 */
export const engineFeed = (inner: Feed, policy: Policy, onFact?: (e: MarketEvent) => void, onRetire?: (ids: readonly string[]) => void, note?: (line: string) => void): EngineFeed => {
  const facts = new FactFeed(inner, new FactProducer(producerOptions(policy), note));
  return {
    feed: {
      next: () => {
        const e = facts.next();
        if (onFact !== undefined && e !== null && e.kind === 'market' && e.id.includes(FACT_ID_SEPARATOR)) onFact(e);
        return e;
      },
      retire: (ids) => {
        facts.retire(ids);
        onRetire?.(ids);
      },
    },
    released: () => facts.released,
    sizes: () => ({ ...facts.sizes() }),
  };
};
