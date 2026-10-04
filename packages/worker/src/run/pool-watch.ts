// The swap stream of every watched pool (WORKER-1): a logs watch on each candidate's and each open position's PumpSwap
// pool, decoded from the log lines at confirmed, named `trades:<pool>` (FACTS-1's stream name, for candles and coverage). The
// strategy reads the swaps for the pool's fee terms and EXIT-1's deployer-sell trigger. A position's pool is exit
// traffic (P1); a candidate's is P3, raised in place when it becomes held. Watches follow the strategy's list, re-read every `everyMs`.
// A watch the stream drops by itself (the 70% halt, a server refusal) is forgotten and watched again at a later sync
// (POOL-1): after a halt as soon as the stream takes P3 watches again, after a refusal with a growing wait (2 s
// doubling to 60 s).
import { P1, P3, type Timers } from '../scheduler/index.ts';
import type { RpcStream, WatchOptions } from '../providers/index.ts';

export const tradesStream = (pool: string): string => `trades:${pool}`;

/** POOL-1: the first wait before a refused pool watch is asked again, doubled per refusal up to the most. */
export const REFUSED_RETRY_MS = { first: 2_000, most: 60_000 } as const;

export interface PoolWatchOptions {
  readonly stream: Pick<RpcStream, 'watchLogs' | 'unwatch' | 'setPriority'> & Partial<Pick<RpcStream, 'onDropped' | 'onServed'>>;
  readonly timers: Timers;
  /** `fromSlot`: a candidate's migration slot, where its trade coverage must start (S0-ZERO); none for held pools. */
  readonly pools: () => ReadonlyMap<string, { readonly mint: string; readonly held: boolean; readonly fromSlot?: bigint }>;
  readonly everyMs: number;
  /**
   * FILL-2's in-run fill (`ingestingFill`) for the pool watches: closes a candidate's catch-up gap from its migration
   * and any reconnect gap. Without it those gaps close as lossy, so H5 and H11 reject that pool.
   */
  readonly fill?: WatchOptions['fill'];
}

export class PoolWatch {
  readonly #o: PoolWatchOptions;
  readonly #watching = new Map<string, { readonly id: number; readonly held: boolean }>();
  #timer: ReturnType<Timers['setTimeout']> | null = null;
  #running = false;
  /** Pools whose watch the server refused: not asked again before `at`; `wait` doubles per refusal. */
  readonly #retry = new Map<string, { at: number; wait: number }>();

  constructor(o: PoolWatchOptions) {
    this.#o = o;
    o.stream.onDropped?.((id, reason) => this.#dropped(id, reason));
    // Served again: a later refusal waits the first 2 s, not the doubled wait of an earlier spell (POOL-1 review).
    o.stream.onServed?.((id) => {
      const pool = [...this.#watching].find(([, w]) => w.id === id)?.[0];
      if (pool !== undefined) this.#retry.delete(pool);
    });
  }

  #dropped(id: number, reason: 'halted' | 'refused'): void {
    const pool = [...this.#watching].find(([, w]) => w.id === id)?.[0];
    if (pool === undefined) return;
    this.#watching.delete(pool);
    if (reason === 'halted') return; // gone from the stream; it refuses new P3 watches until the halt lifts
    // A refused watch stays subscribed-in-name until a reconnect: drop it, and ask again after a wait.
    this.#o.stream.unwatch(id, 'refused');
    const wait = Math.min(REFUSED_RETRY_MS.most, (this.#retry.get(pool)?.wait ?? REFUSED_RETRY_MS.first / 2) * 2);
    this.#retry.set(pool, { at: this.#o.timers.now() + wait, wait });
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

  /** Watches what the list holds and drops what it no longer holds; a pool that became held moves to P1 in place. */
  sync(): void {
    const want = this.#o.pools();
    for (const [pool, w] of [...this.#watching]) {
      const now = want.get(pool);
      if (now === undefined) {
        this.#o.stream.unwatch(w.id, 'not watched');
        this.#watching.delete(pool);
      } else if (now.held !== w.held) {
        // Re-prioritised in place (POS-1): a re-subscribe would cut the pool's trade stream right after the entry.
        // A watch lowered while halted is dropped inside setPriority (POOL-1 hears of it): then it is not listed again.
        if (this.#o.stream.setPriority(w.id, now.held ? P1 : P3)) {
          if (this.#watching.has(pool)) this.#watching.set(pool, { id: w.id, held: now.held });
        }
        else {
          this.#o.stream.unwatch(w.id, 'priority changed');
          this.#watching.delete(pool);
        }
      }
    }
    for (const pool of this.#retry.keys()) if (!want.has(pool)) this.#retry.delete(pool);
    for (const [pool, { held, fromSlot }] of want) {
      if (this.#watching.has(pool)) continue;
      const retry = this.#retry.get(pool);
      if (retry !== undefined && this.#o.timers.now() < retry.at) continue;
      try {
        // Confirmed (FACTS-1 STREAMS.trades): the producer builds the pool state from these swaps (POS-1) and never
        // from processed ones, which can be rolled back.
        // A candidate's coverage starts at its migration (S0-ZERO): its candles are observed from the pool's creation.
        const id = this.#o.stream.watchLogs(pool, {
          priority: held ? P1 : P3, decodeLogs: true, coverage: tradesStream(pool), commitment: 'confirmed',
          ...(this.#o.fill === undefined ? {} : { fill: this.#o.fill }), ...(fromSlot === undefined || held ? {} : { coverFrom: fromSlot }),
        });
        this.#watching.set(pool, { id, held });
      } catch {
        // Refused (the provider's budget halt refuses new P3 watches): retried at the next sync.
      }
    }
  }
}
