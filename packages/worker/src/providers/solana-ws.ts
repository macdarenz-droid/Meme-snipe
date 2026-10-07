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
import { compactLogs } from '../../../core/src/chain/index.ts';
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
   * has no log lines). A gap starts at the watch's own last log-notification slot, inclusive, and ends at the first
   * slot this stream saw live after the resubscribe, once the backfill of that same connection finished. At the drop
   * an open gap (`toSlot` null, reason `disconnect`) is reported at once; at the close it is settled by a bounded gap
   * with the same `fromSlot`, or by `coverage:<name>:resume` {fromSlot, toSlot} when backfill restored it in full.
   * `toSlot` null also means open-ended for unwatched, halted or refused watches. Readers mark those ranges
   * uncovered instead of counting fewer events.
   */
  readonly coverage?: string;
  /**
   * Subscribe at `confirmed` instead of `processed` (FACTS-1: a pool's trade stream for candles, which the gates refuse
   * at processed). The log frames then say so, and their events carry `commitment: 'confirmed'`.
   */
  readonly commitment?: 'confirmed';
  /**
   * FILL-2: fills a reconnect gap on this watch before it is closed. Called once the gap is ready to close (the watch
   * is subscribed again, its page backfill is done and a live slot was seen), with the gap's range; the gap is then
   * closed with a resume when it answers true, and as a bounded lossy gap when it answers false or throws. A new
   * drop while it runs discards its answer. Without it, the single page backfill decides, as before.
   */
  readonly fill?: (gap: { readonly address: string; readonly fromSlot: bigint | null; readonly toSlot: bigint }) => Promise<boolean>;
  /**
   * S0-ZERO: coverage that must start before the subscription, at this slot (a candidate pool's migration: its candles
   * are observed from the pool's creation). On the first subscribe the coverage starts here with an open `catch-up` gap
   * up to the first slot seen live, closed like a reconnect gap: a `resume` only when `fill` restored it in full, else a
   * bounded lossy gap. While it is open the watch's live notifications are held back and put on the feed after the
   * fill's transactions, so the pool's trades reach the feed oldest first. Ignored when not before the stream's next slot.
   */
  readonly coverFrom?: bigint;
}

/** One live logs notification held back while a catch-up gap is open (S0-ZERO). */
interface HeldNotice {
  readonly signature: string;
  readonly slot: bigint;
  readonly err: unknown;
  readonly lines: readonly string[] | null;
}

/** Notifications one watch may hold during a catch-up; past it they go on the feed at once and the gap stays lossy. */
export const CATCH_UP_HOLD_MAX = 5_000;
/**
 * HOLD-TOTAL: notifications all of a stream's watches may hold together. A swap's notification held as parsed was about
 * 10.5 KB of heap (103 log lines); with ~230 pools in their catch-up at once and fills two at a time, the per-watch cap
 * alone let the holds fill the 560 MB heap within minutes of every boot. Held notifications keep only the lines the
 * log reader uses (`compactLogs`, about 2.1 KB each), so this total is about 50 MB. The watch whose notification would
 * pass it overflows exactly as at the per-watch cap: what it holds goes on the feed at once and its catch-up stays lossy.
 */
export const CATCH_UP_HOLD_TOTAL = 24_000;
/**
 * FAILED-LOGS: failed transactions' notifications whose log lines were left off the feed, and those lines' characters,
 * over every stream in this process (counts only): the share of live traffic they were, for the memory probe.
 */
export const FAILED_LOGS = { notices: 0, chars: 0 };

interface CoverageGap {
  readonly fromSlot: bigint | null;
  readonly reason: string;
  backfilled: boolean;
  lossy: boolean;
  /** First slot seen live on this stream after the watch was subscribed again: where the gap ends. */
  liveAfter: bigint | null;
  /** FILL-2: the watch's `fill` for this connection: not asked, running, or answered. */
  fill: 'no' | 'running' | 'done';
  /** S0-ZERO: the hold overflowed during a catch-up, so the trades did not reach the feed in order: never a resume. */
  overflow?: boolean;
}

