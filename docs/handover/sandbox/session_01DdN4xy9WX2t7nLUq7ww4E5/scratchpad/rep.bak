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
    netUsd: usd(net), realizedR: null, exitReason: t.exitReason,
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
    results.push(resultExact(g.group, rt, g.stray.map((s) => ({ at: s.at, netMicro: -toUsd(s.lamports, priceAt(i.solUsd, s.at)) }))));
  }
  return {
    schemaVersion: 1, mode: 'backtest', part: 'research', generatedAt: i.generatedAt, runId: i.runId, codeCommit: i.codeCommit,
    policyHash: `sha256:${policyHash(i.policy)}`,
    dataset: { id: i.dataset.id, from: iso(i.dataset.from), to: iso(i.dataset.to) },
    engine: { ...i.engine },
    candidates: i.candidates, entries: i.entries, gates: [...i.gates], folds: [], results, trades,
  };
};

/** Results with every sum in exact micro-dollars. */
const resultExact = (group: ReportGroup, trades: readonly ReportTrade[], stray: readonly { at: number; netMicro: bigint }[]): ReportResult => {
  const events = [
    ...trades.map((t) => ({ at: Date.parse(t.closedAt), net: micro(t.netUsd), trade: true })),
    ...stray.map((s) => ({ at: s.at, net: s.netMicro, trade: false })),
  ].sort((a, b) => a.at - b.at);
  let cum = 0n;
  let peak = 0n;
  let dd = 0n;
  const equity: ReportResult['equity'] = [];
  const days = new Map<string, { net: bigint; trades: number }>();
  for (const e of events) {
    cum += e.net;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
    equity.push({ mode: 'backtest', at: iso(e.at), cumNetUsd: usd(cum) });
    const d = melbourneDay(e.at);
    const cur = days.get(d) ?? { net: 0n, trades: 0 };
    days.set(d, { net: cur.net + e.net, trades: cur.trades + (e.trade ? 1 : 0) });
  }
  const tradeNet = trades.reduce((t, x) => t + micro(x.netUsd), 0n);
  return {
    mode: 'backtest', group, ci95: null, trades: trades.length, wins: trades.filter((t) => micro(t.netUsd) > 0n).length, netUsd: usd(cum), maxDrawdownUsd: usd(dd),
    meanNetUsd: trades.length === 0 ? null : usd(tradeNet / BigInt(trades.length)), equity,
    days: [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, v]): ReportDay => ({ mode: 'backtest', date, netUsd: usd(v.net), trades: v.trades })),
  };
};
