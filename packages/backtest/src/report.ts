// The BacktestReport file (UI-2's schema, version 1) from finished research runs. Holdout runs never come here:
// their numbers stay in the sealed ledger (§14), and this module has no input for them.
import type { FillConfig, Policy } from '../../core/src/config/index.ts';
import { policyHash } from '../../core/src/config/index.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd, solPriceMicroUsd, toDecimalString } from '../../core/src/units/index.ts';
import { type OffchainSeries, usableFrom } from './dataset/offchain.ts';
import type { BacktestReportV1, ReportDay, ReportGate, ReportGroup, ReportResult, ReportTrade } from '../../core/src/report/index.ts';
import type { StrayCost, TradeRecord } from './trades.ts';

export interface EngineEvidence {
  readonly replays: number;
  readonly identicalReplays: boolean;
  readonly crashes: number;
  readonly illegalStates: number;
  readonly unreconciledIntents: number;
}

export interface ReportInput {
  readonly runId: string;
  readonly generatedAt: string;
  readonly codeCommit: string;
  readonly policy: Policy;
  readonly fills: FillConfig;
  readonly dataset: { readonly id: string; readonly from: number; readonly to: number };
  readonly engine: EngineEvidence;
  readonly solUsd: OffchainSeries;
  readonly candidates: number;
  readonly entries: number;
  readonly groups: readonly { readonly group: ReportGroup; readonly trades: readonly TradeRecord[]; readonly stray: readonly StrayCost[] }[];
  readonly gates: readonly ReportGate[];
}

const usd = (v: bigint): string => toDecimalString(v, 6);
const iso = (ms: number): string => new Date(ms).toISOString();

/** YYYY-MM-DD in Melbourne (AEST/AEDT). Read outside the engine only. */
// One formatter for the process (MEM-1): a new Intl.DateTimeFormat per call costs about 0.7 ms and holds ICU memory
// outside the JS heap, so the collector does not see it; per-row calls grew one test fork to 5.6 GB.
const MELBOURNE_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' });
export const melbourneDay = (ms: number): string => MELBOURNE_DAY.format(ms);

/** The SOL/USD price usable at `ms`: the latest bar whose usable moment is at or before it. */
export const priceAt = (s: OffchainSeries, ms: number): MicroUsd => {
  let best: string | null = null;
  for (const b of s.bars) if (usableFrom(s, b) <= ms) best = b.close;
  if (best === null) throw new RangeError(`no SOL/USD price usable at ${iso(ms)}`);
  return solPriceMicroUsd(best);
};

export const toUsd = (lamports: bigint, px: MicroUsd): bigint =>
  lamports < 0n ? -lamportsToMicroUsd(-lamports as Lamports, px, 'floor') : lamportsToMicroUsd(lamports as Lamports, px, 'floor');

/** Exact decimal of a / b with `places` places, rounded down. */
const decDiv = (a: bigint, b: bigint, places: number): string => toDecimalString((a * 10n ** BigInt(places)) / b, places);

/** USD per whole token (pump tokens have 6 decimals). */
const tokenPrice = (sol: bigint, tokens: bigint, px: MicroUsd): string => (tokens === 0n ? '0' : decDiv(sol * px * 1_000_000n, tokens * 1_000_000_000n * 1_000_000n, 12));

/**
 * A trade in USD, each flow at its own time (item 6 of BT-1c): the entry, the entry leg's costs and the rent at the
 * entry-time price; the proceeds, the exit leg's costs and any rent returned at the exit-time price. SOL moving in
 * between therefore shows in the trade's USD result; its SOL result is reported apart (economics.ts).
 * Approximation: every exit attempt's fees, failed ones included, use the price at the trade's close (the last sell
 * landing, or the data's end for a blocked exit), not each attempt's own time; likewise for repeated entry attempts.
 */
