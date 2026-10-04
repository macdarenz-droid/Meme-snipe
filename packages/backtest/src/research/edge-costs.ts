// RES-4 cost math (docs/research/edge.md §1): break-even price move and win rate per setup, as the outcome stage
// (outcome.ts) scores a trade: the same constants (scoringTerms), exact CORE-2 quotes on mainnet fee configs
// (research/edge/snapshot), the conservative scenario and RENT-1's close outcome.
//   node --no-warnings packages/backtest/src/research/edge-costs.ts    prints the tables (markdown) and writes research/edge/costs.json
// Only PumpSwap is scored: the proof's fills land on PumpSwap; the curve is paper-only research (ARCHITECTURE §3.1).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type FeeConfig, type FeeSplit, type PoolFeeContext, type PoolState, poolFees } from '../../../core/src/amm/index.ts';
import { FILL_CONFIG, TRIAL_POLICY } from '../../../core/src/config/index.ts';
import { pumpSwapRoundTrip } from '../../../core/src/costs/index.ts';
import { bps } from '../../../core/src/units/index.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
/** SOL/USD used for sizes (docs/RESEARCH.md: research dated 2026-10-03, SOL about $119.26). */
export const SOL_USD = 119.26;
export const SIZES_USD = [2, 5, 20] as const;
const SUPPLY = 1_000_000_000_000_000n; // 1B tokens, 6 decimals

type RawFees = { lp_fee_bps: string; protocol_fee_bps: string; creator_fee_bps: string };
type RawFeeConfig = { flat_fees: RawFees; exotic_flat_fees: RawFees; fee_tiers: { market_cap_lamports_threshold: string; fees: RawFees }[] };
const split = (f: RawFees): FeeSplit => ({ lp: bps(Number(f.lp_fee_bps)), protocol: bps(Number(f.protocol_fee_bps)), creator: bps(Number(f.creator_fee_bps)) });
/** The live PumpSwap FeeConfig snapshot (also used by CORE-2's tests). */
export const AMM_FEES: FeeConfig = (() => {
  const raw = (JSON.parse(readFileSync(join(ROOT, 'research', 'edge', 'snapshot', 'fee-configs.json'), 'utf8')) as { amm: RawFeeConfig }).amm;
  return { flatFees: split(raw.flat_fees), exoticFlatFees: split(raw.exotic_flat_fees), feeTiers: raw.fee_tiers.map((t) => ({ marketCapThreshold: BigInt(t.market_cap_lamports_threshold), fees: split(t.fees) })) };
})();

/**
 * The constants the outcome stage (outcome.ts `scoreCandidates`) charges, derived from the same configuration the same
 * way: the landed entry and exit, one failed exit attempt (base + the third ladder rung's priority, all paid), the
 * PumpSwap failure rate, the ladder length and RENT-1's close and dust shares. The parity test in edge.test.ts checks
 * these against the outcome stage's own scores.
 */
const scen = FILL_CONFIG.scenarios.conservative;
const net = FILL_CONFIG.network;
const ladder = TRIAL_POLICY.exits.ladder;
const base = net.signaturesPerTx * net.baseFeePerSignature;
export const terms = {
  entryLanded: base + net.entryPriorityFee + net.tip,
  exitFixed: base + ladder.steps[0]!.priorityFeeLamports + net.tip,
  failedExit: base + ladder.steps[Math.min(2, ladder.steps.length - 1)]!.priorityFeeLamports,
  failProbability: 1 - Number(scen.landPpm.pumpswap) / 1e6,
  maxAttempts: ladder.maxAttempts,
  rent: net.tokenAccountRent,
  closeSuccess: Number(scen.closeSuccessPpm) / 1e6,
  dust: Number(scen.dustPpm) / 1e6,
} as const;
/** Expected failed exit attempts on the ladder: Σ_{k=1..max} f^k (the k-th failure needs k failures in a row). */
export const expectedFailedExits = (): number => {
  let e = 0;
  for (let k = 1; k <= terms.maxAttempts; k++) e += terms.failProbability ** k;
  return e;
};
/** RENT-1: rent back when the sell-and-close lands with no dust; a close that fails without dust pays one failed exit. */
export const rentBack = terms.closeSuccess * (1 - terms.dust);
const failedClose = (1 - terms.closeSuccess) * (1 - terms.dust);
/** Expected fixed lamports per filled round trip, exactly as the outcome stage charges them. */
export const expectedFixed = (): number =>
  Number(terms.entryLanded) + Number(terms.exitFixed) + expectedFailedExits() * Number(terms.failedExit)
  + (1 - rentBack) * Number(terms.rent) + failedClose * Number(terms.failedExit);

// TX-1 uses PumpSwap's v1 instructions on SOL pools; v1 and v2 price the same (pump-swap.ts).
export const poolCtx = (fees: FeeConfig = AMM_FEES): PoolFeeContext => ({ feeConfig: fees, canonical: true, quote: 'sol', baseSupply: SUPPLY, creatorFeeCharged: true, coin: { mayhemMode: false, transferFee: false, transferHook: false }, instruction: 'v1', buybackFeeBps: bps(5000) });

