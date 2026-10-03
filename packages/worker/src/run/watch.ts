// WATCH-1: the independent watch on held positions (§18, DECISIONS "A dead feed leaves no price-based stop"). On its own
// timer, never inside the engine step and never waiting for a feed event, it looks at every open position's market. When
// that market is older than `staleMs`, it reads a coherent snapshot (run/snapshot.ts) through the second path at P1 and
// puts it on the feed, where the strategy prices the position from it alone. A read that fails or cannot be trusted
// raises the critical alert and is tried again on the next tick: a position is never assumed fine without a price.
import type { Timers, TimerHandle } from '../scheduler/timers.ts';
import { decodeSnapshot, type PoolSnapshot, type ReadAccount, snapshotAddresses } from './snapshot.ts';
import { decodePool } from '../../../core/src/chain/index.ts';

export interface WatchRead {
  readonly slot: bigint;
  readonly accounts: readonly ReadAccount[];
}

export interface PositionWatchOptions {
  readonly timers: Timers;
  /** How often the watch looks (config: ZEROED_WATCH_EVERY_MS). */
  readonly everyMs: number;
  /** A held position's market older than this is read again (config: ZEROED_WATCH_STALE_MS). */
  readonly staleMs: number;
  /** Open positions: the mint and the pool it trades on (null when no pool is known yet). */
  readonly held: () => readonly { readonly mint: string; readonly pool: string | null }[];
  /** When the market the position is priced at was observed (ms), or null when it has none. */
  readonly marketAt: (mint: string) => number | null;
  /** The second path: one getMultipleAccounts at confirmed, through the quota scheduler at P1. */
  readonly read: (addresses: readonly string[]) => Promise<WatchRead>;
  /** A trusted snapshot, read at `atMs`: onto the feed. */
  readonly put: (snapshot: PoolSnapshot, atMs: number) => void;
  /** The critical alert for a held mint left without a fresh price (raised once per episode), and its end. */
  readonly alert: (mint: string, reason: string) => void;
  readonly cleared: (mint: string) => void;
}

export class PositionWatch {
  readonly #o: PositionWatchOptions;
  #timer: TimerHandle | null = null;
  #running = false;
  readonly #inFlight = new Set<string>();
  /** Vault addresses by pool, learned from the pool account (the coherent read needs them up front). */
  readonly #vaults = new Map<string, readonly [string, string]>();
  /** Mints whose critical alert is up, with its reason. */
  readonly #alerts = new Map<string, string>();
  reads = 0;
  failures = 0;

  constructor(o: PositionWatchOptions) {
    if (!(o.everyMs > 0) || !(o.staleMs >= o.everyMs)) throw new RangeError('watch: everyMs must be > 0 and staleMs >= everyMs');
    this.#o = o;
  }

  /** The critical alerts up now, one line each. */
  get critical(): readonly string[] {
    return [...this.#alerts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([mint, why]) => `${mint}: no fresh price (${why})`);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = (): void => {
      if (!this.#running) return;
      this.tick();
      this.#timer = this.#o.timers.setTimeout(tick, this.#o.everyMs);
    };
    this.#timer = this.#o.timers.setTimeout(tick, this.#o.everyMs);
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) this.#o.timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** One look at the held positions (the timer calls it). */
  tick(): void {
    const now = this.#o.timers.now();
    const held = this.#o.held();
    const mints = new Set(held.map((h) => h.mint));
    // A position that closed takes its alert with it.
    for (const mint of [...this.#alerts.keys()]) if (!mints.has(mint)) this.#clear(mint);
    for (const { mint, pool } of held) {
      if (this.#inFlight.has(mint)) continue;
      const at = this.#o.marketAt(mint);
      if (at !== null && now - at < this.#o.staleMs) continue;
      if (pool === null) {
        this.#raise(mint, 'no pool known for the position');
        continue;
      }
      this.#inFlight.add(mint);
      void this.#snapshot(mint, pool).finally(() => this.#inFlight.delete(mint));
    }
  }

  async #snapshot(mint: string, pool: string): Promise<void> {
    this.reads++;
    try {
      let vaults = this.#vaults.get(pool);
      if (vaults === undefined) {
        const first = await this.#o.read([pool]);
        const acc = first.accounts[0];
        if (acc == null) throw new Error('the pool account does not exist');
        const p = decodePool(acc.data).value;
        vaults = [p.poolBaseTokenAccount, p.poolQuoteTokenAccount];
        this.#vaults.set(pool, vaults);
      }
      const r = await this.#o.read(snapshotAddresses(pool, vaults[0], vaults[1], mint));
      const s = decodeSnapshot(mint, pool, r.slot, r.accounts);
      if (!s.ok) {
        // The layout may have moved: learn it again on the next read.
        this.#vaults.delete(pool);
        throw new Error(s.reason);
      }
      if (!this.#running) return;
      this.#o.put(s.snapshot, this.#o.timers.now());
      this.#clear(mint);
    } catch (e) {
      this.failures++;
      if (this.#running) this.#raise(mint, e instanceof Error ? e.message : String(e));
    }
  }

  #raise(mint: string, reason: string): void {
    if (this.#alerts.has(mint)) return;
    this.#alerts.set(mint, reason);
    this.#o.alert(mint, reason);
  }

  #clear(mint: string): void {
    if (!this.#alerts.delete(mint)) return;
    this.#o.cleared(mint);
  }
}
