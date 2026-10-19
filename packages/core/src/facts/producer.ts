// Fact producers (FACTS-1): GATE-1's facts derived from released events only. One pure observer, fed every market
// event in release order, live (WORKER-1) and in the backtest (BT-2), so the same events always give the same facts
// (docs/ARCHITECTURE.md §16.1). Each fact is stamped with the slot and receipt time of the data it used.
//
// Inputs:
// - DEC-1 program events as FEED-1 emits them: from fetched transactions (`ev:` ids, confirmed) or from log lines
//   (`logs:` keys; processed unless the watch was confirmed). Processed events never make a fact: they can be rolled back.
// - Coverage of named streams (FEED-1 `coverage:<name>:start|gap|resume`), chain slot notices, cut or undecodable logs.
// - Raw read answers under the keys of raw.ts (accounts, holders, simulation, third-party reads, funders, series).
//
// Rule (owner): missing, stale or failed data produces no fact, or an explicit not-covered one (a flagged or
// `complete: false` fact the gates reject). Nothing here ever fills a gap with a value that passes.
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '../config/time.ts';
import type { Policy } from '../config/policy.ts';
import { RESEARCH_CONFIG } from '../config/research.ts';
import {
  type Address, type PumpEventData, PUMP_AMM_PROGRAM, decodeMint, decodePool, decodeTokenAccount, fromBase64, isNoChangePoolEvent,
} from '../chain/index.ts';
import type { Commitment, QualityFlag } from '../domain/index.ts';
import type { MarketEvent } from '../engine/feed.ts';
import { flatCopy } from '../engine/asof.ts';
import { RepeatTags, tradeRepeatTag } from './repeat-tags.ts';
import type { PoolState } from '../amm/index.ts';
import { swapEventState } from '../fills/pool.ts';
import {
  type Candle, type CandlesFact, type FactObs, type GraduatesFact, type InsidersFact, type MintFact, type PoolFact, type Price,
  type SoftFact, type XcheckFact, CURVE_VOLUME_KEY, EXEC_HEALTH_KEY, GRADUATES_KEY, SOL_USD_KEY, candlesKey, createKey, curveKey,
  carryKey, holdersKey, insidersKey, lpKey, migrationKey, mintKey, poolKey, simKey, softKey, streamKey, xcheckKey,
} from '../gates/facts.ts';
import { HOURLY_MAX_AGE_MS } from '../gates/series.ts';
import { insiderLinks } from './funding.ts';
import { ChainVolumeDays } from './volume.ts';
import { CappedMap } from './capped-map.ts';
import type { VolumeHour } from './raw.ts';
import { BPS_DENOMINATOR } from '../units/index.ts';
import {
  RAW, decimalToMicro, parseAccountsRead, parseVolumeHour, parseExecStats, parseGraduatesSeed, parseFunderRead, parseGoPlusRead, parseHoldersRead,
  parseHoldersAllRead, parseJupiterAuditRead, parseRugCheckRead, parseSimRead, parseSolUsdBar, type AccountsRead, type FunderRead,
  type HoldersAllRead, unwrap,
} from './raw.ts';

/** Holder facts not formed, and scans that fell back after a refused mint-only scan, per UTC day and reason (the coverage report reads it; it never feeds a gate). */
export const HOLDER_ABSTENTIONS_KEY = 'facts/abstentions:holders';

/**
 * PERSIST-2: the outcome of each graduates seed, `{ source, atMs, accepted, added, reason }` (no gate reads it; the
 * worker journals it and shows it in /health, so a restart that leaves survival unknown is visible).
 */
export const GRADUATES_SEED_KEY = 'facts/graduates-seed';

export interface FactWrite {
  readonly key: string;
  readonly value: unknown;
}

/** Stream names the producers read coverage for. WORKER-1 names its watches with these (`WatchOptions.coverage`). */
export const STREAMS = {
  /** Every swap of a pool (logs watch on the pool, confirmed, `decodeLogs`). Candles and graduate survival need it. */
  trades: (pool: string) => `trades:${pool}`,
  /** Every transaction of a mint from its creation slot (signatures of the mint, fetched). Insiders need it. */
  mintTxs: (mint: string) => `mint-txs:${mint}`,
} as const;

/** Execution-health limits. Live risk limits are the owner's (AGENTS.md): without them execution health is never green. */
export interface ExecHealthLimits {
  readonly minAttempts: number;
  readonly maxFailedBps: number;
  readonly maxLandingSlots: number;
  readonly maxQuoteErrorBps: number;
}

export interface ProducerOptions {
  /**
   * POOL-FIRST-READ: events kept per pool before its first read or candle book (default `PRE_READ_KEEP`); 0 keeps none,
   * for a producer no read ever reaches and whose events come in chain order (the backtest's survival producers).
   */
  readonly preReadKeep?: number;
  /** Candles kept from migration on, for the chase check (H11). */
  readonly candleFirstMs: number;
  /** Candles kept back from the newest, for the spike window (H11). */
  readonly candleLastMs: number;
  /**
   * OOM-SEEN: how far behind a pool's newest trade the candle book still recognises a repeat of a trade
   * (`TRADE_REPEAT_WINDOW_MS`). A trade stamped further back is never applied and flags the candles partial.
   */
  readonly tradeRepeatMs: number;
  /** Third-party reads older than this are left out of a cross-check (H16 reads them as `offchain`). */
  readonly maxQuoteAgeMs: number;
  /** Graduate survival mark after migration (§6.4). */
  readonly survivalAfterMs: number;
  /** An account read dates a graduate's survival mark only when it lands within this long after the mark. */
  readonly survivalReadWindowMs: number;
  readonly graduatesKeepMs: number;
  readonly solUsdKeepMs: number;
  /** Hours of chain volume kept: the regime's percentile window plus the last day. */
  readonly volumeKeepMs: number;
  /** Creation-slot buyers: buys in slots s0 to s0 + this (§16.3: s0 to s0+2). */
  readonly insiderSlots: number;
  /** Funder lookups cover the first this many distinct buyers (§16.3: 20). */
  readonly firstBuyers: number;
  readonly execHealth?: ExecHealthLimits;
}

/**
 * OOM-SEEN (supervisor ruling, Option A): the candle book remembers each trade's id for an hour behind the pool's newest
 * trade, so the same swap from a log line and from a fetched transaction counts once. A repeat comes from the other path
 * within minutes: the feed's own duplicate window is 1,500 slots (about 10 minutes), a catch-up's fill reads up to the
 * watch's start, and a gap's fill runs as soon as the daily fill budget allows. An hour covers those with room. A trade
 * stamped more than an hour behind is refused whole: never applied, so a repeat is never counted twice and the reserves
 * never step back, and the candles are flagged partial, so H11 refuses them (fail closed). Kept whole, the ids grew the
 * heap about 1.4 MB a minute at 4,000 swaps a minute.
 */
export const TRADE_REPEAT_WINDOW_MS = HOUR_MS;

/**
 * OOM-MINT: the retired pools and mints remembered (each), so a late event never rebuilds their state. A candidate is let
 * go a few hundred times a day and a create that never migrated about 40,000 times a day: 100,000 is days of the first
 * and over two of the second, at about 80 B each. One dropped from here only means a very late event for it builds a
 * little state again; the strategy still refuses an expired create (`create-expired`).
 */
export const RETIRED_KEEP = 100_000;

/**
 * TRADE-GAP-HEAL: the key prefix of a cut or undecodable pool-trade log's fetch outcome, `hole-fetch:<via>` with
 * `{ signature, found }`. WORKER-1 puts it on the feed after the fetch settles (a found transaction's events are on
 * the feed before it), so the producer knows the hole's transaction is complete, or that it will not come.
 */
export const HOLE_FETCH_PREFIX = 'hole-fetch:';

/**
 * TRADE-GAP-HEAL: how long a hole in a pool's trade stream waits for its transaction before it stays for good (by
 * receipt time): the worker's tries span 30 minutes of waits (2, 4, 8 and 16 minutes) plus the reads themselves.
 */
export const HEAL_WAIT_MS = 45 * MINUTE_MS;

/** TRADE-GAP-HEAL: the most swaps one pool's heal keeps while it waits (20,000, a fifth of RETIRED_KEEP); past it the hole stays (memory bound). */
export const HEAL_TAPE_MAX = RETIRED_KEEP / 5;

/** TRADE-GAP-HEAL: hole signatures remembered (20,000, a fifth of RETIRED_KEEP), so a late fetched copy of a hole's swaps is never applied out of order. */
export const HOLE_SIGS_KEEP = RETIRED_KEEP / 5;

/** POOL-FIRST-READ: pools whose events are kept until their first account read (the oldest-kept pool let go first). */
export const PRE_READ_POOLS = 64;
/** POOL-FIRST-READ: a pool's newest events kept until its first read; one let go past the read's slot leaves the chain stale. */
export const PRE_READ_KEEP = 64;
/**
 * POOL-FIRST-READ (review of #266, P5): how long after a pool's watch started its swaps are kept for a candle book that
 * has not opened (a late migration). A migration can land late through FACTS-REREAD until about the end of the U2
 * window (240 min after migration) plus its retries (2 + 4 + 8 + 16 min); a worker test pins it to those. Past it, the
 * pool's swaps are no longer kept for its book (it is marked lost: a later book opens partial), so pools with no book
 * coming never hold places the waiting ones need.
 */
export const PRE_BOOK_KEEP_MS = RESEARCH_CONFIG.s0.u2WindowToMs + 30 * MINUTE_MS;

/**
 * G4a (supervisor ruling): how long a wallet's funder read (`read:funder:<wallet>`, its first SOL funding: fixed once it
 * happened) is kept: a day. The store forgets the read's key after the same time (worker `liveForget`).
 */
export const FUNDER_KEEP_MS = DAY_MS;

/** OOM-MINT: adds a fresh copy of `id` (never the text it was cut from), dropping the oldest entries past `cap`. */
export const cappedAdd = (set: Set<string>, id: string, cap: number): void => {
  set.add(flatCopy(id));
  for (const old of set) {
    if (set.size <= cap) break;
    set.delete(old);
  }
};

/** Options sized from the locked policy, so the kept windows always cover what the gates read. */
export const producerOptions = (p: Policy, execHealth?: ExecHealthLimits): ProducerOptions => ({
  candleFirstMs: p.gates.chaseCheckAfterMs + MINUTE_MS,
  candleLastMs: p.gates.candleWindowMs + MINUTE_MS,
  tradeRepeatMs: TRADE_REPEAT_WINDOW_MS,
  maxQuoteAgeMs: p.gates.maxQuoteAgeMs,
  survivalAfterMs: p.regime.survivalAfterMs,
  survivalReadWindowMs: MINUTE_MS,
  graduatesKeepMs: (p.regime.survivalMedianDays + 2) * 24 * HOUR_MS + p.regime.survivalAfterMs,
  solUsdKeepMs: 24 * HOUR_MS + (p.regime.failedChecksToDisable + 1) * HOUR_MS + HOURLY_MAX_AGE_MS,
  volumeKeepMs: (p.regime.volumeWindowDays + p.regime.volumeLagDays + 2) * 24 * HOUR_MS,
  insiderSlots: 2,
  firstBuyers: 20,
  ...(execHealth === undefined ? {} : { execHealth }),
});

// ---------- Reading released events ----------

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Seen {
  readonly provider: string;
  readonly slot: bigint;
  readonly receivedAt: number;
  readonly commitment: Commitment;
  readonly backfilled: boolean;
  readonly signature: string;
  /** From a log line (a watch); false for a fetched transaction's event. */
  readonly fromLogs: boolean;
}

/** A DEC-1 program event from a FEED-1 market event, with where and how it was seen; null for anything else. */
export const programEvent = (e: MarketEvent): { readonly ev: PumpEventData; readonly seen: Seen; readonly truncated: boolean } | null => {
  const v = e.value;
  if (!isObj(v) || !isObj(v['event']) || typeof v['txSlot'] !== 'bigint') return null;
  const ev = v['event'];
  if (typeof ev['name'] !== 'string' || ev['name'] === 'other' || !isObj(ev['data'])) return null;
  // Fetched transactions carry the signature in DEC-1's located event; log lines carry it beside the event.
  const fromLogs = e.key.startsWith('logs:');
  const signature = fromLogs ? v['signature'] : ev['signature'];
  if (typeof signature !== 'string') return null;
  // Fetched transactions are confirmed (FEED-1 getTransaction); log lines carry their watch's commitment, else processed.
  const commitment: Commitment = !fromLogs ? 'confirmed' : v['commitment'] === 'confirmed' ? 'confirmed' : 'processed';
  return {
    ev: ev as unknown as PumpEventData,
    seen: {
      provider: typeof v['source'] === 'string' ? v['source'] : 'feed', slot: v['txSlot'], receivedAt: e.moment.receivedAt, commitment,
      backfilled: v['backfilled'] === true, signature, fromLogs,
    },
    truncated: fromLogs && v['truncated'] === true,
  };
};