type Watch =
  | { readonly kind: 'slot'; readonly priority: Priority; handle: number }
  | {
    readonly kind: 'logs'; readonly address: string; readonly opts: WatchOptions; priority: Priority; handle: number; lastSignature: string | null;
    /** Subscribed on the current connection. */
    acked: boolean; started: boolean; startPending: boolean; gap: CoverageGap | null;
    /** Slot of the last live log notification, and of the coverage start: where a gap opened now must begin. */
    lastLogSlot: bigint | null; startSlot: bigint | null;
    /** S0-ZERO: live notifications held back while the catch-up gap is open; null when not holding. */
    held: HeldNotice[] | null;
  }
  | { readonly kind: 'account'; readonly address: string; readonly priority: Priority; handle: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const slotOf = (v: unknown): bigint | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);

export class RpcStream {
  readonly provider: 'helius' | 'alchemy';
  readonly #o: RpcStreamOptions;
  readonly #rpc: RpcSocket;
  readonly #watches = new Map<number, Watch>();
  /** POOL-1: told when a watch stops delivering without its owner asking (dropped at the halt, or refused). */
  readonly #dropped: ((id: number, reason: 'halted' | 'refused') => void)[] = [];
  /** Told when the server accepts a watch's subscription (POOL-1: a refused watch's wait starts over once served). */
  readonly #served: ((id: number) => void)[] = [];
  #nextId = 1;
  /** HOLD-TOTAL: notifications held now across every watch's catch-up. */
  #heldTotal = 0;
  #lastSlot: bigint | null = null;
  #gapFrom: bigint | null = null;
  #wasDown = false;
  #halted = false;
  #backfills = 0;
  #epoch = 0;

