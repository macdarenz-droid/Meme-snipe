// Holm's step-down correction for testing several universes (U1–U3) at a family-wise α
// (Holm, "A simple sequentially rejective multiple test procedure", Scand. J. Statistics 6(2):65–70, 1979).
// Sort the m p-values ascending; the k-th smallest (k = 1..m) is tested at α/(m − k + 1); stop at the first that fails.

export interface HolmResult {
  /** Rejected (passed) per input position. */
  readonly rejected: readonly boolean[];
  /** The level each hypothesis was tested at (its Holm-adjusted α), per input position. */
  readonly levels: readonly number[];
}

export const holm = (pValues: readonly number[], alpha = 0.05): HolmResult => {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha must be in (0, 1), got ${alpha}`);
  for (const p of pValues) if (!(p >= 0 && p <= 1)) throw new RangeError(`p-values must be in [0, 1], got ${p}`);
  const m = pValues.length;
  // Stable order: ties keep input order, so the result does not depend on anything but the inputs.
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const rejected = Array<boolean>(m).fill(false);
  const levels = Array<number>(m).fill(0);
  let stopped = false;
  order.forEach(({ p, i }, k) => {
    const level = alpha / (m - k);
    levels[i] = level;
    if (!stopped && p < level) rejected[i] = true;
    else stopped = true;
  });
  return { rejected, levels };
};
