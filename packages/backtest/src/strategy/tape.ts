// A pool's tape as the strategy saw it, built from the pool events the engine released, one swap at a time (the
// bot's own stream; live builds the same from its feed). One-minute bars of spot price (quote per raw token, at
// PRICE_SCALE), buy and sell SOL, and the deployer's sales; plus the volume-weighted price since migration. Only
// what was released is in it, so it is as of now by construction.
import { PRICE_SCALE } from '../../../core/src/config/index.ts';
import type { PriceBar } from '../../../core/src/exits/index.ts';
import type { PoolView } from '../sim/market.ts';

export const BAR_MS = 60_000;

export interface Bar extends PriceBar {
  readonly open: bigint;
  /** SOL in from buys and out to sells (what traders paid and received), lamports. */
  buyQuote: bigint;
  sellQuote: bigint;
  /** SOL from buys minus SOL to sells, leaving out the deployer's own trades. */
  netIndependent: bigint;
  /** Tokens the deployer sold in the bar. */
  deployerSold: bigint;
  trades: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Spot price of a pool state at PRICE_SCALE, or null when a side is empty. */
export const spotPrice = (v: Pick<PoolView, 'baseReserve' | 'quoteVault' | 'virtualQuoteReserves'>): bigint | null => {
  const quote = v.quoteVault + v.virtualQuoteReserves;
  return quote > 0n && v.baseReserve > 0n ? (quote * PRICE_SCALE) / v.baseReserve : null;
};

export class PoolTape {
  /** The first bars after the tape started (migration), kept for the flush and the volume-weighted price. */
  readonly head: Mutable<Bar>[] = [];
  /** The latest bars, a rolling window. */
  readonly tail: Mutable<Bar>[] = [];
  readonly #headMax: number;
  readonly #tailMax: number;
  /** Totals since the tape started, for the volume-weighted price. */
  quoteVolume = 0n;
  baseVolume = 0n;
  last: { readonly atMs: number; readonly view: PoolView } | null = null;
  readonly startedAtMs: number;

  constructor(startedAtMs: number, headBars: number, tailBars: number) {
    this.startedAtMs = startedAtMs;
    this.#headMax = headBars;
    this.#tailMax = tailBars;
  }

  add(view: PoolView, atMs: number, deployer: string | null): void {
    this.last = { atMs, view };
    const p = spotPrice(view);
    if (p === null) return;
    const start = Math.floor(atMs / BAR_MS) * BAR_MS;
    let bar = this.tail[this.tail.length - 1];
    if (bar === undefined || bar.startMs !== start) {
      bar = { startMs: start, open: p, high: p, low: p, close: p, buyQuote: 0n, sellQuote: 0n, netIndependent: 0n, deployerSold: 0n, trades: 0 };
      this.tail.push(bar);
      if (this.tail.length > this.#tailMax) this.tail.shift();
      if (this.head.length < this.#headMax) this.head.push(bar);
    }
    if (p > bar.high) bar.high = p;
    if (p < bar.low) bar.low = p;
    bar.close = p;
    bar.trades++;
    const own = deployer !== null && view.user === deployer;
    if (view.side === 'buy') {
      bar.buyQuote += view.userQuote;
      if (!own) bar.netIndependent += view.userQuote;
    } else {
      bar.sellQuote += view.userQuote;
      if (!own) bar.netIndependent -= view.userQuote;
      if (own) bar.deployerSold += view.baseAmount;
    }
    this.quoteVolume += view.userQuote;
    this.baseVolume += view.baseAmount;
  }

  /** Bars that ended by `nowMs` or are still open, oldest first, without duplicates between head and tail. */
  bars(): readonly Bar[] {
    const first = this.tail[0]?.startMs ?? Number.MAX_SAFE_INTEGER;
    return [...this.head.filter((b) => b.startMs < first), ...this.tail];
  }

  /** Bars with start in [fromMs, toMs). */
  between(fromMs: number, toMs: number): readonly Bar[] {
    return this.bars().filter((b) => b.startMs >= fromMs && b.startMs < toMs);
  }

  /** Volume-weighted price since the tape started, at PRICE_SCALE; null before any volume. */
  vwap(): bigint | null {
    return this.baseVolume > 0n ? (this.quoteVolume * PRICE_SCALE) / this.baseVolume : null;
  }
}
