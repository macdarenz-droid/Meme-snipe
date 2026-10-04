// Bounds on in-memory caches. Not limits of trading: changing them changes memory use, never an answer.
import { deepFreeze } from './freeze.ts';

export interface MemoryLimits {
  /** Addresses whose ed25519 curve check is remembered (H12 holder classification). */
  readonly offCurveCache: number;
}

export const MEMORY_LIMITS: MemoryLimits = deepFreeze({ offCurveCache: 200_000 });
