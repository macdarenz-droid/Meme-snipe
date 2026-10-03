// Compute-unit limits from offline calibration: p99 of the units our own instruction set consumed, times 1.1
// (docs/ARCHITECTURE.md §10; execution.md §10). Never the 200k default or 1.4M: the priority fee is billed on the
// requested limit, and a tight limit also raises scheduler priority. The table is configuration measured offline;
// TEST-2's dry-run simulations replace the provisional samples (real mainnet swaps of the same shape) with our own.

/** One transaction shape. A build looks up exactly its shape; a missing shape refuses the build. */
export type TxShape = 'curve-buy' | 'curve-sell' | 'curve-sell-close' | 'pool-buy' | 'pool-sell' | 'pool-sell-close' | 'withdraw';

export type CuCalibration = Readonly<Partial<Record<TxShape, number>>>;

/** Runtime cap on a transaction's compute units. */
export const MAX_COMPUTE_UNITS = 1_400_000;
/** Fewer samples than this cannot support a p99. */
export const MIN_CALIBRATION_SAMPLES = 20;

/** ceil(p99 × 1.1), p99 by nearest rank (the ⌈0.99·n⌉-th smallest), in integers only. */
export const calibratedLimit = (consumed: readonly number[]): number => {
  if (consumed.length < MIN_CALIBRATION_SAMPLES) throw new RangeError(`at least ${MIN_CALIBRATION_SAMPLES} samples are needed, got ${consumed.length}`);
  for (const c of consumed) if (!Number.isSafeInteger(c) || c <= 0) throw new RangeError(`compute units must be positive integers, got ${c}`);
  const sorted = [...consumed].sort((a, b) => a - b);
  const rank = Math.ceil((sorted.length * 99) / 100);
  const p99 = sorted[rank - 1]!;
  const limit = Math.ceil((p99 * 11) / 10);
  if (limit > MAX_COMPUTE_UNITS) throw new RangeError(`calibrated limit ${limit} exceeds the ${MAX_COMPUTE_UNITS} runtime cap`);
  return limit;
};

export const calibrate = (samples: Readonly<Partial<Record<TxShape, readonly number[]>>>): CuCalibration => {
  const out: Partial<Record<TxShape, number>> = {};
  for (const [shape, consumed] of Object.entries(samples) as [TxShape, readonly number[]][]) out[shape] = calibratedLimit(consumed);
  return out;
};
