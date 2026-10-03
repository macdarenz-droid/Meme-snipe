// Turns dataset rows into the engine's market events at the moment they are released, with our own trades already
// in the pool state (docs/ARCHITECTURE.md §16.2). Only the replay driver holds this object; the engine sees events.
//
// Keys the engine can look up:
//   pool:<pool>   the PumpSwap pool after each real swap, as our trades left it (PoolView)
//   life:<mint>   a lifecycle event of the mint (create, migration, pool creation, liquidity, boost, ...)
//   disc:<mint>   the bot learns of a graduation, after the modelled discovery lag (Discovery)
//   slot          a block: height and time (every block while trading is active, otherwise a heartbeat)
//   sol-usd       the SOL/USD close once it is usable (offchain.ts)
import { poolAddress, pumpPoolAuthority, toAddress } from '../../../core/src/chain/index.ts';
import type { FeedEvent, MarketEvent, Moment } from '../../../core/src/engine/index.ts';
import { OFF_CHAIN } from '../../../core/src/engine/index.ts';
import { type ObservedFees, ShiftedPool } from '../../../core/src/fills/index.ts';
import type { SeriesBar } from '../dataset/offchain.ts';
import type { AmmSwapRow, BlockRow, DatasetRow, EventRow } from '../dataset/rows.ts';

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
  /** The real swap that produced this state. */
  readonly side: 'buy' | 'sell';
  readonly userQuote: bigint;
  readonly baseAmount: bigint;
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

const canonicalOf = (f: Readonly<Record<string, string>>): boolean => {
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
  /** Puts a derived event (a discovery) into the replay. */
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
    this.#opts = opts;
    this.#seriesAt = (opts.series ?? []).map(() => 0);
  }

  track(pool: string): PoolTrack | undefined {
    return this.pools.get(pool);
  }

  /** The events a row releases, in id order, all at the row's moment. */
  release(row: DatasetRow): FeedEvent[] {
    switch (row.kind) {
      case 'block':
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

  #market(id: string, moment: Moment, key: string, value: unknown): MarketEvent {
    return { kind: 'market', id, moment, key, value };
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
      out.push(this.#market(`g:${b.slot}`, m, 'regime', { label: b.label, slot: b.slot }));
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
    const view: PoolView = {
      pool: row.pool, mint: row.baseMint, quoteMint: row.quoteMint,
      baseReserve: r.shifted.baseReserve, quoteVault: r.shifted.quoteVault, virtualQuoteReserves: r.shifted.virtualQuoteReserves,
      fees: row.fees, baseSupply: row.baseSupply, side: row.side, userQuote: row.userQuote, baseAmount: row.baseAmount,
    };
    return [this.#market(`s:${row.signature}:${row.evIdx}`, rowMoment(row), `pool:${row.pool}`, view)];
  }

  #event(row: EventRow): FeedEvent[] {
    const f = row.fields;
    if (row.event === 'CreatePoolEvent' && f['pool']) {
      this.#poolInfo.set(f['pool'], { mint: f['base_mint'] ?? '', quoteMint: f['quote_mint'] ?? '', canonical: canonicalOf(f), mayhem: flagOf(f['is_mayhem_mode']) });
    }
    const mint = f['mint'] ?? f['base_mint'];
    if (row.event === 'CreateEvent' && f['mint'] && f['symbol']) this.symbols.set(f['mint'], f['symbol']);
    const out: FeedEvent[] = [];
    if (mint) out.push(this.#market(`e:${row.signature}:${row.evIdx}`, rowMoment(row), `life:${mint}`, { event: row.event, program: row.program, fields: f }));
    if (row.event === 'CompletePumpAmmMigrationEvent' && f['mint'] && f['pool'] && !this.#discovered.has(f['mint'])) {
      this.#discovered.add(f['mint']);
      const lag = this.#opts.discoveryLag(f['mint']);
      if (!Number.isSafeInteger(lag) || lag < 1) throw new RangeError('discovery lag must be at least one slot');
      const graduatedAt = row.blockTime * 1000;
      const pool = f['pool'];
      const gmint = f['mint'];
      // Built when released, so the pool's creation event of the same transaction is known by then.
      const at: Moment = { slot: row.slot + BigInt(lag), txIndex: BLOCK_TX, ixIndex: 1, receivedAt: graduatedAt + lag * 400 };
      this.#opts.schedule(this.#market(`d:${gmint}`, at, `disc:${gmint}`, { mint: gmint, pool, graduatedAt, lazy: true }));
    }
    return out;
  }

  /** Completes a discovery's value when it is released (pool facts known by then). */
  discovery(raw: { mint: string; pool: string; graduatedAt: number }): Discovery {
    const info = this.#poolInfo.get(raw.pool);
    return {
      mint: raw.mint, pool: raw.pool, graduatedAt: raw.graduatedAt,
      quoteMint: info?.quoteMint ?? '', canonical: info === undefined ? null : info.canonical && info.mint === raw.mint, mayhem: info?.mayhem ?? null,
    };
  }
}
