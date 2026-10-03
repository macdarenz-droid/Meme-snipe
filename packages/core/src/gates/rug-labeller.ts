// RUG-1: as-of rug labels for H14 (docs/DECISIONS.md "Rug labels"). The labeller is fed the market events the engine
// releases, in release order, like the deployer index. A mint becomes a rug at the first released event that meets
// the definition inside its window, and the `rug:<mint>` fact carries that event's moment: before it, the mint is
// not a rug. The labeller holds no clock and reads no store, so it cannot see a later row.
//
// It reads DEC-1's decoded events as FEED-1 emits them (`value.event`), from logs and from fetched transactions. The
// same event can arrive from both: liquidity is a state (a repeat changes nothing) and each creator sale is counted
// once by its content, which no two distinct sales share (a sale moves the reserves it is stamped with).
import type { MarketEvent } from '../engine/feed.ts';
import { NATIVE_MINT, NATIVE_MINT_2022, SYSTEM_PROGRAM } from '../chain/programs.ts';
import type { RugConfig } from '../config/rugs.ts';
import { SECOND_MS } from '../config/time.ts';
import { BPS_DENOMINATOR } from '../units/index.ts';
import { RUG_PREFIX, RUG_UNJUDGED_PREFIX } from './deployer-index.ts';

export type RugRule = 'creator-dump' | 'collapse';

