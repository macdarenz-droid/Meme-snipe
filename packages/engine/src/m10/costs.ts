// A-M10-03 cost model and fixed-cost amortisation (card Z09; ARCH 2.1-2.4, addendum A07, clarifications C-28, C-50,
// C-77). Pure, bigint lamports only. Adapts Zeroed's lamport cost maths (packages/core/src/costs: ceil on every fee,
// the exact round trip on one pool state) to the Blueprint's three rows.
//
// The engine does not depend on @bot/venue: the pool is priced through `PoolPricing`, which the composition root binds
// to `quoteExactIn` (A-M01-03) on one snapshot and one venue config. Every quote error ends in the effectively infinite
// cost (`INFINITE_COST_BPS`), never 0: `E_ZERO_OUTPUT` (C-85: the dust case of the edge-case rule) and any other
// refusal (fee unknown, a sell above the real vault) alike, because a size that cannot be priced cannot be traded.
//
// Probabilities are doubles in the parameter set; they enter the lamport maths as parts per million
// (`Math.round(p × 10^6)`, exact for every prior: 0.2, 0.05, 0.1, 0.145), and every product is rounded up.
//
// Builder readings (DECISIONS Z09):
// - the strict row's priority is "D15 High at the entry cap"; it is never below the lean priority, so the property
//   lean ≤ strict ≤ conservative holds at small sizes where the cap (20 bps of notional) is under the lean value;
// - the rung-2 term uses the row's own entry priority (lean: the lean priority; strict: the strict priority);
// - `fixedShareBps('conservative')` counts the dust-deposit close with the unrecovered rent (both are fixed lamports).
import type { Bps, Lamports, Result } from '@bot/types';
import type { SimParamSet } from './params.ts';

/** [LD-01] base fee per signature. */
export const BASE_FEE_LAMPORTS = 5_000n;
/** ARCH 1.4, 8.3: the entry priority cap is min(50,000 lamports, 20 bps of notional). */
export const PRIORITY_CAP_LAMPORTS = 50_000n;
export const PRIORITY_CAP_BPS = 20n;
/** Edge case: `out = 0` (or any unpriceable round trip) costs 10,000 × 100 bps. */
export const INFINITE_COST_BPS = 1_000_000 as Bps;
/** POLICY (C-50, RS-06): unrecovered rent prior, 14.5% of the round trip's rent-exempt deposits. Unmeasured. */
export const LOST_RENT_RATE = 0.145;
/** DERIVED [LD-14]: one Token-2022 ATA (170 bytes) is 1,513,840 lamports; the round trip's deposit when none is given. */
export const T22_ATA_RENT_LAMPORTS = 1_513_840n as Lamports;
/** Zeroed's fixed cost per round trip [RS-06]: a sensitivity line beside the rows, never a gate input (ARCH 2.3). */
export const ZEROED_SENSITIVITY_LAMPORTS = 414_009n as Lamports;
/** ARCH `DEPTHPCT`: a size above 0.5% of min(real, effective) quote depth is refused at entry. */
export const DEPTH_CAP_BPS = 50n;
/** The owner's size sweep (CLAUDE.md "Size is not the trial"). */
export const SWEEP_USD: readonly number[] = [5, 20, 100, 1_000, 10_000];

const BPS = 10_000n;
const PPM = 1_000_000n;
const ceilDiv = (a: bigint, b: bigint): bigint => (a <= 0n ? 0n : (a + b - 1n) / b);
const ppm = (p: number): bigint => BigInt(Math.round(p * 1_000_000));
const ofPpm = (amount: bigint, p: bigint): bigint => ceilDiv(amount * p, PPM);
const toBps = (amount: bigint, notional: bigint): number => {
  const bps = ceilDiv(amount * BPS, notional);
  return Number(bps);
};

/** One exact leg on the snapshot. `E_ZERO_OUTPUT` and every other refusal of `quoteExactIn` come back as the code. */
export type PricingQuote = Result<{ amountOut: bigint; venueFeeLamports: bigint }, { code: string }>;
export interface PoolPricing {
  /** Effective quote (real + virtual) and the real quote vault, lamports. */
  effectiveQuoteLamports: bigint;
  realQuoteLamports: bigint;
  quote(side: 'buy' | 'sell', amountIn: bigint): PricingQuote;
}