  constructor(o: RpcStreamOptions) {
    this.provider = o.provider;
    this.#o = o;
    this.#rpc = new RpcSocket(`${o.provider}-ws`, o.url, o.factory, o.timers, o.socket, {
      onOpen: () => {
        this.#epoch++;
        this.#meter(o.creditsPerConnection);
        // A reconnect reports up once its backfill is done; the first open is up at once (nothing was missed yet).
        if (this.#wasDown) void this.#backfill();
        else this.#status('up', { fromSlot: null, first: true });
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

  /** A stop (shutdown or a drill) is a disconnect: the logs watches open a gap and the next start backfills it. */
  stop(): void {
    const open = this.#rpc.socket.state === 'open';
    this.#rpc.stop();
    if (open) this.#down('stopped', true);
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
    const w: Watch = { kind: 'logs', address, opts, priority: opts.priority, handle: 0, lastSignature: null, acked: false, started: false, startPending: false, gap: null, lastLogSlot: null, startSlot: null, held: null };
    return this.#add(w, {
      method: 'logsSubscribe', params: [{ mentions: [address] }, { commitment: opts.commitment ?? 'processed' }], unsubscribe: 'logsUnsubscribe', notification: 'logsNotification',
      onNotify: (r) => {
        if (!isObj(r) || !isObj(r.context) || !isObj(r.value)) return;
        const slot = slotOf(r.context.slot);
        const signature = r.value.signature;
        if (slot === null || !isSignature(signature)) return;
        this.#saw(slot);
        w.lastSignature = signature;
        if (w.lastLogSlot === null || slot > w.lastLogSlot) w.lastLogSlot = slot;
        const err = r.value.err ?? null;
        const lines = r.value.logs;
        const ok = Array.isArray(lines) && lines.every((l) => typeof l === 'string');
        if (err !== null && ok && opts.decodeLogs === true) {
          FAILED_LOGS.notices++;
          for (const l of lines as string[]) FAILED_LOGS.chars += l.length;
        }
        if (w.held !== null) {
          // HOLD-COMPACT: a held notification keeps only the lines the log reader uses, each at its own index. FAILED-LOGS:
          // a failed transaction keeps none (it yields no events).
          w.held.push({ signature, slot, err, lines: ok && err === null ? compactLogs(lines as string[]) : null });
          this.#heldTotal++;
          if (w.held.length > CATCH_UP_HOLD_MAX || this.#heldTotal > CATCH_UP_HOLD_TOTAL) {
            if (w.gap !== null) w.gap.overflow = true;
            this.#release(w);
          }
          return;
        }
        this.#deliver(w, { signature, slot, err, lines: ok ? lines as string[] : null }, false);
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

  /**
   * POOL-1: `fn` hears of every watch that stops delivering without its owner asking: one the 70% halt dropped (it is
   * gone from this stream) or one the server refused (it stays until the next reconnect re-subscribes it, so an owner
   * that wants it sooner unwatches and watches again).
   */
  onDropped(fn: (id: number, reason: 'halted' | 'refused') => void): void {
    this.#dropped.push(fn);
  }

  /** `fn` hears of every watch whose subscription the server accepted (on each connection). */
  onServed(fn: (id: number) => void): void {
    this.#served.push(fn);
  }

  /**
   * Moves a logs watch to another priority in place: the subscription and its coverage go on, with no gap (POS-1: a
   * pool that becomes held keeps its trade stream). Returns false for an unknown or non-logs watch. Raising a watch is
   * always allowed; a watch lowered above P1 while halted is dropped, as at the halt (and reported to `onDropped`).
   */
  setPriority(id: number, priority: Priority): boolean {
    const w = this.#watches.get(id);
    if (w === undefined || w.kind !== 'logs') return false;
    w.priority = priority;
    if (this.#halted && priority > P1) {
      this.unwatch(id, 'halted');
      for (const fn of this.#dropped) fn(id, 'halted');
    }
    return true;
  }

  unwatch(id: number, reason = 'unwatched'): void {
    const w = this.#watches.get(id);
    if (w === undefined) return;
    this.#watches.delete(id);
    this.#rpc.remove(w.handle);
    if (w.kind === 'logs') this.#release(w);
    if (w.kind === 'logs' && w.started) this.#coverageGap(w, this.#openFrom(w), null, reason);
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
          this.#coverageGap(w, this.#openFrom(w), null, 'refused');
          w.gap = null;
        }
        for (const fn of this.#dropped) fn(id, 'refused');
      },
      onSubscribed: () => {
        for (const fn of this.#served) fn(id);
        if (w.kind !== 'logs') return;
        w.acked = true;
        if (!w.started && w.opts.coverage !== undefined) {
          w.started = true;
          const from = this.#nextSlot();
          const cover = w.opts.coverFrom;
          if (cover !== undefined && (from === null || cover < from)) this.#catchUp(w, cover);
          // No slot seen yet: coverage starts at the first slot that arrives.
          else if (from === null) w.startPending = true;
          else this.#start(w, from);
        }
        this.#closeCoverage(w);
      },
    });
    this.#watches.set(id, w);
    return id;
  }

  /** One logs notification onto the feed; `lookup` places it after everything ingested so far (a held one, S0-ZERO). */
  #deliver(w: Extract<Watch, { kind: 'logs' }>, n: HeldNotice, lookup: boolean): void {
    const { address, opts } = w;
    this.#seen(address, n.signature, n.slot, n.err, opts, false, lookup);
    // FAILED-LOGS: a failed transaction's log lines yield no events (its effects were rolled back: `logEvents`), so only
    // its sighting goes on the feed, never its lines (most of a busy pool's logs traffic is bots' failed swaps).
    if (opts.decodeLogs === true && n.lines !== null && n.err === null) {
      this.#o.feed.ingest(this.provider, { type: 'logs', signature: n.signature, slot: n.slot, err: n.err, via: `logs:${address}`, logs: [...n.lines], ...(opts.commitment === undefined ? {} : { commitment: opts.commitment }) }, { receivedAt: this.#o.timers.now(), ...(lookup ? { lookup: true, after: true } : {}) });
    }
  }

  /** HOLD-TOTAL: notifications held now across every watch's catch-up (at most `CATCH_UP_HOLD_TOTAL`). */
  get heldNotices(): number {
    return this.#heldTotal;
  }

  /** Ends a catch-up hold: the held notifications go on the feed in arrival order, after everything ingested before. */
  #release(w: Extract<Watch, { kind: 'logs' }>): void {
    const held = w.held;
    if (held === null) return;
    w.held = null;
    this.#heldTotal -= held.length;
    for (const n of held) this.#deliver(w, n, true);
  }

  #seen(address: string, signature: string, slot: bigint, err: unknown, opts: WatchOptions, backfilled: boolean, lookup = false): void {
    const f = this.#o.feed.ingest(this.provider, { type: 'seen', signature, slot, err, via: `logs:${address}`, detail: null }, { receivedAt: this.#o.timers.now(), backfilled, ...(lookup ? { lookup: true, after: true } : {}) });
    if (opts.fetch !== undefined && err === null && !f.duplicate && this.#o.fetcher) {
      // FACTS-REREAD: a fetch no provider answered (null after the fetcher's retries) fails as an error does.
      this.#o.fetcher.fetch(signature, opts.fetch, backfilled).then((f) => (f === null ? this.#status('fetch_failed', { signature }) : undefined), () => this.#status('fetch_failed', { signature }));
    }
  }

  #saw(slot: bigint): void {
    if (this.#lastSlot === null || slot > this.#lastSlot) this.#lastSlot = slot;
    for (const w of this.#watches.values()) {
      if (w.kind !== 'logs') continue;
      if (w.startPending) {
        w.startPending = false;
        this.#start(w, slot);
      }
      // Live traffic after the resubscribe: the gap ends here, at a slot this stream has seen itself.
      if (w.gap && w.acked && w.gap.liveAfter === null) {
        w.gap.liveAfter = slot;
        this.#closeCoverage(w);
      }
    }
  }

  /**
   * S0-ZERO: coverage from `cover`, before the subscription, as an open catch-up gap up to the first slot seen live. It
   * starts lossy: only a complete fill makes it a resume (#closeCoverage). The page backfill has nothing to add (the
   * gap is not a lost connection), so it counts as done.
   */
  #catchUp(w: Extract<Watch, { kind: 'logs' }>, cover: bigint): void {
    this.#start(w, cover);
    w.gap = { fromSlot: cover, reason: 'catch-up', backfilled: true, lossy: true, liveAfter: null, fill: 'no' };
    if (w.held !== null) this.#heldTotal -= w.held.length;
    w.held = [];
    this.#fact(`coverage:${w.opts.coverage}:gap`, { fromSlot: cover, toSlot: null, reason: 'catch-up', via: `logs:${w.address}` });
  }

