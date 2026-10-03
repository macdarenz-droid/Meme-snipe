// A PumpSwap pool as the backtest sees it once our own trades are in the sequence (docs/ARCHITECTURE.md §11, §16.2).
// The dataset gives each real swap's pre-trade reserves (BuyEvent/SellEvent carry them). Without our trades, the
// pool after a swap is that swap replayed on its pre-trade state with the exact CORE-2 math. With our trades in,
// the pool differs by a delta; every later real swap is replayed on the shifted state with its own input, so later
// traders get the prices our trade left, and the delta is what remains after their trade.
import { type CoinFlags, type FeeSplit, type PoolFeeContext, type PoolState, type PoolTrade, type Quote, poolBuyExactBase, poolBuyExactQuoteIn, poolSell } from '../amm/index.ts';
import type { Bps } from '../units/index.ts';

/** The fee terms a real swap paid, read from its event (rates are per trade on chain, so nothing is assumed). */
export interface ObservedFees {
  readonly split: FeeSplit;
  readonly buybackFeeBps: Bps;
  readonly instruction: 'v1' | 'v2';
}

/** One real PumpSwap swap from the dataset. */
export interface RealSwap {
  readonly side: 'buy' | 'sell';
  /** `exact-base`: `buy` (base out fixed) or `sell` (base in fixed). `exact-quote-in`: `buy_exact_quote_in`. */
  readonly mode: 'exact-base' | 'exact-quote-in';
  /** Base out (exact-base buy), base in (sell), or the user's quote spend (exact-quote-in). */
  readonly amount: bigint;
  /** Reserves before the swap, from the event. */
  readonly pre: PoolState;
  readonly fees: ObservedFees;
  readonly baseSupply: bigint;
}

const ZERO_FEES: FeeSplit = { lp: 0 as Bps, protocol: 0 as Bps, creator: 0 as Bps };

/**
 * A fee context that charges exactly the observed split: a flat schedule on a pool treated as non-canonical, so the
 * quote math neither re-tiers nor re-derives the rates. The creator rate is charged when it was observed non-zero.
 */
export const observedFeeContext = (fees: ObservedFees, baseSupply: bigint, coin: CoinFlags): PoolFeeContext => ({
  feeConfig: { flatFees: fees.split, feeTiers: [{ marketCapThreshold: 0n, fees: fees.split }], exoticFlatFees: ZERO_FEES },
  canonical: false,
  quote: 'sol',
  baseSupply,
  creatorFeeCharged: fees.split.creator > 0,
  coin,
  instruction: fees.instruction,
  buybackFeeBps: fees.buybackFeeBps,
});

const NORMAL: CoinFlags = { mayhemMode: false, transferFee: false, transferHook: false };

/** The swap replayed on `pool` with its own input. */
export const replaySwap = (pool: PoolState, swap: RealSwap): Quote<PoolTrade> => {
  const ctx = observedFeeContext(swap.fees, swap.baseSupply, NORMAL);
  if (swap.amount <= 0n) return { ok: false, reason: 'zero-output', detail: 'swap amount is zero' };
  if (swap.side === 'sell') return poolSell(pool, swap.amount, ctx);
  if (swap.mode === 'exact-base') return poolBuyExactBase(pool, swap.amount, ctx);
  if (swap.amount <= 1n) return { ok: false, reason: 'zero-output', detail: 'spend must be > 1' };
  return poolBuyExactQuoteIn(pool, swap.amount, ctx);
};

export interface PoolDelta {
  readonly base: bigint;
  readonly vault: bigint;
  readonly virtual: bigint;
}

const NO_DELTA: PoolDelta = { base: 0n, vault: 0n, virtual: 0n };

const plus = (p: PoolState, d: PoolDelta): PoolState => ({
  baseReserve: p.baseReserve + d.base, quoteVault: p.quoteVault + d.vault, virtualQuoteReserves: p.virtualQuoteReserves + d.virtual,
});

const minus = (a: PoolState, b: PoolState): PoolDelta => ({
  base: a.baseReserve - b.baseReserve, vault: a.quoteVault - b.quoteVault, virtual: a.virtualQuoteReserves - b.virtualQuoteReserves,
});

const isZero = (d: PoolDelta): boolean => d.base === 0n && d.vault === 0n && d.virtual === 0n;

export interface SwapReplay {
  /** The pool after the swap without our trades. */
  readonly real: PoolState;
  /** The pool after the swap with our trades in the sequence. */
  readonly shifted: PoolState;
  /** False when the swap could not be replayed on the shifted pool (it would have failed there; it is skipped). */
  readonly replayed: boolean;
}

/** One pool's real and shifted state. Mutable; owned by the replay driver, never by the engine. */
export class ShiftedPool {
  #real: PoolState | null = null;
  #delta: PoolDelta = NO_DELTA;

  /** The pool our trades see now, or null before the first swap. */
  get state(): PoolState | null {
    return this.#real === null ? null : plus(this.#real, this.#delta);
  }

  get delta(): PoolDelta {
    return this.#delta;
  }

  /**
   * Applies a real swap. Its pre-trade reserves resync the real state (liquidity events between swaps are carried by
   * them). Returns null when the swap cannot be replayed even on its own pre-trade state: the state is then unknown
   * until the next swap, and our delta is kept.
   */
  applyReal(swap: RealSwap): SwapReplay | null {
    const own = replaySwap(swap.pre, swap);
    if (!own.ok) {
      // The state is unknown until the next swap resyncs it; our own effect on the pool is not undone by that.
      this.#real = null;
      return null;
    }
    const real = own.trade.after;
    if (isZero(this.#delta)) {
      this.#real = real;
      return { real, shifted: real, replayed: true };
    }
    const shiftedPre = plus(swap.pre, this.#delta);
    const shifted = replaySwap(shiftedPre, swap);
    const shiftedPost = shifted.ok ? shifted.trade.after : shiftedPre;
    this.#real = real;
    this.#delta = minus(shiftedPost, real);
    return { real, shifted: shiftedPost, replayed: shifted.ok };
  }

  /** Our trade landed: the pool is now `after` (computed from `state` by the fill). */
  applyOurs(after: PoolState): void {
    if (this.#real === null) throw new RangeError('our trade needs a known pool state');
    this.#delta = minus(after, this.#real);
  }
}
