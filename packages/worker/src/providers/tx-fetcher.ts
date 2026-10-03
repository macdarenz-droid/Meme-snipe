// Fetches full transactions for signatures seen on a stream, so they are decoded by DEC-1's `transactionEvents`
// only. One fetch per signature, whoever asks; providers in order, the next on failure. A processed transaction
// may not be readable at `confirmed` yet, so a null answer is retried a few times.
import type { TransactionRecord } from '../../../core/src/chain/index.ts';
import type { Priority } from '../scheduler/scheduler.ts';
import type { Timers } from '../scheduler/timers.ts';
import type { LiveFeed } from './live-feed.ts';
import type { RpcHttp } from './solana-http.ts';

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
}

export class TxFetcher {
  readonly #o: TxFetcherOptions;
  readonly #inFlight = new Map<string, Promise<TransactionRecord | null>>();
  readonly #done = new Set<string>();

  constructor(o: TxFetcherOptions) {
    if (o.clients.length === 0) throw new RangeError('TxFetcher needs at least one client');
    this.#o = o;
  }

  /** Fetches and ingests `signature` once. Resolves to the record, or null if no provider had it. */
  fetch(signature: string, priority: Priority, backfilled = false): Promise<TransactionRecord | null> {
    if (this.#done.has(signature)) return Promise.resolve(null);
    const running = this.#inFlight.get(signature);
    if (running) return running;
    const p = this.#run(signature, priority, backfilled).finally(() => this.#inFlight.delete(signature));
    this.#inFlight.set(signature, p);
    return p;
  }

  async #run(signature: string, priority: Priority, backfilled: boolean): Promise<TransactionRecord | null> {
    const o = this.#o;
    const started = o.timers.now();
    for (let attempt = 0; attempt <= o.retries; attempt++) {
      if (attempt > 0) await new Promise<void>((resolve) => o.timers.setTimeout(resolve, o.retryMs));
      let lastError: unknown = null;
      let failures = 0;
      for (const client of o.clients) {
        try {
          const record = await client.getTransaction(signature, priority);
          if (record === null) continue;
          this.#remember(signature);
          o.feed.ingest(client.provider, { type: 'tx', record }, { receivedAt: o.timers.now(), lookup: true, backfilled });
          o.onLookup?.(o.timers.now() - started);
          return record;
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

  #remember(signature: string): void {
    this.#done.add(signature);
    if (this.#done.size > this.#o.remember) {
      const oldest = this.#done.values().next().value;
      if (oldest !== undefined) this.#done.delete(oldest);
    }
  }
}
