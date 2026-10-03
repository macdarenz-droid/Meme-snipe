// As-of state for signal research (RES-3, docs/research/signals.md §3). Rows go in strictly in chain order; features
// are read between rows and describe only what was released so far. Asking about a moment before the last released
// row throws, so a caller cannot read the past with the future already loaded.
//
// This module is the feature stage. It never imports the outcome stage (outcome.ts); a test checks the imports.
import { replaySwap, type ObservedFees } from '../../../core/src/fills/index.ts';
import type { PoolState } from '../../../core/src/amm/index.ts';
import type { AmmSwapRow, CurveTradeRow, DatasetRow, EventRow } from '../dataset/rows.ts';
import { canonicalOf, NATIVE_MINTS } from '../sim/market.ts';

const MIN = 60_000;
/** Trades kept per pool: the longest look-back (60 min, plus 60 min for the change "60 min ago") and a margin. */
const KEEP_MS = 130 * MIN;
const DAY_MS = 86_400_000;

export interface TradePoint {
  readonly ms: number;
  readonly slot: bigint;
  readonly user: string;
  readonly buy: boolean;
  /** Lamports the trader paid (buy) or received (sell), fees included, from the exact replay. */
  readonly sol: bigint;
  readonly base: bigint;
  /** Spot price after the trade: (quote vault + virtual quote) / base reserve, lamports per base unit. */
  readonly price: number;
  /** Quote vault after the trade, lamports. */
  readonly quote: bigint;
}

export interface PoolInfo {
  readonly pool: string;
  readonly mint: string;
  readonly quoteMint: string;
  readonly canonical: boolean;
  readonly mayhem: boolean | null;
  migratedAtMs: number | null;
  /** State before the first swap after migration: the migration price and quote. */
  migrationPrice: number | null;
  migrationQuote: bigint | null;
  /** Price as of migration + 5 min, fixed once a later trade (or a later question) passes that moment. */
  price5: number | null;
  peak: number;
  vwapSol: number;
  vwapBase: number;
  /** Trades of the last KEEP_MS, oldest first; `before` is the last trade dropped from the front. */
  trades: TradePoint[];
  before: TradePoint | null;
  last: TradePoint | null;
  state: PoolState | null;
  fees: ObservedFees | null;
  baseSupply: bigint;
}

export interface MintInfo {
  readonly mint: string;
  readonly creator: string;
  readonly createdAtMs: number;
  readonly createSlot: bigint;
  readonly supply: bigint;
  /** Tokens bought on the curve in the creation slot (all wallets, creator included). */
  createSlotBought: bigint;
  /** Net tokens per wallet from curve and pool trades (transfers are not in the data). */
  readonly net: Map<string, bigint>;
  /** Tokens bought on the curve by the first 20 distinct buyers (creator included). */
  readonly early: Map<string, bigint>;
  pool: string | null;
}

export type Features = Readonly<Record<FeatureId, number | null>>;