export type CostRow = 'lean' | 'strict' | 'conservative';
export interface CostBreakdown {
  row: CostRow;
  venueFeesLamports: Lamports; impactLamports: Lamports; legFixedLamports: Lamports; failedOverheadLamports: Lamports;
  janitorLamports: Lamports; rung2ExpectedLamports: Lamports; sandwichLamports: Lamports; stuckLamports: Lamports;
  lostRentLamports: Lamports; dustLamports: Lamports; gStarBps: Bps;
  assumptions: { cuPriceMicroLamports: bigint; priorityLamports: Lamports; tipLamports: Lamports; fFail: number; pSw: number; lostRentRate: number };
}
export interface CostRows { lean: CostBreakdown; strict: CostBreakdown; conservative: CostBreakdown }
/** A round trip that could not be priced: the reason, and the infinite cost every row then carries. */
export interface Unpriced { unpriced: string; gStarBps: Bps }

export type CostError = { code: 'E_INVALID_ARG' | 'E_INVALID_SLIPPAGE'; detail: string };
const bad = (code: CostError['code'], detail: string): { ok: false; error: CostError } => ({ ok: false, error: { code, detail } });

export interface CostOptions {
  includeJanitor?: boolean;
  includeRung2?: boolean;
  /** Strict and conservative rows: the strategy's slippage bounds (integers 0-10,000 bps); required for those rows. */
  slippage?: { entryBps: number; exitBps: number };
  /** The round trip's rent-exempt deposits (conservative row); default one Token-2022 ATA [LD-14]. */
  rentDepositsLamports?: bigint;
}
export interface CostLog { event(level: 'info' | 'warn', code: string, fields: Readonly<Record<string, unknown>>): void }

interface RoundTrip { out: bigint; venueFees: bigint }
/** Logic 1: buy `notional`, then sell every token on the same pre-trade state (impact charged on both sides). */
function roundTrip(p: PoolPricing, notional: bigint): Result<RoundTrip, { code: string }> {
  const buy = p.quote('buy', notional);
  if (!buy.ok) return buy;
  const sell = p.quote('sell', buy.value.amountOut);
  if (!sell.ok) return sell;
  if (sell.value.amountOut <= 0n) return { ok: false, error: { code: 'E_ZERO_OUTPUT' } };
  return { ok: true, value: { out: sell.value.amountOut, venueFees: buy.value.venueFeeLamports + sell.value.venueFeeLamports } };
}

/** `ceil(cuPrice × cuLimit / 10^6)` [LD-02] (B-M19-01's `priorityFeeLamports`). */
export const priorityLamports = (cuPriceMicroLamports: bigint, cuLimit: number): bigint => ceilDiv(cuPriceMicroLamports * BigInt(cuLimit), PPM);
/** min(50,000 lamports, 20 bps of notional), ARCH 1.4 and 8.3. */
export const entryPriorityCap = (notional: bigint): bigint => {
  const bpsCap = (notional * PRIORITY_CAP_BPS) / BPS;
  return bpsCap < PRIORITY_CAP_LAMPORTS ? bpsCap : PRIORITY_CAP_LAMPORTS;
};

const slippageOk = (s: number): boolean => Number.isInteger(s) && s >= 0 && s <= 10_000;

