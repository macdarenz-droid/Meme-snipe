// M10 latency model (A-M10-01 logic 5; ARCH 3.4). The prior is lognormal with median 1,500 ms and p95 5,000 ms
// (A-04): μ = ln(median), σ = (ln(p95) − ln(median)) / Φ⁻¹(0.95) ≈ 0.732 (DERIVED). Draws come only from the seeded
// `Rng` (logic 1): lognormal by Box-Muller from two `nextFloat()` draws; empirical by a uniform draw from the samples.
// The result is multiplied by `multiplier` (R-4 uses 2, ARCH 3.4); only multipliers of 1 or more exist, so a run can
// never make latency shorter than its parameter set says.
//
// Clarification C-61 (A10, bug B1): latency is in milliseconds and becomes slots only through the one slot-to-time
// function (`slotAfterLatency`), never through a fixed slot time.
import type { Rng, Slot } from '@bot/types';
import { slotToTimeMs, timeToSlot, type SlotTimeBasis } from '../m15/slot-time.ts';
import { normalQuantile } from '../m13/stats/special.ts';
import { nextBelow } from './rng.ts';
import type { LatencySpec } from './params.ts';

export interface LatencyModel { sampleMs(rng: Rng, multiplier: number): number }

/** `sim.latency_multiplier` range (A-M10-01 "Config"). */
export const LATENCY_MULTIPLIER_MIN = 1;
export const LATENCY_MULTIPLIER_MAX = 10;

/** μ and σ of the lognormal with the given median and 95th percentile. */
export function lognormalParams(medianMs: number, p95Ms: number): { mu: number; sigma: number } {
  if (!(medianMs > 0) || !(p95Ms > medianMs) || !Number.isFinite(p95Ms)) throw new RangeError('E_SIM_PARAMS: need 0 < median < p95');
  return { mu: Math.log(medianMs), sigma: (Math.log(p95Ms) - Math.log(medianMs)) / normalQuantile(0.95) };
}

function checkMultiplier(m: number): void {
  if (!Number.isFinite(m) || m < LATENCY_MULTIPLIER_MIN || m > LATENCY_MULTIPLIER_MAX) {
    throw new RangeError(`latency multiplier must be in ${LATENCY_MULTIPLIER_MIN}..${LATENCY_MULTIPLIER_MAX}`);
  }
}

export function createLatencyModel(spec: LatencySpec): LatencyModel {
  if (spec.kind === 'lognormal_prior') {
    const { mu, sigma } = lognormalParams(spec.medianMs, spec.p95Ms);
    return {
      sampleMs(rng, multiplier) {
        checkMultiplier(multiplier);
        const u1 = rng.nextFloat(), u2 = rng.nextFloat();
        const z = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);   // 1 − u1 is in (0, 1]
        return Math.exp(mu + sigma * z) * multiplier;
      },
    };
  }
  const samples = [...spec.samplesMs];
  if (samples.length === 0 || samples.length !== spec.n || !samples.every((x) => Number.isFinite(x) && x >= 0)) {
    throw new RangeError('E_SIM_PARAMS: empirical latency needs n finite samples >= 0');
  }
  return {
    sampleMs(rng, multiplier) {
      checkMultiplier(multiplier);
      return (samples[nextBelow(rng, samples.length)] as number) * multiplier;
    },
  };
}

/** The first slot at or after `latencyMs` past slot `from`, dated on `basis` (the B1 fix: no fixed slot time). */
export function slotAfterLatency(from: Slot, latencyMs: number, basis: SlotTimeBasis): Slot {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new RangeError('latency must be finite ms >= 0');
  return timeToSlot(slotToTimeMs(from, basis) + latencyMs, basis);
}
