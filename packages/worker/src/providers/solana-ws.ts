// Standard Solana pubsub on one provider (Helius or Alchemy): `slotSubscribe`, `logsSubscribe` and
// `accountSubscribe` at `processed` (data.md §8.1B–C). Every notification becomes a frame on the live Feed.
// A log notification is a sighting of its signature. A watch may ask for the transaction to be fetched and decoded
// by DEC-1's `transactionEvents`, or (the creates stream) for its log lines to be read by DEC-1's `logEvents`;
// nothing here decodes bytes itself.
//
// Reconnect with backfill: when the stream drops, the feed holds its release point below the first slot we may
// have missed; on reopen, each log watch reads the signatures it missed and each account watch reads its current
// state, all marked backfilled; then the hold ends. Two providers carry the position, so a copy from the other
// provider usually got there first and the backfilled duplicate is dropped.
import { P0, P1, type Priority, ScheduleRefused, type Scheduler } from '../scheduler/scheduler.ts';
import type { Timers } from '../scheduler/timers.ts';
import { isAddress, isSignature } from './canonical.ts';
import type { SocketFactory } from './http.ts';
import type { LiveFeed } from './live-feed.ts';
import { RpcSocket } from './rpc-socket.ts';
import { accountValue, type RpcHttp } from './solana-http.ts';
import type { SocketOptions } from './socket.ts';
import type { TxFetcher } from './tx-fetcher.ts';

export interface RpcStreamOptions {
  readonly provider: 'helius' | 'alchemy';
  readonly url: () => string;
  readonly factory: SocketFactory;
  readonly timers: Timers;
  readonly feed: LiveFeed;
  /** Meters stream bytes and connections against the provider's budget. */
  readonly scheduler: Scheduler;
  /** Credits per byte received and per connection opened. */
  readonly creditsPerByte: number;
  readonly creditsPerConnection: number;
  /** Backfill reads (same provider is fine; the other one is a second failure domain). */
  readonly http: RpcHttp;
  readonly fetcher?: TxFetcher;
  readonly socket: SocketOptions;
  /** Most signatures read per log watch after a gap. */
  readonly backfillLimit: number;
}

export interface WatchOptions {
  readonly priority: Priority;
  /** Fetch and decode each transaction seen, at this priority. Off by default: creates alone run ~50k a day. */
  readonly fetch?: Priority;
  /**
   * Keep the log lines and read events from them with DEC-1's `logEvents` (zero RPC credits). For the creates
   * stream, so the deployer index gets creator, mint and slot for every create. Backfilled sightings carry no logs.
   */
  readonly decodeLogs?: boolean;
  /**
   * Names a stream whose completeness matters (e.g. `creates` for the H14 deployer index). Its feed then carries
   * `coverage:<name>:start` when first subscribed and `coverage:<name>:gap` {fromSlot, toSlot, reason} for every
   * slot range it may have missed and backfill could not restore in full (with `decodeLogs`, any reconnect: backfill
   * has no log lines). `toSlot` null means open-ended (unwatched, halted or refused). Readers mark those ranges
   * uncovered instead of counting fewer events.
   */
  readonly coverage?: string;
}

interface CoverageGap {
  readonly fromSlot: bigint | null;
  readonly reason: string;
  backfilled: boolean;
  lossy: boolean;
}

type Watch =
  | { readonly kind: 'slot'; readonly priority: Priority; handle: number }
  | {
    readonly kind: 'logs'; readonly address: string; readonly opts: WatchOptions; readonly priority: Priority; handle: number; lastSignature: string | null;
    /** Subscribed on the current connection. */
    acked: boolean; started: boolean; startPending: boolean; gap: CoverageGap | null;
  }
  | { readonly kind: 'account'; readonly address: string; readonly priority: Priority; handle: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const slotOf = (v: unknown): bigint | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);

