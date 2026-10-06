// OOM-SWAPS: what the live engine's as-of store keeps, shared by the worker and its parity replay so both prune alike.
// Without it the store kept every event for the process: each swap on a watched pool left its trade event and a fresh
// pool fact (about 10 KB with their addresses), and at a few thousand swaps a minute the heap reached its limit in minutes.
import type { Collapse, Forget, Retention, Shape } from '../../../core/src/engine/index.ts';
import { SEED_KEY, SOL_PRICE_KEY } from '../engine/strategy.ts';
import { FACT_READS_KEY } from '../facts/source.ts';
import { FUNDER_KEEP_MS, RAW } from '../../../core/src/facts/index.ts';
import { GRADUATES_KEY, LOG_CREATE_PREFIX, TX_CREATE_PREFIX, candlesKey, carryKey, compactCreate, compactCurveTrade, curveTradeKeys, mintKey, poolKey, streamKey, tradeTailCollapse } from '../../../core/src/gates/index.ts';

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
/**
 * G4a (supervisor ruling): the graduates fact (`gates/graduates`), stated whole at every resolved graduate (about one a
 * minute), each time with every graduate of its 16-day window: kept whole, each statement held a pointer array the
 * length of the series, about 180 KB a statement at the live rate once the window is full (about 260 MB a day). The
 * regime gate reads it as of now (`Evidence.read`, 'series'); the strategy acts on the released event; nothing asks
 * for an older value.
 */
const GRADUATES = GRADUATES_KEY;
/**
 * STORE-GROWTH: the worker's own running facts, each stated again whole: SOL/USD at every price tick (`worker:sol-price`,
 * about one a second live), and the day's read counts at every read (`worker:fact-reads`). The strategy looks the price
 * up as of now only; nothing looks the read counts up in the store (the source keeps its own counts). Kept whole, both
 * grew for the process: in the harness about 200 entries a minute between them, more at live's read rate.
 */
const RUNNING = [SOL_PRICE_KEY, FACT_READS_KEY];
const NEWEST_ONLY = (): boolean => false;

/**
 * The live store's collapse: a head fact, a seen signature, the slot notice, an account read and its mint fact, the graduates fact, and the worker's running facts keep their newest value; a trade key keeps its newest event
 * and every event whose tail would fail (`tradeTailCollapse`).
 */
export const liveCollapse: Collapse = (key) => (key === SLOT || key === GRADUATES || RUNNING.includes(key) || key.startsWith(SEEN) || HEADS.some((p) => key.startsWith(p)) || READS.some((p) => key.startsWith(p)) ? NEWEST_ONLY : tradeTailCollapse(key));

const CURVE_TRADE = curveTradeKeys('');
/**
 * CREATE-COMPACT: a create event and a curve trade event are stored with only the fields their store readers read
 * (`compactCreate`, `compactCurveTrade`); the strategy and the producer still act on the released event whole.
 */
export const liveShape: Shape = (key) =>
  key === SEED_KEY ? compactSeed
    : key.startsWith(LOG_CREATE_PREFIX) || key.startsWith(TX_CREATE_PREFIX) ? compactCreate : CURVE_TRADE.some((p) => key.startsWith(p)) ? compactCurveTrade : null;

/**
 * G4a (supervisor ruling): the boot's seed fact (`worker:seed`) carries the index's creates, coverage, fill, rugs and
 * history, up to 200,000 creates on a start with no saved state. The strategy acts on the released event; nothing
 * looks it up in the store (the seed's history is the strategy's own copy), so the store keeps only its moment and
 * how many of each it carried.
 */
export const compactSeed = (v: unknown): unknown => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
  const o = v as Readonly<Record<string, unknown>>;
  const n = (k: string): number | null => (Array.isArray(o[k]) ? (o[k] as unknown[]).length : null);
  return Object.freeze({ asOf: o['asOf'], counts: Object.freeze({ creates: n('creates'), coverage: n('coverage'), fill: n('fill'), rugs: n('rugs'), history: n('history') }) });
};

const FUNDER = RAW.funder('');
/**
 * G4a (supervisor ruling): a wallet's funder read (`read:funder:<wallet>`) is forgotten a day after it was read, as the
 * producer forgets it (`FUNDER_KEEP_MS`). The producer acts on the released read; nothing looks the key up in the store.
 */
export const liveForget: Forget = (key) => (key.startsWith(FUNDER) ? FUNDER_KEEP_MS : null);

