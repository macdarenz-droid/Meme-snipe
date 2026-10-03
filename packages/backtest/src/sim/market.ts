// Turns dataset rows into the engine's market events at the moment they are released, with our own trades already
// in the pool state (docs/ARCHITECTURE.md §16.2). Only the replay driver holds this object; the engine sees events.
//
// Keys the engine can look up:
// Every on-chain observation (pool, life, regime) reaches the engine after the observation delay: it is built when its
// row is read (so a pool state is the one right after that swap), and released at the end of the first block at or
// after its own slot plus the delay slots, at that block's real time plus the provider-to-worker time, stamped with the
// block height known then. During a feed blackout nothing is released; the backlog follows in chain order when it ends.
// Each observation carries its chain moment (`observed`), so its age never resets on arrival. With recorded receipt
// times (`observe: null`) observations are released at their own moment, never delayed twice.
//
//   pool:<pool>   the PumpSwap pool after each real swap, as our trades left it (PoolView)
//   life:<mint>   a lifecycle event of the mint (create, migration, pool creation, liquidity, boost, ...)
//   disc:<mint>   the bot learns of a graduation, after the modelled discovery lag (Discovery)
//   slot          a block: height and time (every block while trading is active, otherwise a heartbeat)
//   sol-usd       the SOL/USD close once it is usable (offchain.ts)
import { poolAddress, pumpPoolAuthority, toAddress } from '../../../core/src/chain/index.ts';
import type { FeedEvent, MarketEvent, Moment } from '../../../core/src/engine/index.ts';
import { compareMoments, createRng, OFF_CHAIN } from '../../../core/src/engine/index.ts';
import { type ObservedFees, ShiftedPool } from '../../../core/src/fills/index.ts';
import type { SeriesBar } from '../dataset/offchain.ts';
import type { AmmSwapRow, BlockRow, DatasetRow, EventRow } from '../dataset/rows.ts';
import type { Hook } from './replay.ts';

/** A block's row sorts after the slot's transactions; our landing after it; world reports last. */
export const BLOCK_TX = OFF_CHAIN - 2;
export const LANDING_TX = OFF_CHAIN - 1;

export const NATIVE_MINTS = new Set(['So11111111111111111111111111111111111111112', '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP']);

export interface PoolView {
  readonly pool: string;
  readonly mint: string;
  readonly quoteMint: string;
  readonly baseReserve: bigint;
  readonly quoteVault: bigint;
  readonly virtualQuoteReserves: bigint;
  readonly fees: ObservedFees;
  readonly baseSupply: bigint;
  /** The real swap that produced this state: its side, and what that trader paid in (buy) or received (sell), fees
   * included, from the exact replay. Not the event's `user_quote_amount`, whose meaning differs by instruction. */
  readonly side: 'buy' | 'sell';
  readonly userQuote: bigint;
  readonly baseAmount: bigint;
  /** Height of the latest block when this state was released (a transaction signed now takes that block's hash). */
  readonly blockHeight: bigint;
  /** The swap's own chain moment: its slot and block time (ms). The state's age is measured from here. */
  readonly observed: { readonly slot: bigint; readonly at: number };
}

export interface Discovery {
  readonly mint: string;
  readonly pool: string;
  readonly quoteMint: string;
  /** Block time of the migration, ms. */
  readonly graduatedAt: number;
  /** null: the pool's creation event was not seen, so canonical cannot be proven. */
  readonly canonical: boolean | null;
  /** null: no event stated it. */
  readonly mayhem: boolean | null;
  /** Height of the latest block when the discovery arrived. */
  readonly blockHeight: bigint;
}

export interface PoolTrack {
  readonly shifted: ShiftedPool;
  fees: ObservedFees | null;
  baseSupply: bigint;
  mint: string;
  quoteMint: string;
}

interface PoolInfo {
  readonly mint: string;
  readonly quoteMint: string;
  readonly canonical: boolean;
  readonly mayhem: boolean | null;
}