const sourceOf = (e: MarketEvent): string => (isObj(e.value) && typeof e.value['source'] === 'string' ? e.value['source'] : 'facts');
const quality = (backfilled: boolean): readonly QualityFlag[] => (backfilled ? ['backfilled'] : []);
const usable = (c: Commitment): boolean => c !== 'processed';
const ms = (seconds: bigint): number | null => {
  const v = Number(seconds) * SECOND_MS;
  return seconds >= 0n && Number.isSafeInteger(v) ? v : null;
};

// ---------- Prices and candles ----------

const cmpPrice = (a: Price, b: Price): number => {
  const l = a.quote * b.base;
  const r = b.quote * a.base;
  return l < r ? -1 : l > r ? 1 : 0;
};
const price = (quote: bigint, base: bigint): Price | null => (quote > 0n && base > 0n ? { quote, base } : null);

interface CandleBook {
  readonly pool: string;
  readonly mint: string;
  readonly openedAtMs: number;
  readonly fromSlot: bigint;
  readonly candles: Candle[];
  /** A trade whose price could not be formed: the candles are no longer complete. Sticky. */
  partial: boolean;
  /**
   * RT-A4: swaps the book needed were let go before it opened late (POOL-FIRST-READ). The candles stay partial for
   * good: no heal restores it (a heal resets `partial` to its mark's, and never brings those swaps back).
   */
  dropped: boolean;
  /** Trade repeat tags (`tradeRepeatTag`) by their trade minute, back to `tradeRepeatMs` behind `newestMs` (OOM-SEEN, SEEN-TAGS). */
  readonly seen: RepeatTags;
  /** The newest trade time applied. */
  newestMs: number;
  /** `newestMs` at the last sweep: the next runs once the newest trade is a quarter window later. */
  sweptMs: number;
  /** TRADE-GAP-HEAL: the last swap the book applied: its post-trade reserves anchor a heal's chain. */
  lastSwap: SwapEv | null;
  /** TRADE-GAP-HEAL: the book as it was before its newest trade slot's first swap, and the swaps since. */
  mark: BookMark | null;
}

export type SwapEv = Extract<PumpEventData, { name: 'BuyEvent' | 'SellEvent' }>;

/** TRADE-GAP-HEAL: a swap as released, with where it was seen. */
interface TapeSwap {
  readonly ev: SwapEv;
  readonly seen: Seen;
}

/**
 * TRADE-GAP-HEAL: a candle book (and its pool's chain) as it was before the first swap of slot `slot`, and every swap
 * the book took since, in release order. A hole at `slot` or later can be healed from here: the swaps are put back in
 * exact chain order from this state.
 */
interface BookMark {
  readonly slot: bigint;
  readonly candles: readonly Candle[];
  readonly partial: boolean;
  readonly newestMs: number;
  readonly sweptMs: number;
  readonly reserve: Reserve | undefined;
  readonly lastSwap: SwapEv | null;
  /** The pool's chain at the mark (the object, so a read that replaced it since is seen), or null without one. */
  readonly chain: { readonly ref: PoolChain; readonly state: PoolState; readonly coveredFrom: bigint; readonly clean: boolean } | null;
  readonly tape: TapeSwap[];
  /** A pool transaction other than a swap was seen since the mark: the chain cannot be healed across it. */
  other: boolean;
}

/** TRADE-GAP-HEAL: a pool whose trade stream has holes waiting for their transactions. */
interface Heal {
  readonly startedAt: number;
  readonly mark: BookMark;
  /** Every swap the book took since the mark, in release order. */
  readonly tape: TapeSwap[];
  /** The holes by signature: `arrived` once the fetch put the whole transaction on the feed. */
  readonly holes: Map<string, { readonly slot: bigint; arrived: boolean }>;
  /** The holes' own swaps on this pool, held back from the book and the chain until the heal. */
  readonly fetched: TapeSwap[];
  other: boolean;
  /** A hole's transaction holds a pool event other than a swap: never healed. */
  tainted: boolean;
}

// ---------- Streams ----------

interface StreamState {
  fromSlot: bigint;
  /** Ranges the stream may have missed: bounded gaps and holes (a cut or undecodable log, by its signature), inclusive. */
  gaps: { readonly from: bigint | null; readonly to: bigint; readonly sig?: string }[];
  /** Open gaps by their start (`toSlot` not known yet); a null start is unknown, so it covers everything. */
  readonly open: Map<string, bigint | null>;
  readonly vias: Set<string>;
  /** Receipt time of the stream's first start (POOL-FIRST-READ: `PRE_BOOK_KEEP_MS` counts from it). */
  readonly startedAt: number;
  /**
   * POOL-FIRST-READ (trade streams): the pool's kept events were let go whole before its first read (`chain`) or its
   * candle book (`book`). Kept with the stream, never in a capped set, so the mark cannot fall out (review of #266).
   */
  lost?: { chain: boolean; book: boolean };
}

/** The first slot after which the stream has had no gap at all. */
const gapFreeSince = (s: StreamState): bigint => s.gaps.reduce((m, g) => (g.to + 1n > m ? g.to + 1n : m), s.fromSlot);

const coverageOf = (key: string): { stream: string; part: 'start' | 'gap' | 'resume' } | null => {
  if (!key.startsWith('coverage:')) return null;
  const rest = key.slice('coverage:'.length);
  const at = rest.lastIndexOf(':');
  const part = rest.slice(at + 1);
  if (at <= 0 || (part !== 'start' && part !== 'gap' && part !== 'resume')) return null;
  return { stream: rest.slice(0, at), part };
};

const slotOrNull = (v: unknown): bigint | null | undefined => (v === null ? null : typeof v === 'bigint' && v >= 0n ? v : undefined);

// ---------- Completeness ----------

export type Completeness = 'complete' | 'bounded' | 'unresolved';

/**
 * Every fact says how complete its evidence is, for the gates and BT-2's completeness manifest: `bounded` for a
 * largest-accounts holder list (the remainder is only bounded), `unresolved` for a flagged fact or an incomplete insider
 * list, `complete` otherwise. A producer may set it itself; this fills it in from the fact when it did not.
 */
export const stampCompleteness = (value: unknown): unknown => {
  if (!isObj(value) || !isObj(value['obs']) || typeof value['completeness'] === 'string') return value;
  const q = value['obs']['quality'];
  const flagged = Array.isArray(q) && q.some((x) => x !== 'backfilled' && x !== 'deduplicated');
  const c: Completeness = flagged || value['complete'] === false ? 'unresolved' : value['coverage'] === 'largest' ? 'bounded' : 'complete';
  return { ...value, completeness: c };
};

// ---------- Complete holder sets ----------

/**
 * The complete holder set from one program-account read, or null when it cannot be proven complete: an account the
 * mint's program does not own, one that does not decode or is of another mint, an address twice, a mint that can
 * still mint (supply could grow), a mint read after the account read, or balances that do not sum to the supply.
 */
type CompleteHolder = { mint: string; address: string; owner: string; ownerProgram: string | null; amount: bigint; delegate: string | null; delegatedAmount: bigint };
export type HolderRefusal = 'mint-read-after-scan' | 'mint-can-mint' | 'mint-undecodable' | 'repeated-address' | 'wrong-program' | 'undecodable-account' | 'other-mint' | 'sum-mismatch';
type CompleteSet = { supply: bigint; coverage: 'all'; completeness: 'complete'; accounts: CompleteHolder[] };

/** The complete set, or why the read cannot prove one (counted per day so a silent abstention shows up). */
export const checkHolders = (r: HoldersAllRead): { readonly ok: true; readonly set: CompleteSet } | { readonly ok: false; readonly reason: HolderRefusal } => {
  const no = (reason: HolderRefusal) => ({ ok: false as const, reason });
  if (r.mintSlot > r.slot) return no('mint-read-after-scan');
  let supply: bigint;
  try {
    const m = decodeMint(fromBase64(r.mintData), r.program as Address);
    if (m.mintAuthority !== null) return no('mint-can-mint');
    supply = m.supply;
  } catch {
    return no('mint-undecodable');
  }
  const programs = new Map(r.ownerPrograms.map((o) => [o.owner, o.program]));
  const seen = new Set<string>();
  const accounts: CompleteHolder[] = [];
  let sum = 0n;
  for (const a of r.accounts) {
    if (seen.has(a.address)) return no('repeated-address');
    if (a.owner !== r.program) return no('wrong-program');
    seen.add(a.address);
    let t: ReturnType<typeof decodeTokenAccount>;
    try {
      t = decodeTokenAccount(fromBase64(a.data), a.owner as Address);
    } catch {
      return no('undecodable-account');
    }
    if (t.mint !== r.mint) return no('other-mint');
    sum += t.amount;
    // Delegates ride along for GATE-1e (it attributes min(delegatedAmount, amount) to the delegate in the numerators).
    if (t.amount > 0n) accounts.push({ mint: r.mint, address: a.address, owner: t.owner, ownerProgram: programs.get(t.owner) ?? null, amount: t.amount, delegate: t.delegate, delegatedAmount: t.delegatedAmount });
  }
  if (sum !== supply) return no('sum-mismatch');
  accounts.sort((a, b) => (a.address < b.address ? -1 : 1));
  return { ok: true, set: { supply, coverage: 'all', completeness: 'complete', accounts } };
};

export const completeHolders = (r: HoldersAllRead): CompleteSet | null => {
  const c = checkHolders(r);
  return c.ok ? c.set : null;
};

// ---------- Per-mint state ----------

interface PoolCreated {
  readonly pool: string;
  readonly slot: bigint;
  readonly atMs: number;
  readonly quote: bigint;
  readonly base: bigint;
}

interface Account {
  readonly owner: string | null;
  readonly data: string | null;
  readonly slot: bigint;
  readonly receivedAt: number;
  readonly commitment: Commitment;
  readonly provider: string;
}

interface Track {
  readonly mint: string;
  create?: { readonly creator: string; readonly atMs: number; readonly slot: bigint; readonly signature: string };
  completeAtMs?: number;
  /** Slot of the CompleteEvent: no curve buy can follow it. */
  completeSlot?: bigint;
  migration?: { readonly pool: string; readonly atMs: number; readonly slot: bigint };
  migrationWritten: boolean;
  readonly pools: Map<string, PoolCreated>;
  /** Buyers by the first slot they bought in, pruned past the slot that completes the first-buyers set. */
  readonly buyers: Map<string, bigint>;
  devBuySameTx: boolean;
  readonly xcheck: Map<'rugcheck' | 'goplus' | 'jupiter', { readonly at: number; readonly src: XcheckFact['sources'][number] }>;
  /** OOM-MINT: every wallet this mint was added to in `#walletMints`, so a retire takes it out of exactly those. */
  readonly wallets: Set<string>;
}

interface Pending {
  readonly mint: string;
  readonly pool: string;
  readonly migratedAtMs: number;
  readonly slot: bigint;
}

/** Effective quote reserves (vault + virtual) of a pool, as of a time. */
interface Reserve {
  readonly atMs: number;
  readonly effective: bigint;
}

/**
 * A pool's state kept current from its swap stream (POS-1). The base is the last coherent account read (its static
 * fields: index, vaults, LP mint, flags); the reserves move with each confirmed swap the stream carries. Valid only
 * while the pool's trade stream has had no gap since `coveredFrom`.
 */
interface PoolChain {
  readonly mint: string;
  /** The pool fact of the last coherent account read: the static fields every derived fact carries. */
  readonly read: PoolFact & { readonly accountBytes: number };
  /** The pool's reserves after the last swap applied (or as read): current only while `stale` is null. */
  state: PoolState;
  /** The first slot the stream must cover for `state` to be current: the read's slot + 1, or a re-basing swap's slot. */
  coveredFrom: bigint;
  /** Slot of the newest swap seen since the read (applied or not); swaps up to the read's slot are already in it. */
  lastSlot: bigint;
  readonly readSlot: bigint;
  /** POOL-FIRST-READ: slot of the newest pool event other than a swap since the read (the read's slot if none). */
  otherSlot: bigint;
  /** Why the state is stale, while it is; a gap clears once a swap re-bases it, anything else needs a read. */
  stale: { readonly reason: string; readonly kind: 'gap' | 'mismatch' } | null;
  /** Swaps seen at `lastSlot` (a delivery twice, from a log line and a fetched transaction, counts once); older slots are refused anyway. */
  readonly seen: Set<string>;
  /** Swaps applied to this chain, newest last (bounded): a second delivery behind newer swaps is a repeat, not a miss. */
  readonly applied: Set<string>;
}

const effectiveOf = (s: PoolState): bigint => s.quoteVault + s.virtualQuoteReserves;

/**
 * TRADE-GAP-HEAL: swaps in exact chain order from `from` (a pool's reserves after the swap before them): slot by slot,
 * each next swap the one whose pre-trade reserves (base, and vault + virtual) equal the reserves so far, and its replay
 * (core fills `swapEventState`) the reserves after it. Null when any slot leaves a swap that does not chain, two that
 * could come next, or one that does not reproduce its event: the order is not proven.
 */
