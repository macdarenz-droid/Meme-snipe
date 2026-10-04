// RES-4 cost math (docs/research/edge.md §1): break-even price move and win rate per setup, as the proof scores it.
//   node --no-warnings packages/backtest/src/research/edge-costs.ts    prints the tables (markdown) and writes research/edge/costs.json
// Exact CORE-2 quotes on mainnet fee configs (packages/core/test/amm/fixtures), the conservative fill scenario and the
// policy's ladder; rent refunded only when the atomic sell-and-close lands (DECISIONS "Rent", RENT-1).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CurveState, type PoolState, poolFees } from '../../../core/src/amm/index.ts';
import { FILL_CONFIG, TRIAL_POLICY } from '../../../core/src/config/index.ts';
import { costAtSize, pumpCurveRoundTrip, pumpSwapRoundTrip, type RoundTripQuoter } from '../../../core/src/costs/index.ts';
import { bps } from '../../../core/src/units/index.ts';
import { AMM_FEE_CONFIG, CHECKED_GLOBAL, NORMAL_COIN, PUMP_FEE_CONFIG, PUMP_GLOBAL } from '../../../core/test/amm/helpers.ts';

const SOL = 1_000_000_000n;
/** SOL/USD used for sizes (docs/RESEARCH.md: research dated 2026-10-03, SOL about $119.26). */
export const SOL_USD = 119.26;
export const SIZES_USD = [2, 5, 20] as const;
const SUPPLY = 1_000_000_000_000_000n; // 1B tokens, 6 decimals

const scen = FILL_CONFIG.scenarios.conservative;
const net = FILL_CONFIG.network;
const base = net.signaturesPerTx * net.baseFeePerSignature;
const ladder = TRIAL_POLICY.exits.ladder.steps;

/** Paid failed attempts per landed one: misses that land as failed transactions (drops cost nothing). */
const paidFailuresPerLanded = (landPpm: bigint): number => {
  const miss = 1 - Number(landPpm) / 1e6;
  const paidShare = 1 - Number(scen.dropPpm) / 1e6;
  return (paidShare * miss) / (1 - miss);
};
/** Probability the token-account rent comes back: the sell-and-close lands with the close and no dust left. */
const rentBack = (Number(scen.closeSuccessPpm) / 1e6) * (1 - Number(scen.dustPpm) / 1e6);

export interface Setup {
  readonly id: string;
  readonly label: string;
  readonly venue: 'pumpswap' | 'pump-curve';
  readonly quoter: RoundTripQuoter;
  readonly feeBps: number;
  readonly note: string;
}

const curve: CurveState = {
  virtualTokenReserves: PUMP_GLOBAL.initialVirtualTokenReserves, virtualQuoteReserves: PUMP_GLOBAL.initialVirtualSolReserves,
  realTokenReserves: PUMP_GLOBAL.initialRealTokenReserves, realQuoteReserves: 0n, complete: false,
};
// A fresh graduate: ~67.4 SOL real + ~17.6 SOL virtual (BOOST) against ~206.9M tokens, ~411 SOL market cap (README fact-check).
const young: PoolState = { baseReserve: 206_900_000_000_000n, quoteVault: 67_400_000_000n, virtualQuoteReserves: 17_600_000_000n };
// The smallest U1 pool: $50k of quote (H8, U1 floor) on the migration's constant product, BOOST spent.
const k = (young.quoteVault + young.virtualQuoteReserves) * young.baseReserve;
const u1Quote = BigInt(Math.ceil((50_000 / SOL_USD) * 1e9));
const u1: PoolState = { baseReserve: k / u1Quote, quoteVault: u1Quote, virtualQuoteReserves: 0n };

// TX-1 uses PumpSwap's v1 instructions on SOL pools; v1 and v2 price the same (pump-swap.ts).
const poolCtx = { feeConfig: AMM_FEE_CONFIG, canonical: true, quote: 'sol' as const, baseSupply: SUPPLY, creatorFeeCharged: true, coin: NORMAL_COIN, instruction: 'v1' as const, buybackFeeBps: bps(5000) };
const tierBps = (p: PoolState): number => {
  const f = poolFees(p, poolCtx);
  return f.lp + f.protocol + f.creator;
};
// U1's worst allowed tier (1,470–2,460 SOL cap, 1.15%), forced on the same pool to bound the cost from above.
const u1Worst = { ...poolCtx, feeConfig: { ...AMM_FEE_CONFIG, feeTiers: [{ marketCapThreshold: 0n, fees: AMM_FEE_CONFIG.feeTiers.find((t) => t.fees.lp + t.fees.protocol + t.fees.creator === 115)!.fees }] } };