export const rowMoment = (row: DatasetRow): Moment =>
  row.kind === 'block'
    ? { slot: row.slot, txIndex: BLOCK_TX, ixIndex: 0, receivedAt: row.blockTime * 1000 }
    : { slot: row.slot, txIndex: row.txIdx, ixIndex: row.evIdx, receivedAt: row.blockTime * 1000 };

const flagOf = (s: string | undefined): boolean | null => (s === 'true' || s === '1' ? true : s === 'false' || s === '0' ? false : null);

export const canonicalOf = (f: Readonly<Record<string, string>>): boolean => {
  try {
    if (f['index'] !== '0' || !f['creator'] || !f['base_mint'] || !f['quote_mint'] || !f['pool']) return false;
    const mint = toAddress(f['base_mint']);
    if (f['creator'] !== pumpPoolAuthority(mint)) return false;
    return poolAddress(0, toAddress(f['creator']), mint, toAddress(f['quote_mint'])) === f['pool'];
  } catch {
    return false;
  }
};

export interface MarketOptions {
  /** Blocks between heartbeat slot events while nothing is in flight. */
  readonly heartbeatBlocks: number;
  /** Draws the discovery lag (slots, >= 1) for a newly graduated mint. */
  readonly discoveryLag: (mint: string) => number;
  /** An intent in flight: slot events and ticks every block while true (a held position needs only the heartbeat). */
  readonly active: () => boolean;
  /**
   * The observation delay: total slots (event → processed, plus processed → confirmed when the decision path waits for
   * it), provider-to-worker ms, and blackout durations per UTC day placed from `seed`. Null: the rows carry recorded
   * receipt times, so nothing is added.
   */
  readonly observe: { readonly slots: number; readonly providerMs: number; readonly blackouts: readonly { readonly durationMs: number; readonly atMsOfDay?: number }[]; readonly seed: string } | null;
  /** Slots per window of the market-volume tally (the fill model's congestion window). */
  readonly volumeWindowSlots: number;
  /** Puts driver work into the replay (the observation release). */
  readonly hook: (h: Hook) => void;
  /** True while dataset rows remain. */
  readonly hasRows: () => boolean;
  /** Puts a derived event (a discovery, a delayed observation) into the replay. */
  readonly schedule: (e: FeedEvent) => void;
  /** Slots where the chain's programs changed (DATA-1 manifest): a `regime` event at the first block at or after each. */
  readonly regimeBoundaries?: readonly { readonly slot: bigint; readonly label: string }[];
  /** Off-chain series, each released at the first block at or after a value's usable moment. */
  readonly series?: readonly { readonly key: string; readonly releases: readonly { readonly at: number; readonly bar: SeriesBar }[] }[];
}

export class Market {
  readonly pools = new Map<string, PoolTrack>();
  readonly #poolInfo = new Map<string, PoolInfo>();
  readonly #opts: MarketOptions;
  readonly #seriesAt: number[];
  readonly #discovered = new Set<string>();
  #regimeAt = 0;
  /** The regime boundary the data is past, or null before the first. */
  regime: string | null = null;
  /** Each boundary passed, with the block time (ms) of the first block at or after it. */
  readonly regimesPassed: { readonly slot: bigint; readonly label: string; readonly at: number }[] = [];
  /** Symbols from CreateEvents, for the report only. */
  readonly symbols = new Map<string, string>();
  /** Blocks seen so far: the backtest's block height. */
  blockHeight = 0n;
  blockTime = 0;
  slot = 0n;
  /** Real swaps that could not be replayed on our shifted pool (they would have failed there). */
  skippedSwaps = 0;
  /** Real swaps the exact math could not reproduce even on their own state (pool marked unknown until the next). */
  unquotableSwaps = 0;

  constructor(opts: MarketOptions) {
    if (!Number.isSafeInteger(opts.heartbeatBlocks) || opts.heartbeatBlocks < 1) throw new RangeError('heartbeatBlocks must be >= 1');
    const o = opts.observe;
    if (o !== null && (!Number.isSafeInteger(o.slots) || o.slots < 1)) throw new RangeError('observation delay must be at least one slot');
    if (o !== null && (!Number.isSafeInteger(o.providerMs) || o.providerMs < 0)) throw new RangeError('providerMs must be >= 0');
    this.#opts = opts;
    this.#seriesAt = (opts.series ?? []).map(() => 0);
  }

