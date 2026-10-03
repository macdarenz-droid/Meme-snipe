// Exit rules (docs/ARCHITECTURE.md §9) as one pure step per position update: the tracker carries what the rules
// remember (peak price, trail level, partials taken, quote failures, blocked retries), the observation carries the
// market as of now. Every threshold comes from the session policy. Risk limits are not an input: no daily cutoff,
// pause or kill latch can block an exit (§8, §18).
import { type ExitUniverse, MINUTE_MS, type Policy, exitsFor } from '../config/index.ts';
import type { ExitReason, PositionStatus } from '../lifecycle/index.ts';
import type { FillNetwork } from '../fills/index.ts';
import { BPS_DENOMINATOR, type MicroUsd, mulDiv } from '../units/index.ts';
import { type ExitMarket, type Liquidation, type PriceBar, atOrBelow, atr, execPrice, liquidationValue, quoteReserve } from './value.ts';

const BPS = BPS_DENOMINATOR;

export type TriggerCode =
  | 'price_stop' | 'break_even' | 'trailing_stop' | 'time_flat' | 'time_max'
  | 'deployer_sell' | 'liquidity_drop' | 'quote_failures' | 'no_route' | 'negative_flow'
  | 'take_profit';

/** The lifecycle reason each trigger is booked under. */
export const TRIGGER_REASON: Readonly<Record<TriggerCode, ExitReason>> = {
  price_stop: 'stop', break_even: 'stop', trailing_stop: 'trailing_stop', time_flat: 'max_hold', time_max: 'max_hold',
  deployer_sell: 'thesis_lost', negative_flow: 'thesis_lost',
  liquidity_drop: 'liquidity', quote_failures: 'liquidity', no_route: 'liquidity',
  take_profit: 'take_profit',
};

export interface Trigger {
  readonly code: TriggerCode;
  readonly detail: string;
}

/** Fixed at the entry fill. */
export interface EntryPlan {
  /** The position's universe; it selects the strategy exits (S0 carries the universe it controls for). */
  readonly universe: ExitUniverse;
  readonly openedAtMs: number;
  /** Entry notional, for the size rule on how many exits a position may use. */
  readonly notional: MicroUsd;
  /** 1R in lamports: the planned loss at the stop, costs included (R5). */
  readonly riskUnit: bigint;
  /** The structure stop as an executable price (PRICE_SCALE). It never moves down. */
  readonly stopPrice: bigint;
  /** The market's quote reserve at entry, for the liquidity stop. */
  readonly entryReserve: bigint;
}

/** The position as the book has it now. */
export interface Holding {
  readonly status: PositionStatus;
  readonly quantity: bigint;
  /** Tokens sold so far (CORE-1 `sold`). */
  readonly sold: bigint;
  /** Every lamport spent on the position so far: entry spend, fees, rent not recovered, exit fees paid. */
  readonly costBasis: bigint;
  /** Lamports received from exits so far. */
  readonly realized: bigint;
  /** Fees one more exit transaction costs at the first rung (base, priority, tip). */
  readonly exitCost: bigint;
  /** CORE-1 `exitSeq`: exit owners created so far. Sales under one owner are one partial. */
  readonly exitSeq: number;
  /**
   * Ladder attempts signed for this position across every exit owner, from the book (`exitAttemptsOf`). The budget
   * lives in the book, so a restart with a fresh tracker cannot hand out a new ladder.
   */
  readonly exitAttempts: number;
  /**
   * Raw balance of our token account. It can exceed `quantity` (dust, or tokens someone sent us); then closing the
   * account would fail and roll back the sale, so the exit sells our quantity and leaves the account open.
   */
  readonly tokenAccountBalance: bigint;
  /** An earlier sell-and-close of this position resolved failed at the close: later exits sell only (EXIT-1b). */
  readonly closeFailed: boolean;
}

export interface Observed<T> {
  readonly atMs: number;
  readonly value: T;
}

/** One-minute net SOL flow into the market (buys − sells), as of the end of the minute. */
export interface FlowMinute {
  readonly startMs: number;
  readonly net: bigint;
}

