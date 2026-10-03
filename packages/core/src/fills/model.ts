// The paper fill model (docs/ARCHITECTURE.md §11). A paper fill is a model, not proof a transaction would land.
// Pure functions over a seeded Rng: the same seed and the same inputs give the same draws and fills, in the backtest
// and in live paper mode alike. Parameters come from configuration (config/fills.ts), never from this file.
import { type CoinFlags, type NoQuoteReason, type PoolState, poolBuyExactQuoteIn, poolSell } from '../amm/index.ts';
import { PPM } from '../costs/index.ts';
import type { Venue } from '../domain/index.ts';
import type { Rng } from '../engine/index.ts';
import { BPS_DENOMINATOR, mulDiv } from '../units/index.ts';
import { type ObservedFees, observedFeeContext } from './pool.ts';

export type ScenarioName = 'base' | 'conservative' | 'optimistic';
export const SCENARIO_NAMES: readonly ScenarioName[] = ['base', 'conservative', 'optimistic'];

export interface FillScenario {
  readonly name: ScenarioName;
  /** Share of attempts that land and execute, in ppm, per venue (§11 defaults until our own data exist). */
  readonly landPpm: Readonly<Record<Venue, bigint>>;
  /**
   * Of the attempts that do not execute, the share (ppm) that never reach a block: they expire after their last valid
   * block height and cost nothing. The rest land as failed transactions and pay the base and priority fees.
   */
  readonly dropPpm: bigint;
  /** Feed lag before the engine learns of a token, in slots; one value is drawn uniformly per token. */
  readonly discoverySlots: readonly number[];
  /** Slots from broadcast to landing; one value is drawn uniformly per attempt. */
  readonly landingSlots: readonly number[];
  /** Slots from landing until the status reads `confirmed`. */
  readonly confirmSlots: number;
  /** Slots from landing until the status reads `finalized` (a failure is terminal only then). */
  readonly finalizeSlots: number;
  /** The shortfall of the executed amount against the quote, scaled by this (ppm; 1,000,000 = as executed, 1.5x = conservative). */
  readonly slippagePpm: bigint;
  /** Take-profit judged on the trade's wick or on the slot's close (§11: conservative uses close). For the exit rules. */
  readonly takeProfit: 'wick' | 'close';
  /** False: token-account rent counts as never returned (conservative). */
  readonly rentRecovery: boolean;
}

/** Network terms of one attempt. Rent and the escalation ladder are separate (config, policy). */
export interface FillNetwork {
  readonly signaturesPerTx: bigint;
  readonly baseFeePerSignature: bigint;
  readonly entryPriorityFee: bigint;
  /** Tip per landed transaction; it reverts with a failed one. */
  readonly tip: bigint;
  /** Blocks a blockhash stays valid after the block it was taken at. */
  readonly blockhashValidBlocks: bigint;
  /** Rent of the token account opened on entry. */
  readonly tokenAccountRent: bigint;
}