export const SETUPS: readonly Setup[] = [
  { id: 'curve', label: 'pump curve (fresh)', venue: 'pump-curve', quoter: pumpCurveRoundTrip(curve, { feeTiers: PUMP_FEE_CONFIG.feeTiers, global: CHECKED_GLOBAL, creatorFeeCharged: true, coin: NORMAL_COIN }), feeBps: 125, note: 'paper only (§3.1)' },
  { id: 'young', label: 'young PumpSwap (at migration, ~411 SOL cap)', venue: 'pumpswap', quoter: pumpSwapRoundTrip(young, poolCtx), feeBps: tierBps(young), note: 'U2 at entry pays 1.20–1.25%' },
  { id: 'u1', label: `U1 survivor ($50k quote, ~${Math.round(Number((u1.quoteVault * SUPPLY) / u1.baseReserve) / 1e9)} SOL cap)`, venue: 'pumpswap', quoter: pumpSwapRoundTrip(u1, poolCtx), feeBps: tierBps(u1), note: 'live tier at the U1 floor' },
  { id: 'u1-1.15', label: 'U1 survivor at the 1.15% tier (upper bound)', venue: 'pumpswap', quoter: pumpSwapRoundTrip(u1, u1Worst), feeBps: 115, note: 'worst U1 tier' },
];

export interface Row {
  readonly setup: string;
  readonly usd: number;
  readonly feeBps: number;
  /** Venue fees and impact, both legs, % of notional. */
  readonly proportionalPct: number;
  readonly fixedLamports: number;
  readonly fixedPct: number;
  /** Rent not recovered when the close fails (sensitivity: no recovery at all). */
  readonly rentNoRecoveryPct: number;
  /** Break-even gross move: proportional + fixed. */
  readonly breakEvenPct: number;
  readonly breakEvenNoRentPct: number;
}

export const rows = (): Row[] =>
  SETUPS.flatMap((s) => SIZES_USD.map((usd) => {
    const spend = BigInt(Math.floor((usd / SOL_USD) * 1e9));
    const land = scen.landPpm[s.venue];
    const fail = paidFailuresPerLanded(land);
    const c = costAtSize(s.quoter, spend, { signaturesPerTx: net.signaturesPerTx, baseFeePerSignature: net.baseFeePerSignature, entryPriorityFee: net.entryPriorityFee, exitPriorityFee: ladder[0]!.priorityFeeLamports, tip: net.tip, entryFailurePpm: 0n, exitFailurePpm: 0n },
      { tokenAccount: net.tokenAccountRent, tokenAccountClosedOnExit: true, oneTime: 0n, transient: 0n });
    if (!c.ok) throw new Error(`${s.id} $${usd}: ${c.reason}`);
    const t = c.trade;
    // Failed entry and exit attempts at their fee (base + priority; the exit's at rung 1), per landed trade.
    const failed = fail * Number(base + net.entryPriorityFee) + fail * Number(base + ladder[0]!.priorityFeeLamports);
    const rentLost = (1 - rentBack) * Number(net.tokenAccountRent);
    const fixed = Number(t.fixed.total) + failed + rentLost;
    const paid = Number(t.roundTrip.paid);
    const pct = (x: number) => (100 * x) / paid;
    const proportionalPct = pct(Number(t.proportional));
    return {
      setup: s.id, usd, feeBps: s.feeBps, proportionalPct, fixedLamports: Math.round(fixed), fixedPct: pct(fixed),
      rentNoRecoveryPct: pct(Number(net.tokenAccountRent)), breakEvenPct: proportionalPct + pct(fixed),
      breakEvenNoRentPct: proportionalPct + pct(fixed - rentLost + Number(net.tokenAccountRent)),
    };
  }));

/** Break-even win rate of a bracket exit: win +W, lose −L (gross moves), cost c per trade: p = (L + c) / (W + L). */
export const breakEvenWinRate = (winPct: number, lossPct: number, costPct: number): number => (lossPct + costPct) / (winPct + lossPct);
export const BRACKETS = [[10, 5], [20, 10], [30, 15], [50, 20]] as const;

if (import.meta.main) {
  const r = rows();
  const f = (x: number, d = 2) => x.toFixed(d);
  const lines = [
    `Conservative scenario: land ${SETUPS.map((s) => `${s.venue} ${Number(scen.landPpm[s.venue]) / 1e4}%`).filter((x, i, a) => a.indexOf(x) === i).join(', ')}; ${Number(scen.dropPpm) / 1e4}% of misses never land; rent back with probability ${f(rentBack * 100, 1)}%. SOL $${SOL_USD}.`,
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
  writeFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'research', 'edge', 'costs.json'), JSON.stringify({ solUsd: SOL_USD, rentBack, rows: r }, null, 2) + '\n');
}