/** What the exit engine sees at `nowMs`. Anything stamped after `nowMs` is ignored and reported. */
export interface ExitObservation {
  readonly nowMs: number;
  /** True on the slot's closing state; a close-based take-profit only fires then. */
  readonly slotClose: boolean;
  readonly market: Observed<ExitMarket> | null;
  /** Share of supply the deployer and its linked cluster sold since entry, in basis points. */
  readonly deployerSoldBps: Observed<number> | null;
  /** The aggregator's sell route for our size (`missing` on NO_ROUTES_FOUND). */
  readonly sellRoute: Observed<'ok' | 'missing'> | null;
  readonly flow: readonly FlowMinute[];
  readonly bars: readonly PriceBar[];
}

export interface ExitSettings {
  readonly exits: Policy['exits'];
  readonly minNotional: MicroUsd;
  /** A market state older than this is not a quote. */
  readonly maxQuoteAgeMs: number;
  /** From the fill scenario: the conservative scenario judges take-profit on the slot's close only (§11). */
  readonly takeProfitOn: 'wick' | 'close';
  /** What one blocked-exit retry costs: base fee, the last rung's capped priority fee, and the tip. */
  readonly retryCost: bigint;
}

export type AttemptNetwork = Pick<FillNetwork, 'signaturesPerTx' | 'baseFeePerSignature' | 'tip'>;

export const exitSettings = (policy: Policy, takeProfitOn: 'wick' | 'close', network: AttemptNetwork): ExitSettings => {
  const { steps, maxFeePerAttempt } = policy.exits.ladder;
  const fee = steps[steps.length - 1]!.priorityFeeLamports;
  return {
    exits: policy.exits, minNotional: policy.capital.minNotional, maxQuoteAgeMs: policy.gates.maxQuoteAgeMs, takeProfitOn,
    retryCost: network.signaturesPerTx * network.baseFeePerSignature + (fee < maxFeePerAttempt ? fee : maxFeePerAttempt) + network.tip,
  };
};

export interface ExitTracker {
  /** Highest executable price since entry (PRICE_SCALE). */
  readonly peak: bigint | null;
  /** Runner trail level; it only rises. */
  readonly trail: bigint | null;
  readonly partials: number;
  readonly lastSold: bigint;
  /** The exit owner (`exitSeq`) whose sale was last counted as a partial. */
  readonly partialSeq: number | null;
  /** Highest rung attempted so far (`noteAttempt`); escalation never goes below the next one. */
  readonly lastRung: number | null;
  /** Consecutive market states whose reverse quote failed. */
  readonly quoteFailures: number;
  readonly lastQuoteAtMs: number | null;
  /** Reached the time-stop target before T_flat. */
  readonly flatMet: boolean;
  /** When the position was first seen blocked since the last attempt. */
  readonly blockedAtMs: number | null;
  readonly blockedRetries: number;
  /**
   * Full-exit reasons that fired while an exit was in flight and were merged into it. When that exit was a partial,
   * its owner sells only its share, so the rest is exited the moment the position is open again (EXIT-1b).
   */
  readonly pendingFull: readonly ExitReason[] | null;
}

export const newTracker = (): ExitTracker => ({
  peak: null, trail: null, partials: 0, lastSold: 0n, partialSeq: null, lastRung: null,
  quoteFailures: 0, lastQuoteAtMs: null, flatMet: false, blockedAtMs: null, blockedRetries: 0, pendingFull: null,
});

/** Records the rung of a signed attempt. The attempt count itself comes from the book (`Holding.exitAttempts`). */
export const noteAttempt = (t: ExitTracker, rung: number): ExitTracker => ({
  ...t, lastRung: t.lastRung !== null && t.lastRung > rung ? t.lastRung : rung,
});

export type ExitDecision =
  /** No exit; the triggers listed fired but cannot act now (for the log). */
  | { readonly kind: 'hold'; readonly fired: readonly Trigger[]; readonly detail: string }
  /**
   * Request an exit of `quantity`. `value` is the liquidation quote it starts from; when it is not ok, or `blocked`
   * names why no attempt is left, the exit is booked blocked at once (never a fabricated fill). Attempts start at
   * `startRung`, at most `maxAttempts` (what remains of the position's ladder).
   */
  | {
    readonly kind: 'exit';
    readonly quantity: bigint;
    readonly partial: boolean;
    readonly retry: boolean;
    readonly reasons: readonly ExitReason[];
    readonly fired: readonly Trigger[];
    readonly value: Liquidation;
    readonly startRung: number;
    readonly maxAttempts: number;
    readonly blocked: string | null;
    /**
     * Sell and close the token account in the same transaction (its rent comes back only if that lands). Only for a
     * full exit of a clean account with no failed close before; otherwise the exit sells only and the rent stays
     * locked until a later close succeeds. Selling always comes before reclaiming rent.
     */
    readonly closeAccount: boolean;
  }
  /** An exit owner already holds the quantity: add the reasons to it, create nothing (one exit owner, CORE-1). */
  | { readonly kind: 'merge'; readonly reasons: readonly ExitReason[]; readonly fired: readonly Trigger[] };