interface Landing { priority: bigint; tip: bigint; cuPrice: bigint }
function rowCost(row: CostRow, rt: RoundTrip, notional: bigint, set: SimParamSet, land: Landing, o: CostOptions): CostBreakdown {
  const fFail = ppm(set.fFailEntry);
  const fFailExit = ppm(set.fFailExit);
  const fExp = ppm(set.fExp);
  const legFixed = BASE_FEE_LAMPORTS + land.priority + land.tip;
  // Logic 3: fFail / (1 − fFail) × (base + priority) per leg.
  const failedPerLeg = ceilDiv(fFail * (BASE_FEE_LAMPORTS + land.priority), PPM - fFail);
  const janitorOne = BASE_FEE_LAMPORTS + set.cost.janitorPriorityLamports + set.cost.senderTipLamports;
  const janitor = o.includeJanitor === false ? 0n : janitorOne;
  // Logic 5: P(rung ≥ 2) = 1 − (1 − fFailExit)(1 − fExp); the extra is the Jito tip plus one more entry priority.
  const pRung2 = PPM - ((PPM - fFailExit) * (PPM - fExp)) / PPM;
  const rung2 = o.includeRung2 === false ? 0n : ofPpm(set.cost.jitoTipLamports + land.priority, pRung2);
  let sandwich = 0n, stuck = 0n, lostRent = 0n, dust = 0n;
  if (row !== 'lean') {
    const s = o.slippage as { entryBps: number; exitBps: number };
    sandwich = ofPpm(ceilDiv(BigInt(s.entryBps) * notional, BPS), ppm(set.pSwEntry)) + ofPpm(ceilDiv(BigInt(s.exitBps) * rt.out, BPS), ppm(set.pSwExit));
    stuck = ceilDiv(fFailExit * fFailExit * fFailExit * rt.out, PPM * PPM * PPM);
  }
  if (row === 'conservative') {
    lostRent = ofPpm(o.rentDepositsLamports ?? T22_ATA_RENT_LAMPORTS, ppm(LOST_RENT_RATE));
    dust = janitorOne;
  }
  const F = 2n * legFixed + 2n * failedPerLeg + janitor + rung2 + sandwich + stuck + lostRent + dust;
  // Logic 6: g* = (notional + F) / out − 1, rounded up.
  const g = notional + F - rt.out;
  const gStar = g <= 0n ? 0 : Number(ceilDiv(g * BPS, rt.out));
  return {
    row,
    venueFeesLamports: rt.venueFees as Lamports,
    impactLamports: (notional - rt.out - rt.venueFees > 0n ? notional - rt.out - rt.venueFees : 0n) as Lamports,
    legFixedLamports: (2n * legFixed) as Lamports, failedOverheadLamports: (2n * failedPerLeg) as Lamports,
    janitorLamports: janitor as Lamports, rung2ExpectedLamports: rung2 as Lamports, sandwichLamports: sandwich as Lamports,
    stuckLamports: stuck as Lamports, lostRentLamports: lostRent as Lamports, dustLamports: dust as Lamports,
    gStarBps: Math.min(gStar, INFINITE_COST_BPS) as Bps,
    assumptions: {
      cuPriceMicroLamports: land.cuPrice, priorityLamports: land.priority as Lamports, tipLamports: land.tip as Lamports,
      fFail: set.fFailEntry, pSw: row === 'lean' ? 0 : set.pSwEntry, lostRentRate: row === 'conservative' ? LOST_RENT_RATE : 0,
    },
  };
}

function landingOf(set: SimParamSet, landing: 'lean' | 'premium'): Landing {
  const cuPrice = landing === 'lean' ? set.cost.leanCuPriceMicroLamports : set.cost.premiumCuPriceMicroLamports;
  return { cuPrice, priority: priorityLamports(cuPrice, set.cost.cuLimit), tip: landing === 'lean' ? set.cost.senderTipLamports : set.cost.premiumTipLamports };
}

function checkNotional(notional: bigint): CostError | null {
  return notional > 0n ? null : { code: 'E_INVALID_ARG', detail: 'notional must be > 0' };
}

/**
 * ARCH M10 `estimateRoundTripCostBps` (logic 1-6): the lean-row formula with lean or premium landing. Never 0 for a
 * round trip that cannot be priced: `INFINITE_COST_BPS`, logged with the quote's code.
 */
