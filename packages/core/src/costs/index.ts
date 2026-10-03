// Venue-aware round-trip cost model and feasible trade size (docs/ARCHITECTURE.md, "Economics of the 20 dollar trial"):
// expected net P&L(q) = q * (g - v) - F. Amounts are lamports unless named Usd (micro-dollars).
// Costs round up, amounts received and caps round down.
// Contract: an unquotable state (completed curve, effective reserve <= 0, a spend that buys nothing, a sell larger
// than the real reserves) throws RangeError or CurveCompleteError from the quote; callers treat any throw as no trade.
import {
  type CurveFeeContext, type CurveState, type PoolFeeContext, type PoolState,
  curveBuyExactQuoteIn, curveSell, poolBuyExactQuoteIn, poolSell,
} from '../amm/index.ts';
import { type MicroUsd, lamports, lamportsToMicroUsd, microUsdToLamports, mulDiv } from '../units/index.ts';

export const PPM = 1_000_000n;
/** Solana base fee per signature, charged on failed transactions too (solana.com/docs/core/fees). Input, not assumed. */
export const BASE_FEE_PER_SIGNATURE = 5_000n;
/**
 * Bound on integer rounding in one round trip, in lamports: per leg at most three ceil fees, one floor of the net
 * amount, the program's "net - 1", and one floor on the output. 16 leaves margin; the tests check v(q) stays under
 * the bound across the size range.
 */
export const ROUND_TRIP_ROUNDING_LAMPORTS = 16n;

/**
 * Buy for `spend` lamports (fees included), then sell every token back at the pre-entry price: the round trip with
 * zero price move. `paid - proceeds === venueFees + impact` exactly. The exit is priced on the pre-entry reserves,
 * while the real-reserve checks see the quote our own entry added (otherwise a fresh curve could never be exited).
 */
export interface RoundTrip {
  readonly spend: bigint;
  /** Lamports actually paid on entry, fees included (<= spend). */
  readonly paid: bigint;
  readonly tokens: bigint;
  /** Lamports received on exit, fees taken. */
  readonly proceeds: bigint;
  readonly entryFees: bigint;
  readonly exitFees: bigint;
  readonly entryImpact: bigint;
  readonly exitImpact: bigint;
}
export type RoundTripQuoter = (spend: bigint) => RoundTrip;

export const pumpCurveRoundTrip = (state: CurveState, ctx: CurveFeeContext): RoundTripQuoter => (spend) => {
  const buy = curveBuyExactQuoteIn(state, spend, ctx);
  if (buy.tokens <= 0n) throw new RangeError('spend buys no tokens');
  const sell = curveSell({ ...state, realQuoteReserves: state.realQuoteReserves + buy.quote, realTokenReserves: buy.after.realTokenReserves }, buy.tokens, ctx);
  return {
    spend, paid: buy.userQuote, tokens: buy.tokens, proceeds: sell.userQuote,
    entryFees: buy.protocolFee + buy.creatorFee, exitFees: sell.protocolFee + sell.creatorFee,
    entryImpact: buy.impact, exitImpact: sell.impact,
  };
};

export const pumpSwapRoundTrip = (pool: PoolState, ctx: PoolFeeContext): RoundTripQuoter => (spend) => {
  const buy = poolBuyExactQuoteIn(pool, spend, ctx);
  if (buy.base <= 0n) throw new RangeError('spend buys no tokens');
  // Same effective reserve as before entry; the vault holds what the entry added.
  const added = buy.quote + buy.lpFee;
  const sell = poolSell({ ...pool, quoteVault: pool.quoteVault + added, virtualQuoteReserves: pool.virtualQuoteReserves - added }, buy.base, ctx);
  return {
    spend, paid: buy.userQuote, tokens: buy.base, proceeds: sell.userQuote,
    entryFees: buy.lpFee + buy.protocolFee + buy.creatorFee, exitFees: sell.lpFee + sell.protocolFee + sell.creatorFee,
    entryImpact: buy.impact, exitImpact: sell.impact,
  };
};

