// RUG-1c validation (docs/DECISIONS.md "Rug labels"): how well rugs labels match an executable-loss outcome, how a
// minimum collapse peak changes that, and how much rugs-1 misses by design (deployer tokens moved to another wallet and
// sold there; creation-slot buyers dumping). Research only: it reads whole first-day histories, which the engine never
// does, and nothing here feeds a decision. Labels come from the same labeller, through its probe.
import { recordFromRpc, transactionEvents, type RpcTransactionBase64 } from '../../../core/src/chain/index.ts';
import type { RugConfig } from '../../../core/src/config/rugs.ts';
import { RugLabeller, exitCostBps, type VenueState } from '../../../core/src/gates/index.ts';
import { BPS_DENOMINATOR } from '../../../core/src/units/index.ts';
import type { MarketEvent } from '../../../core/src/engine/index.ts';
import { eventsOfFrame, rankIn, type Frame } from '../providers/canonical.ts';

type TokenBalance = { readonly mint: string; readonly owner?: string; readonly uiTokenAmount: { readonly amount: string } };
/** A `getTransaction` result with the token balances the RPC returns in `meta`. */
export type FullRpcTransaction = RpcTransactionBase64 & {
  readonly meta: NonNullable<RpcTransactionBase64['meta']> & { readonly preTokenBalances?: readonly TokenBalance[] | null; readonly postTokenBalances?: readonly TokenBalance[] | null };
};

export interface LaunchReport {
  readonly mint: string;
  readonly creator: string;
  readonly createdAtMs: number;
  readonly supply: string;
  readonly transactions: number;
  /** First time each rugs rule held with the config as given (null: never inside its window). */
  readonly creatorDumpAtMs: number | null;
  /** Deployer sales in the window, bps of supply. */
  readonly deployerSoldBps: number;
  /** Per level in the window: the running peak and the level, for minimum-peak sweeps. */
  readonly levels: readonly { readonly atMs: number; readonly level: string; readonly peak: string }[];
  /** The highest quote liquidity in the window, when, on which venue, and the exit cost of the rugs reference position there. */
  readonly peak: string;
  readonly peakAtMs: number | null;
  readonly peakVenue: string | null;
  readonly peakExitCostBps: string | null;
  /** The level just after the highest peak, bps of it: a one-transaction spike drops at once (null: nothing after). */
  readonly afterPeakBps: number | null;
  /** The highest peak is the first pool level after migration (a venue change, not trading). */
  readonly peakAtMigration: boolean;
  /** The deployer's first sale: its size (bps of supply) and time; null when the deployer never sold. */
  readonly firstSaleBps: number | null;
  readonly firstSaleAtMs: number | null;
  /** First time the collapse rule held (no minimum peak), or null. */
  readonly collapseAtMs: number | null;
  /** Non-deployer wallets' SOL into and out of the mint's venues in the window, and the quote liquidity left at its end. */
  readonly outsiderIn: string;
  readonly outsiderOut: string;
  readonly finalQuote: string;
  /** outsiderIn − outsiderOut − finalQuote: a lower bound on what outsiders could not get back (negative: they gained). */
  readonly executableLoss: string;
  /** Tokens the deployer moved to other wallets (not a sale), and those wallets' sales, bps of supply. */
  readonly transferredBps: number;
  readonly transferSoldBps: number;
  /** Wallets other than the deployer that bought in the create's slot, and their sales, bps of supply. */
  readonly bundleBoughtBps: number;
  readonly bundleSoldBps: number;
}

const bps = (part: bigint, whole: bigint): number => (whole > 0n ? Number((part * BPS_DENOMINATOR) / whole) : 0);
const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : 0n);

/** One transaction of a launch's history, decoded: what the analysis reads. */
export interface LaunchStep {
  readonly slot: bigint;
  readonly blockTime: number | null;
  readonly err: unknown;
  /** DEC-1's events of the transaction. */
  readonly events: readonly { readonly program: string; readonly name: string; readonly data?: unknown }[];
  /** The same events as FEED-1 market events, for the labeller. */
  readonly market: readonly MarketEvent[];
  readonly preTokenBalances: readonly TokenBalance[] | null | undefined;
  readonly postTokenBalances: readonly TokenBalance[] | null | undefined;
}