export const FEATURE_IDS = [
  'f_net15', 'f_net60', 'f_bsr15', 'f_indep60', 'f_size15', 'f_trades15', 'f_ret15', 'f_ret60', 'f_dd', 'f_vwap', 'f_hl',
  'f_vol60', 'f_liq', 'f_liqchg60', 'f_age', 'f_2side60', 'f_top60', 'f_c2g', 'f_devnet', 'f_bundle', 'f_top10', 'f_dep24',
  'f_grad24', 'f_sol24', 'f_liqmig', 'f_turn60', 'f_early_sold',
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

export class AsOfError extends Error {
  override readonly name = 'AsOfError';
}

const spot = (s: PoolState): number | null => (s.baseReserve > 0n ? Number(s.quoteVault + s.virtualQuoteReserves) / Number(s.baseReserve) : null);
const sol = (lamports: bigint): number => Number(lamports) / 1e9;

export interface TrackerOptions {
  /** SOL/USD as usable at a moment (ms), or null when unknown. */
  readonly solUsd: (ms: number) => number | null;
}

export class SignalTracker {
  readonly pools = new Map<string, PoolInfo>();
  readonly mints = new Map<string, MintInfo>();
  /** Creation times per creator, for the deployer count. */
  readonly #byCreator = new Map<string, number[]>();
  /** Migration times of the last 24 h, oldest first. */
  readonly #migrations: number[] = [];
  /** Pools seen in a CreatePoolEvent, before their migration event. */
  readonly #poolFacts = new Map<string, { mint: string; quoteMint: string; canonical: boolean; mayhem: boolean | null }>();
  readonly #opts: TrackerOptions;
  /** The last released row: its slot, block time (ms) and position. */
  slot = -1n;
  nowMs = 0;
  #pos = '';
  unquotable = 0;

  constructor(opts: TrackerOptions) {
    this.#opts = opts;
  }

  /** Releases one row. Rows must come in chain order. */
  push(row: DatasetRow): void {
    const ms = row.blockTime * 1000;
    if (row.slot < this.slot) throw new AsOfError(`row at slot ${row.slot} after slot ${this.slot}: rows must be in chain order`);
    this.slot = row.slot;
    if (ms > this.nowMs) this.nowMs = ms;
    this.#pos = row.kind === 'block' ? `${row.slot}:b` : `${row.slot}:${row.txIdx}:${row.evIdx}`;
    switch (row.kind) {
      case 'amm':
        return this.#swap(row);
      case 'curve':
        return this.#curve(row);
      case 'event':
        return this.#event(row);
      case 'block':
        return;
    }
  }

  /** Throws unless the tracker has released nothing after `slot`: the caller is asking as of `slot` or later. */
  assertAsOf(slot: bigint): void {
    if (this.slot > slot) throw new AsOfError(`asked as of slot ${slot}, but rows up to slot ${this.slot} (${this.#pos}) are already released`);
  }

  #event(row: EventRow): void {
    const f = row.fields;
    const ms = row.blockTime * 1000;
    if (row.event === 'CreateEvent' && f['mint'] && f['creator'] && !this.mints.has(f['mint'])) {
      const supply = /^\d+$/.test(f['token_total_supply'] ?? '') ? BigInt(f['token_total_supply']!) : 1_000_000_000_000_000n;
      this.mints.set(f['mint'], { mint: f['mint'], creator: f['creator'], createdAtMs: ms, createSlot: row.slot, supply, createSlotBought: 0n, net: new Map(), early: new Map(), pool: null });
      const list = this.#byCreator.get(f['creator']) ?? [];
      list.push(ms);
      this.#byCreator.set(f['creator'], list);
      return;
    }
    if (row.event === 'CreatePoolEvent' && f['pool']) {
      this.#poolFacts.set(f['pool'], {
        mint: f['base_mint'] ?? '', quoteMint: f['quote_mint'] ?? '', canonical: canonicalOf(f),
        mayhem: f['is_mayhem_mode'] === 'true' || f['is_mayhem_mode'] === '1' ? true : f['is_mayhem_mode'] === 'false' || f['is_mayhem_mode'] === '0' ? false : null,
      });
      return;
    }
    if (row.event === 'CompletePumpAmmMigrationEvent' && f['mint'] && f['pool']) {
      const facts = this.#poolFacts.get(f['pool']);
      if (facts === undefined || this.pools.has(f['pool'])) return;
      this.pools.set(f['pool'], {
        pool: f['pool'], mint: f['mint'], quoteMint: facts.quoteMint, canonical: facts.canonical && facts.mint === f['mint'], mayhem: facts.mayhem,
        migratedAtMs: ms, migrationPrice: null, migrationQuote: null, price5: null, peak: 0, vwapSol: 0, vwapBase: 0,
        trades: [], before: null, last: null, state: null, fees: null, baseSupply: 0n,
      });
      const m = this.mints.get(f['mint']);
      if (m !== undefined) m.pool = f['pool'];
      this.#migrations.push(ms);
      while (this.#migrations.length > 0 && this.#migrations[0]! < ms - DAY_MS) this.#migrations.shift();
    }
  }

  #curve(row: CurveTradeRow): void {
    const m = this.mints.get(row.mint);
    if (m === undefined) return;
    const d = row.isBuy ? row.tokenAmount : -row.tokenAmount;
    m.net.set(row.user, (m.net.get(row.user) ?? 0n) + d);
    if (row.isBuy && row.slot === m.createSlot) m.createSlotBought += row.tokenAmount;
    if (row.isBuy && (m.early.has(row.user) || m.early.size < 20)) m.early.set(row.user, (m.early.get(row.user) ?? 0n) + row.tokenAmount);
  }

  #swap(row: AmmSwapRow): void {
    const p = this.pools.get(row.pool);
    if (p === undefined) return;
    const r = replaySwap(row.pre, row);
    if (!r.ok) {
      this.unquotable++;
      return;
    }
    const ms = row.blockTime * 1000;
    const after = r.trade.after;
    const price = spot(after);
    if (price === null) return;
    if (p.migrationPrice === null) {
      p.migrationPrice = spot(row.pre);
      p.migrationQuote = row.pre.quoteVault;
    }
    if (p.price5 === null && p.migratedAtMs !== null && ms > p.migratedAtMs + 5 * MIN) p.price5 = p.last?.price ?? p.migrationPrice;
    const buy = row.side === 'buy';
    const t: TradePoint = { ms, slot: row.slot, user: row.user, buy, sol: r.trade.userQuote, base: r.trade.base, price, quote: after.quoteVault };
    p.trades.push(t);
    while (p.trades.length > 0 && p.trades[0]!.ms < ms - KEEP_MS) p.before = p.trades.shift()!;
    p.last = t;
    p.state = after;
    p.fees = row.fees;
    p.baseSupply = row.baseSupply;
    if (price > p.peak) p.peak = price;
    p.vwapSol += Number(r.trade.quote);
    p.vwapBase += Number(r.trade.base);
    const m = this.mints.get(p.mint);
    if (m !== undefined) m.net.set(row.user, (m.net.get(row.user) ?? 0n) + (buy ? r.trade.base : -r.trade.base));
  }

  // ---------- as-of reads ----------

  /** The last trade at or before `ms`, or the trade dropped just before the kept window. */
  #tradeAsOf(p: PoolInfo, ms: number): TradePoint | null {
    let lo = 0;
    let hi = p.trades.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (p.trades[mid]!.ms <= ms) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) return p.trades[lo - 1]!;
    return p.before !== null && p.before.ms <= ms ? p.before : null;
  }

  /** Price as of `ms`: the last trade's, or the migration price between migration and the first trade. */
  priceAsOf(p: PoolInfo, ms: number): number | null {
    const t = this.#tradeAsOf(p, ms);
    if (t !== null) return t.price;
    if (p.before !== null) return null;
    return p.migratedAtMs !== null && ms >= p.migratedAtMs ? p.migrationPrice : null;
  }

  #window(p: PoolInfo, fromMs: number, toMs: number): TradePoint[] {
    return p.trades.filter((t) => t.ms > fromMs && t.ms <= toMs);
  }

  /** Price as of migration + 5 min, when that moment has passed. */
  price5(p: PoolInfo, nowMs: number): number | null {
    if (p.migratedAtMs === null || nowMs < p.migratedAtMs + 5 * MIN) return null;
    return p.price5 ?? p.last?.price ?? p.migrationPrice;
  }

  /** Highest 1-min candle rise (high ÷ open − 1) among candles that overlap the last `windowMs`. */
  candleSpike(p: PoolInfo, nowMs: number, windowMs: number): number | null {
    let worst = 0;
    const start = Math.floor((nowMs - windowMs) / MIN) * MIN;
    for (let m = start; m <= nowMs; m += MIN) {
      const open = this.priceAsOf(p, m);
      if (open === null) continue;
      let high = open;
      for (const t of this.#window(p, m, Math.min(m + MIN, nowMs))) if (t.price > high) high = t.price;
      worst = Math.max(worst, high / open - 1);
    }
    return worst;
  }

  /** Every feature as of `nowMs`, after the row at `slot` was released. */
  features(pool: string, nowMs: number, slot: bigint): Features {
    this.assertAsOf(slot);
    if (nowMs < this.nowMs) throw new AsOfError(`asked as of ${nowMs}, but rows up to ${this.nowMs} are released`);
    const p = this.pools.get(pool);
    if (p === undefined) throw new RangeError(`pool ${pool} is not tracked`);
    const m = this.mints.get(p.mint) ?? null;
    const q = p.state === null ? null : sol(p.state.quoteVault + p.state.virtualQuoteReserves);
    const price = this.priceAsOf(p, nowMs);
    const w15 = this.#window(p, nowMs - 15 * MIN, nowMs);
    const w60 = this.#window(p, nowMs - 60 * MIN, nowMs);
    const flow = (w: readonly TradePoint[]) => {
      let b = 0;
      let s = 0;
      for (const t of w) if (t.buy) b += sol(t.sol);
      else s += sol(t.sol);
      return { b, s };
    };
    const f15 = flow(w15);
    const f60 = flow(w60);
    const ret = (back: number): number | null => {
      const then = this.priceAsOf(p, nowMs - back);
      return price === null || then === null || then <= 0 ? null : Math.log(price / then);
    };
    const users60 = new Map<string, { b: number; s: number }>();
    for (const t of w60) {
      const u = users60.get(t.user) ?? { b: 0, s: 0 };
      if (t.buy) u.b += sol(t.sol);
      else u.s += sol(t.sol);
      users60.set(t.user, u);
    }
    let indep = 0;
    let twoSided = 0;
    let top = 0;
    const vol60 = f60.b + f60.s;
    for (const u of users60.values()) {
      if (u.b > 0 && u.s === 0) indep++;
      if (u.b > 0 && u.s > 0) twoSided += u.b + u.s;
      top = Math.max(top, u.b + u.s);
    }
    const lowIn = (from: number, to: number): number | null => {
      const open = this.priceAsOf(p, from);
      let low = open ?? Infinity;
      for (const t of this.#window(p, from, to)) if (t.price < low) low = t.price;
      return low === Infinity ? null : low;
    };
    const lowRecent = lowIn(nowMs - 30 * MIN, nowMs);
    const lowPrior = lowIn(nowMs - 60 * MIN, nowMs - 30 * MIN);
    const closes: number[] = [];
    for (let k = 60; k >= 0; k--) {
      const c = this.priceAsOf(p, nowMs - k * MIN);
      if (c !== null) closes.push(c);
    }
    let vol: number | null = null;
    if (closes.length >= 31) {
      const r: number[] = [];
      for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i]! / closes[i - 1]!));
      const mu = r.reduce((a, b) => a + b, 0) / r.length;
      vol = Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / (r.length - 1));
    }
    const q60 = this.#tradeAsOf(p, nowMs - 60 * MIN);
    let top10: number | null = null;
    let devnet: number | null = null;
    let bundle: number | null = null;
    let c2g: number | null = null;
    let dep24: number | null = null;
    let earlySold: number | null = null;
    if (m !== null && m.supply > 0n) {
      const held = [...m.net.values()].filter((v) => v > 0n).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
      top10 = Number(held.slice(0, 10).reduce((a, b) => a + b, 0n)) / Number(m.supply);
      const d = m.net.get(m.creator) ?? 0n;
      devnet = Number(d > 0n ? d : 0n) / Number(m.supply);
      bundle = Number(m.createSlotBought) / Number(m.supply);
      if (p.migratedAtMs !== null) c2g = Math.log1p(Math.max(0, p.migratedAtMs - m.createdAtMs) / MIN);
      const bought = [...m.early.values()].reduce((a, b) => a + b, 0n);
      if (bought > 0n) {
        let held = 0n;
        for (const u of m.early.keys()) {
          const v = m.net.get(u) ?? 0n;
          if (v > 0n) held += v;
        }
        earlySold = Math.max(0, 1 - Number(held) / Number(bought));
      }
      dep24 = (this.#byCreator.get(m.creator) ?? []).filter((t) => t < m.createdAtMs && t >= m.createdAtMs - DAY_MS).length;
    }
    const usd = this.#opts.solUsd(nowMs);
    const usd24 = this.#opts.solUsd(nowMs - DAY_MS);
    return {
      f_net15: q === null || q <= 0 ? null : (f15.b - f15.s) / q,
      f_net60: q === null || q <= 0 ? null : (f60.b - f60.s) / q,
      f_bsr15: f15.b + f15.s > 0 ? f15.b / (f15.b + f15.s) : null,
      f_indep60: indep,
      f_size15: w15.length > 0 ? (f15.b + f15.s) / w15.length : null,
      f_trades15: Math.log1p(w15.length),
      f_ret15: ret(15 * MIN),
      f_ret60: ret(60 * MIN),
      f_dd: price === null || p.peak <= 0 ? null : price / p.peak - 1,
      f_vwap: price === null || p.vwapBase <= 0 ? null : price / (p.vwapSol / p.vwapBase) - 1,
      f_hl: lowRecent === null || lowPrior === null ? null : lowRecent > lowPrior ? 1 : 0,
      f_vol60: vol,
      f_liq: q === null || q <= 0 ? null : Math.log(q),
      f_liqchg60: q60 === null || p.state === null || q60.quote <= 0n ? null : Number(p.state.quoteVault) / Number(q60.quote) - 1,
      f_age: p.migratedAtMs === null ? null : Math.log1p((nowMs - p.migratedAtMs) / MIN),
      f_2side60: vol60 > 0 ? twoSided / vol60 : null,
      f_top60: vol60 > 0 ? top / vol60 : null,
      f_c2g: c2g,
      f_devnet: devnet,
      f_bundle: bundle,
      f_top10: top10,
      f_dep24: dep24,
      f_grad24: this.#migrations.filter((t) => t > nowMs - DAY_MS && t <= nowMs).length,
      f_liqmig: p.state === null || p.migrationQuote === null || p.migrationQuote <= 0n ? null : Number(p.state.quoteVault) / Number(p.migrationQuote) - 1,
      f_turn60: q === null || q <= 0 ? null : vol60 / q,
      f_early_sold: earlySold,
      f_sol24: usd === null || usd24 === null || usd24 <= 0 ? null : Math.log(usd / usd24),
    };
  }

  /** Pools whose migration was seen, as candidates for the universes. */
  *trackedPools(): Generator<PoolInfo> {
    yield* this.pools.values();
  }

  /** Spot price and quote of a pool now, for universe filters. */
  liveState(pool: string): { readonly price: number | null; readonly quote: bigint | null; readonly effectiveQuote: bigint | null; readonly supply: bigint } {
    const p = this.pools.get(pool);
    if (p === undefined || p.state === null) return { price: null, quote: null, effectiveQuote: null, supply: 0n };
    return { price: spot(p.state), quote: p.state.quoteVault, effectiveQuote: p.state.quoteVault + p.state.virtualQuoteReserves, supply: p.baseSupply };
  }

  isSolQuote(p: PoolInfo): boolean {
    return NATIVE_MINTS.has(p.quoteMint);
  }

  /** Drops state that can no longer serve a decision: pools older than `maxPoolAgeMs` since migration, mints that never migrated. */
  prune(nowMs: number, maxPoolAgeMs: number): void {
    for (const [k, p] of this.pools) {
      if (p.migratedAtMs !== null && p.migratedAtMs < nowMs - maxPoolAgeMs) {
        this.pools.delete(k);
        this.mints.delete(p.mint);
      }
    }
    // A mint that has not migrated within the curve tape (72 h, DATA-1) never becomes a candidate.
    for (const [k, m] of this.mints) if (m.pool === null && m.createdAtMs < nowMs - 3 * DAY_MS) this.mints.delete(k);
    for (const [k, f] of this.#poolFacts) if (!this.mints.has(f.mint) && !this.pools.has(k)) this.#poolFacts.delete(k);
    for (const [k, list] of this.#byCreator) {
      const kept = list.filter((t) => t >= nowMs - maxPoolAgeMs);
      if (kept.length === 0) this.#byCreator.delete(k);
      else this.#byCreator.set(k, kept);
    }
  }
}
