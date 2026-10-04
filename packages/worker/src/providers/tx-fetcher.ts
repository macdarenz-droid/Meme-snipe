// Fetches full transactions for signatures seen on a stream, so they are decoded by DEC-1's `transactionEvents`
// only. One fetch per signature, whoever asks; providers in order, the next on failure. A processed transaction
// may not be readable at `confirmed` yet, so a null answer is retried a few times. A repeat ask for a signature already
// on the feed resolves to its first arrival (never null: null means not found, and callers turn that into a rugs gap).
import type { TransactionRecord } from '../../../core/src/chain/index.ts';
import type { Priority } from '../scheduler/scheduler.ts';
import type { Timers } from '../scheduler/timers.ts';
import type { LiveFeed } from './live-feed.ts';
import type { RpcHttp } from './solana-http.ts';
import { CappedMap } from '../run/capped-map.ts';

export interface TxFetcherOptions {
  readonly clients: readonly RpcHttp[];
  readonly feed: LiveFeed;
  readonly timers: Timers;
  /** Extra tries after a null answer, `retryMs` apart. */
  readonly retries: number;
  readonly retryMs: number;
  /** Signatures remembered as fetched, oldest forgotten first. */
  readonly remember: number;
  /** Each lookup that found its transaction, with how long it took from the first ask (RUN-1c's latency histogram). */
  readonly onLookup?: (ms: number) => void;
  /** A monotonic local clock (ms) for the arrival stamp; default `performance.now`. */
  readonly mono?: () => number;
}

/** A transaction found: its slot and when it first arrived on this host. `again` when an earlier fetch put it on the feed. */
export interface Fetched {
  readonly slot: bigint;
  readonly at: number;
  readonly mono: number;
  readonly again: boolean;
}

export class TxFetcher {
  readonly #o: TxFetcherOptions;
  readonly #inFlight = new Map<string, Promise<Fetched | null>>();
  /**
   * Fetched signatures and their first arrival, the newest `remember`, oldest forgotten first in O(1) (a few dozen bytes
   * each, never the record). A signature is remembered only once its transaction is on the feed.
   */
  readonly #done: CappedMap<string, Fetched>;

  constructor(o: TxFetcherOptions) {
    if (o.clients.length === 0) throw new RangeError('TxFetcher needs at least one client');
    this.#o = o;
    this.#done = new CappedMap(o.remember);
  }

  /** Fetches and ingests `signature` once. Resolves to its arrival, or null if no provider had it. */
  fetch(signature: string, priority: Priority, backfilled = false): Promise<Fetched | null> {
    const done = this.#done.get(signature);
    if (done !== undefined) return Promise.resolve({ ...done, again: true });
    const running = this.#inFlight.get(signature);
    if (running) return running;
    const p = this.#run(signature, priority, backfilled).finally(() => this.#inFlight.delete(signature));
    this.#inFlight.set(signature, p);
    return p;
  }

  async #run(signature: string, priority: Priority, backfilled: boolean): Promise<Fetched | null> {
    const o = this.#o;
    const started = o.timers.now();
    for (let attempt = 0; attempt <= o.retries; attempt++) {
      if (attempt > 0) await new Promise<void>((resolve) => o.timers.setTimeout(resolve, o.retryMs));
      let lastError: unknown = null;
      let failures = 0;
      for (const client of o.clients) {
        try {
          const record: TransactionRecord | null = await client.getTransaction(signature, priority);
          if (record === null) continue;
          const found: Fetched = { slot: record.slot, at: o.timers.now(), mono: (o.mono ?? (() => performance.now()))(), again: false };
          o.feed.ingest(client.provider, { type: 'tx', record }, { receivedAt: found.at, lookup: true, backfilled });
          // Remembered only once on the feed: an ingest that throws leaves the next ask to read it again.
          this.#done.set(signature, found);
          o.onLookup?.(found.at - started);
          return found;
        } catch (e) {
          lastError = e;
          failures++;
        }
      }
      // Every provider failed on the last try: report it. A plain "not found" is not an error.
      if (failures === o.clients.length && attempt === o.retries) throw lastError;
    }
    return null;
  }
}