  /**
   * All pools' real quote volume (lamports) per window, every window kept: the network state steps through each window
   * from the one before's volume, so no window may read as zero once passed (one entry per active window, small).
   */
  readonly #volume = new Map<bigint, bigint>();

  /** Market volume in window `win - 1` (complete when asked during `win`), lamports. */
  volumeBefore(win: bigint): bigint {
    return this.#volume.get(win - 1n) ?? 0n;
  }

  #tally(slot: bigint, lamports: bigint): void {
    const win = slot / BigInt(this.#opts.volumeWindowSlots);
    this.#volume.set(win, (this.#volume.get(win) ?? 0n) + lamports);
  }

  track(pool: string): PoolTrack | undefined {
    return this.pools.get(pool);
  }

  /** Observations waiting for their release block, in chain order (their due slots never decrease). */
  #queue: { readonly due: bigint; readonly e: MarketEvent }[] = [];
  #queueAt = 0;
  #armed = false;
  #seq = 0;
  #hooks = 0;
  /** Observations released at the row's own moment (recorded receipt times). */
  #now: FeedEvent[] = [];
  /** Feed blackouts placed so far, ms [from, to). */
  readonly blackouts: { readonly from: number; readonly to: number }[] = [];
  #blackoutDays = new Set<string>();

  #observe(e: MarketEvent): void {
    const observed = { slot: e.moment.slot, at: e.moment.receivedAt };
    const ev: MarketEvent = { ...e, value: { ...(e.value as Readonly<Record<string, unknown>>), observed } };
    const o = this.#opts.observe;
    if (o === null) {
      this.#now.push(ev);
      return;
    }
    this.#enqueue(e.moment.slot + BigInt(o.slots), ev);
  }

  /** Queues an observation for its due slot, keeping the queue ordered by due slot (stable). */
  #enqueue(due: bigint, e: MarketEvent): void {
    let k = this.#queue.length;
    while (k > this.#queueAt && this.#queue[k - 1]!.due > due) k--;
    this.#queue.splice(k, 0, { due, e });
    if (!this.#armed) this.#arm(this.#queue[this.#queueAt]!.due, e.moment.receivedAt);
    else if (due < this.#armedAt) this.#arm(due, e.moment.receivedAt);
  }

  #armedAt = 0n;

  #arm(slot: bigint, receivedAt: number): void {
    this.#armed = true;
    this.#armedAt = slot;
    // A superseded hook finds the queue head not yet due and re-arms nothing (see #release).
    this.#opts.hook({ id: `obs:${this.#hooks++}`, moment: { slot, txIndex: BLOCK_TX, ixIndex: 1, receivedAt }, run: () => this.#release(slot) });
  }

  #inBlackout(t: number): boolean {
    return this.blackouts.some((b) => t >= b.from && t < b.to);
  }

  /** Places the blackouts of the UTC day holding `ms` (once per day), from the seed. */
  #placeBlackouts(ms: number): void {
    const o = this.#opts.observe;
    if (o === null || o.blackouts.length === 0) return;
    const day = new Date(ms).toISOString().slice(0, 10);
    if (this.#blackoutDays.has(day)) return;
    this.#blackoutDays.add(day);
    const start = Date.parse(`${day}T00:00:00Z`);
    o.blackouts.forEach((b, k) => {
      const d = b.durationMs;
      const at = start + (b.atMsOfDay ?? Math.floor((createRng(`${o.seed}:blackout:${day}:${k}`).nextU32() / 2 ** 32) * (86_400_000 - d)));
      this.blackouts.push({ from: at, to: at + d });
    });
  }

  /** At the end of block `slot` (if it has one): releases every due observation, unless the feed is blacked out. */
  #release(slot: bigint): void {
    // Only the latest armed hook acts; an earlier one superseded by a sooner due slot does nothing.
    if (!this.#armed || slot !== this.#armedAt) return;
    this.#armed = false;
    const o = this.#opts.observe!;
    const next = () => (this.#opts.hasRows() ? this.#arm(slot + 1n, this.blockTime * 1000) : this.#drop());
    if (this.slot !== slot) return next();
    const t = this.blockTime * 1000 + o.providerMs;
    if (this.#inBlackout(t)) return next();
    // Everything due is released in chain order (its own moment), whatever its delay.
    const batch: MarketEvent[] = [];
    while (this.#queueAt < this.#queue.length && this.#queue[this.#queueAt]!.due <= slot) batch.push(this.#queue[this.#queueAt++]!.e);
    batch.sort((a, b) => compareMoments(a.moment, b.moment) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const e of batch) {
      this.#opts.schedule({ ...e, moment: { slot, txIndex: BLOCK_TX, ixIndex: 2 + this.#seq++, receivedAt: t }, value: { ...(e.value as Readonly<Record<string, unknown>>), blockHeight: this.blockHeight } });
    }
    if (this.#queueAt > 4096) {
      this.#queue = this.#queue.slice(this.#queueAt);
      this.#queueAt = 0;
    }
    const head = this.#queue[this.#queueAt];
    if (head !== undefined) this.#arm(head.due > slot ? head.due : slot + 1n, t);
  }

  /** The data ended before these observations' release block: they are never seen. */
  #drop(): void {
    this.#queue = [];
    this.#queueAt = 0;
  }

  /** The events a row releases now, in id order, all at the row's moment (observations are scheduled for later). */
  release(row: DatasetRow): FeedEvent[] {
    this.#now = [];
    const out = this.#row(row);
    return this.#now.length === 0 ? out : [...out, ...this.#now];
  }

  #row(row: DatasetRow): FeedEvent[] {
    switch (row.kind) {
      case 'block':
        this.#placeBlackouts(row.blockTime * 1000);
        return this.#block(row);
      case 'amm':
        return this.#swap(row);
      case 'event':
        return this.#event(row);
      case 'curve':
        // Curve trades are recorded, not traded (§3.1); the engine does not need them yet.
        return [];
    }
  }

  /**
   * Every market event carries the height of the latest block when it was released: a transaction signed while
   * handling it takes that block's hash. A discovery is stamped again when it is released (see discovery()).
   */
  #market(id: string, moment: Moment, key: string, value: Readonly<Record<string, unknown>>): MarketEvent {
    return { kind: 'market', id, moment, key, value: { ...value, blockHeight: this.blockHeight } };
  }

  #block(row: BlockRow): FeedEvent[] {
    this.blockHeight++;
    this.blockTime = row.blockTime;
    this.slot = row.slot;
    const m = rowMoment(row);
    const value = { blockHeight: this.blockHeight, blockTime: row.blockTime };
    const out: FeedEvent[] = [];
    const bounds = this.#opts.regimeBoundaries ?? [];
    while (this.#regimeAt < bounds.length && bounds[this.#regimeAt]!.slot <= row.slot) {
      const b = bounds[this.#regimeAt++]!;
      this.regime = b.label;
      this.regimesPassed.push({ slot: b.slot, label: b.label, at: row.blockTime * 1000 });
      this.#observe(this.#market(`g:${b.slot}`, m, 'regime', { label: b.label, slot: b.slot }));
    }
    (this.#opts.series ?? []).forEach((s, k) => {
      // The latest value usable by this block; older ones it skips over are superseded.
      let last: SeriesBar | null = null;
      while (this.#seriesAt[k]! < s.releases.length && s.releases[this.#seriesAt[k]!]!.at <= row.blockTime * 1000) last = s.releases[this.#seriesAt[k]!++]!.bar;
      if (last !== null) out.push(this.#market(`x:${s.key}:${last.start}`, m, s.key, { start: last.start, close: last.close }));
    });
    if (this.#opts.active()) {
      out.push(
        this.#market(`b:${row.slot}`, m, 'slot', value),
        { kind: 'world', id: `t:${row.slot}`, moment: m, event: { type: 'tick', blockHeight: this.blockHeight } },
      );
    } else if (this.blockHeight % BigInt(this.#opts.heartbeatBlocks) === 0n) {
      out.push(this.#market(`b:${row.slot}`, m, 'slot', value));
    }
    return out;
  }

  #swap(row: AmmSwapRow): FeedEvent[] {
    let t = this.pools.get(row.pool);
    if (t === undefined) {
      t = { shifted: new ShiftedPool(), fees: null, baseSupply: 0n, mint: row.baseMint, quoteMint: row.quoteMint };
      this.pools.set(row.pool, t);
    }
    t.fees = row.fees;
    t.baseSupply = row.baseSupply;
    const r = t.shifted.applyReal(row);
    if (r === null) {
      this.unquotableSwaps++;
      return [];
    }
    if (!r.replayed) this.skippedSwaps++;
    this.#tally(row.slot, r.trade.userQuote);
    const view: PoolView = {
      pool: row.pool, mint: row.baseMint, quoteMint: row.quoteMint,
      baseReserve: r.shifted.baseReserve, quoteVault: r.shifted.quoteVault, virtualQuoteReserves: r.shifted.virtualQuoteReserves,
      fees: row.fees, baseSupply: row.baseSupply, side: row.side, userQuote: r.trade.userQuote, baseAmount: row.side === 'buy' ? r.trade.base : row.baseAmount,
      blockHeight: this.blockHeight, observed: { slot: row.slot, at: row.blockTime * 1000 },
    };
    this.#observe(this.#market(`s:${row.signature}:${row.evIdx}`, rowMoment(row), `pool:${row.pool}`, view as unknown as Readonly<Record<string, unknown>>));
    return [];
  }

  #event(row: EventRow): FeedEvent[] {
    const f = row.fields;
    if (row.event === 'CreatePoolEvent' && f['pool']) {
      this.#poolInfo.set(f['pool'], { mint: f['base_mint'] ?? '', quoteMint: f['quote_mint'] ?? '', canonical: canonicalOf(f), mayhem: flagOf(f['is_mayhem_mode']) });
    }
    const mint = f['mint'] ?? f['base_mint'];
    if (row.event === 'CreateEvent' && f['mint'] && f['symbol']) this.symbols.set(f['mint'], f['symbol']);
    if (mint) this.#observe(this.#market(`e:${row.signature}:${row.evIdx}`, rowMoment(row), `life:${mint}`, { event: row.event, program: row.program, fields: f }));
    if (row.event === 'CompletePumpAmmMigrationEvent' && f['mint'] && f['pool'] && !this.#discovered.has(f['mint'])) {
      this.#discovered.add(f['mint']);
      const lag = this.#opts.discoveryLag(f['mint']);
      if (!Number.isSafeInteger(lag) || lag < 1) throw new RangeError('discovery lag must be at least one slot');
      const graduatedAt = row.blockTime * 1000;
      const pool = f['pool'];
      const gmint = f['mint'];
      // Built when released, so the pool's creation event of the same transaction is known by then. With a modelled
      // feed it goes through the observation queue at its own lag, so a blackout holds it like any other observation.
      const ev = this.#market(`d:${gmint}`, rowMoment(row), `disc:${gmint}`, { mint: gmint, pool, graduatedAt, lazy: true });
      if (this.#opts.observe === null) {
        this.#opts.schedule({ ...ev, moment: { slot: row.slot + BigInt(lag), txIndex: BLOCK_TX, ixIndex: 1, receivedAt: graduatedAt + lag * 400 } });
      } else {
        this.#enqueue(row.slot + BigInt(lag), ev);
      }
    }
    return [];
  }

  /** Completes a discovery's value when it is released (pool facts known by then). */
  discovery(raw: { mint: string; pool: string; graduatedAt: number }): Discovery {
    const info = this.#poolInfo.get(raw.pool);
    return {
      mint: raw.mint, pool: raw.pool, graduatedAt: raw.graduatedAt,
      quoteMint: info?.quoteMint ?? '', canonical: info === undefined ? null : info.canonical && info.mint === raw.mint, mayhem: info?.mayhem ?? null,
      blockHeight: this.blockHeight,
    };
  }
}
