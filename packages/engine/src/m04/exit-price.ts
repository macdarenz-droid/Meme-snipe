// Ruling Z07-31 (SPEC-A C-88): during a slot-clock disagreement an exit read carries two unstored reads, the newest
// one under the ceiling and the highest plausible one past it. Neither can be trusted alone (a lagging peer, or a
// plausible liar with a faked vault: #325 red team MAJOR-R10), so an exit prices on the WORSE proceeds of the two:
// for a sell, the smaller quote out, and its minOut is derived from that smaller quote. Pure.

/** One read with the proceeds the caller's venue model gives for the exit on it (lamports out for a sell). */
export interface ExitCandidate<S> { snapshot: S; proceedsLamports: bigint }

/**
 * The candidate with the smaller proceeds; an absent one (null) is skipped, and a tie keeps `a`. Null only when both
 * are absent.
 */
export function worseProceeds<S>(a: ExitCandidate<S> | null, b: ExitCandidate<S> | null): ExitCandidate<S> | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.proceedsLamports < a.proceedsLamports ? b : a;
}
