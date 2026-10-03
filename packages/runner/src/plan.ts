// Drill plan: fixed before the run starts and written to the evidence folder, so drill times are pre-set,
// never chosen while watching the market. Pure.

export type Drill =
  | { readonly id: string; readonly kind: 'restart'; readonly atMs: number; readonly windowMs: number }
  | { readonly id: string; readonly kind: 'feed'; readonly atMs: number; readonly feed: string; readonly dropMs: number };

export interface PlanOptions {
  readonly durationMs: number;
  readonly feeds: readonly string[];
  /** Restart drills; the accept needs at least 3 mid-trade kills, so plan more than 3 to absorb quiet windows. */
  readonly restarts?: number;
  /** After a restart drill's time, wait this long for an open trade before killing anyway. */
  readonly restartWindowMs?: number;
  readonly feedDropMs?: number;
}

const H = 3_600_000;

/**
 * Restarts at evenly spaced points of the run (never in its first or last 5%); one drop per feed, placed halfway
 * between restarts so the two kinds never overlap.
 */
export const makePlan = (o: PlanOptions): readonly Drill[] => {
  const restarts = o.restarts ?? 6;
  const windowMs = o.restartWindowMs ?? Math.min(H, o.durationMs / (4 * (restarts + 1)));
  const dropMs = o.feedDropMs ?? Math.min(120_000, o.durationMs / 200);
  if (!(o.durationMs > 0) || restarts < 3) throw new Error('plan needs a positive duration and at least 3 restarts');
  const step = (o.durationMs * 0.9) / restarts;
  const first = o.durationMs * 0.05;
  const drills: Drill[] = [];
  for (let i = 0; i < restarts; i++) {
    drills.push({ id: `restart-${i + 1}`, kind: 'restart', atMs: Math.round(first + i * step), windowMs: Math.round(windowMs) });
  }
  const feeds = [...o.feeds].sort();
  feeds.forEach((feed, i) => {
    // Halfway between restart i and i+1, wrapping to later gaps when there are more feeds than gaps.
    const gap = i % restarts;
    const at = first + gap * step + step / 2 + Math.floor(i / restarts) * (step / 8);
    drills.push({ id: `feed-${feed}`, kind: 'feed', atMs: Math.round(at), feed, dropMs: Math.round(dropMs) });
  });
  return drills.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
};
