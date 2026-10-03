// Exit-failure stress views of finished runs (scoring side; BT-1c exit-failure ruling): the blocked-exit rate when a
// position's whole exit ladder fell inside congestion (this feeds y_severe), and expectancy and survival as
// deterministic failure bursts of a given length become more frequent.
import { economics } from './economics.ts';
import { type RunOptions, type RunResult, runBacktest } from './run.ts';
import { tradesOf } from './trades.ts';

export interface LadderCongestion {
  /** Positions with exit attempts, every one of them sent while congested. */
  readonly allCongested: number;
  readonly allCongestedBlocked: number;
  /** Positions with exit attempts of which at least one was sent in calm. */
  readonly rest: number;
  readonly restBlocked: number;
}

export const ladderCongestion = (r: RunResult): LadderCongestion => {
  const byPosition = new Map<string, boolean[]>();
  const positionOf = new Map<string, string>();
  for (const i of Object.values(r.book.intents)) if (i.intent.purpose === 'exit') positionOf.set(i.intent.id, i.intent.positionId);
  for (const pid of positionOf.values()) byPosition.set(pid, byPosition.get(pid) ?? []);
  for (const a of r.attempts) {
    const pid = positionOf.get(a.intentId);
    if (pid !== undefined) byPosition.get(pid)!.push(a.congested);
  }
  let allCongested = 0;
  let allCongestedBlocked = 0;
  let rest = 0;
  let restBlocked = 0;
  for (const [pid, flags] of byPosition) {
    const blocked = r.book.positions[pid]?.status !== 'closed';
    if (flags.length > 0 && flags.every((f) => f)) {
      allCongested++;
      if (blocked) allCongestedBlocked++;
    } else {
      rest++;
      if (blocked) restBlocked++;
    }
  }
  return { allCongested, allCongestedBlocked, rest, restBlocked };
};

export interface BurstRow {
  readonly perDay: number;
  readonly durationMs: number;
  readonly trades: number;
  readonly entryDecisions: number;
  readonly allInPerEntryDecisionMicro: bigint | null;
  /** Share of positions with exits that ended blocked. */
  readonly blockedExitRate: number;
  readonly minEquityMicro: bigint;
  readonly survived: boolean;
}

/** One run per burst length and frequency (bursts per UTC day, evenly spaced), the rest of the options unchanged. */
export const burstSweep = (base: RunOptions, grid: { readonly perDay: readonly number[]; readonly durationsMs: readonly number[] },
  window: { readonly from: number; readonly to: number }): BurstRow[] => {
  const out: BurstRow[] = [];
  const solUsd = base.series.find((s) => s.name === 'SOL/USD');
  if (solUsd === undefined) throw new RangeError('the sweep needs the SOL/USD series');
  for (const durationMs of grid.durationsMs) {
    for (const perDay of grid.perDay) {
      const r = runBacktest({ ...base, failureBursts: { perDay, durationMs } });
      const { trades, stray } = tradesOf(r, base.fills);
      const entryDecisions = Object.values(r.book.intents).filter((i) => i.intent.purpose === 'entry').length;
      const e = economics({ trades, stray, entryDecisions, solUsd, window, policy: base.policy, research: base.research });
      const l = ladderCongestion(r);
      const exits = l.allCongested + l.rest;
      out.push({
        perDay, durationMs, trades: trades.length, entryDecisions, allInPerEntryDecisionMicro: e.usd.allInPerEntryDecisionMicro,
        blockedExitRate: exits === 0 ? 0 : (l.allCongestedBlocked + l.restBlocked) / exits, minEquityMicro: e.survival.minEquityMicro, survived: e.survival.survived,
      });
    }
  }
  return out;
};