/** Landing policy per transaction attempt. Priority fee and tip are policy choices, passed in. */
export interface NetworkPolicy {
  readonly signaturesPerTx: bigint;
  readonly baseFeePerSignature: bigint;
  /** Priority fee per attempt in lamports, billed on the requested CU limit (see `priorityFeeLamports`). */
  readonly entryPriorityFee: bigint;
  readonly exitPriorityFee: bigint;
  /** Tip per landed transaction (e.g. Helius Sender SWQoS-only). It reverts with a failed transaction. */
  readonly tip: bigint;
  /** Expected share of attempts that fail and are retried, in ppm (0 <= p < 1,000,000). */
  readonly entryFailurePpm: bigint;
  readonly exitFailurePpm: bigint;
}

/** Rent amounts from `getMinimumBalanceForRentExemption`, never hard-coded (SIMD-0437 keeps lowering them). */
export interface RentInputs {
  /** Rent of the token account opened on entry. */
  readonly tokenAccount: bigint;
  /** True when the exit sells the full balance and closes the account in the same transaction (rent comes back). */
  readonly tokenAccountClosedOnExit: boolean;
  /** Rent of one-time accounts still missing for this wallet (e.g. volume accumulators); 0 once they exist. */
  readonly oneTime: bigint;
  /** Rent created and closed inside one transaction (e.g. a WSOL account): needs cash, costs nothing. */
  readonly transient: bigint;
}

/**
 * Trade size policy from configuration (CLAUDE.md "Capital and trade size scale"): the trial uses $2 to $5, later
 * settings are larger. No size is a constant in code.
 */
export interface SizePolicy {
  readonly minNotional: MicroUsd;
  readonly maxNotional: MicroUsd;
  /** Largest round-trip price impact accepted at the real size, ppm of notional. Sets a depth cap from the pool. */
  readonly maxImpactPpm: bigint;
}

/** Caller limits on notional, in micro-dollars. Each one only lowers the maximum. */
export interface SizeCaps {
  /** Largest loss accepted on this trade. Worst case is the whole notional plus fixed costs. */
  readonly lossAllowance: MicroUsd;
  /** Any other depth limit the caller holds (e.g. from a router quote); the pool's own impact cap applies as well. */
  readonly executableDepth: MicroUsd;
  /** Spendable balance; must also cover fixed costs and locked or transient rent. */
  readonly cash: MicroUsd;
  /** Remaining risk budget (same worst case as the loss allowance). */
  readonly riskBudget: MicroUsd;
}

/** Ceil(base * p / (1 - p)): expected cost of failed attempts before one success, failure share p in ppm. */
export const expectedFailureCost = (failedAttemptCost: bigint, failurePpm: bigint): bigint => {
  if (failurePpm < 0n || failurePpm >= PPM) throw new RangeError('failure share must be in [0, 1,000,000) ppm');
  return mulDiv(failedAttemptCost, failurePpm, PPM - failurePpm, 'ceil');
};

/** Priority fee in lamports: ceil(CU price in micro-lamports * CU limit / 1e6), billed on the requested limit. */
export const priorityFeeLamports = (microLamportsPerCu: bigint, cuLimit: bigint): bigint => mulDiv(microLamportsPerCu, cuLimit, PPM, 'ceil');

export interface LegNetworkCost {
  /** Base fee, priority fee and tip of the landed transaction. */
  readonly landed: bigint;
  /** Expected base and priority fees of failed attempts. */
  readonly expectedFailures: bigint;
}

export interface FixedCosts {
  readonly entry: LegNetworkCost;
  readonly exit: LegNetworkCost;
  /** One-time rent charged to this trade. */
  readonly oneTimeRent: bigint;
  /** Token account rent that does not come back (account not closed on exit). */
  readonly unrecoveredRent: bigint;
  /** F: everything above. */
  readonly total: bigint;
  /** Locked during the trade and returned on exit (not part of F). */
  readonly recoverableRent: bigint;
}