// A fresh graduate: ~67.4 SOL real + ~17.6 SOL virtual (BOOST) against ~206.9M tokens, ~411 SOL market cap.
const young: PoolState = { baseReserve: 206_900_000_000_000n, quoteVault: 67_400_000_000n, virtualQuoteReserves: 17_600_000_000n };
// The smallest U1 pool: $50k of quote (H8, U1 floor) on the migration's constant product, BOOST spent.
const k = (young.quoteVault + young.virtualQuoteReserves) * young.baseReserve;
const u1Quote = BigInt(Math.ceil((50_000 / SOL_USD) * 1e9));
const u1: PoolState = { baseReserve: k / u1Quote, quoteVault: u1Quote, virtualQuoteReserves: 0n };
const tierBps = (p: PoolState): number => {
  const f = poolFees(p, poolCtx());
  return f.lp + f.protocol + f.creator;
};
// U1's worst allowed tier (1.15%), forced on the same pool to bound the cost from above.
const worst: FeeConfig = { ...AMM_FEES, feeTiers: [{ marketCapThreshold: 0n, fees: AMM_FEES.feeTiers.find((t) => t.fees.lp + t.fees.protocol + t.fees.creator === 115)!.fees }] };

export interface Setup {
  readonly id: string;
  readonly label: string;
  readonly pool: PoolState;
  readonly ctx: PoolFeeContext;
  readonly feeBps: number;
}
export const SETUPS: readonly Setup[] = [
  { id: 'young', label: 'young PumpSwap (at migration, ~411 SOL cap)', pool: young, ctx: poolCtx(), feeBps: tierBps(young) },
  { id: 'u1', label: `U1 survivor ($50k quote, ~${Math.round(Number((u1.quoteVault * SUPPLY) / u1.baseReserve) / 1e9)} SOL cap)`, pool: u1, ctx: poolCtx(), feeBps: tierBps(u1) },
  { id: 'u1-1.15', label: 'U1 survivor at the 1.15% tier (upper bound)', pool: u1, ctx: poolCtx(worst), feeBps: 115 },
];

export interface Row {
  readonly setup: string;
  readonly usd: number;
  readonly feeBps: number;
  /** Lamports paid on entry (fees included): the base of every percentage. */
  readonly paid: number;
  /** Venue fees and impact, both legs, lamports and % of paid. */
  readonly proportional: number;
  readonly proportionalPct: number;
  readonly fixedLamports: number;
  readonly fixedPct: number;
  /** Break-even gross move: proportional + fixed. */
  readonly breakEvenPct: number;
  /** Sensitivity: rent never comes back. */
  readonly breakEvenNoRentPct: number;
}

/** One row: a zero-move round trip of `spend` lamports on `pool`, with the outcome stage's expected fixed costs. */
export const costRow = (setup: string, usd: number, feeBps: number, pool: PoolState, ctx: PoolFeeContext, spend: bigint): Row => {
  const q = pumpSwapRoundTrip(pool, ctx)(spend);
  if (!q.ok) throw new Error(`${setup} $${usd}: ${q.reason}`);
  const t = q.trade;
  const paid = Number(t.paid);
  const proportional = Number(t.entryFees + t.exitFees + t.entryImpact + t.exitImpact);
  const fixed = expectedFixed();
  const pct = (x: number) => (100 * x) / paid;
  return {
    setup, usd, feeBps, paid, proportional, proportionalPct: pct(proportional), fixedLamports: Math.round(fixed), fixedPct: pct(fixed),
    breakEvenPct: pct(proportional + fixed), breakEvenNoRentPct: pct(proportional + fixed + rentBack * Number(terms.rent)),
  };
};

export const spendOf = (usd: number): bigint => BigInt(Math.floor((usd / SOL_USD) * 1e9));
export const rows = (): Row[] => SETUPS.flatMap((s) => SIZES_USD.map((usd) => costRow(s.id, usd, s.feeBps, s.pool, s.ctx, spendOf(usd))));

/** Break-even win rate of a bracket exit: win +W, lose −L (gross moves), cost c per trade: p = (L + c) / (W + L). */
export const breakEvenWinRate = (winPct: number, lossPct: number, costPct: number): number => (lossPct + costPct) / (winPct + lossPct);
export const BRACKETS = [[10, 5], [20, 10], [30, 15], [50, 20]] as const;

if (import.meta.main) {
  const r = rows();
  const f = (x: number, d = 2) => x.toFixed(d);
  const lines = [
    `Conservative scenario, PumpSwap: an exit attempt fails ${f(terms.failProbability * 100, 0)}% of the time and each failure pays ${terms.failedExit.toLocaleString('en-US')} lamports (${f(expectedFailedExits(), 4)} expected); rent back ${f(rentBack * 100, 1)}%; a close that fails without dust pays one more failed attempt. SOL $${SOL_USD}.`,
    '',
    '| Setup | Size | Fee/side | Fees+impact (both legs) | Fixed (lamports) | Fixed % | Break-even move | Break-even, no rent back |',
    '|---|---|---|---|---|---|---|---|',
    ...r.map((x) => `| ${SETUPS.find((s) => s.id === x.setup)!.label} | $${x.usd} | ${f(x.feeBps / 100)}% | ${f(x.proportionalPct)}% | ${x.fixedLamports.toLocaleString('en-US')} | ${f(x.fixedPct)}% | **${f(x.breakEvenPct)}%** | ${f(x.breakEvenNoRentPct)}% |`),
    '',
    `| Setup | Size | ${BRACKETS.map(([w, l]) => `+${w}/−${l}`).join(' | ')} |`,
    `|---|---|${BRACKETS.map(() => '---').join('|')}|`,
    ...r.map((x) => `| ${x.setup} | $${x.usd} | ${BRACKETS.map(([w, l]) => `${f(100 * breakEvenWinRate(w, l, x.breakEvenPct), 1)}%`).join(' | ')} |`),
  ];
  console.log(lines.join('\n'));
  writeFileSync(join(ROOT, 'research', 'edge', 'costs.json'), JSON.stringify({ solUsd: SOL_USD, rentBack, rows: r }, null, 2) + '\n');
}