/** Decodes `getTransaction` results (oldest first) into steps, through DEC-1 and FEED-1's canonical events. */
export const stepsOf = (txs: readonly { readonly signature: string; readonly rpc: FullRpcTransaction }[]): LaunchStep[] => {
  const ranks = new Map<bigint, Map<string, number>>();
  let seq = 0;
  return txs.map(({ signature, rpc }) => {
    const rec = recordFromRpc(signature, rpc);
    const f: Frame = { seq: ++seq, receivedAt: (rec.blockTime ?? 0) * 1_000, source: 'helius', backfilled: true, place: { at: 'chain', slot: rec.slot }, duplicate: false, body: { type: 'tx', record: rec } };
    const r = ranks.get(rec.slot) ?? new Map<string, number>();
    ranks.set(rec.slot, r);
    rankIn(r, f);
    const market = eventsOfFrame(f, r).flatMap((e) => (e.kind === 'market' ? [e] : []));
    return { slot: rec.slot, blockTime: rec.blockTime, err: rec.err, events: transactionEvents(rec), market, preTokenBalances: rpc.meta.preTokenBalances, postTokenBalances: rpc.meta.postTokenBalances };
  });
};

/** Analyses one launch from its successful transactions, oldest first, inside the rugs window from its create. */
export const analyzeLaunch = (txs: readonly { readonly signature: string; readonly rpc: FullRpcTransaction }[], rugs: RugConfig): LaunchReport | null => analyzeSteps(stepsOf(txs), rugs);