export const chainOrder = <T extends { readonly ev: SwapEv; readonly seen: { readonly slot: bigint } }>(from: PoolState, swaps: readonly T[]): { readonly t: T; readonly after: PoolState }[] | null => {
  const slots = [...new Set(swaps.map((t) => t.seen.slot))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: { t: T; after: PoolState }[] = [];
  let cur = from;
  for (const slot of slots) {
    const rest = swaps.filter((t) => t.seen.slot === slot);
    while (rest.length > 0) {
      const next = rest.filter((t) => t.ev.data.poolBaseTokenReserves === cur.baseReserve && t.ev.data.poolQuoteTokenReserves + (t.ev.data.virtualQuoteReserves ?? 0n) === effectiveOf(cur));
      if (next.length !== 1) return null;
      const t = next[0]!;
      const r = swapEventState(t.ev);
      if (!r.ok) return null;
      out.push({ t, after: r.after });
      cur = r.after;
      rest.splice(rest.indexOf(t), 1);
    }
  }
  return out;
};

/**
 * POOL-FIRST-READ: a pool event released before the pool's chain (its first read) or its candle book (its migration's
 * CreatePoolEvent) exists, kept to be applied once it does.
 */
type PreReadEvent =
  | { readonly kind: 'swap'; readonly t: TapeSwap }
  | { readonly kind: 'other'; readonly slot: bigint; readonly name: string; readonly obs: FactObs }
  // RT-A5 (book only): a hole on the pool's stream, its fetched transaction's swaps, a PumpSwap event other than a swap
  // in that transaction, and its fetch outcome, replayed when the book opens late, as a live heal takes them.
  | { readonly kind: 'hole'; readonly sig: string; readonly slot: bigint; readonly at: number }
  | { readonly kind: 'holeTx'; readonly t: TapeSwap }
  | { readonly kind: 'holeTxOther'; readonly sig: string; readonly slot: bigint; readonly at: number }
  | { readonly kind: 'outcome'; readonly sig: string; readonly found: boolean; readonly e: MarketEvent };

/** A kept event and which of the two still needs it. */
interface Kept {
  readonly x: PreReadEvent;
  chain: boolean;
  book: boolean;
}

/** A pool's kept events, in release order; per consumer, the newest slot it needed that was let go past the cap. */
interface PreRead {
  events: Kept[];
  droppedChain: bigint | null;
  droppedBook: bigint | null;
}

const newest = (a: bigint | null, b: bigint): bigint => (a === null || b > a ? b : a);

const preReadSlot = (x: PreReadEvent): bigint => (x.kind === 'swap' || x.kind === 'holeTx' ? x.t.seen.slot : x.kind === 'outcome' ? x.e.moment.slot : x.slot);
const preReadAt = (x: PreReadEvent): number =>
  x.kind === 'swap' || x.kind === 'holeTx' ? x.t.seen.receivedAt : x.kind === 'other' ? x.obs.receivedAt : x.kind === 'outcome' ? x.e.moment.receivedAt : x.at;

/** Swap ids a pool chain remembers for repeats: a repeat (a log line and a fetched transaction) comes within seconds. */
const APPLIED_KEPT = 512;

export class FactProducer {
  readonly #o: ProducerOptions;
  readonly #mints = new Map<string, Track>();
  readonly #poolMint = new Map<string, string>();
  readonly #books = new Map<string, CandleBook>();
  readonly #streams = new Map<string, StreamState>();
  readonly #accounts = new Map<string, Account>();
  readonly #funders = new Map<string, FunderRead>();
  readonly #walletMints = new Map<string, Set<string>>();
  readonly #reserves = new Map<string, Reserve>();
  readonly #chains = new Map<string, PoolChain>();
  /** POOL-FIRST-READ: watched pools' events released before the pool's first read (capped; a pool let go is remembered). */
  // A pool let go whole is marked on its trade stream (which every kept pool has): its chain starts stale, its book
  // partial.
  readonly #preReads = new CappedMap<string, PreRead>(PRE_READ_POOLS, (pool) => {
    const s = this.#streams.get(STREAMS.trades(pool));
    if (s === undefined) return;
    s.lost ??= { chain: false, book: false };
    if (!this.#chains.has(pool)) s.lost.chain = true;
    if (!this.#books.has(pool)) s.lost.book = true;
  });
  /** POOL-FIRST-READ part 3: books opened late, with their kept swaps, until the opening transaction's events are in. */
  readonly #bookPending = new Map<string, { readonly sig: string; readonly events: readonly PreReadEvent[]; readonly partial: boolean }>();
  /** RT-A5: holes seen before their pool's book, by signature (capped): a fetched transaction names no pool. */
  readonly #preBookHoles = new CappedMap<string, string>(HOLE_SIGS_KEEP);
  /** TRADE-GAP-HEAL: pools waiting for their holes' transactions. */
  readonly #heals = new Map<string, Heal>();
  /** TRADE-GAP-HEAL: signatures of cut or undecodable logs on a trade stream (capped). */
  readonly #holeSigs = new Set<string>();
  /** OOM-MINT: pools let go (`retire`): their candle book is never built again, so no later trade is ever applied. */
  readonly #retiredPools = new Set<string>();
  /** OOM-MINT: mints let go (`retire`): their track is never kept again. */
  readonly #retiredMints = new Set<string>();

  /** OOM-MINT: a tombstone (`cappedAdd`, at most `RETIRED_KEEP`). */
  #tombstone(set: Set<string>, id: string): void {
    cappedAdd(set, id, RETIRED_KEEP);
  }
  readonly #pending = new Map<string, Pending>();
  readonly #graduates: GraduatesFact['items'][number][] = [];
  readonly #sol = new Map<number, bigint>();
  readonly #volume: ChainVolumeDays;
  #abstain = new Map<string, number>();
  #abstainDay = -1;
  #head: bigint | null = null;
  #graduatesChanged = false;
  /** The last insiders value written per mint, without its receipt time: unchanged values are not written again. */
  readonly #insidersSeen = new Map<string, string>();

  constructor(options: ProducerOptions) {
    for (const [k, v] of Object.entries(options)) {
      if (k !== 'execHealth' && !(Number.isSafeInteger(v) && (v as number) >= 0)) throw new RangeError(`producer option ${k} must be a whole number >= 0`);
    }
    this.#o = options;
    this.#volume = new ChainVolumeDays(options.volumeKeepMs);
  }

  /** Feed every released market event, in release order. Returns the facts it changes, each at most once. */
  observe(e: MarketEvent): FactWrite[] {
    const out = new Map<string, unknown>();
    const put = (key: string, value: unknown): void => {
      out.set(key, stampCompleteness(value));
    };
    // Survival marks are judged on the state before this event: a trade after the mark must not date it.
    this.#survival(e, put);
    this.#forgetFunders(e.moment.receivedAt);
    this.#bookTake(e, put);
    this.#chainOther(e, put);
    this.#holeTxOther(e);
    const pe = programEvent(e);
    if (pe !== null) this.#program(pe.ev, pe.seen, pe.truncated, e, put);
    else if (e.key === 'chain:slot') this.#slot(e, put);
    else if (e.key.startsWith('coverage:')) this.#coverage(e, put);
    else if (e.key.startsWith('logs:truncated:') || e.key.startsWith('logs:undecodable:')) this.#hole(e.key.slice(e.key.indexOf(':', 5) + 1), e.moment.slot, put, e);
    else if (e.key.startsWith(HOLE_FETCH_PREFIX)) this.#holeFetched(e.key.slice(HOLE_FETCH_PREFIX.length), e, put);
    else this.#raw(e, put);
    this.#flushGraduates(e, put);
    return [...out].map(([key, value]) => ({ key, value }));
  }

  #track(mint: string): Track {
    let t = this.#mints.get(mint);
    if (t === undefined) {
      t = { mint, migrationWritten: false, pools: new Map(), buyers: new Map(), devBuySameTx: false, xcheck: new Map(), wallets: new Set() };
      // OOM-MINT: a retired mint's later events build nothing that is kept (a fresh track each time, never stored), so
      // its migration fact is never stated again.
      if (!this.#retiredMints.has(mint)) this.#mints.set(mint, t);
    }
    return t;
  }

  // ---------- Program events ----------

  #program(ev: PumpEventData, seen: Seen, truncated: boolean, e: MarketEvent, put: (k: string, v: unknown) => void): void {
    // A cut log may have lost events after the cut: a hole in the stream that carried it.
    if (truncated && isObj(e.value) && typeof e.value['via'] === 'string') this.#hole(e.value['via'], seen.slot, put, e);
    if (!usable(seen.commitment)) return;
    const obs = (slot: bigint): FactObs => ({ provider: seen.provider, slot, receivedAt: seen.receivedAt, quality: quality(seen.backfilled), commitment: seen.commitment });
    switch (ev.name) {
      case 'CreateEvent': {
        const d = ev.data;
        const atMs = ms(d.timestamp);
        const t = this.#track(d.mint);
        if (atMs === null || t.create !== undefined) return;
        t.create = { creator: d.creator, atMs, slot: seen.slot, signature: seen.signature };
        this.#walletMints.set(d.creator, (this.#walletMints.get(d.creator) ?? new Set<string>()).add(d.mint));
        t.wallets.add(d.creator);
        put(createKey(d.mint), { obs: obs(seen.slot), createdAtMs: atMs, creator: d.creator });
        this.#prune(t);
        this.#insiders(t, e, put);
        return;
      }
      case 'TradeEvent':
        return this.#curveTrade(ev.data, seen, e, put);
      case 'CompleteEvent': {
        const atMs = ms(ev.data.timestamp);
        if (atMs === null) return;
        const t = this.#track(ev.data.mint);
        t.completeAtMs ??= atMs;
        t.completeSlot ??= seen.slot;
        // Only a CompleteEvent proves the curve state; the absence of one is never read as "not complete" (H7).
        put(curveKey(ev.data.mint), { obs: obs(seen.slot), complete: true });
        this.#migration(t, e, put);
        return;
      }
      case 'CompletePumpAmmMigrationEvent': {
        const atMs = ms(ev.data.timestamp);
        if (atMs === null) return;
        const t = this.#track(ev.data.mint);
        t.migration ??= { pool: ev.data.pool, atMs, slot: seen.slot };
        this.#migration(t, e, put);
        return;
      }
      case 'CreatePoolEvent': {
        const d = ev.data;
        const atMs = ms(d.timestamp);
        if (atMs === null) return;
        const t = this.#track(d.baseMint);
        if (!t.pools.has(d.pool)) t.pools.set(d.pool, { pool: d.pool, slot: seen.slot, atMs, quote: d.poolQuoteAmount, base: d.poolBaseAmount });
        if (!this.#poolMint.has(d.pool)) this.#poolMint.set(d.pool, d.baseMint);
        if (!this.#books.has(d.pool) && !this.#retiredPools.has(d.pool)) {
          this.#books.set(d.pool, { pool: d.pool, mint: d.baseMint, openedAtMs: atMs, fromSlot: seen.slot, candles: [], partial: false, dropped: false, seen: new RepeatTags(), newestMs: atMs, sweptMs: atMs, lastSwap: null, mark: null });
          this.#reserves.set(d.pool, { atMs, effective: d.poolQuoteAmount });
          this.#writeCandles(d.pool, seen.provider, seen.receivedAt, put);
          this.#bookOpen(d.pool, seen.signature);
        }
        this.#migration(t, e, put);
        return;
      }
      case 'InitBoostEvent': {
        const atMs = ms(ev.data.timestamp);
        if (atMs !== null && this.#books.has(ev.data.pool)) this.#reserves.set(ev.data.pool, { atMs, effective: ev.data.realQuoteReservesAfter + ev.data.virtualQuoteReserves });
        return;
      }
      case 'BuyEvent':
      case 'SellEvent':
        return this.#swap(ev, seen, put);
      default:
        return;
    }
  }

  /** The migration fact: graduation (CompleteEvent), migration and the pool it created, all seen at confirmed. */
  #migration(t: Track, e: MarketEvent, put: (k: string, v: unknown) => void): void {
    if (t.migrationWritten || t.completeAtMs === undefined || t.migration === undefined) return;
    const created = t.pools.get(t.migration.pool);
    if (created === undefined) return;
    const p = price(created.quote, created.base);
    if (p === null) return;
    t.migrationWritten = true;
    const m = t.migration;
    put(migrationKey(t.mint), {
      obs: { provider: sourceOf(e), slot: m.slot, receivedAt: e.moment.receivedAt, quality: [], commitment: 'confirmed' },
      graduatedAtMs: t.completeAtMs, migratedAtMs: m.atMs, pool: m.pool, quoteAtMigration: created.quote, price: p,
    });
    this.#pending.set(m.pool, { mint: t.mint, pool: m.pool, migratedAtMs: m.atMs, slot: m.slot });
    if (this.#books.has(m.pool)) this.#writeCandles(m.pool, sourceOf(e), e.moment.receivedAt, put);
  }

  #curveTrade(d: Extract<PumpEventData, { name: 'TradeEvent' }>['data'], seen: Seen, e: MarketEvent, put: (k: string, v: unknown) => void): void {
    if (!d.isBuy) return;
    // Buyers are kept before the create is known: fetched history can be released in any order within a slot.
    const t = this.#track(d.mint);
    let changed = false;
    if (t.create !== undefined && seen.signature === t.create.signature && d.user === t.create.creator && !t.devBuySameTx) {
      t.devBuySameTx = true;
      changed = true;
    }
    const prev = t.buyers.get(d.user);
    const keep = this.#keepThrough(t);
    if ((prev === undefined || seen.slot < prev) && (keep === null || seen.slot <= keep)) {
      t.buyers.set(d.user, seen.slot);
      const mints = this.#walletMints.get(d.user) ?? new Set<string>();
      mints.add(t.mint);
      this.#walletMints.set(d.user, mints);
      t.wallets.add(d.user);
      this.#prune(t);
      changed = true;
    }
    if (changed && t.create !== undefined) this.#insiders(t, e, put);
  }

  /** Once the create is known: the last slot whose buyers can still matter (the creation window and the first buyers). */
  #keepThrough(t: Track): bigint | null {
    if (t.create === undefined) return null;
    const windowEnd = t.create.slot + BigInt(this.#o.insiderSlots);
    const first = this.#firstBuyers(t);
    return first === null ? null : first.through > windowEnd ? first.through : windowEnd;
  }

  #prune(t: Track): void {
    const keep = this.#keepThrough(t);
    if (keep !== null) for (const [w, at] of t.buyers) if (at > keep) t.buyers.delete(w);
  }

  /**
   * The first buyers: every buyer whose first buy is in a slot up to the slot where the count of distinct buyers
   * reaches the target. Position inside a slot is not known for fetched transactions, so a boundary slot counts
   * whole; the set never depends on arrival order. Null until enough buyers are known, or the curve completed.
   */
  #firstBuyers(t: Track): { readonly wallets: readonly string[]; readonly through: bigint } | null {
    const bySlot = [...t.buyers].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
    // A curve that completed has had every buyer it will have: fewer than the target are then all of them.
    if (bySlot.length < this.#o.firstBuyers) return t.completeSlot === undefined ? null : { wallets: bySlot.map(([w]) => w).sort(), through: t.completeSlot };
    const through = bySlot[this.#o.firstBuyers - 1]![1];
    return { wallets: bySlot.filter(([, at]) => at <= through).map(([w]) => w).sort(), through };
  }

  #swap(ev: SwapEv, seen: Seen, put: (k: string, v: unknown) => void): void {
    const d = ev.data;
    // TRADE-GAP-HEAL: a hole's own swaps, from its fetched transaction, are never applied as they arrive (behind newer
    // swaps, out of order): they wait for the heal, which puts them in chain order, or are dropped with it.
    if (!seen.fromLogs && this.#holeSigs.has(`${d.pool} ${seen.signature}`)) {
      const h = this.#heals.get(d.pool);
      if (h !== undefined && h.holes.has(seen.signature)) h.fetched.push({ ev, seen });
      // RT-A5: no book yet: kept for it, taken by the heal its replay starts.
      else if (!this.#books.has(d.pool)) this.#preRead(d.pool, { kind: 'holeTx', t: { ev, seen } }, false, true);
      return;
    }
    const book = this.#books.get(d.pool);
    // POOL-FIRST-READ: kept for the chain (no read yet) and for the candle book (no migration yet), whichever is missing.
    const noChain = !this.#chains.has(d.pool);
    if (noChain || book === undefined) this.#preRead(d.pool, { kind: 'swap', t: { ev, seen } }, noChain, book === undefined);
    if (book !== undefined && (book.mark === null || seen.slot > book.mark.slot)) this.#markBook(book, seen.slot, true);
    this.#chainSwap(ev, seen, put);
    const atMs = ms(d.timestamp);
    if (book === undefined || atMs === null) return;
    this.#bookSwap(book, ev, seen, atMs, put, false);
  }

  /**
   * A swap into the candle book. `replay` (TRADE-GAP-HEAL): the heal re-applies swaps already counted once, in chain
   * order from a mark, so the repeat check is skipped and nothing is written until the heal is done.
   */
  #bookSwap(book: CandleBook, ev: SwapEv, seen: Seen, atMs: number, put: (k: string, v: unknown) => void, replay: boolean): void {
    const d = ev.data;
    const virtual = d.virtualQuoteReserves ?? 0n;
    const baseBefore = d.poolBaseTokenReserves;
    const quoteBefore = d.poolQuoteTokenReserves;
    // OOM-SEEN: a trade stamped further back than the repeat window is refused whole, before the ids are looked at, so
    // the answer never depends on which old ids a sweep has dropped: never applied, the candles flagged partial.
    if (atMs < book.newestMs - this.#o.tradeRepeatMs) {
      book.partial = true;
      this.#took(book, ev, seen, replay);
      if (!replay) this.#writeCandles(d.pool, seen.provider, seen.receivedAt, put);
      return;
    }
    // The same trade from a fetched transaction and from a log line counts once.
    const tag = tradeRepeatTag(seen.signature, baseBefore, quoteBefore);
    if (book.seen.has(tag)) {
      if (!replay) return;
    } else book.seen.add(tag, Math.floor(atMs / MINUTE_MS));
    this.#took(book, ev, seen, replay);
    if (atMs > book.newestMs) book.newestMs = atMs;
    this.#sweepSeen(book);
    // Reserves in Buy/SellEvent are before the trade; after it the base moves by the base amount and the quote by the
    // lp-adjusted amount (protocol, creator and other fees leave the pool, the LP fee stays). docs/research/historical-data.md.
    const after = ev.name === 'BuyEvent'
      ? { base: baseBefore - ev.data.baseAmountOut, quote: quoteBefore + ev.data.quoteAmountInWithLpFee }
      : { base: baseBefore + ev.data.baseAmountIn, quote: quoteBefore - ev.data.quoteAmountOutWithoutLpFee };
    const pre = price(quoteBefore + virtual, baseBefore);
    const post = price(after.quote + virtual, after.base);
    this.#reserves.set(d.pool, { atMs, effective: after.quote + virtual });
    if (pre === null || post === null) book.partial = true;
    else this.#addTrade(book, atMs, pre, post);
    if (!replay) this.#writeCandles(d.pool, seen.provider, seen.receivedAt, put);
  }

  // ---------- Healing a pool's trade stream (TRADE-GAP-HEAL) ----------

  /** A swap the book took (applied, or refused as too old): kept since the mark, and by a waiting heal. */
  #took(book: CandleBook, ev: SwapEv, seen: Seen, replay: boolean): void {
    book.lastSwap = ev;
    book.mark?.tape.push({ ev, seen });
    if (replay) return;
    const h = this.#heals.get(book.pool);
    if (h === undefined) return;
    h.tape.push({ ev, seen });
    if (this.#expired(h, seen.receivedAt)) this.#heals.delete(book.pool);
  }

  /** The book (and its pool's chain) before the first swap of `slot`: a heal of a hole at that slot or later starts here. */
  #markBook(book: CandleBook, slot: bigint, withChain: boolean): void {
    const c = withChain ? this.#chains.get(book.pool) : undefined;
    book.mark = {
      slot, candles: [...book.candles], partial: book.partial, newestMs: book.newestMs, sweptMs: book.sweptMs, reserve: this.#reserves.get(book.pool),
      lastSwap: book.lastSwap, chain: c === undefined ? null : { ref: c, state: c.state, coveredFrom: c.coveredFrom, clean: c.stale === null }, tape: [], other: false,
    };
  }

  #expired(h: Heal, now: number): boolean {
    return now - h.startedAt > HEAL_WAIT_MS || h.tape.length + h.fetched.length > HEAL_TAPE_MAX;
  }

  /**
   * A cut or undecodable log on a pool's trade stream. Healable only from a mark at or before its slot (every swap
   * since is kept) whose last swap anchors the chain; otherwise, or without a signature, the hole stays for good.
   * A swap taken behind the book's newest slot (released late) puts the hole before the mark: not healable.
   */
  #holeHeal(pool: string, sig: string | undefined, slot: bigint, at: number): void {
    if (sig === undefined) {
      this.#heals.delete(pool);
      return;
    }
    cappedAdd(this.#holeSigs, `${pool} ${sig}`, HOLE_SIGS_KEEP);
    let h = this.#heals.get(pool);
    if (h === undefined) {
      const book = this.#books.get(pool);
      if (book === undefined) {
        // RT-A5: the pool's book has not opened (a late migration): the hole is kept for it, and its replay starts the
        // heal from the book as the swaps before it left it, as live.
        this.#preBookHoles.set(sig, pool);
        this.#preRead(pool, { kind: 'hole', sig, slot, at }, false, true);
        return;
      }
      // No swap at the hole's slot or later taken yet: the book as it is now is the state before that slot.
      if (book.mark === null || slot > book.mark.slot) this.#markBook(book, slot, true);
      const m = book.mark!;
      if (slot < m.slot || m.lastSwap === null) return;
      h = { startedAt: at, mark: m, tape: [...m.tape], holes: new Map(), fetched: [], other: m.other, tainted: false };
      this.#heals.set(pool, h);
    } else if (slot < h.mark.slot) {
      this.#heals.delete(pool);
      return;
    }
    if (!h.holes.has(sig)) h.holes.set(sig, { slot, arrived: false });
  }

  /**
   * WORKER-1 says how a hole's fetch ended. Not found (or too late): the hole stays for good. Found: its transaction is
   * on the feed, every event of it released before this; once every hole of the pool has arrived, the heal runs.
   */
  #holeFetched(via: string, e: MarketEvent, put: (k: string, v: unknown) => void): void {
    const v = unwrap(e.value);
    if (!isObj(v) || typeof v['signature'] !== 'string') return;
    const sig = v['signature'];
    for (const [name, s] of this.#streams) {
      if (!s.vias.has(via) || !name.startsWith('trades:')) continue;
      const pool = name.slice('trades:'.length);
      // RT-A5: a pool with no book yet keeps the outcome for the heal its replay starts.
      if (!this.#heals.has(pool) && !this.#books.has(pool)) this.#preRead(pool, { kind: 'outcome', sig, found: v['found'] === true, e }, false, true);
      else this.#holeOutcome(pool, sig, v['found'] === true, e, put);
    }
  }

  #holeOutcome(pool: string, sig: string, found: boolean, e: MarketEvent, put: (k: string, v: unknown) => void): void {
    const h = this.#heals.get(pool);
    const hole = h?.holes.get(sig);
    if (h === undefined || hole === undefined) return;
    if (!found || this.#expired(h, e.moment.receivedAt)) {
      this.#heals.delete(pool);
      return;
    }
    hole.arrived = true;
    if ([...h.holes.values()].every((x) => x.arrived)) this.#heal(pool, h, e, put);
  }

  /** A hole's fetched transaction holds a PumpSwap event other than a swap (it may have moved the reserves): no heal. */
  #holeTxOther(e: MarketEvent): void {
    if ((this.#heals.size === 0 && this.#preBookHoles.size === 0) || e.key.startsWith('logs:')) return;
    const v = e.value;
    if (!isObj(v) || !isObj(v['event'])) return;
    const ev = v['event'];
    if (ev['program'] !== 'pump_amm' || ev['name'] === 'BuyEvent' || ev['name'] === 'SellEvent' || isNoChangePoolEvent(ev) || typeof ev['signature'] !== 'string') return;
    const sig = ev['signature'];
    for (const h of this.#heals.values()) if (h.holes.has(sig)) h.tainted = true;
    // RT-A5: a hole kept for a book that has not opened: the taint is kept with it, in order.
    const pool = this.#preBookHoles.get(sig);
    if (pool !== undefined && !this.#books.has(pool)) this.#preRead(pool, { kind: 'holeTxOther', sig, slot: e.moment.slot, at: e.moment.receivedAt }, false, true);
  }

  /**
   * Every hole's transaction is in: the swaps since the mark and the holes' own are put in exact chain order (slot by
   * slot, each swap's pre-trade reserves equal to the post-trade reserves before it, from the mark's last swap on, base
   * and effective quote). Only when every swap chains is the book rebuilt from the mark in that order, the holes taken
   * out of the stream's gaps, and the pool's chain set to the end of it (when it was clean at the mark and nothing else
   * replaced it). Anything else leaves every hole for good (fail closed).
   */
  #heal(pool: string, h: Heal, e: MarketEvent, put: (k: string, v: unknown) => void): void {
    this.#heals.delete(pool);
    const book = this.#books.get(pool);
    const m = h.mark;
    if (book === undefined || h.tainted || h.other || m.lastSwap === null) return;
    const idOf = (t: TapeSwap): string => `${t.seen.signature}:${t.ev.data.poolBaseTokenReserves}:${t.ev.data.poolQuoteTokenReserves}`;
    const ids = new Set<string>();
    const all: TapeSwap[] = [];
    for (const t of h.tape) {
      if (ids.has(idOf(t))) continue;
      ids.add(idOf(t));
      all.push(t);
    }
    for (const t of h.fetched) {
      if (ids.has(idOf(t))) continue;
      // Taken before the mark (a delivery from another path): already in the state the heal starts from.
      if (book.seen.has(tradeRepeatTag(t.seen.signature, t.ev.data.poolBaseTokenReserves, t.ev.data.poolQuoteTokenReserves))) continue;
      ids.add(idOf(t));
      all.push(t);
    }
    const anchor = swapEventState(m.lastSwap);
    if (!anchor.ok) return;
    const order = chainOrder(anchor.after, all);
    if (order === null) return;
    // The book, rebuilt from the mark in chain order.
    book.candles.splice(0, book.candles.length, ...m.candles);
    book.partial = m.partial;
    book.newestMs = m.newestMs;
    book.sweptMs = m.sweptMs;
    book.lastSwap = m.lastSwap;
    book.mark = null;
    if (m.reserve === undefined) this.#reserves.delete(pool);
    else this.#reserves.set(pool, m.reserve);
    for (const { t } of order) {
      const mark = book.mark as BookMark | null;
      if (mark === null || t.seen.slot > mark.slot) this.#markBook(book, t.seen.slot, false);
      const atMs = ms(t.ev.data.timestamp);
      if (atMs !== null) this.#bookSwap(book, t.ev, t.seen, atMs, put, true);
    }
    const s = this.#streams.get(STREAMS.trades(pool));
    if (s !== undefined) {
      s.gaps = s.gaps.filter((g) => g.sig === undefined || !h.holes.has(g.sig));
      const f = this.#streamFact(s, e);
      if (f !== undefined) put(streamKey(STREAMS.trades(pool)), f);
    }
    const last = order.at(-1);
    this.#writeCandles(pool, last?.t.seen.provider ?? 'facts', e.moment.receivedAt, put);
    // The chain: only from a clean state at the mark that is the anchor itself, on the same chain (no read since).
    const mc = m.chain;
    const c = this.#chains.get(pool);
    if (last === undefined || mc === null || c !== mc.ref || !mc.clean || c.readSlot >= m.slot || c.lastSlot > last.t.seen.slot) return;
    if (mc.state.baseReserve !== anchor.after.baseReserve || effectiveOf(mc.state) !== effectiveOf(anchor.after)) return;
    if (!this.#tradesCovered(pool, mc.coveredFrom)) return;
    c.state = last.after;
    c.coveredFrom = mc.coveredFrom;
    c.stale = null;
    c.lastSlot = last.t.seen.slot;
    c.seen.clear();
    for (const { t } of order) {
      if (t.seen.slot === c.lastSlot) c.seen.add(idOf(t));
      c.applied.add(idOf(t));
      if (c.applied.size > APPLIED_KEPT) c.applied.delete(c.applied.values().next().value!);
    }
    const ls = last.t.seen;
    put(poolKey(c.mint), this.#chainFact(c, { provider: ls.provider, slot: ls.slot, receivedAt: e.moment.receivedAt, quality: quality(ls.backfilled), commitment: ls.commitment }, c.state, null));
  }

  /**
   * Drops the ids behind the repeat window each time the newest trade has moved a quarter window since the last sweep, so a
   * book holds at most a window and a quarter of trades (answers unchanged: the window is checked first).
   */
  #sweepSeen(book: CandleBook): void {
    if (book.newestMs - book.sweptMs < this.#o.tradeRepeatMs / 4) return;
    // A trade in minute m was stamped before (m + 1) minutes: dropped only when that is at or before the cutoff.
    const cutoff = book.newestMs - this.#o.tradeRepeatMs;
    book.seen.sweep(cutoff);
    book.sweptMs = book.newestMs;
  }

  /**
   * OOM-MINT: what is kept for mints and pools the strategy let go (`Strategy.retired`): a pool's candle book, chain and
   * trade stream, a mint's track and its place in `#walletMints`. A retired pool's book is never built again: a later
   * trade there, a repeat or a new one, is never applied (fail closed; nothing reads its candles, and their key is gone
   * from the store, so H11 would find none).
   */
  retire(ids: readonly string[]): void {
    // The reserve and pending graduate mark stay: they feed the regime's survival series (and are gone or small by then:
    // a candidate leaves at least four hours after migrating, its survival mark is at thirty minutes).
    for (const id of ids) {
      // Tombstoned whether or not state was built yet, so a pool create or a mint create delivered later never builds it.
      this.#books.delete(id);
      this.#heals.delete(id);
      this.#tombstone(this.#retiredPools, id);
      this.#tombstone(this.#retiredMints, id);
      this.#poolMint.delete(id);
      // Review N2: a pool whose survival mark is still pending keeps its chain and trade stream until the mark dates
      // it or its read window passes (`#settle`); the survival series needs them.
      if (!this.#pending.has(id)) this.#forgetPool(id);
      const t = this.#mints.get(id);
      if (t !== undefined) {
        for (const w of t.wallets) {
          const mints = this.#walletMints.get(w);
          if (mints === undefined) continue;
          mints.delete(id);
          if (mints.size === 0) this.#walletMints.delete(w);
        }
        this.#mints.delete(id);
      }
    }
  }

  /** OOM-MINT: how many entries the producer keeps per structure (tests and the memory ceiling). */
  sizes(): { readonly books: number; readonly mints: number; readonly walletMints: number; readonly retiredPools: number; readonly retiredMints: number; readonly streams: number; readonly chains: number; readonly funders: number; readonly preReads: number } {
    return { funders: this.#funders.size, books: this.#books.size, mints: this.#mints.size, walletMints: this.#walletMints.size, retiredPools: this.#retiredPools.size, retiredMints: this.#retiredMints.size, streams: this.#streams.size, chains: this.#chains.size, preReads: this.#preReads.size };
  }

  /** OOM-SEEN: the trade ids a pool's candle book remembers, and its last reserve (tests and diagnostics). */
  candleBook(pool: string): { readonly ids: number; readonly reserve: { readonly atMs: number; readonly effective: bigint } | undefined } | undefined {
    const b = this.#books.get(pool);
    return b === undefined ? undefined : { ids: b.seen.size, reserve: this.#reserves.get(pool) };
  }

  #addTrade(book: CandleBook, atMs: number, pre: Price, post: Price): void {
    const start = Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
    const cs = book.candles;
    const last = cs.at(-1);
    if (last !== undefined && start < last.startMs) {
      // A trade stamped earlier than the newest candle (on-chain clocks can step back a second): out of order, so the
      // candles can no longer be proven complete.
      book.partial = true;
      return;
    }
    const hi = (a: Price, b: Price): Price => (cmpPrice(a, b) >= 0 ? a : b);
    if (last !== undefined && last.startMs === start) cs[cs.length - 1] = { startMs: start, open: last.open, high: hi(hi(last.high, pre), post), close: post };
    else cs.push({ startMs: start, open: pre, high: hi(pre, post), close: post });
    const keepFirst = book.openedAtMs + this.#o.candleFirstMs;
    const keepLast = start - this.#o.candleLastMs;
    for (let i = cs.length - 1; i >= 0; i--) if (cs[i]!.startMs >= keepFirst && cs[i]!.startMs < keepLast) cs.splice(i, 1);
  }

  #writeCandles(pool: string, provider: string, receivedAt: number, put: (k: string, v: unknown) => void): void {
    const b = this.#books.get(pool)!;
    // Only the migration's pool is the coin's market: anyone can create another pool of the same mint.
    if (this.#mints.get(b.mint)?.migration?.pool !== pool) return;
    // The candles depend on every trade since the pool opened, so they are observed at the pool's first slot and stay
    // current only while the pool's trade stream has been gap-free since then.
    const fact: CandlesFact = {
      obs: { provider, slot: b.fromSlot, receivedAt, quality: b.partial || b.dropped ? ['partial'] : [], stream: STREAMS.trades(pool), commitment: 'confirmed' },
      intervalMs: MINUTE_MS,
      candles: [...b.candles],
    };
    put(candlesKey(b.mint), fact);
  }

  // ---------- Insiders and soft features ----------

  /** Covered when the stream started by `from`, may have missed nothing in [from, through], and the head reached `through`. */
  #covered(stream: string, from: bigint, through: bigint): boolean {
    const s = this.#streams.get(stream);
    if (s === undefined || s.fromSlot > from || this.#head === null || this.#head < through) return false;
    for (const g of s.gaps) if (g.to >= from && (g.from === null || g.from <= through)) return false;
    for (const start of s.open.values()) if (start === null || start <= through) return false;
    return true;
  }

  #insiders(t: Track, e: MarketEvent, put: (k: string, v: unknown) => void): void {
    const c = t.create;
    if (c === undefined || !this.#streams.has(STREAMS.mintTxs(t.mint))) return;
    const windowEnd = c.slot + BigInt(this.#o.insiderSlots);
    const windowCovered = this.#covered(STREAMS.mintTxs(t.mint), c.slot, windowEnd);
    const first = this.#firstBuyers(t);
    const buyersCovered = first !== null && this.#covered(STREAMS.mintTxs(t.mint), c.slot, first.through > windowEnd ? first.through : windowEnd);
    const wallets = first?.wallets ?? [];
    // A funder read counts as of now only when it reached the wallet's oldest transaction and is point in time: a
    // funding after now is not known yet, and "no funding" read as of an earlier slot says nothing about now.
    const nowSlot = e.moment.slot;
    const fundedBy = (w: string): FunderRead | undefined => {
      const f = this.#funders.get(w);
      if (f === undefined || !f.complete) return undefined;
      // A found funding is fixed once it happened. No funder found is unknown, never "not funded by the dev": the
      // first transaction may have been a third party's (a spam token account, a close refund).
      const known = f.funder !== null && f.slot !== null && f.slot <= nowSlot;
      return known ? f : undefined;
    };
    const funders = wallets.map(fundedBy);
    const devFunder = fundedBy(c.creator)?.funder ?? null;
    // The dev's linked cluster (core facts/funding.ts, shared with the backtest supplement): only from complete reads.
    const links = first === null ? null : insiderLinks(c.creator, wallets, fundedBy);
    const fundersKnown = links !== null;
    const devCluster = [...(links?.devCluster ?? [])];
    const creationBuyers = [...t.buyers].filter(([, at]) => at >= c.slot && at <= windowEnd).map(([w]) => w);
    const insiders = [...new Set([...creationBuyers, ...devCluster])].filter((w) => w !== c.creator).sort();
    const fact: InsidersFact = {
      obs: { provider: 'facts', slot: c.slot, receivedAt: e.moment.receivedAt, quality: [], commitment: 'confirmed' },
      complete: windowCovered && buyersCovered && fundersKnown,
      insiders,
      devCluster,
    };
    const sig = JSON.stringify([fact.complete, insiders, devCluster, creationBuyers.length, t.devBuySameTx, devFunder, funders.map((f) => f?.funder ?? null)]);
    if (this.#insidersSeen.get(t.mint) === sig) return;
    this.#insidersSeen.set(t.mint, sig);
    put(insidersKey(t.mint), fact);
    const soft: Record<string, unknown> = { obs: fact.obs, completeness: fact.complete ? 'complete' : 'unresolved' };
    if (windowCovered) {
      soft['creationSlotBuyers'] = creationBuyers.length;
      soft['devBuySameTx'] = t.devBuySameTx;
    }
    if (buyersCovered) {
      // First buyers by funding evidence: linked (funded by the dev, or sharing a first funder with another first
      // buyer), supported independent (a known funder no other first buyer shares), unresolved (no point-in-time read).
      const byFunder = new Map<string, number>();
      for (const f of funders) if (f?.funder) byFunder.set(f.funder, (byFunder.get(f.funder) ?? 0) + 1);
      let linked = 0;
      let independent = 0;
      let unresolved = 0;
      wallets.forEach((w, i) => {
        if (w === c.creator) return;
        const f = funders[i];
        if (f === undefined || f.funder === null) unresolved++;
        else if (f.funder === c.creator || f.funder === devFunder || (byFunder.get(f.funder) ?? 0) > 1) linked++;
        else independent++;
      });
      soft['knownLinkedOwners'] = linked;
      soft['supportedIndependentOwners'] = independent;
      soft['unresolvedOwners'] = unresolved;
    }
    put(softKey(t.mint), soft as unknown as SoftFact);
  }

  // ---------- Streams, slots and holes ----------

  #streamFact(s: StreamState, e: MarketEvent): unknown {
    if (this.#head === null) return undefined;
    return {
      obs: { provider: 'facts', slot: this.#head, receivedAt: e.moment.receivedAt, quality: s.open.size > 0 ? ['partial'] : [] },
      gapFreeSince: gapFreeSince(s),
    };
  }

  #slot(e: MarketEvent, put: (k: string, v: unknown) => void): void {
    const v = isObj(e.value) ? e.value['slot'] : undefined;
    if (typeof v !== 'bigint' || (this.#head !== null && v <= this.#head)) return;
    this.#head = v;
    // TRADE-GAP-HEAL: a heal that waited too long is let go: its holes stay.
    for (const [pool, h] of this.#heals) if (this.#expired(h, e.moment.receivedAt)) this.#heals.delete(pool);
    for (const [name, s] of this.#streams) {
      const f = this.#streamFact(s, e);
      if (f !== undefined) put(streamKey(name), f);
    }
    // Insider coverage depends on the head reaching the end of each window: recheck the watched mints.
    for (const name of this.#streams.keys()) this.#refreshInsiders(name, e, put);
    // WATCH-1c: a chain whose stream covered every slot through the head, with no swap or other pool transaction since
    // its last state, is proven unchanged as of the head (a slot's transactions are released before its notice).
    for (const [pool, c] of this.#chains) {
      if (c.stale !== null || !this.#tradesCovered(pool, c.coveredFrom)) continue;
      put(carryKey(c.mint), { pool, slot: v, state: c.state, obs: { provider: 'facts', slot: v, receivedAt: e.moment.receivedAt, quality: [], commitment: 'confirmed' } });
    }
  }

  #coverage(e: MarketEvent, put: (k: string, v: unknown) => void): void {
    const c = coverageOf(e.key);
    const v = unwrap(e.value);
    if (c === null || !isObj(v)) return;
    const from = slotOrNull(v['fromSlot']);
    const to = slotOrNull(v['toSlot']);
    if (from === undefined || (c.part !== 'start' && to === undefined)) return;
    let s = this.#streams.get(c.stream);
    if (c.part === 'start') {
      if (typeof from !== 'bigint') return;
      if (s === undefined) {
        s = { fromSlot: from, gaps: [], open: new Map(), vias: new Set(), startedAt: e.moment.receivedAt };
        this.#streams.set(c.stream, s);
      } else if (s.open.size > 0) {
        // A new start after an open-ended gap (unwatched, halted, refused): covered again only from here.
        for (const start of s.open.values()) s.gaps.push({ from: start, to: from - 1n });
        s.open.clear();
      }
      if (typeof v['via'] === 'string') s.vias.add(v['via']);
    } else if (s !== undefined) {
      const key = from === null ? 'null' : String(from);
      if (c.part === 'gap') {
        if (to === null || to === undefined) s.open.set(key, from);
        else {
          s.open.delete(key);
          s.gaps.push({ from, to });
        }
      } else {
        // Resume: backfill restored the range in full, so an open gap that started there closes with no loss.
        s.open.delete(key);
      }
    } else return;
    const f = this.#streamFact(s, e);
    if (f !== undefined) put(streamKey(c.stream), f);
    this.#refreshInsiders(c.stream, e, put);
    this.#chainCoverage(c.stream, e, put);
  }

  #hole(via: string, slot: bigint, put: (k: string, v: unknown) => void, e: MarketEvent): void {
    const sig = isObj(e.value) && typeof e.value['signature'] === 'string' ? e.value['signature'] : undefined;
    for (const [name, s] of this.#streams) {
      if (!s.vias.has(via)) continue;
      s.gaps.push(sig === undefined ? { from: slot, to: slot } : { from: slot, to: slot, sig });
      if (name.startsWith('trades:')) this.#holeHeal(name.slice('trades:'.length), sig, slot, e.moment.receivedAt);
      const f = this.#streamFact(s, e);
      if (f !== undefined) put(streamKey(name), f);
      this.#refreshInsiders(name, e, put);
      this.#chainCoverage(name, e, put);
    }
  }

  #refreshInsiders(stream: string, e: MarketEvent, put: (k: string, v: unknown) => void): void {
    if (!stream.startsWith('mint-txs:')) return;
    const t = this.#mints.get(stream.slice('mint-txs:'.length));
    if (t !== undefined) this.#insiders(t, e, put);
  }

  // ---------- Raw reads ----------

  #raw(e: MarketEvent, put: (k: string, v: unknown) => void): void {
    const key = e.key;
    const v = unwrap(e.value);
    const provider = sourceOf(e);
    const at = e.moment.receivedAt;
    if (key.startsWith('read:accounts:')) {
      const r = parseAccountsRead(v);
      if (r !== null && key === RAW.accounts(r.mint) && usable(r.commitment)) this.#accountsRead(r, provider, at, put);
    } else if (key.startsWith('read:holders:')) {
      const r = parseHoldersRead(v);
      if (r === null || key !== RAW.holders(r.mint) || !usable(r.commitment)) return;
      put(holdersKey(r.mint), {
        obs: { provider, slot: r.slot, receivedAt: at, quality: [], commitment: r.commitment }, supply: r.supply, coverage: 'largest',
        accounts: r.accounts.map((a) => ({ mint: r.mint, address: a.address, owner: a.owner, ownerProgram: a.ownerProgram, amount: a.amount, delegate: a.delegate, delegatedAmount: a.delegatedAmount })),
      });
    } else if (key.startsWith('read:holders-all:')) {
      const r = parseHoldersAllRead(v);
      if (r === null || key !== RAW.holdersAll(r.mint) || !usable(r.commitment)) return;
      const c = checkHolders(r);
      if (c.ok) put(holdersKey(r.mint), { obs: { provider, slot: r.slot, receivedAt: at, quality: [], commitment: r.commitment }, ...c.set });
      // Abstentions and fallbacks per UTC day and reason, for the coverage report: what never formed, or formed only
      // after a refused mint-only scan, is visible.
      const reasons = [...(r.fallback === true ? ['mint-only-refused'] : []), ...(c.ok ? [] : [c.reason])];
      if (reasons.length > 0) {
        const day = Math.floor(at / DAY_MS);
        if (this.#abstainDay !== day) this.#abstain = new Map();
        this.#abstainDay = day;
        for (const x of reasons) this.#abstain.set(x, (this.#abstain.get(x) ?? 0) + 1);
        put(HOLDER_ABSTENTIONS_KEY, { obs: { provider: 'facts', slot: null, receivedAt: at, quality: [] }, day, counts: Object.fromEntries([...this.#abstain].sort()), last: { mint: r.mint, reason: reasons.at(-1)! } });
      }
    } else if (key.startsWith('read:sim:')) {
      const r = parseSimRead(v);
      if (r === null || key !== RAW.sim(r.mint)) return;
      put(simKey(r.mint), { obs: { provider, slot: r.slot, receivedAt: at, quality: [] }, ok: r.ok, spend: r.spend, paid: r.paid, proceeds: r.proceeds, error: r.error });
    } else if (key.startsWith('read:rugcheck:') || key.startsWith('read:goplus:') || key.startsWith('read:jupiter-audit:')) {
      this.#xcheck(key, v, at, put);
    } else if (key.startsWith('read:funder:')) {
      const r = parseFunderRead(v);
      if (r === null || key !== RAW.funder(r.wallet)) return;
      this.#funders.set(r.wallet, r);
      // Re-read: moved to the end of the read-time order.
      this.#funderAt.delete(r.wallet);
      this.#funderAt.set(r.wallet, at);
      for (const mint of this.#walletMints.get(r.wallet) ?? []) {
        const t = this.#mints.get(mint);
        if (t !== undefined) this.#insiders(t, e, put);
      }
    } else if (key === RAW.solUsd) {
      const bar = parseSolUsdBar(v);
      const p = bar === null ? null : decimalToMicro(bar.close);
      if (bar === null || p === null || bar.start % HOUR_MS !== 0) return;
      this.#sol.set(bar.start + HOUR_MS, p);
      const newest = Math.max(...this.#sol.keys());
      for (const t of [...this.#sol.keys()]) if (t < newest - this.#o.solUsdKeepMs) this.#sol.delete(t);
      put(SOL_USD_KEY, {
        obs: { provider, slot: null, receivedAt: at, quality: [] },
        points: [...this.#sol].sort((a, b) => a[0] - b[0]).map(([tMs, price]) => ({ tMs, price })),
      });
    } else if (key === RAW.volumeHour) {
      const r = parseVolumeHour(v);
      // An hour row is usable only once its hour has ended: earlier it would be a look into the future.
      if (r === null || at < r.hourStartMs + HOUR_MS) return;
      // Linear in rows: a new fact only when the complete days change (a whole window loads at once after a restart).
      if (this.#volume.add(r)) put(CURVE_VOLUME_KEY, { obs: { provider, slot: null, receivedAt: at, quality: [] }, days: this.#volume.days() });
    } else if (key === RAW.graduatesSeed) {
      const r = parseGraduatesSeed(v);
      if (r === null) put(GRADUATES_SEED_KEY, { source: null, atMs: at, accepted: false, added: 0, reason: 'malformed seed' });
      else put(GRADUATES_SEED_KEY, { source: r.source, atMs: at, ...this.#seedGraduates(r, at) });
    } else if (key === RAW.exec) {
      const r = parseExecStats(v);
      if (r === null) return;
      put(EXEC_HEALTH_KEY, { obs: { provider, slot: null, receivedAt: at, quality: [] }, ...this.#health(r) });
    }
  }

  #health(r: NonNullable<ReturnType<typeof parseExecStats>>): { green: boolean; detail: string } {
    const lim = this.#o.execHealth;
    const failedBps = r.attempts === 0 ? null : Number((BigInt(r.failed) * BPS_DENOMINATOR) / BigInt(r.attempts));
    const measured = `${r.attempts} attempts, ${r.failed} failed, landing p50 ${r.landingSlotsP50 ?? 'unknown'} slots, quote error p50 ${r.quoteErrorBpsP50 ?? 'unknown'} bps`;
    if (lim === undefined) return { green: false, detail: `no execution-health limits set by the owner; ${measured}` };
    const bad: string[] = [];
    if (r.attempts < lim.minAttempts) bad.push(`fewer than ${lim.minAttempts} attempts`);
    if (failedBps === null || failedBps > lim.maxFailedBps) bad.push(`failure share above ${lim.maxFailedBps} bps`);
    if (r.landingSlotsP50 === null || r.landingSlotsP50 > lim.maxLandingSlots) bad.push(`landing above ${lim.maxLandingSlots} slots`);
    if (r.quoteErrorBpsP50 === null || r.quoteErrorBpsP50 > lim.maxQuoteErrorBps) bad.push(`quote error above ${lim.maxQuoteErrorBps} bps`);
    return { green: bad.length === 0, detail: bad.length === 0 ? measured : `${bad.join('; ')}; ${measured}` };
  }

  #xcheck(key: string, v: unknown, at: number, put: (k: string, v: unknown) => void): void {
    const auth = (set: boolean | null): 'none' | 'set' | null => (set === null ? null : set ? 'set' : 'none');
    const status = (s: string | null): 'none' | 'set' | null => (s === '1' ? 'set' : s === '0' ? 'none' : null);
    let mint: string;
    let name: 'rugcheck' | 'goplus' | 'jupiter';
    let src: XcheckFact['sources'][number];
    if (key.startsWith('read:rugcheck:')) {
      const r = parseRugCheckRead(v);
      if (r === null || key !== RAW.rugcheck(r.mint)) return;
      [mint, name, src] = [r.mint, 'rugcheck', { provider: 'rugcheck', mintAuthority: auth(r.mintAuthority !== null), freezeAuthority: auth(r.freezeAuthority !== null) }];
    } else if (key.startsWith('read:goplus:')) {
      const r = parseGoPlusRead(v);
      if (r === null || key !== RAW.goplus(r.mint)) return;
      [mint, name, src] = [r.mint, 'goplus', { provider: 'goplus', mintAuthority: status(r.mintable), freezeAuthority: status(r.freezable) }];
    } else {
      const r = parseJupiterAuditRead(v);
      if (r === null || key !== RAW.jupiter(r.mint)) return;
      const off = (disabled: boolean | null): 'none' | 'set' | null => (disabled === null ? null : disabled ? 'none' : 'set');
      [mint, name, src] = [r.mint, 'jupiter', { provider: 'jupiter', mintAuthority: off(r.mintAuthorityDisabled), freezeAuthority: off(r.freezeAuthorityDisabled) }];
    }
    const t = this.#track(mint);
    t.xcheck.set(name, { at, src });
    // Only reads young enough for H16 go in; the fact is as old as its oldest read.
    const fresh = [...t.xcheck.values()].filter((x) => at - x.at <= this.#o.maxQuoteAgeMs).sort((a, b) => (a.src.provider < b.src.provider ? -1 : 1));
    const oldest = Math.min(...fresh.map((x) => x.at));
    put(xcheckKey(mint), { obs: { provider: 'facts', slot: null, receivedAt: oldest, quality: [] }, sources: fresh.map((x) => x.src) });
  }

  // ---------- Accounts: mint, pool, LP ----------

  #accountsRead(r: AccountsRead, provider: string, at: number, put: (k: string, v: unknown) => void): void {
    for (const a of r.accounts) {
      const prev = this.#accounts.get(a.address);
      if (prev !== undefined && prev.slot > r.slot) continue;
      this.#accounts.set(a.address, { owner: a.owner, data: a.data, slot: r.slot, receivedAt: at, commitment: r.commitment, provider });
    }
    const obsOf = (acc: readonly Account[]): FactObs => {
      const oldest = acc.reduce((m, x) => (x.slot < m.slot ? x : m));
      return { provider, slot: oldest.slot, receivedAt: at, quality: [], commitment: oldest.commitment };
    };
    const m = this.#accounts.get(r.mint);
    if (m !== undefined && m.owner !== null && m.data !== null) {
      let account: MintFact['account'] = null;
      try {
        const d = decodeMint(fromBase64(m.data), m.owner as Address);
        account = { mintAuthority: d.mintAuthority, freezeAuthority: d.freezeAuthority, supply: d.supply, extensions: d.extensions };
      } catch {
        account = null;
      }
      put(mintKey(r.mint), { obs: obsOf([m]), owner: m.owner, account });
    }
    // The pool the entry trades on: the migration's pool, else the read's PumpSwap pool of this mint.
    const t = this.#mints.get(r.mint);
    const candidates = [...(t?.migration ? [t.migration.pool] : []), ...r.accounts.map((a) => a.address)];
    for (const address of candidates) {
      const acc = this.#accounts.get(address);
      if (acc === undefined || acc.owner !== PUMP_AMM_PROGRAM || acc.data === null) continue;
      let pool: ReturnType<typeof decodePool>['value'];
      try {
        pool = decodePool(fromBase64(acc.data)).value;
      } catch {
        continue;
      }
      if (pool.baseMint !== r.mint) continue;
      const vault = (at: string, mint: string): { readonly acc: Account; readonly amount: bigint } | null => {
        const x = this.#accounts.get(at);
        if (x === undefined || x.owner === null || x.data === null) return null;
        try {
          const t = decodeTokenAccount(fromBase64(x.data), x.owner as Address);
          // A vault must be the pool's own token account of the right mint; anything else is not its reserve.
          return t.owner === address && t.mint === mint ? { acc: x, amount: t.amount } : null;
        } catch {
          return null;
        }
      };
      const base = vault(pool.poolBaseTokenAccount, pool.baseMint);
      const quote = vault(pool.poolQuoteTokenAccount, pool.quoteMint);
      if (base !== null && quote !== null) {
        // accountBytes and the pool's cashback and creator fields mirror TX-1b's PoolFact (#51) until it merges.
        const fact: PoolFact & { readonly accountBytes: number } = {
          obs: obsOf([acc, base.acc, quote.acc]),
          address,
          owner: acc.owner,
          pool: {
            index: pool.index, creator: pool.creator, baseMint: pool.baseMint, quoteMint: pool.quoteMint, lpMint: pool.lpMint,
            poolBaseTokenAccount: pool.poolBaseTokenAccount, poolQuoteTokenAccount: pool.poolQuoteTokenAccount, lpSupply: pool.lpSupply,
            ...(pool.isMayhemMode === undefined ? {} : { isMayhemMode: pool.isMayhemMode }),
            ...(pool.virtualQuoteReserves === undefined ? {} : { virtualQuoteReserves: pool.virtualQuoteReserves }),
            // TX-1b (H17) reads these; absent on pools written before the fields existed.
            ...(pool.isCashbackCoin === undefined ? {} : { isCashbackCoin: pool.isCashbackCoin }),
            ...(pool.coinCreator === undefined ? {} : { coinCreator: pool.coinCreator }),
          },
          accountBytes: fromBase64(acc.data).length,
          baseVault: base.amount,
          quoteVault: quote.amount,
        };
        this.#chainRead(r.mint, fact, put);
        this.#readReserve(address, quote.amount + (pool.virtualQuoteReserves ?? 0n), at);
      }
      const lp = this.#accounts.get(pool.lpMint);
      if (lp !== undefined && lp.owner !== null && lp.data !== null) {
        try {
          const supply = decodeMint(fromBase64(lp.data), lp.owner as Address).supply;
          put(lpKey(r.mint), { obs: obsOf([lp]), lpMint: pool.lpMint, supply });
        } catch {
          // An LP mint that does not decode makes no LP fact; H6 then rejects as missing.
        }
      }
      break;
    }
  }

  // ---------- Pool state from the swap stream (POS-1) ----------

  /** The trade stream of `pool` has started by `from` and may have missed nothing from `from` on. */
  #tradesCovered(pool: string, from: bigint): boolean {
    const s = this.#streams.get(STREAMS.trades(pool));
    if (s === undefined || s.fromSlot > from || s.open.size > 0) return false;
    return s.gaps.every((g) => g.to < from);
  }

  /**
   * A coherent account read of the pool re-bases its chain, unless the chain already holds a newer state (a read
   * answered for an older slot than the swaps applied since): that read's pool fact is then left out, never released
   * over a newer one.
   */
  #chainRead(mint: string, fact: PoolFact & { readonly accountBytes: number }, put: (k: string, v: unknown) => void): void {
    // The fact's slot: the oldest of the accounts it was built from, so a swap after it is never taken as already in it.
    const slot = fact.obs.slot ?? 0n;
    const c = this.#chains.get(fact.address);
    // POOL-FIRST-READ: a pool event other than a swap newer than the read is not in it either.
    if (c !== undefined && (c.lastSlot > slot || c.otherSlot > slot)) return;
    const n: PoolChain = {
      mint, read: fact, coveredFrom: slot + 1n, lastSlot: slot, readSlot: slot, otherSlot: slot, stale: null, seen: new Set(), applied: new Set(),
      state: { baseReserve: fact.baseVault, quoteVault: fact.quoteVault, virtualQuoteReserves: fact.pool.virtualQuoteReserves ?? 0n },
    };
    this.#chains.set(fact.address, n);
    put(poolKey(mint), fact);
    if (c !== undefined) return;
    const pre = this.#takePre(fact.address, 'chain');
    // POOL-FIRST-READ: the pool's events released before this first read and newer than it are applied now, in release
    // order, exactly as if the read had come first: every swap through the same checks (those at or before the read's
    // slot are in it and skipped, the rest must chain). Events let go past the cap, if newer than the read, leave the chain stale (a gap: the
    // next swap kept re-bases it on its own pre-trade reserves).
    if (pre.lost || (pre.dropped !== null && pre.dropped > slot)) this.#stale(n, 'gap', 'pool events before the first read were let go', fact.obs, put);
    for (const x of pre.events) {
      if (x.kind === 'swap') this.#chainSwap(x.t.ev, x.t.seen, put);
      else if (x.kind === 'other') this.#otherOnChain(n, x.slot, x.name, x.obs, put);
    }
  }

  /**
   * POOL-FIRST-READ: keeps a watched pool's event released before its chain (`chain`) or its candle book (`book`)
   * exists, the newest `PRE_READ_KEEP` of the pool. One buffer and one cap serve both.
   */
  #preRead(pool: string, x: PreReadEvent, chain: boolean, book: boolean): void {
    const keep = this.#o.preReadKeep ?? PRE_READ_KEEP;
    const s = this.#streams.get(STREAMS.trades(pool));
    if (keep === 0 || s === undefined) return;
    // Review of #266 (P5): past the time a late migration can land, swaps are no longer kept for the book. What was kept
    // for it goes, and the book is marked lost (a migration that still lands opens it partial).
    if (book && preReadAt(x) - s.startedAt > PRE_BOOK_KEEP_MS) {
      book = false;
      s.lost ??= { chain: false, book: false };
      s.lost.book = true;
      const q = this.#preReads.get(pool);
      if (q !== undefined) {
        for (const k of q.events) k.book = false;
        q.events = q.events.filter((k) => k.chain);
        q.droppedBook = null;
        if (q.events.length === 0 && q.droppedChain === null) this.#preReads.delete(pool);
      }
    }
    if (!chain && !book) return;
    let p = this.#preReads.get(pool);
    if (p === undefined) {
      p = { events: [], droppedChain: null, droppedBook: null };
      this.#preReads.set(pool, p);
    }
    p.events.push({ x, chain, book });
    if (p.events.length > keep) {
      const k = p.events.shift()!;
      if (k.chain) p.droppedChain = newest(p.droppedChain, preReadSlot(k.x));
      if (k.book) p.droppedBook = newest(p.droppedBook, preReadSlot(k.x));
    }
  }

  /**
   * POOL-FIRST-READ: the kept events `who` (now existing) needs, in release order, the newest slot it needed that was
   * let go, and whether the pool's kept events were let go whole. The rest stays for the other, while it is missing.
   */
  #takePre(pool: string, who: 'chain' | 'book'): { readonly events: PreReadEvent[]; readonly dropped: bigint | null; readonly lost: boolean } {
    const s = this.#streams.get(STREAMS.trades(pool));
    const lost = s?.lost?.[who] === true;
    if (s?.lost !== undefined) s.lost[who] = false;
    const p = this.#preReads.get(pool);
    if (p === undefined) return { events: [], dropped: null, lost };
    const events = p.events.filter((k) => k[who]).map((k) => k.x);
    const dropped = who === 'chain' ? p.droppedChain : p.droppedBook;
    for (const k of p.events) k[who] = false;
    p.events = p.events.filter((k) => k.chain || k.book);
    if (who === 'chain') p.droppedChain = null;
    else p.droppedBook = null;
    if (this.#chains.has(pool) && this.#books.has(pool)) this.#preReads.delete(pool);
    return { events, dropped, lost };
  }

  /**
   * POOL-FIRST-READ part 3: a candle book opened late (the migration's transaction released after swaps on its pool,
   * as after a re-read) takes the swaps kept for it, in release order, exactly as `#swap` takes them live, so the
   * candles equal an in-order run. They are taken once the opening transaction's own events are in (its first swap
   * comes after its CreatePoolEvent, and every kept swap is from a later transaction: the pool did not exist before
   * it), at the first event of another transaction (`#bookTake`). Swaps it needed that were let go past the cap, or a
   * pool whose kept events were let go whole, leave the book partial (never complete with trades missing).
   */
  #bookOpen(pool: string, sig: string): void {
    const book = this.#books.get(pool)!;
    const pre = this.#takePre(pool, 'book');
    // Swaps (and their holes) before the CreatePoolEvent's slot are not the pool's trades.
    const events = pre.events.filter((x) => x.kind === 'outcome' || x.kind === 'holeTxOther' || x.kind === 'other' || preReadSlot(x) >= book.fromSlot);
    const partial = pre.lost || (pre.dropped !== null && pre.dropped >= book.fromSlot);
    if (events.length > 0 || partial) this.#bookPending.set(pool, { sig, events, partial });
  }

  /** POOL-FIRST-READ part 3: books opened late take their kept swaps at the first event of another transaction. */
  #bookTake(e: MarketEvent, put: (k: string, v: unknown) => void): void {
    if (this.#bookPending.size === 0) return;
    const sig = programEvent(e)?.seen.signature;
    for (const [pool, p] of this.#bookPending) {
      if (sig === p.sig) continue;
      this.#bookPending.delete(pool);
      const book = this.#books.get(pool);
      if (book === undefined) continue;
      // RT-A4: set before any swap is taken, so no mark (and no heal from one) can read the candles as complete.
      if (p.partial) book.dropped = true;
      for (const x of p.events) {
        if (x.kind === 'swap') {
          const { ev, seen } = x.t;
          if (book.mark === null || seen.slot > book.mark.slot) this.#markBook(book, seen.slot, false);
          const atMs = ms(ev.data.timestamp);
          if (atMs !== null) this.#bookSwap(book, ev, seen, atMs, put, false);
        } else if (x.kind === 'hole') this.#holeHeal(pool, x.sig, x.slot, x.at);
        else if (x.kind === 'holeTx') {
          const h = this.#heals.get(pool);
          if (h !== undefined && h.holes.has(x.t.seen.signature)) h.fetched.push(x.t);
        } else if (x.kind === 'holeTxOther') {
          const h = this.#heals.get(pool);
          if (h !== undefined && h.holes.has(x.sig)) h.tainted = true;
        } else if (x.kind === 'other') {
          // As `#chainOther` live: no heal across a pool transaction other than a swap.
          if (book.mark !== null) book.mark.other = true;
          const h = this.#heals.get(pool);
          if (h !== undefined) h.other = true;
        } else this.#holeOutcome(pool, x.sig, x.found, x.e, put);
      }
      if (p.partial) this.#writeCandles(pool, sourceOf(e), e.moment.receivedAt, put);
    }
  }

  /** The pool fact of a chain's current state, observed as `obs`; flagged `partial` with its reason while stale. */
  #chainFact(c: PoolChain, obs: FactObs, state: PoolState, stale: string | null): unknown {
    return {
      ...c.read, obs: stale === null ? obs : { ...obs, quality: [...obs.quality, 'partial'] },
      pool: { ...c.read.pool, virtualQuoteReserves: state.virtualQuoteReserves },
      baseVault: state.baseReserve, quoteVault: state.quoteVault,
      ...(stale === null ? {} : { stale }),
    };
  }

  /** Marks a chain stale and releases its last state flagged, so neither a gate nor an exit prices from it. */
  #stale(c: PoolChain, kind: 'gap' | 'mismatch', reason: string, obs: FactObs, put: (k: string, v: unknown) => void): void {
    // Already stale: only a mismatch replaces a gap (it needs a read, not just a gap-free swap, to clear).
    if (c.stale !== null && (c.stale.kind === 'mismatch' || kind === 'gap')) return;
    c.stale = { kind, reason };
    put(poolKey(c.mint), this.#chainFact(c, obs, c.state, reason));
  }

  /**
   * WATCH-1c: a confirmed PumpSwap event on a pool's own trade stream that is not a swap (a deposit, a withdrawal, a
   * buyback, an admin or fee instruction, or one DEC-1 cannot name) may have moved the reserves without a swap event:
   * the chain is stale until the next swap re-bases it on the program's own pre-trade reserves. So "no swap" proves
   * "unchanged" only while nothing else touched the pool. Fail closed: an unnamed event counts too.
   */
  #chainOther(e: MarketEvent, put: (k: string, v: unknown) => void): void {
    // DEDUP-PER-WATCH: `logs:pool-other:<via>` is another watch's copy of a log whose PumpSwap event DEC-1 cannot name
    // (the feed releases a transaction's events once, through the first watch that saw it).
    const echo = e.key.startsWith('logs:pool-other:');
    if (!echo && !e.key.startsWith('logs:pump_amm:')) return;
    const v = e.value;
    if (!isObj(v) || v['commitment'] !== 'confirmed' || typeof v['via'] !== 'string' || !v['via'].startsWith('logs:') || typeof v['txSlot'] !== 'bigint') return;
    const ev = isObj(v['event']) ? v['event'] : undefined;
    const name = echo ? v['name'] : ev?.['name'];
    if (name === 'BuyEvent' || name === 'SellEvent') return;
    // POOL-FIRST-READ part 2: an event proven on mainnet to leave the reserves unchanged is not a change (only its exact
    // discriminators; an echo carries none, so it stays a change).
    if (!echo && isNoChangePoolEvent(ev)) return;
    // DEDUP-PER-WATCH: the pool the event touched. A named one says it; one DEC-1 cannot name says nothing, so every
    // watch that saw its transaction counts it (this watch here, the others by their `pool-other` copies). Fail closed.
    const named = !echo && ev !== undefined && isObj(ev['data']) && typeof ev['data']['pool'] === 'string' ? ev['data']['pool'] : null;
    const pool = named ?? v['via'].slice('logs:'.length);
    // TRADE-GAP-HEAL: no heal across it (a pool transaction other than a swap may move the reserves).
    const b = this.#books.get(pool);
    if (b?.mark) b.mark.other = true;
    const h = this.#heals.get(pool);
    if (h !== undefined) h.other = true;
    const c = this.#chains.get(pool);
    const label = typeof name === 'string' ? name : 'unnamed';
    const obs: FactObs = { provider: sourceOf(e), slot: v['txSlot'], receivedAt: e.moment.receivedAt, quality: [], commitment: 'confirmed' };
    // Kept for the chain (no read yet) and, RT-A5, for the book's heals (no book yet), whichever is missing.
    this.#preRead(pool, { kind: 'other', slot: v['txSlot'], name: label, obs }, c === undefined, !this.#books.has(pool));
    if (c !== undefined) this.#otherOnChain(c, v['txSlot'], label, obs, put);
  }

  #otherOnChain(c: PoolChain, slot: bigint, name: string, obs: FactObs, put: (k: string, v: unknown) => void): void {
    if (slot <= c.readSlot) return;
    if (slot > c.otherSlot) c.otherSlot = slot;
    this.#stale(c, 'gap', `a pool transaction other than a swap (${name})`, obs, put);
  }

  /** A gap or hole in a pool's trade stream makes its chain stale at once; a pool no longer watched drops its chain. */
  #chainCoverage(stream: string, e: MarketEvent, put: (k: string, v: unknown) => void): void {
    if (!stream.startsWith('trades:')) return;
    const pool = stream.slice('trades:'.length);
    // WORKER-1's PoolWatch unwatches a pool that left its list with reason 'not watched': nothing will read its state.
    const v = unwrap(e.value);
    if (e.key.endsWith(':gap') && isObj(v) && v['toSlot'] === null && v['reason'] === 'not watched') {
      const gone = this.#chains.get(pool);
      this.#chains.delete(pool);
      this.#preReads.delete(pool);
      if (gone !== undefined && gone.stale === null) put(poolKey(gone.mint), this.#chainFact(gone, { provider: 'facts', slot: e.moment.slot, receivedAt: e.moment.receivedAt, quality: [], commitment: 'confirmed' }, gone.state, 'swap stream gap'));
      return;
    }
    const c = this.#chains.get(pool);
    if (c === undefined || c.stale !== null || this.#tradesCovered(stream.slice('trades:'.length), c.coveredFrom)) return;
    this.#stale(c, 'gap', 'swap stream gap', { provider: 'facts', slot: e.moment.slot, receivedAt: e.moment.receivedAt, quality: [], commitment: 'confirmed' }, put);
  }

  /**
   * A confirmed swap moves the chain to the pool right after it (core fills `swapEventState`, the backtest's replay).
   * Fail closed: a stream gap since the base, pre-trade reserves that differ from the chain's state (a swap or a
   * liquidity change not seen) or a swap that does not reproduce its event make the state stale. After a gap the
   * stream re-bases on the first swap it carries gap-free: its pre-trade reserves are the program's own report.
   */
  #chainSwap(ev: Extract<PumpEventData, { name: 'BuyEvent' | 'SellEvent' }>, seen: Seen, put: (k: string, v: unknown) => void): void {
    const d = ev.data;
    const c = this.#chains.get(d.pool);
    // POOL-FIRST-READ: a swap before the pool's first read was kept (`#swap`) until the read, which applies it if newer.
    if (c === undefined) return;
    if (seen.slot <= c.readSlot) return;
    const id = `${seen.signature}:${d.poolBaseTokenReserves}:${d.poolQuoteTokenReserves}`;
    if (c.seen.has(id)) return;
    c.seen.add(id);
    const older = seen.slot < c.lastSlot;
    if (seen.slot > c.lastSlot) {
      c.lastSlot = seen.slot;
      c.seen.clear();
      c.seen.add(id);
    }
    const obs: FactObs = { provider: seen.provider, slot: seen.slot, receivedAt: seen.receivedAt, quality: quality(seen.backfilled), commitment: seen.commitment };
    if (c.stale?.kind === 'mismatch') return;
    if (c.stale !== null) {
      // Re-base after a gap on the swap's own pre-trade reserves; the coverage check below keeps it stale unless the
      // stream has had no gap from this swap's slot on. Review of #266 (P1/P2): never on a swap from the slot of a pool
      // event other than a swap or before it (its order against that event is not proven, and the event's change would
      // be lost): only a swap from a later slot, or a read at or after it, re-bases.
      if (older || seen.slot <= c.otherSlot) return;
      c.coveredFrom = seen.slot;
      c.state = { baseReserve: d.poolBaseTokenReserves, quoteVault: d.poolQuoteTokenReserves, virtualQuoteReserves: d.virtualQuoteReserves ?? 0n };
      c.stale = null;
      c.seen.clear();
      c.seen.add(id);
    } else if (older) {
      // A repeat of a swap already applied is nothing new. Any other swap released behind a newer one cannot be applied
      // in order: the state is not known until the next swap re-bases it (fail closed; WATCH-1c carries a state only
      // while nothing is missing from it).
      if (c.applied.has(id)) return;
      return this.#stale(c, 'gap', `swap ${seen.signature} arrived out of order`, obs, put);
    }
    const state = c.state;
    if (!this.#tradesCovered(d.pool, c.coveredFrom)) return this.#stale(c, 'gap', 'swap stream gap', obs, put);
    const pre = { baseReserve: d.poolBaseTokenReserves, effective: d.poolQuoteTokenReserves + (d.virtualQuoteReserves ?? 0n) };
    // The price-setting reserves (base, and vault + virtual) must chain exactly; the vault/virtual split is taken from
    // the event, which reports it (a sell does not say whether it was v2, so the split after a sell may be the v1 one).
    if (pre.baseReserve !== state.baseReserve || pre.effective !== state.quoteVault + state.virtualQuoteReserves) {
      return this.#stale(c, 'mismatch', `reserves mismatch: swap ${seen.signature} starts at ${pre.baseReserve}/${pre.effective}, state ${state.baseReserve}/${state.quoteVault + state.virtualQuoteReserves}`, obs, put);
    }
    const r = swapEventState(ev);
    if (!r.ok) return this.#stale(c, 'mismatch', r.reason, obs, put);
    c.state = r.after;
    c.applied.add(id);
    if (c.applied.size > APPLIED_KEPT) c.applied.delete(c.applied.values().next().value!);
    put(poolKey(c.mint), this.#chainFact(c, obs, r.after, null));
  }

  // ---------- Graduate survival (§6.4) ----------

  /**
   * An account read of a pending graduate's pool at or after its mark dates its survival. The window's end needs no
   * check here: `#survival` runs first on every event and drops a graduate once the window has passed.
   */
  #readReserve(pool: string, effective: bigint, at: number): void {
    const p = this.#pending.get(pool);
    if (p === undefined) return;
    if (at >= p.migratedAtMs + this.#o.survivalAfterMs) this.#resolve(p, effective);
  }

  /** A pending graduate is done: its pool's chain and trade stream go too if the pool was let go meanwhile. */
  #settle(pool: string): void {
    this.#pending.delete(pool);
    if (this.#retiredPools.has(pool)) this.#forgetPool(pool);
  }

  #forgetPool(pool: string): void {
    this.#heals.delete(pool);
    this.#chains.delete(pool);
    this.#preReads.delete(pool);
    this.#bookPending.delete(pool);
    this.#streams.delete(STREAMS.trades(pool));
  }

  #resolve(p: Pending, reserveAfter: bigint): void {
    this.#settle(p.pool);
    // What this process measured replaces a seeded entry for the same mint.
    const i = this.#graduates.findIndex((g) => g.mint === p.mint);
    if (i >= 0) this.#graduates.splice(i, 1);
    this.#graduates.push({ mint: p.mint, migratedAtMs: p.migratedAtMs, reserveAfter });
    this.#graduatesChanged = true;
  }

  /**
   * PERSIST-2: graduates known before this process. As-of honest: a seed dated after the moment it is released is
   * refused whole, and an entry counts only when its survival mark was reached by the seed's own as-of moment. A mint
   * the series already holds keeps its entry (a live measurement or an earlier seed); one that disagrees with it
   * refuses the whole seed, since two sources that differ on one graduate cannot both be trusted for the others.
   */
  #seedGraduates(r: NonNullable<ReturnType<typeof parseGraduatesSeed>>, at: number): { accepted: boolean; added: number; reason: string | null } {
    if (r.asOfMs > at) return { accepted: false, added: 0, reason: `dated ${r.asOfMs}, after its release at ${at}` };
    const have = new Map(this.#graduates.map((g) => [g.mint, g]));
    const add: GraduatesFact['items'][number][] = [];
    for (const i of r.items) {
      if (i.migratedAtMs + this.#o.survivalAfterMs > r.asOfMs) continue;
      const h = have.get(i.mint);
      if (h !== undefined) {
        if (h.migratedAtMs !== i.migratedAtMs || h.reserveAfter !== i.reserveAfter) return { accepted: false, added: 0, reason: `disagrees with the series on ${i.mint}` };
        continue;
      }
      have.set(i.mint, i);
      add.push({ mint: i.mint, migratedAtMs: i.migratedAtMs, reserveAfter: i.reserveAfter });
    }
    if (add.length > 0) {
      this.#graduates.push(...add);
      this.#graduatesChanged = true;
    }
    return { accepted: true, added: add.length, reason: null };
  }

  /** G4a: wallets' funder reads in read-time order (oldest first), for `#forgetFunders`. */
  readonly #funderAt = new Map<string, number>();

  /**
   * G4a (supervisor ruling): a wallet's funder read is let go `FUNDER_KEEP_MS` after it was read. Every candidate's
   * insider read reads its wallets' funders again as of its own slot (`Readers.readInsiders`), so nothing a live
   * candidate (at most about six hours with its tail) still needs is ever let go, and no read is saved by keeping one.
   */
  #forgetFunders(now: number): void {
    for (const [w, at] of this.#funderAt) {
      if (at + FUNDER_KEEP_MS > now) break;
      this.#funderAt.delete(w);
      this.#funders.delete(w);
    }
  }

  #survival(e: MarketEvent, put: (k: string, v: unknown) => void): void {
    const now = e.moment.receivedAt;
    for (const p of [...this.#pending.values()]) {
      const mark = p.migratedAtMs + this.#o.survivalAfterMs;
      if (now < mark) continue;
      // With every trade of the pool seen from migration to the mark, the last reserve before the mark is the reserve at it.
      const r = this.#reserves.get(p.pool);
      const through = this.#head !== null && this.#head < e.moment.slot ? this.#head : e.moment.slot;
      if (r !== undefined && r.atMs <= mark && this.#covered(STREAMS.trades(p.pool), p.slot, through)) this.#resolve(p, r.effective);
      else if (now > mark + this.#o.survivalReadWindowMs) this.#settle(p.pool);
    }
    this.#flushGraduates(e, put);
  }

  #flushGraduates(e: MarketEvent, put: (k: string, v: unknown) => void): void {
    if (!this.#graduatesChanged) return;
    this.#graduatesChanged = false;
    const g = graduatesFact(this.#graduates, e.moment.receivedAt, this.#o.graduatesKeepMs);
    this.#graduates.splice(0, this.#graduates.length, ...g.kept);
    put(GRADUATES_KEY, g.value);
  }
}

type GraduateItem = GraduatesFact['items'][number];

/**
 * The graduates fact as of `nowMs` (one implementation for the live producer and the backtest, supervisor ruling):
 * items that migrated within `keepMs` are kept, in their given order; the fact lists them by migration time, then mint.
 */
export const graduatesFact = (items: readonly GraduateItem[], nowMs: number, keepMs: number): { readonly kept: GraduateItem[]; readonly value: GraduatesFact } => {
  const keepFrom = nowMs - keepMs;
  const kept = items.filter((x) => x.migratedAtMs >= keepFrom);
  return {
    kept,
    value: {
      obs: { provider: 'facts', slot: null, receivedAt: nowMs, quality: [] },
      items: [...kept].sort((a, b) => a.migratedAtMs - b.migratedAtMs || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0)),
    },
  };
};
