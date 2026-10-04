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
import {
  type Address, type PumpEventData, PUMP_AMM_PROGRAM, decodeMint, decodePool, decodeTokenAccount, fromBase64,
} from '../chain/index.ts';
import type { Commitment, QualityFlag } from '../domain/index.ts';
import type { MarketEvent } from '../engine/feed.ts';
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
import type { VolumeHour } from './raw.ts';
import { BPS_DENOMINATOR } from '../units/index.ts';
import {
  RAW, decimalToMicro, parseAccountsRead, parseVolumeHour, parseExecStats, parseFunderRead, parseGoPlusRead, parseHoldersRead,
  parseHoldersAllRead, parseJupiterAuditRead, parseRugCheckRead, parseSimRead, parseSolUsdBar, type AccountsRead, type FunderRead,
  type HoldersAllRead, unwrap,
} from './raw.ts';

/** Holder facts not formed, and scans that fell back after a refused mint-only scan, per UTC day and reason (the coverage report reads it; it never feeds a gate). */
export const HOLDER_ABSTENTIONS_KEY = 'facts/abstentions:holders';

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
  /** Candles kept from migration on, for the chase check (H11). */
  readonly candleFirstMs: number;
  /** Candles kept back from the newest, for the spike window (H11). */
  readonly candleLastMs: number;
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

