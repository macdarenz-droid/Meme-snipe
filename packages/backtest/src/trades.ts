// Round trips of a finished run, in lamports, built after the run from the final book and the fill model's attempt
// records (the scoring side; the engine never reads this). A position still held when the data ends, or whose exit
// was blocked, is valued at what the last ladder rung would get on the final pool, or 0 (§11).
import type { FillConfig } from '../../core/src/config/index.ts';
import type { RunResult } from './run.ts';
import type { AttemptRecord } from './sim/world.ts';

export interface TradeRecord {
  readonly id: string;
  readonly mint: string;
  readonly symbol: string;
  readonly openedAt: number;
  readonly closedAt: number;
  /** Lamports paid for the tokens, venue fees included. */
  readonly entrySol: bigint;
  readonly tokens: bigint;
  /** Lamports received, venue fees taken; for a blocked or held position, its end value. */
  readonly exitSol: bigint;
  readonly networkBase: bigint;
  readonly priority: bigint;
  readonly tip: bigint;
  readonly venueFee: bigint;
  readonly creatorFee: bigint;
  /** Price impact both legs plus the scenario's extra slippage, lamports. */
  readonly slippage: bigint;
  readonly rentPaid: bigint;
  readonly rentReturned: bigint;
  readonly exitReason: 'time-stop' | 'blocked';
  readonly net: bigint;
  readonly attempts: number;
  readonly failedAttempts: number;
}

/** Network fees of attempts that never became a position (failed entries): a real cost, kept apart from trades. */
export interface StrayCost {
  readonly at: number;
  readonly lamports: bigint;
}

const fees = (a: AttemptRecord, base: bigint, tip: bigint) => ({
  base: a.fee === 0n ? 0n : base,
  priority: a.fee === 0n ? 0n : a.priorityFee,
  tip: a.outcome === 'filled' ? tip : 0n,
});

const slippageLamports = (a: AttemptRecord): bigint => {
  const c = a.costs;
  const f = a.fill;
  if (c === null || f === null) return 0n;
  if (a.purpose === 'exit') return c.impact + c.extraSlippage;
  // A buy's extra slippage is in tokens: value it at the fill's own price.
  const bought = f.tokens + c.extraSlippage;
  return c.impact + (bought === 0n ? 0n : (c.extraSlippage * f.sol) / bought);
};

export const tradesOf = (r: RunResult, fills: FillConfig): { readonly trades: TradeRecord[]; readonly stray: StrayCost[] } => {
  const net = fills.network;
  const base = net.signaturesPerTx * net.baseFeePerSignature;
  const scenario = fills.scenarios[r.scenario];
  const byIntent = new Map<string, AttemptRecord[]>();
  for (const a of r.attempts) byIntent.set(a.intentId, [...(byIntent.get(a.intentId) ?? []), a]);
  const trades: TradeRecord[] = [];
  const stray: StrayCost[] = [];
  for (const p of Object.values(r.book.positions)) {
    const entryAttempts = byIntent.get(p.entryIntentId) ?? [];
    const entry = entryAttempts.find((a) => a.outcome === 'filled');
    if (entry === undefined || entry.fill === null) {
      for (const a of entryAttempts) if (a.fee > 0n) stray.push({ at: a.landedAt ?? r.endedAt, lamports: a.fee });
      continue;
    }
    const exitIntents = Object.values(r.book.intents).filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === p.id).map((i) => i.intent.id);
    const exitAttempts = exitIntents.flatMap((id) => byIntent.get(id) ?? []);
    const all = [...entryAttempts, ...exitAttempts];
    const sold = exitAttempts.filter((a) => a.outcome === 'filled' && a.fill !== null);
    const soldSol = sold.reduce((t, a) => t + a.fill!.sol, 0n);
    const held = p.quantity;
    const blocked = p.status !== 'closed';
    const endValue = blocked ? r.endValue(p.mint, held) : 0n;
    const exitSol = soldSol + endValue;
    let b = 0n;
    let pr = 0n;
    let tp = 0n;
    for (const a of all) {
      const f = fees(a, base, net.tip);
      b += f.base;
      pr += f.priority;
      tp += f.tip;
    }
    const venue = all.reduce((t, a) => t + (a.costs === null ? 0n : a.costs.lpFee + a.costs.protocolFee), 0n);
    const creator = all.reduce((t, a) => t + (a.costs?.creatorFee ?? 0n), 0n);
    const slippage = all.reduce((t, a) => t + slippageLamports(a), 0n);
    const rentPaid = net.tokenAccountRent;
    const rentReturned = scenario.rentRecovery && !blocked ? rentPaid : 0n;
    const closedAt = blocked ? r.endedAt : Math.max(...sold.map((a) => a.landedAt ?? 0));
    trades.push({
      id: p.id, mint: p.mint, symbol: r.symbols.get(p.mint) ?? p.mint.slice(0, 6),
      openedAt: entry.landedAt ?? 0, closedAt, entrySol: entry.fill.sol, tokens: entry.fill.tokens, exitSol,
      networkBase: b, priority: pr, tip: tp, venueFee: venue, creatorFee: creator, slippage, rentPaid, rentReturned,
      exitReason: blocked ? 'blocked' : 'time-stop',
      net: exitSol - entry.fill.sol - b - pr - tp - rentPaid + rentReturned,
      attempts: all.length, failedAttempts: all.filter((a) => a.outcome !== 'filled').length,
    });
  }
  trades.sort((x, y) => x.closedAt - y.closedAt || (x.id < y.id ? -1 : 1));
  return { trades, stray };
};