export class RpcStream {
  readonly provider: 'helius' | 'alchemy';
  readonly #o: RpcStreamOptions;
  readonly #rpc: RpcSocket;
  readonly #watches = new Map<number, Watch>();
  #nextId = 1;
  #lastSlot: bigint | null = null;
  #gapFrom: bigint | null = null;
  #wasDown = false;
  #halted = false;
  #backfills = 0;

  constructor(o: RpcStreamOptions) {
    this.provider = o.provider;
    this.#o = o;
    this.#rpc = new RpcSocket(`${o.provider}-ws`, o.url, o.factory, o.timers, o.socket, {
      onOpen: () => {
        this.#meter(o.creditsPerConnection);
        if (this.#wasDown) void this.#backfill();
      },
      onDown: (reason, wasOpen) => this.#down(reason, wasOpen),
      onBytes: (n) => this.#meter(n * o.creditsPerByte),
    });
  }

  get gapId(): string {
    return `${this.provider}-ws`;
  }

  /** Backfills run so far (for drills). */
  get backfills(): number {
    return this.#backfills;
  }

  start(): void {
    this.#rpc.start();
  }

  stop(): void {
    this.#rpc.stop();
  }

  /** The socket, for drills (TEST-3 drops it to prove the reconnect and backfill path). */
  get socket(): RpcSocket {
    return this.#rpc;
  }

  watchSlots(priority: Priority = P1): number {
    return this.#add({ kind: 'slot', priority, handle: 0 }, {
      method: 'slotSubscribe', params: [], unsubscribe: 'slotUnsubscribe', notification: 'slotNotification',
      onNotify: (r) => {
        if (!isObj(r)) return;
        const slot = slotOf(r.slot);
        if (slot === null) return;
        this.#saw(slot);
        this.#o.feed.ingest(this.provider, { type: 'slot', slot, parent: slotOf(r.parent), root: slotOf(r.root) }, { receivedAt: this.#o.timers.now() });
      },
    });
  }

  watchLogs(address: string, opts: WatchOptions): number {
    if (!isAddress(address)) throw new RangeError('logs watch needs a base58 address');
    const w: Watch = { kind: 'logs', address, opts, priority: opts.priority, handle: 0, lastSignature: null, acked: false, started: false, startPending: false, gap: null };
    return this.#add(w, {
      method: 'logsSubscribe', params: [{ mentions: [address] }, { commitment: 'processed' }], unsubscribe: 'logsUnsubscribe', notification: 'logsNotification',
      onNotify: (r) => {
        if (!isObj(r) || !isObj(r.context) || !isObj(r.value)) return;
        const slot = slotOf(r.context.slot);
        const signature = r.value.signature;
        if (slot === null || !isSignature(signature)) return;
        this.#saw(slot);
        w.lastSignature = signature;
        const err = r.value.err ?? null;
        this.#seen(address, signature, slot, err, opts, false);
        const lines = r.value.logs;
        if (opts.decodeLogs === true && Array.isArray(lines) && lines.every((l) => typeof l === 'string')) {
          this.#o.feed.ingest(this.provider, { type: 'logs', signature, slot, err, via: `logs:${address}`, logs: lines as string[] }, { receivedAt: this.#o.timers.now() });
        }
      },
    });
  }

  watchAccount(address: string, priority: Priority): number {
    if (!isAddress(address)) throw new RangeError('account watch needs a base58 address');
    return this.#add({ kind: 'account', address, priority, handle: 0 }, {
      method: 'accountSubscribe', params: [address, { encoding: 'base64', commitment: 'processed' }], unsubscribe: 'accountUnsubscribe', notification: 'accountNotification',
      onNotify: (r) => {
        if (!isObj(r) || !isObj(r.context)) return;
        const slot = slotOf(r.context.slot);
        if (slot === null) return;
        let v: ReturnType<typeof accountValue>;
        try {
          v = accountValue(this.provider, r.value);
        } catch {
          return;
        }
        this.#saw(slot);
        this.#o.feed.ingest(this.provider, { type: 'account', slot, address, ...v }, { receivedAt: this.#o.timers.now() });
      },
    });
  }

  unwatch(id: number, reason = 'unwatched'): void {
    const w = this.#watches.get(id);
    if (w === undefined) return;
    this.#watches.delete(id);
    this.#rpc.remove(w.handle);
    if (w.kind === 'logs' && w.started) this.#coverageGap(w, w.gap?.fromSlot ?? this.#nextSlot(), null, reason);
  }

  #add(w: Watch, spec: Parameters<RpcSocket['add']>[0]): number {
    this.#checkBudget();
    if (this.#halted && w.priority !== P0) throw new ScheduleRefused(this.provider, w.priority, 'halted');
    const id = this.#nextId++;
    w.handle = this.#rpc.add({
      ...spec,
      onRefused: (code) => {
        this.#status('refused', { watch: id, code });
        if (w.kind === 'logs') {
          this.#coverageGap(w, w.gap?.fromSlot ?? this.#nextSlot(), null, 'refused');
          w.gap = null;
        }
      },
      onSubscribed: () => {
        if (w.kind !== 'logs') return;
        w.acked = true;
        if (!w.started && w.opts.coverage !== undefined) {
          w.started = true;
          const from = this.#nextSlot();
          // No slot seen yet: coverage starts at the first slot that arrives.
          if (from === null) w.startPending = true;
          else this.#fact(`coverage:${w.opts.coverage}:start`, { fromSlot: from, via: `logs:${w.address}` });
        }
        this.#closeCoverage(w);
      },
    });
    this.#watches.set(id, w);
    return id;
  }

  #seen(address: string, signature: string, slot: bigint, err: unknown, opts: WatchOptions, backfilled: boolean): void {
    const f = this.#o.feed.ingest(this.provider, { type: 'seen', signature, slot, err, via: `logs:${address}`, detail: null }, { receivedAt: this.#o.timers.now(), backfilled });
    if (opts.fetch !== undefined && err === null && !f.duplicate && this.#o.fetcher) {
      this.#o.fetcher.fetch(signature, opts.fetch, backfilled).catch(() => this.#status('fetch_failed', { signature }));
    }
  }

  #saw(slot: bigint): void {
    if (this.#lastSlot === null || slot > this.#lastSlot) this.#lastSlot = slot;
    for (const w of this.#watches.values()) {
      if (w.kind !== 'logs' || !w.startPending) continue;
      w.startPending = false;
      this.#fact(`coverage:${w.opts.coverage}:start`, { fromSlot: slot, via: `logs:${w.address}` });
    }
  }

  #meter(credits: number): void {
    if (credits > 0) this.#o.scheduler.meter(credits);
    this.#checkBudget();
  }

  /** At the halt share, watches above P1 are dropped. An open position's P0–P1 watches stay: exits are never starved. */
  #checkBudget(): void {
    if (this.#halted || !this.#o.scheduler.halted) return;
    this.#halted = true;
    for (const [id, w] of this.#watches) if (w.priority > P1) this.unwatch(id, 'halted');
    this.#status('halted', { share: this.#o.scheduler.status().budgetShare });
  }

  #down(reason: string, wasOpen: boolean): void {
    if (!wasOpen) return; // never opened: nothing was streaming, so nothing was missed since the last gap
    this.#wasDown = true;
    this.#gapFrom = this.#lastSlot === null ? null : this.#lastSlot + 1n;
    if (this.#gapFrom !== null) this.#o.feed.openGap(this.gapId, this.#gapFrom, this.#o.timers.now());
    for (const w of this.#watches.values()) {
      if (w.kind !== 'logs') continue;
      w.acked = false;
      // A gap still open from an earlier drop keeps its start.
      if (!w.started) continue;
      if (w.gap) w.gap.backfilled = false;
      else w.gap = { fromSlot: this.#gapFrom, reason: 'disconnect', backfilled: false, lossy: w.opts.decodeLogs === true };
    }
    this.#status('down', { reason, lastSlot: this.#lastSlot });
  }

  async #backfill(): Promise<void> {
    this.#wasDown = false;
    this.#backfills++;
    const from = this.#gapFrom;
    const o = this.#o;
    let filled = 0;
    let failed = 0;
    const jobs = [...this.#watches.values()].map(async (w) => {
      // A P0–P1 watch serves the open position, so its refill is exit traffic: P0, which the 70% halt never refuses.
      const priority = w.priority <= P1 ? P0 : w.priority;
      try {
        if (w.kind === 'logs') {
          const opts: { until?: string; limit: number } = { limit: o.backfillLimit };
          const before = w.lastSignature;
          if (before !== null) opts.until = before;
          const sigs = await o.http.getSignaturesForAddress(w.address, opts, priority);
          // A full page may have cut older missed signatures off.
          if (w.gap && sigs.length >= o.backfillLimit) w.gap.lossy = true;
          // Newest first from the node; ingest oldest first, as they happened.
          for (const s of sigs.reverse()) {
            if (before === null && from !== null && s.slot < from) continue;
            this.#seen(w.address, s.signature, s.slot, s.err, w.opts, true);
            filled++;
          }
          const newest = sigs.at(-1);
          // The live stream may have moved on while we read: never set the mark back to an older signature.
          if (newest && w.lastSignature === before) w.lastSignature = newest.signature;
          if (w.gap) w.gap.backfilled = true;
          this.#closeCoverage(w);
        } else if (w.kind === 'account') {
          const info = await o.http.getAccountInfo(w.address, priority);
          if (info.value !== null) {
            o.feed.ingest(this.provider, { type: 'account', slot: info.slot, address: w.address, ...info.value }, { receivedAt: o.timers.now(), backfilled: true });
            filled++;
          }
        }
      } catch {
        failed++;
        if (w.kind === 'logs' && w.gap) {
          w.gap.lossy = true;
          w.gap.backfilled = true;
          this.#closeCoverage(w);
        }
      }
    });
    await Promise.all(jobs);
    o.feed.closeGap(this.gapId);
    this.#status('up', { fromSlot: from, filled, failed });
  }

  /** The first slot not yet seen on this stream: where a coverage gap opened now would start. */
  #nextSlot(): bigint | null {
    const tip = this.#o.feed.tip;
    const last = this.#lastSlot === null ? null : this.#lastSlot + 1n;
    return tip === null ? last : last === null || tip > last ? tip : last;
  }

  /** Ends a reconnect gap once the watch is subscribed again and its backfill is done; reports it if anything may be missing. */
  #closeCoverage(w: Extract<Watch, { kind: 'logs' }>): void {
    const g = w.gap;
    if (g === null || !w.acked || !g.backfilled) return;
    w.gap = null;
    // Live notifications flow from the subscription ack, so the tip now bounds what was missed.
    if (g.lossy) this.#coverageGap(w, g.fromSlot, this.#o.feed.tip ?? this.#lastSlot, g.reason);
  }

  #coverageGap(w: Extract<Watch, { kind: 'logs' }>, fromSlot: bigint | null, toSlot: bigint | null, reason: string): void {
    if (w.opts.coverage === undefined) return;
    if (toSlot === null) w.started = false; // open-ended: a new start fact marks where coverage resumes
    this.#fact(`coverage:${w.opts.coverage}:gap`, { fromSlot, toSlot, reason, via: `logs:${w.address}` });
  }

  #fact(key: string, value: Record<string, unknown>): void {
    this.#o.feed.ingest('worker', { type: 'offchain', key, value }, { receivedAt: this.#o.timers.now() });
  }

  #status(state: string, detail: Record<string, unknown>): void {
    this.#o.feed.ingest('worker', { type: 'offchain', key: `feed:status:${this.provider}`, value: { state, ...detail } }, { receivedAt: this.#o.timers.now() });
  }
}