const reportTrade = (t: TradeRecord, group: ReportGroup, pxIn: MicroUsd, pxOut: MicroUsd): ReportTrade => {
  const both = (k: keyof TradeRecord['legs']['entry']) => toUsd(t.legs.entry[k], pxIn) + toUsd(t.legs.exit[k], pxOut);
  const c = {
    venue: both('venueFee'), creator: both('creatorFee'), priority: both('priority'), tip: both('tip'), network: both('networkBase'),
    slippage: both('slippage'), rentPaid: toUsd(t.rentPaid, pxIn), rentReturned: toUsd(t.rentReturned, pxOut),
  };
  const total = c.venue + c.creator + c.priority + c.tip + c.network + c.slippage + c.rentPaid - c.rentReturned;
  const size = toUsd(t.entrySol, pxIn);
  const proceeds = toUsd(t.exitSol, pxOut);
  // Venue fees and slippage are inside the entry and exit amounts; network fees and rent are paid on top.
  const net = proceeds - size - c.network - c.priority - c.tip - c.rentPaid + c.rentReturned;
  return {
    mode: 'backtest', id: t.id, group, mint: t.mint, symbol: t.symbol || t.mint.slice(0, 6), venue: 'pumpswap',
    openedAt: iso(t.openedAt), closedAt: iso(t.closedAt), holdSeconds: Math.max(0, Math.round((t.closedAt - t.openedAt) / 1000)),
    entryPriceUsd: tokenPrice(t.entrySol, t.tokens, pxIn), exitPriceUsd: tokenPrice(t.exitSol, t.tokens, pxOut),
    sizeUsd: usd(size), grossUsd: usd(net + total),
    costs: {
      venueFeeUsd: usd(c.venue), creatorFeeUsd: usd(c.creator), priorityFeeUsd: usd(c.priority), tipUsd: usd(c.tip), networkFeeUsd: usd(c.network),
      slippageUsd: usd(c.slippage), rentPaidUsd: usd(c.rentPaid), rentReturnedUsd: usd(c.rentReturned), totalUsd: usd(total),
    },
    netUsd: usd(net), ...tradeLamports(t), realizedR: null, exitReason: t.exitReason,
  };
};

/** Returns on lamports to 9 places, rounded toward zero (BigInt division). */
const RETURN_PLACES = 9;
const scaledRatio = (num: bigint, den: bigint): bigint => (num * 10n ** BigInt(RETURN_PLACES)) / den;
/** A value scaled by 10^places as an exact decimal with exactly `places` places: 180000000n, 9 → "0.180000000". */
const fixed = (v: bigint, places: number): string => {
  const neg = v < 0n;
  const a = (neg ? -v : v).toString().padStart(places + 1, '0');
  return `${neg ? '-' : ''}${a.slice(0, a.length - places)}.${a.slice(a.length - places)}`;
};
const ratio = (num: bigint, den: bigint): string => fixed(scaledRatio(num, den), RETURN_PLACES);

/**
 * The trade's exact lamport figures (BT-SOL: profit is counted in SOL). Each cost kind is both legs' sum; net is the
 * trade record's own (exit SOL − entry SOL − network fees, priority, tip and rent paid + rent returned), gross is net
 * plus every cost, and the return is net ÷ entry lamports.
 */
const tradeLamports = (t: TradeRecord): Pick<ReportTrade, 'sizeLamports' | 'grossLamports' | 'costsLamports' | 'netLamports' | 'netReturn'> => {
  const both = (k: keyof TradeRecord['legs']['entry']) => t.legs.entry[k] + t.legs.exit[k];
  const c = {
    venue: both('venueFee'), creator: both('creatorFee'), priority: both('priority'), tip: both('tip'), network: both('networkBase'),
    slippage: both('slippage'), rentPaid: t.rentPaid, rentReturned: t.rentReturned,
  };
  const total = c.venue + c.creator + c.priority + c.tip + c.network + c.slippage + c.rentPaid - c.rentReturned;
  return {
    sizeLamports: t.entrySol.toString(), grossLamports: (t.net + total).toString(), netLamports: t.net.toString(),
    costsLamports: {
      venueFeeLamports: c.venue.toString(), creatorFeeLamports: c.creator.toString(), priorityFeeLamports: c.priority.toString(), tipLamports: c.tip.toString(),
      networkFeeLamports: c.network.toString(), slippageLamports: c.slippage.toString(), rentPaidLamports: c.rentPaid.toString(),
      rentReturnedLamports: c.rentReturned.toString(), totalLamports: total.toString(),
    },
    netReturn: t.entrySol > 0n ? ratio(t.net, t.entrySol) : fixed(0n, RETURN_PLACES),
  };
};