const legNetwork = (net: NetworkPolicy, priority: bigint, failurePpm: bigint): LegNetworkCost => {
  if (net.signaturesPerTx < 1n || net.baseFeePerSignature < 0n || priority < 0n || net.tip < 0n) throw new RangeError('network inputs must be non-negative, with at least one signature');
  const base = net.signaturesPerTx * net.baseFeePerSignature;
  return { landed: base + priority + net.tip, expectedFailures: expectedFailureCost(base + priority, failurePpm) };
};

export const fixedCosts = (net: NetworkPolicy, rent: RentInputs): FixedCosts => {
  if (rent.tokenAccount < 0n || rent.oneTime < 0n || rent.transient < 0n) throw new RangeError('rent must be >= 0');
  const entry = legNetwork(net, net.entryPriorityFee, net.entryFailurePpm);
  const exit = legNetwork(net, net.exitPriorityFee, net.exitFailurePpm);
  const unrecoveredRent = rent.tokenAccountClosedOnExit ? 0n : rent.tokenAccount;
  const recoverableRent = rent.tokenAccountClosedOnExit ? rent.tokenAccount : 0n;
  return {
    entry, exit, oneTimeRent: rent.oneTime, unrecoveredRent, recoverableRent,
    total: entry.landed + entry.expectedFailures + exit.landed + exit.expectedFailures + rent.oneTime + unrecoveredRent,
  };
};

export interface CostAtSize {
  readonly roundTrip: RoundTrip;
  /** Venue fees and impact of both legs plus other proportional costs, in lamports. */
  readonly proportional: bigint;
  /** v(q) = proportional / paid, in ppm, rounded up. */
  readonly vPpm: bigint;
  readonly fixed: FixedCosts;
  /** Loss of a zero-price-move round trip: proportional + F. */
  readonly totalLoss: bigint;
}

/** Per-leg and round-trip cost of spending `spend` lamports. `extraPpm` adds other proportional costs (e.g. a router fee). */
export const costAtSize = (quote: RoundTripQuoter, spend: bigint, net: NetworkPolicy, rent: RentInputs, extraPpm = 0n): CostAtSize => {
  if (extraPpm < 0n) throw new RangeError('extra proportional cost must be >= 0');
  const roundTrip = quote(spend);
  const extra = mulDiv(roundTrip.paid, extraPpm, PPM, 'ceil');
  const proportional = roundTrip.entryFees + roundTrip.exitFees + roundTrip.entryImpact + roundTrip.exitImpact + extra;
  const fixed = fixedCosts(net, rent);
  return { roundTrip, proportional, vPpm: mulDiv(proportional, PPM, roundTrip.paid, 'ceil'), fixed, totalLoss: proportional + fixed.total };
};

/** Round-trip price impact at `spend`, ppm of what was paid, rounded up. */
export const roundTripImpactPpm = (quote: RoundTripQuoter, spend: bigint): bigint => {
  const r = quote(spend);
  return mulDiv(r.entryImpact + r.exitImpact, PPM, r.paid, 'ceil');
};

/** Argmax of a unimodal `f` over integers in [lo, hi] (ternary search, then the best of the last few points). */
const peakOf = (lo: bigint, hi: bigint, f: (q: bigint) => bigint): bigint => {
  let a = lo;
  let b = hi;
  while (b - a > 2n) {
    const m1 = a + (b - a) / 3n;
    const m2 = b - (b - a) / 3n;
    if (f(m1) < f(m2)) a = m1 + 1n; else b = m2;
  }
  let best = a;
  for (let q = a + 1n; q <= b; q++) if (f(q) > f(best)) best = q;
  return best;
};

