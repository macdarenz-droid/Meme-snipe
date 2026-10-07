// OOM-SWAPS: what the live engine's as-of store keeps, shared by the worker and its parity replay so both prune alike.
// Without it the store kept every event for the process: each swap on a watched pool left its trade event and a fresh
// pool fact (about 10 KB with their addresses), and at a few thousand swaps a minute the heap reached its limit in minutes.
import type { Collapse, Forget, Retention, Shape } from '../../../core/src/engine/index.ts';
import { SEED_KEY, SOL_PRICE_KEY, feesKey } from '../engine/strategy.ts';
import { FACT_READS_KEY } from '../facts/source.ts';
import { FUNDER_KEEP_MS, HOLE_FETCH_PREFIX, RAW } from '../../../core/src/facts/index.ts';
import { CURVE_VOLUME_KEY, EXEC_HEALTH_KEY, GRADUATES_KEY, LOG_CREATE_PREFIX, RUG_CHECK_PREFIX, SOL_USD_KEY, TX_CREATE_PREFIX, candlesKey, carryKey, compactCreate, compactCurveTrade, curveTradeKeys, holdersKey, lpKey, mintKey, poolKey, simKey, softKey, streamKey, tradeTailCollapse, xcheckKey } from '../../../core/src/gates/index.ts';

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
 * MEM-FIXES (red team C R2-C1): the rest of a candidate's coherent batch, stated again whole at every read (once a minute
 * per candidate): the raw reads (`read:holders`, `read:holders-all`, `read:sim`, `read:rugcheck`, `read:goplus`,
 * `read:jupiter-audit`), the fee context (`worker:fees`) and the gate facts made of them (`gates/holders`, `gates/sim`,
 * `gates/lp`, `gates/soft`, `gates/xcheck`). Kept whole, each read stayed until the candidate retired: 240 candidates
 * read once a minute grew the heap to 294 MB in 4 h, still rising. Every reader looks them up as of now only: the gates
 * through `Evidence.read` (H6 lp, H12/H13 holders, H15 sim, H16 soft and xcheck; no as-of argument), the strategy's
 * `#market` (`worker:fees`, no as-of argument); the producer and the worker act on the released frame; `history` is
 * asked for trade, coverage and deployer keys only. As of now, the newest entry is the answer with or without the
 * older ones (every entry is dated at or before now), so decisions and their logged inputs are unchanged; an as-of
 * read of an older moment finds no entry (never a newer one). The backtest's study reads holders as of the past, but
 * its engine keeps every entry (no collapse); only the live worker and its parity replay use these rules.
 */
const BATCH = [RAW.holders(''), RAW.holdersAll(''), RAW.sim(''), RAW.rugcheck(''), RAW.goplus(''), RAW.jupiter(''), feesKey(''), holdersKey(''), simKey(''), lpKey(''), softKey(''), xcheckKey('')];
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
/**
 * STORE-GROWTH sweep: the regime's other series, stated whole like the graduates fact (SOL/USD's hourly points, the
 * curve volume's days, execution health), and the raw reads they are made from (`sol-usd`, `read:chain-volume-hour`,
 * `read:exec-health`). The regime and H8 read the facts as of now (`Evidence.read`); the producer acts on the released
 * raw read and keeps its own series; nothing asks the store for an older value (`history` is asked for trade, coverage
 * and deployer keys only).
 */
const REGIME = [SOL_USD_KEY, CURVE_VOLUME_KEY, EXEC_HEALTH_KEY, RAW.solUsd, RAW.volumeHour, RAW.exec];
/**
 * F1b (supervisor ruling): an event of a known program that DEC-1 does not decode (`<program>:other:<program>`, from logs
 * and from fetched transactions). Its subject is the program, so the key never retires; nothing reads it (the producer
 * skips `other` events, `programEvent`), so only its newest value is kept.
 */
const OTHER = /^(?:logs:)?(?:pump|pump_amm):other:/;
/**
 * F4 (supervisor ruling): a creator's on-demand deployer check (`coverage:rugs:deployer:<creator>`, RUG-1c), stated
 * whole at every check, read by H14 as of now (`Evidence.read`; `history` reads only the `coverage:<stream>:start|gap|
 * resume` keys, which it is not); and a feed's status (`feed:status:<feed>`), which the worker acts on as it arrives
 * and nothing looks up in the store. TRADE-GAP-HEAL: a hole's fetch outcome (`hole-fetch:<via>`), which the producer
 * acts on as it is released and nothing looks up in the store.
 */
const STATED = [RUG_CHECK_PREFIX, 'feed:status:', HOLE_FETCH_PREFIX];
const NEWEST_ONLY = (): boolean => false;

/**
 * The live store's collapse: a head fact, a seen signature, the slot notice, an account read and its mint fact, the rest of a candidate's batch reads and their facts, the graduates fact and the regime's other series with their raw reads, and the worker's running facts keep their newest value; a trade key keeps its newest event
 * and every event whose tail would fail (`tradeTailCollapse`).
 */
export const liveCollapse: Collapse = (key) => (key === SLOT || key === GRADUATES || OTHER.test(key) || STATED.some((p) => key.startsWith(p)) || RUNNING.includes(key) || REGIME.includes(key) || key.startsWith(SEEN) || HEADS.some((p) => key.startsWith(p)) || READS.some((p) => key.startsWith(p)) || BATCH.some((p) => key.startsWith(p)) ? NEWEST_ONLY : tradeTailCollapse(key));

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