export function estimateRoundTripCostBps(p: PoolPricing, notional: bigint, landing: 'lean' | 'premium', set: SimParamSet,
  o: Pick<CostOptions, 'includeJanitor' | 'includeRung2'> = {}, log?: CostLog): Bps {
  if (notional <= 0n) throw { code: 'E_INVALID_ARG' };
  const rt = roundTrip(p, notional);
  if (!rt.ok) {
    log?.event('warn', 'm10.cost_unpriced', { reason: rt.error.code });
    return INFINITE_COST_BPS;
  }
  return rowCost('lean', rt.value, notional, set, landingOf(set, landing), o).gStarBps;
}

/** Logic 7: `ceil(M × 10,000 / (30 × tradesPerDay × notional))`; `E_INVALID_ARG` on tradesPerDay ≤ 0 or notional 0 (C-28). */
export function fixedCostBpsPerTrade(fixedMonthlyLamports: bigint, tradesPerDay: number, notional: bigint): Bps {
  if (!(Number.isFinite(tradesPerDay) && tradesPerDay > 0) || notional <= 0n || fixedMonthlyLamports < 0n) throw { code: 'E_INVALID_ARG' };
  // tradesPerDay may be fractional; scale it to parts per million so the division stays exact.
  const tpd = BigInt(Math.round(tradesPerDay * 1_000_000));
  if (tpd <= 0n) throw { code: 'E_INVALID_ARG' };
  const bps = ceilDiv(fixedMonthlyLamports * BPS * PPM, 30n * tpd * notional);
  return Number(bps) as Bps;
}

/**
 * Logic 9: the lean, strict and conservative rows on the same round trip. The strict and conservative rows need the
 * strategy's slippage bounds (`E_INVALID_SLIPPAGE` when missing or outside 0-10,000). An unpriceable round trip gives
 * `{ unpriced }` with the infinite cost.
 */
export function costRows(p: PoolPricing, notional: bigint, set: SimParamSet, o: CostOptions = {}, log?: CostLog): Result<CostRows | Unpriced, CostError> {
  const n = checkNotional(notional);
  if (n !== null) return { ok: false, error: n };
  if (o.slippage === undefined) return bad('E_INVALID_SLIPPAGE', 'the strict and conservative rows need the strategy slippage bounds');
  if (!slippageOk(o.slippage.entryBps) || !slippageOk(o.slippage.exitBps)) return bad('E_INVALID_SLIPPAGE', 'slippage bounds must be integers 0-10,000 bps');
  if (o.rentDepositsLamports !== undefined && o.rentDepositsLamports < 0n) return bad('E_INVALID_ARG', 'rent deposits must be >= 0');
  const rt = roundTrip(p, notional);
  if (!rt.ok) {
    log?.event('warn', 'm10.cost_unpriced', { reason: rt.error.code });
    return { ok: true, value: { unpriced: rt.error.code, gStarBps: INFINITE_COST_BPS } };
  }
  const lean = landingOf(set, 'lean');
  const cap = entryPriorityCap(notional);
  const strictPriority = cap > lean.priority ? cap : lean.priority;
  const strict: Landing = { cuPrice: ceilDiv(strictPriority * PPM, BigInt(set.cost.cuLimit)), priority: strictPriority, tip: set.cost.senderTipLamports };
  return {
    ok: true,
    value: {
      lean: rowCost('lean', rt.value, notional, set, lean, o),
      strict: rowCost('strict', rt.value, notional, set, strict, o),
      conservative: rowCost('conservative', rt.value, notional, set, strict, o),
    },
  };
}

export const isUnpriced = (r: CostRows | Unpriced): r is Unpriced => 'unpriced' in r;

/** The row's fixed lamports (legs, failed overhead, janitor, rung-2, plus rent and dust in the conservative row) ÷ notional. */
export function fixedLamportsOf(b: CostBreakdown): bigint {
  return b.legFixedLamports + b.failedOverheadLamports + b.janitorLamports + b.rung2ExpectedLamports + b.lostRentLamports + b.dustLamports;
}
export function fixedShareBps(b: CostBreakdown, notional: bigint): Bps {
  if (notional <= 0n) throw { code: 'E_INVALID_ARG' };
  return toBps(fixedLamportsOf(b), notional) as Bps;
}
/** The 414,009-lamport sensitivity line in bps of notional (never a gate input). */
export const sensitivityBps = (notional: bigint): Bps => {
  if (notional <= 0n) throw { code: 'E_INVALID_ARG' };
  return toBps(ZEROED_SENSITIVITY_LAMPORTS, notional) as Bps;
};