/** The analysis on decoded steps (oldest first). */
export const analyzeSteps = (steps: readonly LaunchStep[], rugs: RugConfig): LaunchReport | null => {
  const window = Math.max(rugs.creatorDump.windowMs, rugs.collapse.windowMs);
  let create: Record<string, unknown> | null = null;
  let pool: string | null = null;
  const levels: { atMs: number; level: string; peak: string }[] = [];
  let top: { level: bigint; atMs: number; state: VenueState | null; index: number } | null = null;
  let firstPool: number | null = null;
  let firstSale: { bps: number; atMs: number } | null = null;
  let collapseAt: number | null = null;
  let sold = 0n;
  let dumpAt: number | null = null;
  const labeller = new RugLabeller(rugs, {
    level: (_m, level, peak, atMs, state) => {
      if (state?.venue === 'pool' && firstPool === null) firstPool = levels.length;
      if (top === null || level > top.level) top = { level, atMs, state, index: levels.length };
      const age = create === null ? Infinity : atMs - Number(big(create['timestamp'])) * 1_000;
      if (collapseAt === null && peak > 0n && age <= rugs.collapse.windowMs && level * BPS_DENOMINATOR <= peak * (BPS_DENOMINATOR - BigInt(rugs.collapse.dropBps))) collapseAt = atMs;
      levels.push({ atMs, level: String(level), peak: String(peak) });
    },
    sale: (_m, total, atMs) => {
      sold = total;
      if (firstSale === null && create !== null) firstSale = { bps: bps(total, big(create['tokenTotalSupply'])), atMs };
      const supply = create === null ? 0n : big(create['tokenTotalSupply']);
      const age = create === null ? Infinity : atMs - Number(big(create['timestamp'])) * 1_000;
      if (dumpAt === null && supply > 0n && age <= rugs.creatorDump.windowMs && total * BPS_DENOMINATOR >= supply * BigInt(rugs.creatorDump.supplyBps)) dumpAt = atMs;
    },
  });
  let outsiderIn = 0n;
  let outsiderOut = 0n;
  let transferred = 0n;
  let transferSold = 0n;
  let bundleBought = 0n;
  let bundleSold = 0n;
  const recipients = new Set<string>();
  const bundle = new Set<string>();
  let createSlot: bigint | null = null;
  let count = 0;
  for (const rec of steps) {
    if (rec.err !== null) continue;
    const evs = rec.events;
    const c = evs.find((e) => e.name === 'CreateEvent' && e.program === 'pump');
    if (create === null && c !== undefined) {
      create = c.data as unknown as Record<string, unknown>;
      createSlot = rec.slot;
    }
    if (create === null) continue;
    const mint = create['mint'] as string;
    const t0 = Number(big(create['timestamp'])) * 1_000;
    if ((rec.blockTime ?? 0) * 1_000 > t0 + window) break;
    count++;
    const deployer = new Set([create['creator'] as string, create['user'] as string]);
    for (const e of rec.market) labeller.observe(e);
    let deployerSoldHere = 0n;
    for (const e of evs) {
      if (e.name === 'other') continue;
      const d = e.data as unknown as Record<string, unknown>;
      if (e.name === 'CompletePumpAmmMigrationEvent' && d['mint'] === mint) pool = d['pool'] as string;
      const curve = e.program === 'pump' && e.name === 'TradeEvent' && d['mint'] === mint;
      const onPool = e.program === 'pump_amm' && pool !== null && d['pool'] === pool && (e.name === 'BuyEvent' || e.name === 'SellEvent');
      if (!curve && !onPool) continue;
      const user = d['user'] as string;
      const isBuy = curve ? d['isBuy'] === true : e.name === 'BuyEvent';
      const tokens = curve ? big(d['tokenAmount']) : isBuy ? big(d['baseAmountOut']) : big(d['baseAmountIn']);
      const sol = curve ? big(d['solAmount']) : isBuy ? big(d['userQuoteAmountIn']) : big(d['userQuoteAmountOut']);
      if (deployer.has(user)) {
        if (!isBuy) deployerSoldHere += tokens;
        continue;
      }
      if (isBuy) outsiderIn += sol;
      else outsiderOut += sol;
      if (isBuy && curve && rec.slot === createSlot) {
        bundle.add(user);
        bundleBought += tokens;
      }
      if (!isBuy && recipients.has(user)) transferSold += tokens;
      if (!isBuy && bundle.has(user)) bundleSold += tokens;
    }
    // Token moves out of the deployer's wallets that are not its own sales: a transfer to other wallets.
    const delta = new Map<string, bigint>();
    const add = (list: readonly TokenBalance[] | null | undefined, sign: bigint) => {
      for (const b of list ?? []) if (b.mint === mint && b.owner !== undefined) delta.set(b.owner, (delta.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
    };
    add(rec.preTokenBalances, -1n);
    add(rec.postTokenBalances, 1n);
    const out = [...deployer].reduce((a, w) => a - (delta.get(w) ?? 0n), 0n) - deployerSoldHere;
    if (out > 0n) {
      transferred += out;
      // Every wallet whose balance rose is a recipient; the deployer and the venues never appear as a trade's user.
      for (const [owner, d] of delta) if (d > 0n) recipients.add(owner);
    }
  }
  if (create === null) return null;
  const supply = big(create['tokenTotalSupply']);
  const finalQuote = levels.length === 0 ? 0n : BigInt(levels.at(-1)!.level);
  const t = top as { level: bigint; atMs: number; state: VenueState | null; index: number } | null;
  const after = t === null ? undefined : levels[t.index + 1];
  const exit = t === null || t.state === null ? null : exitCostBps(t.state, BigInt(rugs.materiality.referenceLamports));
  return {
    mint: create['mint'] as string, creator: create['creator'] as string, createdAtMs: Number(big(create['timestamp'])) * 1_000, supply: String(supply),
    transactions: count, creatorDumpAtMs: dumpAt, deployerSoldBps: bps(sold, supply), levels,
    peak: String(t?.level ?? 0n), peakAtMs: t?.atMs ?? null, peakVenue: t?.state?.venue ?? null, peakExitCostBps: exit === null ? null : String(exit),
    afterPeakBps: t === null || after === undefined || t.level === 0n ? null : bps(BigInt(after.level), t.level),
    peakAtMigration: t !== null && t.index === (firstPool as number | null),
    firstSaleBps: (firstSale as { bps: number } | null)?.bps ?? null, firstSaleAtMs: (firstSale as { atMs: number } | null)?.atMs ?? null,
    collapseAtMs: collapseAt,
    outsiderIn: String(outsiderIn), outsiderOut: String(outsiderOut), finalQuote: String(finalQuote),
    executableLoss: String(outsiderIn - outsiderOut - finalQuote),
    transferredBps: bps(transferred, supply), transferSoldBps: bps(transferSold, supply),
    bundleBoughtBps: bps(bundleBought, supply), bundleSoldBps: bps(bundleSold, supply),
  };
};

/**
 * The highest quote liquidity that was still there at the next observation (max over consecutive levels of the
 * smaller one), up to and including level `upTo`: a one-transaction spike does not count (candidate rule, DECISIONS).
 */
export const sustainedPeak = (r: LaunchReport, upTo = r.levels.length - 1): bigint => {
  let best = 0n;
  for (let i = 0; i < upTo && i + 1 < r.levels.length; i++) {
    const a = BigInt(r.levels[i]!.level);
    const b = BigInt(r.levels[i + 1]!.level);
    const held = a < b ? a : b;
    if (held > best) best = held;
  }
  return best;
};

/** Collapse whose sustained reserve before it reached at least `line` (the candidate materiality rule). */
export const collapsesSustained = (r: LaunchReport, rugs: RugConfig, line: bigint): boolean =>
  r.levels.some((l, i) => {
    const peak = BigInt(l.peak);
    return peak > 0n && l.atMs - r.createdAtMs <= rugs.collapse.windowMs
      && BigInt(l.level) * BPS_DENOMINATOR <= peak * (BPS_DENOMINATOR - BigInt(rugs.collapse.dropBps))
      && sustainedPeak(r, i) >= line;
  });

/** Whether the collapse rule holds with this minimum peak (same test as the labeller, on the recorded levels). */
export const collapses = (r: LaunchReport, rugs: RugConfig, minPeak: bigint): boolean =>
  r.levels.some((l) => {
    const peak = BigInt(l.peak);
    return peak > 0n && peak >= minPeak && l.atMs - r.createdAtMs <= rugs.collapse.windowMs
      && BigInt(l.level) * BPS_DENOMINATOR <= peak * (BPS_DENOMINATOR - BigInt(rugs.collapse.dropBps));
  });

export interface SweepRow {
  readonly minPeak: string;
  readonly labelled: number;
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  /** null when undefined (no labels, or no harmful launches). */
  readonly precision: number | null;
  readonly recall: number | null;
}

/** Labels (creator dump, or collapse from at least `minPeak`) against the outcome "executable loss ≥ `loss`". */
export const sweep = (reports: readonly LaunchReport[], rugs: RugConfig, minPeaks: readonly bigint[], loss: bigint): SweepRow[] =>
  minPeaks.map((minPeak) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const r of reports) {
      const label = r.creatorDumpAtMs !== null || collapses(r, rugs, minPeak);
      const harm = BigInt(r.executableLoss) >= loss;
      if (label && harm) tp++;
      else if (label) fp++;
      else if (harm) fn++;
    }
    return {
      minPeak: String(minPeak), labelled: tp + fp, truePositive: tp, falsePositive: fp, falseNegative: fn,
      precision: tp + fp === 0 ? null : tp / (tp + fp), recall: tp + fn === 0 ? null : tp / (tp + fn),
    };
  });