/**
 * Largest spend in [lo, hi] whose `measure` stays at or below `limit`, or null if `lo` already exceeds it.
 * `measure` grows with size (constant-product impact does); the result is re-checked, so rounding noise can only make
 * it smaller, never unsafe.
 */
const largestWithin = (lo: bigint, hi: bigint, limit: bigint, measure: (q: bigint) => bigint): bigint | null => {
  if (measure(lo) > limit) return null;
  if (measure(hi) <= limit) return hi;
  let ok = lo;
  let bad = hi;
  while (bad - ok > 1n) {
    const mid = (ok + bad) / 2n;
    if (measure(mid) <= limit) ok = mid; else bad = mid;
  }
  return ok;
};

export type NoTradeReason =
  | 'caps-below-minimum'
  | 'impact-above-limit'
  | 'edge-not-above-cost'
  | 'break-even-above-maximum';

export interface SizeInput {
  readonly quote: RoundTripQuoter;
  readonly solPrice: MicroUsd;
  /** Conservative gross edge g, ppm of notional. */
  readonly edgePpm: bigint;
  readonly network: NetworkPolicy;
  readonly rent: RentInputs;
  readonly policy: SizePolicy;
  readonly caps: SizeCaps;
  /** Other proportional costs per round trip, ppm (e.g. a router fee on both legs). */
  readonly extraPpm?: bigint;
}

export interface SizeRange {
  readonly minLamports: bigint;
  readonly maxLamports: bigint;
  readonly minUsd: MicroUsd;
  readonly maxUsd: MicroUsd;
}

interface SizeCommon {
  readonly fixed: FixedCosts;
  /**
   * Upper bound of the proportional cost over the candidate range, ppm: v(q) plus a rounding allowance plus the cross
   * term g * v (costs also apply to the gain). Break-even is F / (g - vPpm).
   */
  readonly vPpm: bigint;
  /** Largest size every cap, the policy maximum and the pool allow. */
  readonly maxUsd: MicroUsd;
  /**
   * What set `maxUsd`: a cap, the policy maximum, the pool's impact limit, or `costLimit` when larger sizes cost more
   * (impact grows with size) than the edge pays.
   */
  readonly bindingCap: keyof SizeCaps | 'maxNotional' | 'impactLimit' | 'costLimit';
}

export type SizeDecision =
  | (SizeCommon & { readonly trade: true; readonly range: SizeRange; readonly breakEvenLamports: bigint; readonly expectedNetAtMaxUsd: MicroUsd })
  | (SizeCommon & { readonly trade: false; readonly reason: NoTradeReason; readonly breakEvenLamports?: bigint });

const minOf = <K extends string>(entries: readonly (readonly [K, bigint])[]): readonly [K, bigint] =>
  entries.reduce((a, b) => (b[1] < a[1] ? b : a));

/**
 * The sizes in [policy.minNotional, policy.maxNotional] worth taking: expected net q * (g - v) - F > 0 within every cap,
 * with v the largest v(q) over the candidate range plus a rounding allowance, so the answer is conservative. Impact is
 * quoted from the pool at each real size; sizes whose impact passes the policy limit, or that lie past the size where
 * expected net q * (g - v(q)) peaks, are cut off the top of the range.
 */