/** Options sized from the locked policy, so the kept windows always cover what the gates read. */
export const producerOptions = (p: Policy, execHealth?: ExecHealthLimits): ProducerOptions => ({
  candleFirstMs: p.gates.chaseCheckAfterMs + MINUTE_MS,
  candleLastMs: p.gates.candleWindowMs + MINUTE_MS,
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
      backfilled: v['backfilled'] === true, signature,
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
  readonly seen: Set<string>;
}

// ---------- Streams ----------

interface StreamState {
  fromSlot: bigint;
  /** Ranges the stream may have missed: bounded gaps and holes (a cut or undecodable log), inclusive. */
  readonly gaps: { readonly from: bigint | null; readonly to: bigint }[];
  /** Open gaps by their start (`toSlot` not known yet); a null start is unknown, so it covers everything. */
  readonly open: Map<string, bigint | null>;
  readonly vias: Set<string>;
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
  /** Why the state is stale, while it is; a gap clears once a swap re-bases it, anything else needs a read. */
  stale: { readonly reason: string; readonly kind: 'gap' | 'mismatch' } | null;
  /** Swaps seen at `lastSlot` (a delivery twice, from a log line and a fetched transaction, counts once); older slots are refused anyway. */
  readonly seen: Set<string>;
  /** Swaps applied to this chain, newest last (bounded): a second delivery behind newer swaps is a repeat, not a miss. */
  readonly applied: Set<string>;
}

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
    this.#chainOther(e, put);
    const pe = programEvent(e);
    if (pe !== null) this.#program(pe.ev, pe.seen, pe.truncated, e, put);
    else if (e.key === 'chain:slot') this.#slot(e, put);
    else if (e.key.startsWith('coverage:')) this.#coverage(e, put);
    else if (e.key.startsWith('logs:truncated:') || e.key.startsWith('logs:undecodable:')) this.#hole(e.key.slice(e.key.indexOf(':', 5) + 1), e.moment.slot, put, e);
    else this.#raw(e, put);
    this.#flushGraduates(e, put);
    return [...out].map(([key, value]) => ({ key, value }));
  }

  #track(mint: string): Track {
    let t = this.#mints.get(mint);
    if (t === undefined) {
      t = { mint, migrationWritten: false, pools: new Map(), buyers: new Map(), devBuySameTx: false, xcheck: new Map() };
      this.#mints.set(mint, t);
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
        if (!this.#books.has(d.pool)) {
          this.#books.set(d.pool, { pool: d.pool, mint: d.baseMint, openedAtMs: atMs, fromSlot: seen.slot, candles: [], partial: false, seen: new Set() });
          this.#reserves.set(d.pool, { atMs, effective: d.poolQuoteAmount });
          this.#writeCandles(d.pool, seen.provider, seen.receivedAt, put);
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

  #swap(ev: Extract<PumpEventData, { name: 'BuyEvent' | 'SellEvent' }>, seen: Seen, put: (k: string, v: unknown) => void): void {
    this.#chainSwap(ev, seen, put);
    const d = ev.data;
    const book = this.#books.get(d.pool);
    const atMs = ms(d.timestamp);
    if (book === undefined || atMs === null) return;
    const virtual = d.virtualQuoteReserves ?? 0n;
    const baseBefore = d.poolBaseTokenReserves;
    const quoteBefore = d.poolQuoteTokenReserves;
    // The same trade from a fetched transaction and from a log line counts once.
    const id = `${seen.signature}:${baseBefore}:${quoteBefore}`;
    if (book.seen.has(id)) return;
    book.seen.add(id);
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
    this.#writeCandles(d.pool, seen.provider, seen.receivedAt, put);
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
      obs: { provider, slot: b.fromSlot, receivedAt, quality: b.partial ? ['partial'] : [], stream: STREAMS.trades(pool), commitment: 'confirmed' },
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
        s = { fromSlot: from, gaps: [], open: new Map(), vias: new Set() };
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
    for (const [name, s] of this.#streams) {
      if (!s.vias.has(via)) continue;
      s.gaps.push({ from: slot, to: slot });
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
    if (c !== undefined && c.lastSlot > slot) return;
    this.#chains.set(fact.address, {
      mint, read: fact, coveredFrom: slot + 1n, lastSlot: slot, readSlot: slot, stale: null, seen: new Set(), applied: new Set(),
      state: { baseReserve: fact.baseVault, quoteVault: fact.quoteVault, virtualQuoteReserves: fact.pool.virtualQuoteReserves ?? 0n },
    });
    put(poolKey(mint), fact);
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
    if (!e.key.startsWith('logs:pump_amm:')) return;
    const v = e.value;
    if (!isObj(v) || v['commitment'] !== 'confirmed' || typeof v['via'] !== 'string' || !v['via'].startsWith('logs:') || typeof v['txSlot'] !== 'bigint') return;
    const name = isObj(v['event']) ? v['event']['name'] : undefined;
    if (name === 'BuyEvent' || name === 'SellEvent') return;
    const c = this.#chains.get(v['via'].slice('logs:'.length));
    if (c === undefined || v['txSlot'] <= c.readSlot) return;
    this.#stale(c, 'gap', `a pool transaction other than a swap (${typeof name === 'string' ? name : 'unnamed'})`, { provider: sourceOf(e), slot: v['txSlot'], receivedAt: e.moment.receivedAt, quality: [], commitment: 'confirmed' }, put);
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
    if (c === undefined || seen.slot <= c.readSlot) return;
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
      // stream has had no gap from this swap's slot on.
      if (older) return;
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

  #resolve(p: Pending, reserveAfter: bigint): void {
    this.#pending.delete(p.pool);
    this.#graduates.push({ mint: p.mint, migratedAtMs: p.migratedAtMs, reserveAfter });
    this.#graduatesChanged = true;
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
      else if (now > mark + this.#o.survivalReadWindowMs) this.#pending.delete(p.pool);
    }
    this.#flushGraduates(e, put);
  }

  #flushGraduates(e: MarketEvent, put: (k: string, v: unknown) => void): void {
    if (!this.#graduatesChanged) return;
    this.#graduatesChanged = false;
    const now = e.moment.receivedAt;
    const keepFrom = now - this.#o.graduatesKeepMs;
    for (let i = this.#graduates.length - 1; i >= 0; i--) if (this.#graduates[i]!.migratedAtMs < keepFrom) this.#graduates.splice(i, 1);
    put(GRADUATES_KEY, {
      obs: { provider: 'facts', slot: null, receivedAt: now, quality: [] },
      items: [...this.#graduates].sort((a, b) => a.migratedAtMs - b.migratedAtMs || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0)),
    });
  }
}
