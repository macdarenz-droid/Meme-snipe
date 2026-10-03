// Drill plan: fixed before the run starts and written to the evidence folder, so drill times are pre-set,
// never chosen while watching the market. Pure.
import type { RestartCause } from './contract.ts';

export type Drill =
  | { readonly id: string; readonly kind: 'restart'; readonly cause: RestartCause; readonly atMs: number; readonly windowMs: number }
  | { readonly id: string; readonly kind: 'feed'; readonly atMs: number; readonly feed: string; readonly dropMs: number }
  /** Every RPC and WebSocket provider lost at once for dropMs. */
  | { readonly id: string; readonly kind: 'rpc'; readonly atMs: number; readonly dropMs: number };

/**
 * Restart causes in plan order. Crashes come first and most often (the accept needs at least 3 of them mid-trade);
 * every other cause appears at least once in a plan of 6 or more restarts.
 */
export const DEFAULT_CAUSES: readonly RestartCause[] = ['crash', 'reboot', 'crash', 'host-loss', 'crash', 'chain-rebuild', 'crash', 'reboot'];

export interface PlanOptions {
  readonly durationMs: number;
  readonly feeds: readonly string[];
  /** Restart drills; the accept needs at least 3 mid-trade kills, so plan more than 3 to absorb quiet windows. */
  readonly restarts?: number;
  /** Cause of each restart, in order; defaults to DEFAULT_CAUSES (repeated if more restarts are asked for). */
  readonly causes?: readonly RestartCause[];
  /** After a restart drill's time, wait this long for an open trade before killing anyway. */
  readonly restartWindowMs?: number;
  readonly feedDropMs?: number;
  /** The shortest default drop: two health samples. */
  readonly minFeedDropMs?: number;
  /** RPC-loss drills (all providers at once). */
  readonly rpcDrops?: number;
  readonly rpcDropMs?: number;
}

const H = 3_600_000;

/**
 * Restarts at evenly spaced points of the run (never in its first or last 5%); one drop per feed and then the RPC
 * drops, each halfway between two restarts, so drills never overlap.
 */
export const makePlan = (o: PlanOptions): readonly Drill[] => {
  const causes = o.causes ?? DEFAULT_CAUSES;
  const restarts = o.restarts ?? (o.causes ? o.causes.length : DEFAULT_CAUSES.length);
  const windowMs = o.restartWindowMs ?? Math.min(H, o.durationMs / (4 * (restarts + 1)));
  // At least two health samples long (10 s each by default): a shorter drop can fall between samples and read as never
  // reported (rehearsal 37142749019, a 4.5 s drop).
  const dropMs = o.feedDropMs ?? Math.min(120_000, Math.max(o.minFeedDropMs ?? 20_000, o.durationMs / 200));
  const rpcDrops = o.rpcDrops ?? 2;
  const rpcDropMs = o.rpcDropMs ?? dropMs;
  if (!(o.durationMs > 0) || restarts < 3) throw new Error('plan needs a positive duration and at least 3 restarts');
  const step = (o.durationMs * 0.9) / restarts;
  const first = o.durationMs * 0.05;
  const drills: Drill[] = [];
  for (let i = 0; i < restarts; i++) {
    drills.push({ id: `restart-${i + 1}`, kind: 'restart', cause: causes[i % causes.length]!, atMs: Math.round(first + i * step), windowMs: Math.round(windowMs) });
  }
  // Halfway between restart i and i+1, wrapping to later gaps when there are more drops than gaps.
  const at = (i: number): number => Math.round(first + (i % restarts) * step + step / 2 + Math.floor(i / restarts) * (step / 8));
  const feeds = [...o.feeds].sort();
  feeds.forEach((feed, i) => drills.push({ id: `feed-${feed}`, kind: 'feed', atMs: at(i), feed, dropMs: Math.round(dropMs) }));
  for (let j = 0; j < rpcDrops; j++) drills.push({ id: `rpc-${j + 1}`, kind: 'rpc', atMs: at(feeds.length + j), dropMs: Math.round(rpcDropMs) });
  return drills.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
};
