// The swap stream of every watched pool (WORKER-1): a logs watch on each candidate's and each open position's PumpSwap
// pool, decoded from the log lines at confirmed, named `trades:<pool>` (FACTS-1's stream name, for candles and coverage). The
// strategy reads the swaps for the pool's fee terms and EXIT-1's deployer-sell trigger. A position's pool is exit
// traffic (P1); a candidate's is P3. Watches follow the strategy's list, re-read every `everyMs`.
import { P1, P3, type Timers } from '../scheduler/index.ts';
import type { RpcStream } from '../providers/index.ts';

export const tradesStream = (pool: string): string => `trades:${pool}`;

export interface PoolWatchOptions {
  readonly stream: Pick<RpcStream, 'watchLogs' | 'unwatch'>;
  readonly timers: Timers;
  readonly pools: () => ReadonlyMap<string, { readonly mint: string; readonly held: boolean }>;
  readonly everyMs: number;
}

export class PoolWatch {
  readonly #o: PoolWatchOptions;
  readonly #watching = new Map<string, { readonly id: number; readonly held: boolean }>();
  #timer: ReturnType<Timers['setTimeout']> | null = null;
  #running = false;

  constructor(o: PoolWatchOptions) {
    this.#o = o;
  }

  get watching(): ReadonlyMap<string, { readonly id: number; readonly held: boolean }> {
    return this.#watching;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = (): void => {
      if (!this.#running) return;
      this.sync();
      this.#timer = this.#o.timers.setTimeout(tick, this.#o.everyMs);
    };
    tick();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) this.#o.timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Watches what the list holds and drops what it no longer holds; a pool that became held is re-watched at P1. */
  sync(): void {
    const want = this.#o.pools();
    for (const [pool, w] of this.#watching) {
      const now = want.get(pool);
      if (now === undefined || now.held !== w.held) {
        this.#o.stream.unwatch(w.id, now === undefined ? 'not watched' : 'priority changed');
        this.#watching.delete(pool);
      }
    }
    for (const [pool, { held }] of want) {
      if (this.#watching.has(pool)) continue;
      try {
        // Confirmed (FACTS-1 STREAMS.trades): the producer builds the pool state from these swaps (POS-1) and never
        // from processed ones, which can be rolled back.
        const id = this.#o.stream.watchLogs(pool, { priority: held ? P1 : P3, decodeLogs: true, coverage: tradesStream(pool), commitment: 'confirmed' });
        this.#watching.set(pool, { id, held });
      } catch {
        // Refused (the provider's budget halt refuses new P3 watches): retried at the next sync.
      }
    }
  }
}
