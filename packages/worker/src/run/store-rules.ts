// OOM-SWAPS: what the live engine's as-of store keeps, shared by the worker and its parity replay so both prune alike.
// Without it the store kept every event for the process: each swap on a watched pool left its trade event and a fresh
// pool fact (about 10 KB with their addresses), and at a few thousand swaps a minute the heap reached its limit in minutes.
import type { Collapse, Retention } from '../../../core/src/engine/index.ts';
import { RAW } from '../../../core/src/facts/index.ts';
import { candlesKey, carryKey, mintKey, poolKey, streamKey, tradeTailCollapse } from '../../../core/src/gates/index.ts';

const POOL_PREFIX = poolKey('');

/**
 * How long a pool fact's past is kept: a minute. Every reader looks a pool fact up as of now (the gates' evidence, the
 * strategy's market and exits); the store keeps the latest value at or before the horizon, so those answers are exact.
 */
export const POOL_FACT_KEEP_MS = 60_000;

/** The live store's horizons: pool facts a minute, everything else whole (`Retention`). */
export const liveRetention: Retention = (key) => (key.startsWith(POOL_PREFIX) ? POOL_FACT_KEEP_MS : null);

/**
 * OOM-HEADS: facts the producer states again whole, each time replacing the last, and that every reader looks up only
 * as of now (the gates' evidence, the strategy): a stream's head at every slot notice for every stream, a pool's candles
 * at every swap, a chain's carry at every slot. Only `history` sees an older value, and it is asked for trade, coverage
 * and deployer keys only. Kept whole, 240 trade streams at 2.5 slot notices a second and the candles of every swap grew
 * the heap about 20 MB a minute.
 */
const HEADS = [streamKey(''), candlesKey(''), carryKey('')];
/**
 * OOM-HEADS: a signature seen on a watch (`seen:<via>`, one per logs notification, a few thousand a minute): nothing looks
 * it up in the store (the delay probe and the fetches act on the frame), so only its newest value is kept too.
 */
const SEEN = 'seen:';
/**
 * OOM-SEEN: the chain's slot notice (`chain:slot`, 2.5 a second): the producer, the strategy and the worker act on the
 * released event; nothing looks it up in the store, so only its newest value is kept.
 */
const SLOT = 'chain:slot';
/**
 * OOM-MINT: a candidate's account read (`read:accounts:<mint>`) and the mint fact made from it (`gates/mint:<mint>`), each
 * stated again whole at every read: the producer acts on the released read, the gates look the mint fact up as of now
 * (`Evidence.read`); nothing asks for an older value (`history` is asked for trade, coverage and deployer keys only).
 */
const READS = [RAW.accounts(''), mintKey('')];
const NEWEST_ONLY = (): boolean => false;

/**
 * The live store's collapse: a head fact, a seen signature, the slot notice, an account read and its mint fact keep their newest value; a trade key keeps its newest event
 * and every event whose tail would fail (`tradeTailCollapse`).
 */
export const liveCollapse: Collapse = (key) => (key === SLOT || key.startsWith(SEEN) || HEADS.some((p) => key.startsWith(p)) || READS.some((p) => key.startsWith(p)) ? NEWEST_ONLY : tradeTailCollapse(key));
