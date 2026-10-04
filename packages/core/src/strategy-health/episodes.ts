// Episodes from the book (STRATEGY-HEALTH-OBS step 3). One entry intent is one episode: its size is the intent's
// `spend`, fixed before the first attempt; its value is the settled net of every position the intent opened (late-fill
// positions and partial exits included), or, when it never filled, minus the fees its attempts paid. The backtest and the
// worker hand in their own settlement (the same core functions, PAPER-1), so both build the same episodes from the same
// book. An episode is final only when every one of its positions has a settled net: no flow can arrive after `final`.
import { type Book, type IntentState, isTerminal } from '../lifecycle/index.ts';
import type { HealthEvent, HealthState, StrategyIdentity } from './index.ts';

export interface EpisodeSources {
  readonly identityOf: (entry: IntentState) => StrategyIdentity;
  /** A position's settled net in lamports (core `tradeNet`) and when it settled, or null while it is not settled. */
  readonly positionNet: (positionId: string) => { readonly net: bigint; readonly atMs: number } | null;
  /** Fees paid by an entry that never filled, and when the last of them was paid. */
  readonly strayFees: (entryIntentId: string) => { readonly lamports: bigint; readonly atMs: number };
}

export interface FinalEpisode {
  readonly episodeId: string;
  readonly identity: StrategyIdentity;
  readonly entryLamports: bigint;
  /** One flow per position (its settled net), or the stray fees of a failed entry; none when dropped. */
  readonly flows: readonly bigint[];
  readonly outcome: 'closed' | 'failed-entry' | 'dropped';
  readonly atMs: number;
}

/**
 * The episodes that are final in this book, in the order they became final (time, then entry intent id). Open ones
 * are left out; they stay open in the health state until they are final, so an unfinished loser never vanishes.
 */
export const finalEpisodes = (book: Book, src: EpisodeSources): FinalEpisode[] => {
  const byEntry = new Map<string, string[]>();
  for (const p of Object.values(book.positions)) byEntry.set(p.entryIntentId, [...(byEntry.get(p.entryIntentId) ?? []), p.id]);
  const out: FinalEpisode[] = [];
  for (const i of Object.values(book.intents)) {
    if (i.intent.purpose !== 'entry') continue;
    const base = { episodeId: i.intent.id as string, identity: src.identityOf(i), entryLamports: i.intent.spend as bigint };
    const positions = (byEntry.get(i.intent.id) ?? []).sort();
    // No fill on any of its positions: final once the intent is terminal, a failed entry if it paid fees.
    if (i.fills.length === 0) {
      // A failed or expired attempt may still be retried within the intent; only a terminal intent is final.
      if (!isTerminal(i)) continue;
      const fees = src.strayFees(i.intent.id);
      out.push(fees.lamports > 0n
        ? { ...base, flows: [-fees.lamports], outcome: 'failed-entry', atMs: fees.atMs }
        : { ...base, flows: [], outcome: 'dropped', atMs: fees.atMs });
      continue;
    }
    if (positions.length === 0) continue; // filled but its position not booked yet
    const nets = positions.map((id) => src.positionNet(id));
    if (nets.some((n) => n === null)) continue;
    out.push({ ...base, flows: nets.map((n) => n!.net), outcome: 'closed', atMs: Math.max(...nets.map((n) => n!.atMs)) });
  }
  return out.sort((a, b) => a.atMs - b.atMs || (a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0));
};

/**
 * Events for the final episodes the state has not seen yet, numbered on from the state's last sequence. Each episode
 * is emitted whole (entry, flows, final), so the state never holds a half-built episode from this path.
 */
export const newEpisodeEvents = (state: HealthState, episodes: readonly FinalEpisode[]): HealthEvent[] => {
  let seq = state.lastSeq;
  const out: HealthEvent[] = [];
  for (const e of episodes) {
    if (state.finished[e.episodeId] || state.open[e.episodeId]) continue;
    out.push({ type: 'entry', seq: ++seq, episodeId: e.episodeId, identity: e.identity, entryLamports: e.entryLamports });
    for (const f of e.flows) out.push({ type: 'flow', seq: ++seq, episodeId: e.episodeId, lamports: f });
    out.push({ type: 'final', seq: ++seq, episodeId: e.episodeId, outcome: e.outcome });
  }
  return out;
};