const pick = (rng: Rng, list: readonly number[], what: string): number => {
  if (list.length === 0) throw new RangeError(`${what} needs at least one value`);
  const v = list[rng.int(list.length)]!;
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${what} values must be integers >= 0`);
  return v;
};

/** A uniform draw in [0, 1,000,000) from one u32. */
const ppmDraw = (rng: Rng): bigint => (BigInt(rng.nextU32()) * PPM) >> 32n;

export const drawDiscoverySlots = (rng: Rng, s: FillScenario): number => pick(rng, s.discoverySlots, 'discoverySlots');

export type AttemptFate = 'lands' | 'fails' | 'dropped';

export interface AttemptDraw {
  /** Slots after the broadcast at which the attempt reaches a block (ignored when dropped). */
  readonly landingSlots: number;
  readonly fate: AttemptFate;
}

/** One attempt's latency and fate. Always two draws in the same order, so later draws never depend on the outcome. */
export const drawAttempt = (rng: Rng, s: FillScenario, venue: Venue): AttemptDraw => {
  const landingSlots = pick(rng, s.landingSlots, 'landingSlots');
  const u = ppmDraw(rng);
  const land = s.landPpm[venue];
  if (u < land) return { landingSlots, fate: 'lands' };
  // The remaining range [land, 1e6) splits by dropPpm into dropped then failed.
  const dropped = mulDiv(PPM - land, s.dropPpm, PPM, 'floor');
  return { landingSlots, fate: u - land < dropped ? 'dropped' : 'fails' };
};

/** Lamports an attempt costs: a landed success pays base, priority and tip; a landed failure base and priority; a dropped one nothing. */
export const attemptFee = (net: FillNetwork, priorityFee: bigint, fate: 'filled' | 'failed' | 'dropped'): bigint => {
  const base = net.signaturesPerTx * net.baseFeePerSignature;
  if (fate === 'dropped') return 0n;
  return fate === 'failed' ? base + priorityFee : base + priorityFee + net.tip;
};

/** Lamport costs inside one execution, for the trade report. */
export interface ExecutionCosts {
  readonly lpFee: bigint;
  readonly protocolFee: bigint;
  readonly creatorFee: bigint;
  /** Price impact against the pre-trade spot price, in lamports. */
  readonly impact: bigint;
  /** The scenario's extra slippage, in output units (tokens on a buy, lamports on a sell). */
  readonly extraSlippage: bigint;
}

export type Execution =
  | { readonly ok: true; readonly out: bigint; readonly paid: bigint; readonly after: PoolState; readonly costs: ExecutionCosts }
  | { readonly ok: false; readonly reason: 'slippage' | NoQuoteReason; readonly detail: string };

/** The executed amount after the scenario's extra slippage: shortfall against the quote scaled by slippagePpm. */
export const withSlippage = (executed: bigint, quoted: bigint, slippagePpm: bigint): bigint => {
  if (slippagePpm < PPM) throw new RangeError('slippage scale must be at least 1,000,000 ppm (as executed)');
  const shortfall = quoted > executed ? quoted - executed : 0n;
  const extra = mulDiv(shortfall, slippagePpm - PPM, PPM, 'ceil');
  return executed > extra ? executed - extra : 0n;
};

export interface OurTrade {
  readonly pool: PoolState;
  readonly fees: ObservedFees;
  readonly baseSupply: bigint;
  readonly coin: CoinFlags;
  /** What the route promised and the least it accepts (from the signed attempt's quote). */
  readonly quotedOut: bigint;
  readonly minOut: bigint;
  readonly slippagePpm: bigint;
}

const finish = (out: bigint, paid: bigint, after: PoolState, t: OurTrade, fees: Omit<ExecutionCosts, 'extraSlippage'>): Execution => {
  const final = withSlippage(out, t.quotedOut, t.slippagePpm);
  return final < t.minOut || final <= 0n
    ? { ok: false, reason: 'slippage', detail: `out ${final} below min ${t.minOut}` }
    : { ok: true, out: final, paid, after, costs: { ...fees, extraSlippage: out - final } };
};

const costsOf = (q: { readonly lpFee: bigint; readonly protocolFee: bigint; readonly creatorFee: bigint; readonly impact: bigint }) => ({
  lpFee: q.lpFee, protocolFee: q.protocolFee, creatorFee: q.creatorFee, impact: q.impact,
});

/** Our buy, spending at most `spend` lamports fees included, on the pool as it stands after every real trade of the slot. */
export const executeBuy = (t: OurTrade, spend: bigint): Execution => {
  const q = poolBuyExactQuoteIn(t.pool, spend, observedFeeContext(t.fees, t.baseSupply, t.coin));
  return q.ok ? finish(q.trade.base, q.trade.userQuote, q.trade.after, t, costsOf(q.trade)) : q;
};

/** Our sell of `tokens`. `paid` is the tokens sold; `out` the lamports received. */
export const executeSell = (t: OurTrade, tokens: bigint): Execution => {
  const q = poolSell(t.pool, tokens, observedFeeContext(t.fees, t.baseSupply, t.coin));
  return q.ok ? finish(q.trade.userQuote, tokens, q.trade.after, t, costsOf(q.trade)) : q;
};

/**
 * A blocked exit's value (§11): what the last rung of the escalation ladder would accept for the tokens on the pool
 * as it stands, or 0 when the pool cannot be quoted.
 */
export const blockedExitValue = (pool: PoolState | null, tokens: bigint, fees: ObservedFees | null, baseSupply: bigint, coin: CoinFlags, lastRungBelowBps: number): bigint => {
  if (pool === null || fees === null || tokens <= 0n) return 0n;
  if (!Number.isSafeInteger(lastRungBelowBps) || lastRungBelowBps < 0 || BigInt(lastRungBelowBps) > BPS_DENOMINATOR) throw new RangeError('rung bps must be in [0, 10,000]');
  const q = poolSell(pool, tokens, observedFeeContext(fees, baseSupply, coin));
  return q.ok ? mulDiv(q.trade.userQuote, BPS_DENOMINATOR - BigInt(lastRungBelowBps), BPS_DENOMINATOR, 'floor') : 0n;
};
