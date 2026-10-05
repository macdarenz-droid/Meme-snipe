// OOM-SWAPS: what the live engine's as-of store keeps, shared by the worker and its parity replay so both prune alike.
// Without it the store kept every event for the process: each swap on a watched pool left its trade event and a fresh
// pool fact (about 10 KB with their addresses), and at a few thousand swaps a minute the heap reached its limit in minutes.
import type { Collapse, Retention } from '../../../core/src/engine/index.ts';
import { poolKey, tradeTailCollapse } from '../../../core/src/gates/index.ts';

const POOL_PREFIX = poolKey('');

/**
 * How long a pool fact's past is kept: a minute. Every reader looks a pool fact up as of now (the gates' evidence, the
 * strategy's market and exits); the store keeps the latest value at or before the horizon, so those answers are exact.
 */
export const POOL_FACT_KEEP_MS = 60_000;

/** The live store's horizons: pool facts a minute, everything else whole (`Retention`). */
export const liveRetention: Retention = (key) => (key.startsWith(POOL_PREFIX) ? POOL_FACT_KEEP_MS : null);

/** The live store's collapse: a trade key keeps its newest event and every event whose tail would fail (`tradeTailCollapse`). */
export const liveCollapse: Collapse = tradeTailCollapse;