/**
 * How strongly a small deployer sale predicts a later collapse or loss: launches grouped by the size of the deployer's
 * first sale (bps of supply; bounds are lower-inclusive), with the share that collapsed after that sale and the median
 * executable loss. `null` group: the deployer never sold.
 */
export const saleBuckets = (reports: readonly LaunchReport[], bounds: readonly number[] = [0, 50, 200, 500]) => {
  const groups = new Map<string, LaunchReport[]>();
  for (const r of reports) {
    const b = r.firstSaleBps;
    const key = b === null ? 'none' : `${[...bounds].reverse().find((x) => b >= x) ?? bounds[0]}+`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const median = (xs: bigint[]) => (xs.length === 0 ? null : String([...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor((xs.length - 1) / 2)]));
  return [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([group, rs]) => ({
    group, launches: rs.length,
    collapsedAfterSale: rs.filter((r) => r.collapseAtMs !== null && (r.firstSaleAtMs === null || r.collapseAtMs >= r.firstSaleAtMs)).length,
    medianLoss: median(rs.map((r) => BigInt(r.executableLoss))),
  }));
};

/** Launches rugs-1 does not label where the deployer's moved tokens, or the creation-slot buyers, sold ≥ the dump share. */
export const misses = (reports: readonly LaunchReport[], rugs: RugConfig) => {
  const unlabelled = reports.filter((r) => r.creatorDumpAtMs === null && !collapses(r, rugs, 0n));
  const share = rugs.creatorDump.supplyBps;
  return {
    launches: reports.length,
    unlabelled: unlabelled.length,
    transferThenSell: unlabelled.filter((r) => r.transferSoldBps >= share).map((r) => r.mint),
    bundleDump: unlabelled.filter((r) => r.bundleSoldBps >= share).map((r) => r.mint),
    anyTransferThenSell: reports.filter((r) => r.transferSoldBps >= share).map((r) => r.mint),
    anyBundleDump: reports.filter((r) => r.bundleSoldBps >= share).map((r) => r.mint),
  };
};
