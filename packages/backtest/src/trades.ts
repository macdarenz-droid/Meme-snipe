// Round trips of a finished run, in lamports, built after the run from the final book and the fill model's attempt
// records (the scoring side; the engine never reads this). A position still held when the data ends, or whose exit
// was blocked, is valued at what the last ladder rung would get on the final pool, or 0 (§11).
import type { FillConfig } from '../../core/src/config/index.ts';
import type { RunResult } from './run.ts';
import type { AttemptRecord } from './sim/world.ts';

/** One leg's costs, lamports: converted to USD at that leg's own time (entry at the entry, exit at the exit). */
export interface LegCosts {
  readonly networkBase: bigint;
  readonly priority: bigint;
  readonly tip: bigint;
  readonly venueFee: bigint;
  readonly creatorFee: bigint;
  readonly slippage: bigint;
}

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
  /** The totals above split by leg. */
  readonly legs: { readonly entry: LegCosts; readonly exit: LegCosts };
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
  const byIntent = new Map<string, AttemptRecord[]>();
  for (const a of r.attempts) byIntent.set(a.intentId, [...(byIntent.get(a.intentId) ?? []), a]);
  const trades: TradeRecord[] = [];
  const stray: StrayCost[] = [];
  // Several positions can share an entry intent (LEDGER-1b): a late buy landing books `<position>.o<n>`, holding the
  // intent's n-th fill. Each such position owns its fill and that fill's attempt; the main position owns the rest.
  const lateFill = (pid: string): number | null => {
    const m = /\.o(\d+)$/.exec(pid);
    return m === null ? null : Number(m[1]) - 1;
  };
  const claimed = new Map<string, Set<string>>();
  for (const p of Object.values(r.book.positions)) {
    const k = lateFill(p.id);
    const f = k === null ? undefined : r.book.intents[p.entryIntentId]?.fills[k];
    if (f !== undefined) claimed.set(p.entryIntentId, (claimed.get(p.entryIntentId) ?? new Set<string>()).add(f.signature));
  }
  // One token account per entry: its rent is charged to the first trade of the entry intent only, and comes back once,
  // only when a sell of one of its positions landed as an atomic sell-and-close (world.ts). A sell-only fallback, a
  // partial exit, dust or an unsolicited token leaves it locked.
  const rentCharged = new Set<string>();
  const positionOfIntent = new Map<string, string>();
  for (const i of Object.values(r.book.intents)) if (i.intent.purpose === 'exit') positionOfIntent.set(i.intent.id, i.intent.positionId);
  const closedEntries = new Set<string>();
  for (const a of r.attempts) {
    if (!a.closedAccount) continue;
    const pid = positionOfIntent.get(a.intentId);
    const p = pid === undefined ? undefined : r.book.positions[pid];
    if (p !== undefined) closedEntries.add(p.entryIntentId);
  }
  const ordered = Object.values(r.book.positions).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const p of ordered) {
    const intent = r.book.intents[p.entryIntentId];
    const k = lateFill(p.id);
    const late = claimed.get(p.entryIntentId) ?? new Set<string>();
    const fillsOf = k === null ? (intent?.fills ?? []).filter((f) => !late.has(f.signature)) : [intent?.fills[k]].filter((f) => f !== undefined);
    const signatures = new Set<string>(fillsOf.map((f) => f.signature));
    const entryAttempts = (byIntent.get(p.entryIntentId) ?? []).filter((a) => (k === null ? !late.has(a.signature) : signatures.has(a.signature)));
    const landings = fillsOf.map((f) => {
      const a = entryAttempts.find((x) => x.signature === f.signature);
      // Every fill comes from an attempt the fill model settled; one without is a broken run, never a guessed time.
      if (a === undefined || a.landedAt === null) throw new RangeError(`position ${p.id}: fill ${f.signature} has no landed attempt record`);
      return a.landedAt;
    });
    const entryFill = fillsOf.length === 0 ? null : {
      sol: fillsOf.reduce((t, f) => t + f.sol, 0n), tokens: fillsOf.reduce((t, f) => t + f.tokens, 0n), at: Math.min(...landings),
    };
    if (entryFill === null) {
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
    const leg = (as: readonly AttemptRecord[]): LegCosts => {
      let b = 0n;
      let pr = 0n;
      let tp = 0n;
      for (const a of as) {
        const f = fees(a, base, net.tip);
        b += f.base;
        pr += f.priority;
        tp += f.tip;
      }
      return {
        networkBase: b, priority: pr, tip: tp,
        venueFee: as.reduce((t, a) => t + (a.costs === null ? 0n : a.costs.lpFee + a.costs.protocolFee), 0n),
        creatorFee: as.reduce((t, a) => t + (a.costs?.creatorFee ?? 0n), 0n),
        slippage: as.reduce((t, a) => t + slippageLamports(a), 0n),
      };
    };
    const legs = { entry: leg(entryAttempts), exit: leg(exitAttempts) };
    const b = legs.entry.networkBase + legs.exit.networkBase;
    const pr = legs.entry.priority + legs.exit.priority;
    const tp = legs.entry.tip + legs.exit.tip;
    const venue = legs.entry.venueFee + legs.exit.venueFee;
    const creator = legs.entry.creatorFee + legs.exit.creatorFee;
    const slippage = legs.entry.slippage + legs.exit.slippage;
    const firstOfEntry = !rentCharged.has(p.entryIntentId);
    rentCharged.add(p.entryIntentId);
    const rentPaid = firstOfEntry ? net.tokenAccountRent : 0n;
    // RENT-1: the rent comes back exactly when a sell-and-close landed (the fill model draws it per attempt), in every
    // scenario; the no-recovery line stays a reported sensitivity (economics), never the score.
    const rentReturned = firstOfEntry && closedEntries.has(p.entryIntentId) ? rentPaid : 0n;
    const closedAt = blocked ? r.endedAt : Math.max(...sold.map((a) => a.landedAt ?? 0));
    trades.push({
      id: p.id, mint: p.mint, symbol: r.symbols.get(p.mint) ?? p.mint.slice(0, 6),
      openedAt: entryFill.at, closedAt, entrySol: entryFill.sol, tokens: entryFill.tokens, exitSol,
      networkBase: b, priority: pr, tip: tp, venueFee: venue, creatorFee: creator, slippage, rentPaid, rentReturned,
      exitReason: blocked ? 'blocked' : 'time-stop',
      net: exitSol - entryFill.sol - b - pr - tp - rentPaid + rentReturned,
      attempts: all.length, failedAttempts: all.filter((a) => a.outcome !== 'filled').length, legs,
    });
  }
  trades.sort((x, y) => x.closedAt - y.closedAt || (x.id < y.id ? -1 : 1));
  return { trades, stray };
};