  #start(w: Extract<Watch, { kind: 'logs' }>, from: bigint): void {
    w.startSlot = from;
    this.#fact(`coverage:${w.opts.coverage}:start`, { fromSlot: from, via: `logs:${w.address}` });
  }

  /** Where a gap opened now begins: the watch's own last log slot, inclusive (notifications for it may still have been in flight). */
  #openFrom(w: Extract<Watch, { kind: 'logs' }>): bigint | null {
    return w.gap?.fromSlot ?? w.lastLogSlot ?? w.startSlot ?? this.#nextSlot();
  }

  #meter(credits: number): void {
    if (credits > 0) this.#o.scheduler.meter(credits);
    this.#checkBudget();
  }

  /** At the halt share, watches above P1 are dropped. An open position's P0–P1 watches stay: exits are never starved. */
  #checkBudget(): void {
    if (this.#halted && !this.#o.scheduler.halted) {
      // A new month (resetBudget): watches may be added again.
      this.#halted = false;
      this.#status('resumed', { share: this.#o.scheduler.status().budgetShare });
      return;
    }
    if (this.#halted || !this.#o.scheduler.halted) return;
    this.#halted = true;
    for (const [id, w] of this.#watches) {
      if (w.priority <= P1) continue;
      this.unwatch(id, 'halted');
      for (const fn of this.#dropped) fn(id, 'halted');
    }
    this.#status('halted', { share: this.#o.scheduler.status().budgetShare });
  }

  #down(reason: string, wasOpen: boolean): void {
    if (!wasOpen) return; // never opened: nothing was streaming, so nothing was missed since the last gap
    this.#epoch++; // a backfill still running belongs to the connection just lost
    this.#wasDown = true;
    this.#gapFrom = this.#lastSlot === null ? null : this.#lastSlot + 1n;
    if (this.#gapFrom !== null) this.#o.feed.openGap(this.gapId, this.#gapFrom, this.#o.timers.now());
    for (const w of this.#watches.values()) {
      if (w.kind !== 'logs') continue;
      w.acked = false;
      // A gap still open from an earlier drop keeps its start.
      if (!w.started) continue;
      if (w.gap) {
        w.gap.backfilled = false;
        w.gap.fill = 'no'; // a fill running for the lost connection is discarded (see #closeCoverage)
        w.gap.liveAfter = null;
      } else {
        w.gap = { fromSlot: this.#openFrom(w), reason: 'disconnect', backfilled: false, lossy: w.opts.decodeLogs === true, liveAfter: null, fill: 'no' };
        // Visible at once: decisions made during the outage must see the range as uncovered (the engine cannot wait for the end).
        this.#fact(`coverage:${w.opts.coverage}:gap`, { fromSlot: w.gap.fromSlot, toSlot: null, reason: 'disconnect', via: `logs:${w.address}` });
      }
    }
    this.#status('down', { reason, lastSlot: this.#lastSlot });
  }

  async #backfill(): Promise<void> {
    this.#wasDown = false;
    this.#backfills++;
    const from = this.#gapFrom;
    const epoch = this.#epoch;
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
          this.#backfilled(w, epoch);
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
          this.#backfilled(w, epoch);
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

  /**
   * A backfill finished. Only one started on the current connection counts: every drop and every open moves the
   * epoch, so a backfill from a lost connection can never close a newer gap.
   */
  #backfilled(w: Extract<Watch, { kind: 'logs' }>, epoch: number): void {
    if (w.gap === null || epoch !== this.#epoch) return;
    w.gap.backfilled = true;
    this.#closeCoverage(w);
  }

  /**
   * Ends a reconnect gap once the watch is subscribed again, its backfill is done, and this stream has seen a slot
   * live since the resubscribe; reports it if anything may be missing. Until then the gap stays open.
   */
  #closeCoverage(w: Extract<Watch, { kind: 'logs' }>): void {
    const g = w.gap;
    if (g === null || !w.acked || !g.backfilled || g.liveAfter === null) return;
    const fill = w.opts.fill;
    if (fill !== undefined && g.fill !== 'done') {
      if (g.fill === 'running') return;
      g.fill = 'running';
      const epoch = this.#epoch;
      const toSlot = g.fromSlot !== null && g.liveAfter < g.fromSlot ? g.fromSlot : g.liveAfter;
      void fill({ address: w.address, fromSlot: g.fromSlot, toSlot }).catch(() => false).then((complete) => {
        // A drop while the fill ran started a new connection: this answer is for the old one.
        if (epoch !== this.#epoch || w.gap !== g || g.fill !== 'running') return;
        g.lossy = !complete || g.overflow === true;
        g.fill = 'done';
        this.#closeCoverage(w);
      });
      return;
    }
    w.gap = null;
    // The fill's transactions are on the feed: the held live notifications follow them (S0-ZERO).
    this.#release(w);
    // Never an empty or inverted range: the end is at least the start.
    const to = g.fromSlot !== null && g.liveAfter < g.fromSlot ? g.fromSlot : g.liveAfter;
    // The open gap reported at the drop is now settled: bounded if anything may be missing, otherwise restored in full.
    if (g.lossy) this.#coverageGap(w, g.fromSlot, to, g.reason);
    else this.#fact(`coverage:${w.opts.coverage}:resume`, { fromSlot: g.fromSlot, toSlot: to, via: `logs:${w.address}` });
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