/** A trade in USD with each flow at its own time (the report's trade row). */
export const tradeInUsd = (t: TradeRecord, group: ReportGroup, s: OffchainSeries): ReportTrade => reportTrade(t, group, priceAt(s, t.openedAt), priceAt(s, t.closedAt));

/** "-12.5" → -12500000n. */
export const micro = (s: string): bigint => {
  const neg = s.startsWith('-');
  const [w = '0', f = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0'));
  return neg ? -v : v;
};

export const buildReport = (i: ReportInput): BacktestReportV1 => {
  const results: ReportResult[] = [];
  const trades: ReportTrade[] = [];
  for (const g of i.groups) {
    const rt = g.trades.map((t) => tradeInUsd(t, g.group, i.solUsd));
    trades.push(...rt);
    results.push(resultExact(g.group, rt, g.stray.map((s) => ({ at: s.at, netMicro: -toUsd(s.lamports, priceAt(i.solUsd, s.at)), netLamports: -s.lamports }))));
  }
  return {
    schemaVersion: 1, mode: 'backtest', part: 'research', generatedAt: i.generatedAt, runId: i.runId, codeCommit: i.codeCommit,
    policyHash: `sha256:${policyHash(i.policy)}`,
    dataset: { id: i.dataset.id, from: iso(i.dataset.from), to: iso(i.dataset.to) },
    engine: { ...i.engine },
    candidates: i.candidates, entries: i.entries, gates: [...i.gates], folds: [], results, trades,
  };
};

/** Results with every sum exact: micro-dollars and lamports, side by side. */
const resultExact = (group: ReportGroup, trades: readonly ReportTrade[], stray: readonly { at: number; netMicro: bigint; netLamports: bigint }[]): ReportResult => {
  const events = [
    ...trades.map((t) => ({ at: Date.parse(t.closedAt), net: micro(t.netUsd), lamports: BigInt(t.netLamports), trade: true })),
    ...stray.map((s) => ({ at: s.at, net: s.netMicro, lamports: s.netLamports, trade: false })),
  ].sort((a, b) => a.at - b.at);
  let cum = 0n;
  let peak = 0n;
  let dd = 0n;
  let cumL = 0n;
  let peakL = 0n;
  let ddL = 0n;
  const equity: ReportResult['equity'] = [];
  const days = new Map<string, { net: bigint; lamports: bigint; trades: number }>();
  for (const e of events) {
    cum += e.net;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
    cumL += e.lamports;
    if (cumL > peakL) peakL = cumL;
    if (peakL - cumL > ddL) ddL = peakL - cumL;
    equity.push({ mode: 'backtest', at: iso(e.at), cumNetUsd: usd(cum), cumNetLamports: cumL.toString() });
    const d = melbourneDay(e.at);
    const cur = days.get(d) ?? { net: 0n, lamports: 0n, trades: 0 };
    days.set(d, { net: cur.net + e.net, lamports: cur.lamports + e.lamports, trades: cur.trades + (e.trade ? 1 : 0) });
  }
  const tradeNet = trades.reduce((t, x) => t + micro(x.netUsd), 0n);
  const tradeNetL = trades.reduce((t, x) => t + BigInt(x.netLamports), 0n);
  // The mean of the per-trade returns, from each exact ratio at 9 places (rounded toward zero, as each ratio is).
  const returnSum = trades.reduce((t, x) => t + (BigInt(x.sizeLamports) > 0n ? scaledRatio(BigInt(x.netLamports), BigInt(x.sizeLamports)) : 0n), 0n);
  return {
    mode: 'backtest', group, ci95: null, trades: trades.length, wins: trades.filter((t) => micro(t.netUsd) > 0n).length, netUsd: usd(cum), maxDrawdownUsd: usd(dd),
    meanNetUsd: trades.length === 0 ? null : usd(tradeNet / BigInt(trades.length)),
    netLamports: cumL.toString(), maxDrawdownLamports: ddL.toString(),
    meanNetLamports: trades.length === 0 ? null : (tradeNetL / BigInt(trades.length)).toString(),
    meanReturn: trades.length === 0 ? null : fixed(returnSum / BigInt(trades.length), RETURN_PLACES),
    equity,
    days: [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, v]): ReportDay => ({ mode: 'backtest', date, netUsd: usd(v.net), netLamports: v.lamports.toString(), trades: v.trades })),
  };
};