export interface ExitStep {
  readonly tracker: ExitTracker;
  readonly decision: ExitDecision;
  /** Observations dropped because they were stamped after now (as-of violations). */
  readonly ignored: readonly string[];
}

export type StopCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'stop-not-below-entry' | 'too-wide' | 'no-atr' | 'beyond-atr'; readonly detail: string };

/**
 * The price stop an entry may use (§9, R7): below the entry price, at most `loss.stopMaxBps` away and at most
 * the universe's `stopAtrTenths` / 10 × ATR away. A structure that needs more skips the trade; a stop is never widened to fit.
 * Prices are executable prices (PRICE_SCALE); `range` is the ATR as of the entry, null when not enough bars exist.
 */
export const checkStopDistance = (policy: Policy, universe: ExitUniverse, entryPrice: bigint, stopPrice: bigint, range: bigint | null): StopCheck => {
  const { stopAtrTenths } = exitsFor(policy.exits, universe);
  if (stopPrice <= 0n || stopPrice >= entryPrice) return { ok: false, reason: 'stop-not-below-entry', detail: `stop ${stopPrice}, entry ${entryPrice}` };
  const d = entryPrice - stopPrice;
  if (d * BPS > BigInt(policy.loss.stopMaxBps) * entryPrice) return { ok: false, reason: 'too-wide', detail: `distance ${d} above ${policy.loss.stopMaxBps} bps` };
  if (range === null) return { ok: false, reason: 'no-atr', detail: 'not enough bars for the ATR' };
  if (d * 10n > BigInt(stopAtrTenths) * range) return { ok: false, reason: 'beyond-atr', detail: `distance ${d} above ${stopAtrTenths} tenths of ATR ${range}` };
  return { ok: true };
};

const reasonsOf =(fired: readonly Trigger[]): ExitReason[] => [...new Set(fired.map((t) => TRIGGER_REASON[t.code]))];

/** Exit transactions a position of this notional may use: one partial and the rest at q_min, up to three from 2 × q_min. */
export const maxExitTransactions = (s: ExitSettings, notional: MicroUsd): number =>
  notional >= 2n * s.minNotional ? s.exits.maxExitTxAboveDoubleMin : s.exits.maxExitTxAtMinNotional;

/** Any run of `n` contiguous one-minute buckets after entry with net flow below zero, each finished by now. */
const negativeRun = (flow: readonly FlowMinute[], n: number, fromMs: number, nowMs: number): boolean => {
  let last: { readonly startMs: number; readonly run: number } | null = null;
  for (const b of flow) {
    if (b.startMs < fromMs || b.startMs + MINUTE_MS > nowMs) continue;
    const run: number = b.net < 0n ? (last !== null && b.startMs === last.startMs + MINUTE_MS ? last.run + 1 : 1) : 0;
    if (run >= n) return true;
    last = { startMs: b.startMs, run };
  }
  return false;
};

const maxOf = (a: bigint | null, b: bigint): bigint => (a !== null && a > b ? a : b);