/** USD to lamports at a SOL/USD price, rounded to nearest (ARCH 2.2 at $150: $5 = 33,333,333; $10 = 66,666,667). */
/** `solUsd` is required (ruling Z09-5): ARCH Table 2-A's $150 is a test value, never a hidden default. */
export function usdToLamports(usd: number, solUsd: number): bigint {
  if (!(Number.isFinite(usd) && usd > 0 && Number.isFinite(solUsd) && solUsd > 0)) throw { code: 'E_INVALID_ARG' };
  // Cents and micro-dollars keep it exact for every sweep size and any recorded price with 6 decimals.
  const u = BigInt(Math.round(usd * 100));
  const s = BigInt(Math.round(solUsd * 1_000_000));
  return (u * 10_000n * 1_000_000_000n * 2n + s) / (2n * s);
}

/** One size of the sweep: gross move needed, fixed costs, percentage fees and impact on min(real, effective) depth, apart. */
export interface SweepRowParts { venueFeesBps: Bps; impactBps: Bps; fixedBps: Bps; otherBps: Bps; gStarBps: Bps }
export interface SweepRow {
  usd: number; sizeLamports: Lamports; depthLamports: Lamports;
  /** Size ≤ 0.5% of min(real, effective) quote depth (ARCH `DEPTHPCT`). */
  withinDepthCap: boolean;
  unpriced: string | null;
  rows: Record<CostRow, SweepRowParts> | null;
  sensitivityBps: Bps;
}

/**
 * The owner's size sweep ($5, $20, $100, $1,000, $10,000): every row's cost split into venue fees, impact, fixed costs
 * and the rest (sandwich, stuck), all priced on `minDepth`, the pool at min(real, effective) quote depth (the caller
 * builds it: the same spot price with the quote reserve at the smaller of the two). `gStarBps` is the gross move a trade
 * needs before costs to break even.
 */
/**
 * `solUsd` is a required input with its source (ruling Z09-5); sizes are computed in lamports and the dollar amount is
 * only the row label (ruling Z09-6: profit in SOL).
 */
export function sizeSweep(minDepth: PoolPricing, set: SimParamSet, o: CostOptions, solUsd: number, sizesUsd: readonly number[] = SWEEP_USD, log?: CostLog):
  Result<SweepRow[], CostError> {
  const depth = minDepth.realQuoteLamports < minDepth.effectiveQuoteLamports ? minDepth.realQuoteLamports : minDepth.effectiveQuoteLamports;
  const out: SweepRow[] = [];
  for (const usd of sizesUsd) {
    const size = usdToLamports(usd, solUsd);
    const r = costRows(minDepth, size, set, o, log);
    if (!r.ok) return r;
    const base = { usd, sizeLamports: size as Lamports, depthLamports: (depth > 0n ? depth : 0n) as Lamports,
      withinDepthCap: depth > 0n && size * BPS <= depth * DEPTH_CAP_BPS, sensitivityBps: sensitivityBps(size) };
    if (isUnpriced(r.value)) { out.push({ ...base, unpriced: r.value.unpriced, rows: null }); continue; }
    const v = r.value;
    const parts = (b: CostBreakdown): SweepRowParts => ({
      venueFeesBps: toBps(b.venueFeesLamports, size) as Bps, impactBps: toBps(b.impactLamports, size) as Bps,
      fixedBps: toBps(fixedLamportsOf(b), size) as Bps, otherBps: toBps(b.sandwichLamports + b.stuckLamports, size) as Bps, gStarBps: b.gStarBps,
    });
    out.push({ ...base, unpriced: null, rows: { lean: parts(v.lean), strict: parts(v.strict), conservative: parts(v.conservative) } });
  }
  return { ok: true, value: out };
}