export const feasibleSize = (input: SizeInput): SizeDecision => {
  const { quote, solPrice, edgePpm, network, rent, policy, caps } = input;
  const extraPpm = input.extraPpm ?? 0n;
  if (solPrice <= 0n) throw new RangeError('SOL price must be > 0');
  if (policy.minNotional <= 0n || policy.maxNotional < policy.minNotional) throw new RangeError('size policy needs 0 < minNotional <= maxNotional');
  if (policy.maxImpactPpm < 0n) throw new RangeError('impact limit must be >= 0');
  const fixed = fixedCosts(network, rent);
  const fixedUsd = lamportsToMicroUsd(lamports(fixed.total), solPrice, 'ceil');
  const cashNeedsUsd = fixedUsd + lamportsToMicroUsd(lamports(fixed.recoverableRent + rent.transient), solPrice, 'ceil');
  let [bindingCap, maxUsdRaw] = minOf<SizeCommon['bindingCap']>([
    ['maxNotional', policy.maxNotional],
    ['lossAllowance', caps.lossAllowance - fixedUsd],
    ['riskBudget', caps.riskBudget - fixedUsd],
    ['executableDepth', caps.executableDepth],
    ['cash', caps.cash - cashNeedsUsd],
  ]);
  const lo = microUsdToLamports(policy.minNotional, solPrice, 'ceil');
  let hi = maxUsdRaw < policy.minNotional ? 0n : microUsdToLamports(maxUsdRaw as MicroUsd, solPrice, 'floor');
  const reject = (reason: NoTradeReason, vPpm: bigint, breakEven?: bigint): SizeDecision => ({
    trade: false, reason, fixed, vPpm, maxUsd: maxUsdRaw as MicroUsd, bindingCap, ...(breakEven === undefined ? {} : { breakEvenLamports: breakEven }),
  });
  if (hi < lo) return reject('caps-below-minimum', 0n);

  // Depth from the pool itself: the largest size whose round-trip impact stays within policy.
  const impactCap = largestWithin(lo, hi, policy.maxImpactPpm, (q) => roundTripImpactPpm(quote, q));
  if (impactCap === null) { bindingCap = 'impactLimit'; return reject('impact-above-limit', 0n); }
  if (impactCap < hi) { hi = impactCap; bindingCap = 'impactLimit'; maxUsdRaw = lamportsToMicroUsd(lamports(hi), solPrice, 'floor'); }

  const allowance = mulDiv(ROUND_TRIP_ROUNDING_LAMPORTS, PPM, lo, 'ceil');
  // Fees and impact also take their share of the gain: net ~ q * (g - v - g*v), so the cross term counts as cost.
  const vAt = (q: bigint) => {
    const v = costAtSize(quote, q, network, rent, extraPpm).vPpm + allowance;
    return v + mulDiv(edgePpm > 0n ? edgePpm : 0n, v, PPM, 'ceil');
  };
  if (edgePpm <= vAt(lo)) return reject('edge-not-above-cost', vAt(lo));
  // Impact grows with size, so q * (g - v(q)) rises and then falls. Past its peak a larger trade earns less in
  // expectation while risking more: cut the range there.
  const peak = peakOf(lo, hi, (q) => q * (edgePpm - vAt(q)));
  if (peak < hi) { hi = peak; bindingCap = 'costLimit'; maxUsdRaw = lamportsToMicroUsd(lamports(hi), solPrice, 'floor'); }

  const vLo = vAt(lo);
  const vHi = vAt(hi);
  const vPpm = vLo > vHi ? vLo : vHi;
  const common = { fixed, vPpm, maxUsd: maxUsdRaw as MicroUsd, bindingCap };
  const margin = edgePpm - vPpm;
  const breakEvenLamports = mulDiv(fixed.total, PPM, margin, 'ceil');
  // Smallest q with q * margin > F * 1e6 (strictly positive expected net).
  const firstProfitable = (fixed.total * PPM) / margin + 1n;
  const min = firstProfitable > lo ? firstProfitable : lo;
  if (min > hi) return { ...common, trade: false, reason: 'break-even-above-maximum', breakEvenLamports };

  // >= 0 because hi >= firstProfitable.
  const netAtMax = mulDiv(hi, margin, PPM, 'floor') - fixed.total;
  return {
    ...common, trade: true, breakEvenLamports,
    range: {
      minLamports: min, maxLamports: hi,
      minUsd: lamportsToMicroUsd(lamports(min), solPrice, 'ceil'),
      maxUsd: lamportsToMicroUsd(lamports(hi), solPrice, 'floor'),
    },
    expectedNetAtMaxUsd: lamportsToMicroUsd(lamports(netAtMax), solPrice, 'floor'),
  };
};
