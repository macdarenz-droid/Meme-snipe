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
  /**
   * A held market proven fresh is still read this often (WATCH-1c): the stream's proof cannot see a transfer straight
   * into a pool vault. Absent: no such reads.
   */
  readonly verifyMs?: number;
  /** An answer later than this is not used: it would already be too old to quote (config: ZEROED_WATCH_LATENCY_MS). */
  readonly latencyMs: number;
  /**
   * Open positions, and entries in flight (so a fresh snapshot already exists when the entry lands): the mint and the
   * pool it trades on (null when no pool is known yet).
   */
  readonly held: () => readonly { readonly mint: string; readonly pool: string | null }[];
  /**
   * When the position's market was last renewed (ms), or null when it has none: a feed pool fact counts from its release
   * (a live feed releases one each slot while the pool trades), the watch's own snapshot from its read.
   */
  readonly marketAt: (mint: string) => number | null;
  /** The second path: one getMultipleAccounts at confirmed (no older than `minContextSlot`), through the quota scheduler at P0. */
  readonly read: (addresses: readonly string[], minContextSlot: bigint | null) => Promise<WatchRead>;
  /**
   * WATCH-1d: the chain head the feed last released and when, or null before the first. A snapshot is held to it: read
   * no older than `head - maxLagSlots`, refused when it answers older, live or not (a dead feed's last head is still a floor).
   */
  readonly head?: () => { readonly slot: bigint; readonly atMs: number } | null;
  /** How far a snapshot's bank may trail the live head: the policy's `maxStateSlotLag`, as for the gates' chain state. */
  readonly maxLagSlots?: number;
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
  /** When each held mint was last read (or first seen held): the verify period counts from it. */
  readonly #lastRead = new Map<string, number>();
  /** The last snapshot taken per pool: its bank's slot and when it was first read (a repeat of that bank is not new). */
  readonly #taken = new Map<string, { readonly slot: bigint; readonly atMs: number }>();
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

  /**
   * A position just opened: read now, whatever the market's age, so an entry that lands faster than one period is not
   * left a period without a fresh price. Nothing when a read for the mint is already in flight.
   */
  opened(mint: string, pool: string | null): void {
    if (!this.#running || pool === null || this.#inFlight.has(mint)) return;
    this.#inFlight.add(mint);
    void this.#snapshot(mint, pool).finally(() => this.#inFlight.delete(mint));
  }

  /** One look at the held positions (the timer calls it). */
  tick(): void {
    const now = this.#o.timers.now();
    const held = this.#o.held();
    const mints = new Set(held.map((h) => h.mint));
    // A position that closed takes its alert with it.
    for (const mint of [...this.#alerts.keys()]) if (!mints.has(mint)) this.#clear(mint);
    for (const mint of [...this.#lastRead.keys()]) if (!mints.has(mint)) this.#lastRead.delete(mint);
    for (const { mint, pool } of held) {
      if (!this.#lastRead.has(mint)) this.#lastRead.set(mint, now);
      if (this.#inFlight.has(mint)) continue;
      const at = this.#o.marketAt(mint);
      const verify = this.#o.verifyMs !== undefined && now - this.#lastRead.get(mint)! >= this.#o.verifyMs;
      if (at !== null && now - at < this.#o.staleMs && !verify) continue;
      if (pool === null) {
        this.#raise(mint, 'no pool known for the position');
        continue;
      }
      this.#inFlight.add(mint);
      void this.#snapshot(mint, pool).finally(() => this.#inFlight.delete(mint));
    }
  }

  /** One read through the second path, refused when its answer comes later than `latencyMs`. */
  #read(addresses: readonly string[], minContextSlot: bigint | null): Promise<WatchRead> {
    const ms = this.#o.latencyMs;
    let timer: TimerHandle | null = null;
    const late = new Promise<never>((_, reject) => {
      timer = this.#o.timers.setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    });
    return Promise.race([this.#o.read(addresses, minContextSlot), late]).finally(() => {
      if (timer !== null) this.#o.timers.clearTimeout(timer);
    });
  }

  async #snapshot(mint: string, pool: string): Promise<void> {
    this.reads++;
    this.#lastRead.set(mint, this.#o.timers.now());
    try {
      const head = this.#o.head?.() ?? null;
      const lag = BigInt(this.#o.maxLagSlots ?? 0);
      // The last released head bounds the bank whether or not the feed is still live: the chain never goes back, so a
      // dead feed's head is still a proven floor (risk review of #141). Live (the head moved within a stale limit and one
      // period) only names the case in the alert.
      const live = head !== null && this.#o.timers.now() - head.atMs < this.#o.staleMs + this.#o.everyMs;
      const minSlot = head !== null && head.slot > lag ? head.slot - lag : null;
      let vaults = this.#vaults.get(pool);
      if (vaults === undefined) {
        const first = await this.#read([pool], minSlot);
        const acc = first.accounts[0];
        if (acc == null) throw new Error('the pool account does not exist');
        const p = decodePool(acc.data).value;
        vaults = [p.poolBaseTokenAccount, p.poolQuoteTokenAccount];
        this.#vaults.set(pool, vaults);
      }
      const r = await this.#read(snapshotAddresses(pool, vaults[0], vaults[1], mint), minSlot);
      // A bank older than the head allows, or no newer than the last one taken, is not a fresh price, however
      // fresh its answer (audit: a lagging node answered the same bank twice, 10 minutes apart).
      if (minSlot !== null && r.slot < minSlot) throw new Error(live
        ? `the read's bank is slot ${r.slot}, ${head!.slot - r.slot} slots behind the head ${head!.slot} (at most ${lag})`
        : `the read's bank is slot ${r.slot}, ${head!.slot - r.slot} slots behind the last released head ${head!.slot} (at most ${lag}; the feed is silent)`);
      const last = this.#taken.get(pool);
      if (last !== undefined && r.slot <= last.slot) {
        if (r.slot < last.slot) throw new Error(`the read's bank is slot ${r.slot}, behind the last one taken (${last.slot})`);
        if (this.#o.timers.now() - last.atMs >= this.#o.staleMs) throw new Error(`the read's bank is still slot ${r.slot}, first read ${this.#o.timers.now() - last.atMs} ms ago`);
        return;
      }
      const s = decodeSnapshot(mint, pool, r.slot, r.accounts);
      if (!s.ok) {
        // The layout may have moved: learn it again on the next read.
        this.#vaults.delete(pool);
        throw new Error(s.reason);
      }
      if (!this.#running) return;
      const at = this.#o.timers.now();
      this.#taken.set(pool, { slot: r.slot, atMs: at });
      this.#o.put(s.snapshot, at);
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