/** The value of a `rug:<mint>` fact. DeployerIndex reads `mint` and `creator`; the rest is the audit trail. */
export interface RugLabel {
  readonly mint: string;
  readonly creator: string;
  readonly rule: RugRule;
  /** Chain time (ms) of the event that met the rule. */
  readonly atMs: number;
  readonly slot: bigint;
  /** The rug config version that made the label. */
  readonly version: string;
  readonly detail: string;
}

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const big = (v: unknown): bigint | null => (typeof v === 'bigint' ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const SOL_QUOTES: ReadonlySet<string> = new Set([SYSTEM_PROGRAM, NATIVE_MINT, NATIVE_MINT_2022]);

interface Launch {
  readonly mint: string;
  readonly creator: string;
  /** The creator and the signer of the create: both sell for the deployer. */
  readonly sellers: ReadonlySet<string>;
  readonly createdAtMs: number;
  /** The canonical pool, once the migration names it. */
  pool: string | null;
  /** Total supply from the create; null when the event did not carry it (the dump rule cannot be judged then). */
  readonly supply: bigint | null;
  sold: bigint;
  readonly sales: Set<string>;
  peak: bigint;
}

/** Chain time in ms of a decoded event's `timestamp` (seconds), or null. */
const timeOf = (d: Obj): number | null => {
  const ts = big(d['timestamp']);
  if (ts === null || ts < 0n) return null;
  const ms = Number(ts) * SECOND_MS;
  return Number.isSafeInteger(ms) ? ms : null;
};

/**
 * The transaction a FEED-1 event came from: logs carry `value.signature`, fetched transactions `ev:<signature>:…` ids.
 * Both copies of one event give the same signature, so two equal sales in different transactions stay two.
 */
const signatureOf = (e: MarketEvent): string => {
  const v = e.value;
  if (isObj(v) && typeof v['signature'] === 'string') return v['signature'];
  return e.id.startsWith('ev:') ? (e.id.split(':')[1] ?? '') : '';
};

export class RugLabeller {
  readonly #config: RugConfig;
  readonly #launches = new Map<string, Launch>();
  /** Canonical pool -> mint, from the migration event (other pools of a mint are not the deployer's). */
  readonly #pools = new Map<string, string>();
  readonly #labelled = new Set<string>();
  /** Mints the dump rule cannot judge, kept while their launch is tracked. */
  readonly #unjudged = new Map<string, string>();

  constructor(config: RugConfig) {
    this.#config = config;
  }

  /** Feed every released market event here, in release order. Returns the rug facts this event made (zero or one). */
  observe(e: MarketEvent): MarketEvent[] {
    const v = e.value;
    if (!isObj(v) || !isObj(v['event'])) return [];
    const ev = v['event'];
    const d = ev['data'];
    if (!isObj(d)) return [];
    const program = ev['program'];
    const name = ev['name'];
    if (program === 'pump') {
      if (name === 'CreateEvent') return this.#create(e, d);
      else if (name === 'TradeEvent') return this.#curveTrade(e, d);
      else if (name === 'CompletePumpAmmMigrationEvent') this.#migration(d);
    } else if (program === 'pump_amm' && (name === 'SellEvent' || name === 'BuyEvent')) {
      return this.#poolTrade(e, d, name === 'SellEvent');
    }
    return [];
  }

  /** Entries held in memory, per table. */
  get tracked(): { readonly launches: number; readonly pools: number; readonly labelled: number; readonly unjudged: number } {
    return { launches: this.#launches.size, pools: this.#pools.size, labelled: this.#labelled.size, unjudged: this.#unjudged.size };
  }

  /** Mints the dump rule could not judge, with the reason (logged with H14's evidence). */
  get unjudged(): ReadonlyMap<string, string> {
    return this.#unjudged;
  }

  #create(e: MarketEvent, d: Obj): MarketEvent[] {
    const mint = str(d['mint']);
    const creator = str(d['creator']);
    const createdAtMs = timeOf(d);
    if (mint === null || creator === null || createdAtMs === null || this.#launches.has(mint)) return [];
    // Launches are kept in arrival order. One whose windows ended a full window before this launch can no longer be
    // labelled (chain times run in release order to within seconds), so it is dropped: memory stays bounded.
    const horizon = Math.max(this.#config.creatorDump.windowMs, this.#config.collapse.windowMs);
    for (const [old, l] of this.#launches) {
      if (l.createdAtMs + 2 * horizon >= createdAtMs) break;
      this.#launches.delete(old);
      this.#labelled.delete(old);
      this.#unjudged.delete(old);
      if (l.pool !== null) this.#pools.delete(l.pool);
    }
    const user = str(d['user']);
    const supply = big(d['tokenTotalSupply']);
    const usable = supply !== null && supply > 0n ? supply : null;
    this.#launches.set(mint, {
      mint, creator, sellers: new Set(user === null ? [creator] : [creator, user]), createdAtMs, pool: null, supply: usable,
      sold: 0n, sales: new Set(), peak: 0n,
    });
    if (usable !== null) return [];
    // Not judged is not "not a rug": the fact makes H14 uncovered for this deployer (RUG-1 review).
    const reason = 'the create carries no total supply';
    this.#unjudged.set(mint, reason);
    const key = `${RUG_UNJUDGED_PREFIX}${mint}`;
    return [{ kind: 'market', id: key, moment: e.moment, key, value: { mint, creator, reason, version: this.#config.version } }];
  }

  #migration(d: Obj): void {
    const mint = str(d['mint']);
    const pool = str(d['pool']);
    const l = mint === null ? undefined : this.#launches.get(mint);
    if (l === undefined || pool === null || l.pool !== null) return;
    l.pool = pool;
    this.#pools.set(pool, l.mint);
  }

  #curveTrade(e: MarketEvent, d: Obj): MarketEvent[] {
    const sig = signatureOf(e);
    const l = this.#open(str(d['mint']));
    const at = timeOf(d);
    if (l === null || at === null) return [];
    const quoteMint = str(d['quoteMint']);
    // TradeEvent reserves are post-trade. A curve quoted in another mint keeps its reserves in the quote fields.
    const liquidity = big(quoteMint === null || SOL_QUOTES.has(quoteMint) ? d['realSolReserves'] : d['realQuoteReserves']);
    const user = str(d['user']);
    const amount = big(d['tokenAmount']);
    const sale = d['isBuy'] === false && user !== null && amount !== null
      ? { user, amount, id: `curve|${sig}|${user}|${amount}|${String(d['solAmount'])}|${String(d['virtualSolReserves'])}|${String(d['virtualTokenReserves'])}|${at}` }
      : null;
    return this.#judge(e, l, at, liquidity === null ? [] : [liquidity], sale);
  }

  #poolTrade(e: MarketEvent, d: Obj, sell: boolean): MarketEvent[] {
    const sig = signatureOf(e);
    const pool = str(d['pool']);
    const l = this.#open(pool === null ? null : (this.#pools.get(pool) ?? null));
    const at = timeOf(d);
    if (l === null || at === null) return [];
    // Buy/SellEvent reserves are pre-trade. Liquidity is the effective quote reserve (vault + signed virtual), the
    // one that prices trades; after a sale it is that less the quote paid out of the curve, the LP fee staying in.
    const vault = big(d['poolQuoteTokenReserves']);
    const virtual = big(d['virtualQuoteReserves']) ?? 0n;
    const levels: bigint[] = [];
    if (vault !== null) {
      levels.push(vault + virtual);
      const out = big(d['quoteAmountOut']);
      const lp = big(d['lpFee']);
      if (sell && out !== null && lp !== null) levels.push(vault + virtual - out + lp);
    }
    const user = str(d['user']);
    const amount = big(d['baseAmountIn']);
    const sale = sell && user !== null && amount !== null
      ? { user, amount, id: `pool|${sig}|${pool}|${user}|${amount}|${String(d['quoteAmountOut'])}|${String(vault)}|${String(d['poolBaseTokenReserves'])}|${at}` }
      : null;
    return this.#judge(e, l, at, levels, sale);
  }

  /** The launch of a mint that is tracked and not yet labelled. */
  #open(mint: string | null): Launch | null {
    if (mint === null || this.#labelled.has(mint)) return null;
    return this.#launches.get(mint) ?? null;
  }

  #judge(e: MarketEvent, l: Launch, at: number, levels: readonly bigint[], sale: { user: string; amount: bigint; id: string } | null): MarketEvent[] {
    const age = at - l.createdAtMs;
    const { creatorDump, collapse } = this.#config;
    if (sale !== null && l.sellers.has(sale.user) && !l.sales.has(sale.id)) {
      l.sales.add(sale.id);
      l.sold += sale.amount;
      if (l.supply !== null && age <= creatorDump.windowMs && l.sold * BPS_DENOMINATOR >= l.supply * BigInt(creatorDump.supplyBps)) {
        return this.#label(e, l, at, 'creator-dump', `the deployer sold ${l.sold} of ${l.supply} tokens within ${age} ms of launch`);
      }
    }
    for (const level of levels) {
      if (level > l.peak) l.peak = level;
      if (l.peak > 0n && age <= collapse.windowMs && level * BPS_DENOMINATOR <= l.peak * (BPS_DENOMINATOR - BigInt(collapse.dropBps))) {
        return this.#label(e, l, at, 'collapse', `quote liquidity ${level} after a peak of ${l.peak}, within ${age} ms of launch`);
      }
    }
    return [];
  }

  #label(e: MarketEvent, l: Launch, atMs: number, rule: RugRule, detail: string): MarketEvent[] {
    this.#labelled.add(l.mint);
    const value: RugLabel = { mint: l.mint, creator: l.creator, rule, atMs, slot: e.moment.slot, version: this.#config.version, detail };
    return [{ kind: 'market', id: `${RUG_PREFIX}${l.mint}`, moment: e.moment, key: `${RUG_PREFIX}${l.mint}`, value }];
  }

  /** PERSIST-1: the labeller's tables, for a restart without a re-read of every tracked launch's trades. */
  snapshot(): RugLabellerState {
    const byKey = <T>(xs: T[], k: (x: T) => string) => xs.sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
    return {
      version: this.#config.version,
      // Arrival order is kept: the drop of old launches walks the table from the oldest.
      launches: [...this.#launches.values()].map((l) => ({
        mint: l.mint, creator: l.creator, sellers: [...l.sellers].sort(), createdAtMs: l.createdAtMs, pool: l.pool, supply: l.supply,
        sold: l.sold, sales: [...l.sales].sort(), peak: l.peak,
      })),
      pools: byKey([...this.#pools], ([p]) => p),
      labelled: [...this.#labelled].sort(),
      unjudged: byKey([...this.#unjudged], ([m]) => m),
    };
  }

  /**
   * PERSIST-1: a labeller restored from `snapshot`. A state written under another rug config version is refused (its
   * running sums were judged by other rules), as is a malformed one; the caller then discards the file.
   */
  static restore(config: RugConfig, s: RugLabellerState): RugLabeller {
    if (s.version !== config.version) throw new RangeError(`saved labeller state is ${String(s.version)}, the config is ${config.version}`);
    const r = new RugLabeller(config);
    const nat = (v: unknown, what: string): bigint => {
      if (typeof v !== 'bigint' || v < 0n) throw new RangeError(`bad ${what}`);
      return v;
    };
    const strs = (v: unknown, what: string): string[] => {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new RangeError(`bad ${what}`);
      return v as string[];
    };
    if (!Array.isArray(s.launches)) throw new RangeError('bad launches');
    for (const l of s.launches as unknown[]) {
      if (!isObj(l) || typeof l['mint'] !== 'string' || typeof l['creator'] !== 'string' || !Number.isSafeInteger(l['createdAtMs'])) throw new RangeError('bad launch');
      if (l['pool'] !== null && typeof l['pool'] !== 'string') throw new RangeError('bad launch pool');
      r.#launches.set(l['mint'], {
        mint: l['mint'], creator: l['creator'], sellers: new Set(strs(l['sellers'], 'sellers')), createdAtMs: l['createdAtMs'] as number,
        pool: l['pool'] as string | null, supply: l['supply'] === null ? null : nat(l['supply'], 'supply'), sold: nat(l['sold'], 'sold'),
        sales: new Set(strs(l['sales'], 'sales')), peak: nat(l['peak'], 'peak'),
      });
    }
    if (!Array.isArray(s.pools) || !Array.isArray(s.unjudged)) throw new RangeError('bad tables');
    for (const p of s.pools as unknown[]) {
      if (!Array.isArray(p) || typeof p[0] !== 'string' || typeof p[1] !== 'string') throw new RangeError('bad pool row');
      r.#pools.set(p[0], p[1]);
    }
    for (const m of strs(s.labelled, 'labelled')) r.#labelled.add(m);
    for (const u of s.unjudged as unknown[]) {
      if (!Array.isArray(u) || typeof u[0] !== 'string' || typeof u[1] !== 'string') throw new RangeError('bad unjudged row');
      r.#unjudged.set(u[0], u[1]);
    }
    return r;
  }
}

/** The labeller's saved tables (PERSIST-1): public chain data and our own labels only. */
export interface RugLabellerState {
  readonly version: string;
  readonly launches: readonly {
    readonly mint: string; readonly creator: string; readonly sellers: readonly string[]; readonly createdAtMs: number;
    readonly pool: string | null; readonly supply: bigint | null; readonly sold: bigint; readonly sales: readonly string[]; readonly peak: bigint;
  }[];
  readonly pools: readonly (readonly [string, string])[];
  readonly labelled: readonly string[];
  readonly unjudged: readonly (readonly [string, string])[];
}