/** One update of one position. Pure: the same inputs always give the same step. */
export const decideExit = (s: ExitSettings, plan: EntryPlan, h: Holding, t0: ExitTracker, obs: ExitObservation): ExitStep => {
  const g = s.exits;
  // Never a default: a universe without its own block throws.
  const x = exitsFor(g, plan.universe);
  const now = obs.nowMs;
  const ignored: string[] = [];
  const asOf = <T>(name: string, o: Observed<T> | null): Observed<T> | null => {
    if (o === null) return null;
    if (o.atMs > now) {
      ignored.push(`${name} stamped ${o.atMs} after now ${now}`);
      return null;
    }
    return o;
  };
  const hold = (detail: string, fired: readonly Trigger[] = []): ExitStep => ({ tracker: t, decision: { kind: 'hold', fired, detail }, ignored });

  let t = t0;
  if (h.status === 'opening' || h.status === 'closed' || h.quantity <= 0n) return hold(`nothing to manage (${h.status})`);

  // Tokens are still held, so a new sale was a partial (an outside sale counts too: the runner rules are the tighter
  // ones). Fills of one exit owner in several steps are one partial.
  if (h.sold > t.lastSold) {
    t = { ...t, partials: h.exitSeq === t.partialSeq ? t.partials : t.partials + 1, partialSeq: h.exitSeq, lastSold: h.sold };
  }

  const market = asOf('market', obs.market);
  const fresh = market !== null && now - market.atMs <= s.maxQuoteAgeMs ? market : null;
  const liq: Liquidation = fresh === null
    ? { ok: false, reason: 'no-market', detail: market === null ? 'no market state' : 'market state is stale' }
    : liquidationValue(fresh.value, h.quantity);
  if (fresh !== null && fresh.atMs !== t.lastQuoteAtMs) t = { ...t, quoteFailures: liq.ok ? 0 : t.quoteFailures + 1, lastQuoteAtMs: fresh.atMs };
  const value = liq.ok ? liq.value : null;
  if (value !== null) t = { ...t, peak: maxOf(t.peak, execPrice(value, h.quantity)) };

  const range = atr(obs.bars, x.atrPeriod, x.atrBarMs, now);
  if (t.partials >= 1 && t.peak !== null && range !== null) {
    const level = t.peak - (BigInt(x.trailAtrTenths) * range) / 10n;
    t = { ...t, trail: maxOf(t.trail, level) };
  }

  const R = plan.riskUnit;
  const pnl = value === null ? null : h.realized + value - h.exitCost - h.costBasis;
  const elapsed = now - plan.openedAtMs;
  if (!t.flatMet && pnl !== null && elapsed <= x.tFlatMs && pnl * BPS >= BigInt(x.flatMinRBps) * R) t = { ...t, flatMet: true };

  const fired: Trigger[] = [];
  const fire = (code: TriggerCode, detail: string) => fired.push({ code, detail });
  if (value !== null && atOrBelow(value, h.quantity, plan.stopPrice)) fire('price_stop', `value ${value} at or below the stop`);
  if (t.partials >= 1 && pnl !== null && pnl <= 0n) fire('break_even', `runner P&L ${pnl} at or below break-even after costs`);
  // A trail exists only after a partial (set above).
  if (t.trail !== null && value !== null && atOrBelow(value, h.quantity, t.trail)) fire('trailing_stop', `value ${value} at or below the trail`);
  if (elapsed >= x.tMaxMs) fire('time_max', `held ${elapsed} ms`);
  else if (elapsed >= x.tFlatMs && !t.flatMet) fire('time_flat', `target not reached by ${x.tFlatMs} ms`);
  const dev = asOf('deployerSoldBps', obs.deployerSoldBps);
  if (dev !== null && dev.value > g.deployerSellSupplyBps) fire('deployer_sell', `deployer cluster sold ${dev.value} bps of supply`);
  if (fresh !== null && quoteReserve(fresh.value) * BPS <= plan.entryReserve * (BPS - BigInt(g.liquidityDropBps))) {
    fire('liquidity_drop', `reserve ${quoteReserve(fresh.value)} vs ${plan.entryReserve} at entry`);
  }
  if (t.quoteFailures >= g.reverseQuoteFailures) fire('quote_failures', `${t.quoteFailures} reverse quotes failed in a row`);
  const route = asOf('sellRoute', obs.sellRoute);
  if (route !== null && route.value === 'missing') fire('no_route', 'no sell route');
  if (negativeRun(obs.flow, g.negativeFlowMinutes, plan.openedAtMs, now)) fire('negative_flow', `net SOL flow negative for ${g.negativeFlowMinutes} minutes`);
  const full = fired.slice();

  const k = BigInt(t.partials + 1);
  const tpTime = s.takeProfitOn === 'wick' || obs.slotClose;
  if (t.partials < maxExitTransactions(s, plan.notional) - 1 && pnl !== null && tpTime
    && (pnl * BPS >= k * BigInt(x.partialAtRBps) * R || pnl * BPS >= k * BigInt(x.partialAtGainBps) * h.costBasis)) {
    fire('take_profit', `P&L ${pnl} reached take-profit ${k}`);
  }

  if (h.status === 'exit_requested' || h.status === 'exit_pending') {
    if (full.length > 0) t = { ...t, pendingFull: [...new Set([...(t.pendingFull ?? []), ...reasonsOf(full)])] };
    return fired.length === 0 ? hold('exit in progress') : { tracker: t, decision: { kind: 'merge', reasons: reasonsOf(fired), fired }, ignored };
  }

  const last = g.ladder.steps.length - 1;
  const used = h.exitAttempts;
  const left = g.ladder.maxAttempts - used;
  // Without a remembered rung (a restart), every attempt went at least one rung up from the first, so `used` is a floor.
  const next = Math.min(Math.max(t.lastRung === null ? 0 : t.lastRung + 1, used), last);
  // Triggers read the whole holding's value; the order carries the quote for the quantity it sells (EXIT-1b), so its
  // min-out and the fresh quote at attempt time describe the same sale.
  const quoteFor = (quantity: bigint): Liquidation => (quantity === h.quantity || fresh === null ? liq : liquidationValue(fresh.value, quantity));
  const exit = (quantity: bigint, partial: boolean, retry: boolean, reasons: readonly ExitReason[]): ExitStep => ({
    tracker: t,
    decision: {
      kind: 'exit', quantity, partial, retry, reasons, fired, value: quoteFor(quantity),
      // Escalation never goes down: a new owner starts above the highest rung already tried.
      startRung: retry ? last : next,
      maxAttempts: retry ? 1 : Math.max(left, 0),
      blocked: retry || left > 0 ? null : `exit ladder used: ${used} attempts on this position`,
      // A non-partial exit always sells the whole holding.
      closeAccount: !partial && h.tokenAccountBalance === h.quantity && !h.closeFailed,
    },
    ignored,
  });

  if (h.status === 'exit_blocked') {
    // Keep watching; retry at the last rung with a fresh quote once the wait has passed, while retries remain and the
    // quote pays more than the attempt costs.
    if (t.blockedAtMs === null) t = { ...t, blockedAtMs: now };
    // Retries are single attempts past the ladder, so the book bounds them too when the tracker was lost.
    const retries = Math.max(t.blockedRetries, used - g.ladder.maxAttempts);
    if (retries >= g.blockedRetryAttempts) return hold('exit blocked: retries used', fired);
    if (now < t.blockedAtMs! + g.blockedRetryMs) return hold('exit blocked: waiting to retry', fired);
    if (!liq.ok) return hold(`exit blocked: ${liq.detail}`, fired);
    // The retry goes at the last rung: the least it may receive is the quote less that rung's slippage, and that, not
    // the quote, must pay for the attempt (EXIT-1b).
    const leastProceeds = mulDiv(liq.value, BPS - BigInt(x.ladder.steps[last]!.minOutBelowTriggerBps), BPS, 'floor');
    if (leastProceeds <= s.retryCost) return hold('exit blocked: the least accepted proceeds do not cover the attempt', fired);
    t = { ...t, blockedAtMs: null, blockedRetries: retries + 1, pendingFull: null };
    return exit(h.quantity, false, true, fired.length > 0 ? reasonsOf(fired) : ['emergency']);
  }

  if (t.pendingFull !== null) {
    // A full exit fired while a partial was in flight: the rest goes on the first step with a fresh quote, on the normal
    // ladder. A missing or stale quote at the fill is timing, not a dead pool, so it waits (EXIT-1b review); a trigger
    // that fires without a quote (time, deployer, route, quote failures) still exits at once below.
    if (!liq.ok && full.length === 0) return hold('full exit remembered: waiting for a fresh quote', fired);
    const reasons = [...new Set([...t.pendingFull, ...reasonsOf(fired)])];
    t = { ...t, pendingFull: null };
    return exit(h.quantity, false, false, reasons);
  }
  if (full.length > 0) return exit(h.quantity, false, false, reasonsOf(fired));
  if (fired.length > 0) {
    const share = mulDiv(h.quantity, BigInt(x.partialMinShareBps), BPS, 'ceil');
    return share >= h.quantity ? exit(h.quantity, false, false, ['take_profit']) : exit(share, true, false, ['take_profit']);
  }
  return hold('no trigger');
};
