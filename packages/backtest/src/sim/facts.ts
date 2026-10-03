// Historical gate facts (BT-2, docs/ARCHITECTURE.md §16.3): the backtest feed's equivalent of FEED-1's live reads.
// It sees dataset rows only as they are released, in chain order, so every fact it builds is as of that moment, and
// it builds the gate facts of a mint only at a check moment: the values a live account read would return then.
//
// It also feeds the deployer index and RUG-1's labeller the way WORKER-1 does live (docs/DECISIONS.md "Rug labels",
// wiring must-haves): every create goes to the engine as a confirmed create event, curve and pool trades go to the
// labeller, and its labels go to the engine at the moment of the event that made them. Rug coverage follows the
// trade stream: the dataset holds trades only for its hash sample, so every create outside the sample is marked
// `rug-unjudged` and H14 is not covered for that deployer, never "no rugs".
import { createHash } from 'node:crypto';
import {
  type Address, addressBytes, decodeBase58, findProgramAddress, NATIVE_MINT, PUMP_AMM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, toAddress,
} from '../../../core/src/chain/index.ts';
import type { FeedEvent, MarketEvent, Moment } from '../../../core/src/engine/index.ts';
import {
  type Candle, type FactObs, type HolderAccount, type Price, GRADUATES_KEY, parseGraduates, RUG_UNJUDGED_PREFIX, RugLabeller, SOL_USD_KEY, TX_CREATE_PREFIX, candlesKey, coverageKeys,
  createKey, holdersKey, insidersKey, lpKey, migrationKey, mintKey, poolKey,
} from '../../../core/src/gates/index.ts';
import type { RugConfig } from '../../../core/src/config/index.ts';
import { MINUTE_MS } from '../../../core/src/config/index.ts';
import { solPriceMicroUsd } from '../../../core/src/units/index.ts';
import type { SeriesBar } from '../dataset/offchain.ts';
import type { RawRow } from '../dataset/raw.ts';
import type { AmmSwapRow, CurveTradeRow, DatasetRow, EventRow } from '../dataset/rows.ts';
import type { PoolView } from './market.ts';
import { SignalTracker } from '../research/tracker.ts';
import { FactProducer, type ProducerOptions } from '../../../core/src/facts/index.ts';
import { landings, type ReadLatency } from '../study/reads.ts';

export const ATA_PROGRAM = toAddress('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** The associated token account of `owner` for `mint` under `tokenProgram`. PumpSwap pool vaults are these. */
export const associatedTokenAddress = (owner: string, mint: string, tokenProgram: string): string =>
  findProgramAddress([addressBytes(toAddress(owner)), addressBytes(toAddress(tokenProgram)), addressBytes(toAddress(mint))], ATA_PROGRAM).address;

/** DATA-1's sampling hash: first 8 bytes of sha256(mint bytes), big-endian, over 2^64 (scanner sample.go). Null: not an address. */
/** The tie-break key of a check: sha256 of the salt, universe and mint (hex, compared as text). */
export const tieHash = (salt: string, universe: string, mint: string): string => createHash('sha256').update(`${salt}|${universe}|${mint}`).digest('hex');

/** The key of a check's stage-2/3 reads landing (FACTS-1 staging). */
export const LANDED_PREFIX = 'landed:';

/** The fact key of RES-3's features released with a check. */
export const featuresKey = (mint: string): string => `features:${mint}`;

export const mintHashFraction = (mint: string): number | null => {
  let b: Uint8Array;
  try {
    b = decodeBase58(mint);
  } catch {
    return null;
  }
  if (b.length !== 32) return null;
  const h = createHash('sha256').update(b).digest();
  return Number(h.readBigUInt64BE(0)) / 2 ** 64;
};

/** How the backtest checks a universe: from `fromMs` to `toMs` after migration, every `everyMs`. */
export interface CheckWindow {
  readonly universe: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly everyMs: number;
  /** Least effective quote reserve (lamports) for a check to be scheduled; a pool below it is skipped at that check. */
  readonly minQuoteLamports: bigint;
}

export interface FactOptions {
  /** The dataset's launch-sample rate (manifest `sampling.launch_rate`); null when the manifest does not say. */
  readonly sampleRate: number | null;
  readonly rugs: RugConfig;
  readonly windows: readonly CheckWindow[];
  /**
   * Salt of the tie-break between checks due at the same block (consensus of the three reviews, 2026-10-04): fixed and
   * recorded in the study configuration before any replay, so no ordering can be tuned on outcomes.
   */
  readonly tieSalt: string;
  /** Hourly SOL/USD releases (usable moment and bar), in order. */
  readonly solUsd: readonly { readonly at: number; readonly bar: SeriesBar }[];
  /** SOL/USD points carried in a fact (enough for a 24 h change). */
  readonly solUsdPoints: number;
  /** Candles kept per mint: the first `candlesHead` after migration and the latest `candlesTail`. */
  readonly candlesHead: number;
  readonly candlesTail: number;
  /**
   * Deployer-funded wallets and the dev's linked cluster per mint, from a funding backfill (first funding transaction
   * of the dev and first 20 buyers, §16.3). Each list is dated when it was complete; before that, or without a
   * source, the insiders fact is incomplete and H13 rejects.
   */
  /**
   * The pool account as allocated at creation (ARCHITECTURE §16 table: H17's backtest source is DATA-1's record of
   * it): data length, cashback flag and coin creator, known from `knownAtMs`. Without it those fields stay absent and
   * H17 rejects through H16 (missing), the safe failure. A coin creator in the CreatePoolEvent is used when present.
   */
  /**
   * The dataset keeps every Approve/ApproveChecked/Revoke/SetAuthority transaction on tracked mints' token accounts
   * (DATA-1). Until it does, delegates can be missed, which is the permissive direction (live reads them directly),
   * so every holder read is marked partial and H12 is "not covered" (supervisor ruling, 2026-10-04). Default false.
   */
  readonly delegatesComplete?: boolean;
  /**
   * Run RES-3's as-of signal tracker on the same rows (feed side, in chain order) and release its features with each
   * check, for configurations with a feature rule. Off by default.
   */
  readonly features?: boolean;
  /**
   * FACTS-1 staging: when a check's stage-2 answers (accounts, cross-checks) and stage-3 answers (the complete holder
   * scan, funders) land. The projector releases the facts as of each landing; the strategy decides on them then.
   * Absent: both land at the check (tests only; study runs pass READ_LATENCY).
   */
  readonly readLatency?: ReadLatency;
  /**
   * Graduate survival for the regime gate (§6.4), produced by FACTS-1's own producer (supervisor ruling: one source,
   * never a copy): it is fed the dataset's curve completions, migrations and pool creations, each pool's swaps up to
   * its survival mark, and the slot notices; only its graduates fact is released. Off when absent.
   */
  readonly survival?: ProducerOptions;
  readonly poolAccounts?: (pool: string) => { readonly knownAtMs: number; readonly accountBytes: number; readonly isCashbackCoin: boolean; readonly coinCreator: string } | null;
  readonly insiders?: (mint: string) => { readonly knownAtMs: number; readonly funded: readonly string[]; readonly devCluster: readonly string[] } | null;
  /**
   * When trade rows begin (ms): an assembled window's lead-in days carry events, stats and blocks only (DATA-1). Rug
   * coverage starts there, and a launch created before it is unjudged (its trades are not in the dataset). Default:
   * trades from the first row.
   */
  readonly tradesFromMs?: number;
  /** Slot ranges the dataset did not scan (manifest `coverage_gaps`, "from-to"). */
  readonly gaps?: readonly { readonly fromSlot: bigint; readonly toSlot: bigint }[];
}

const PROVIDER = 'dataset';
/** A launch that has not graduated after this long is dropped (H9 needs its create only if it graduates). */
export const UNGRADUATED_KEEP_MS = 7 * 24 * 3_600_000;
const SYSTEM = '11111111111111111111111111111111';
const NUM = /^-?\d+$/;
/** Text fields that may look like numbers but are never amounts. */
const TEXT = new Set(['name', 'symbol', 'uri']);
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** A dataset event's fields as DEC-1 decodes them: camelCase keys, integers as bigint, flags as booleans. */
const decoded = (fields: Readonly<Record<string, string>>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[camel(k)] = TEXT.has(k) ? v : NUM.test(v) ? BigInt(v) : v === 'true' ? true : v === 'false' ? false : v;
  }
  return out;
};

const seconds = (row: { readonly blockTime: number }, ts: unknown): bigint => (typeof ts === 'bigint' ? ts : BigInt(row.blockTime));

interface SurvivalTrack {
  readonly producer: FactProducer;
  pool: string | null;
  markMs: number | null;
  done: boolean;
}

interface MintState {
  readonly mint: string;
  sampled: boolean;
  create: { createdAtMs: number; creator: string; user: string | null; supply: bigint | null; tokenProgram: string | null; slot: bigint; receivedAt: number; signature: string } | null;
  graduatedAtMs: number | null;
  migration: { migratedAtMs: number; pool: string; sol: bigint; tokens: bigint; slot: bigint; receivedAt: number; signature: string } | null;
  pool: { address: string; index: number; creator: string; quoteMint: string; lpMint: string; mayhem: boolean | undefined; coinCreator: string | undefined; signature: string } | null;
  lp: { supply: bigint; known: boolean; minted: bigint; burned: bigint };
  account: { owner: string; mintAuthority: string | null; freezeAuthority: string | null; extensions: { kind: string; type: number; state?: string }[] } | null;
  /** Extensions set up before InitializeMint (fixed-size ones must be). */
  pendingExt: { kind: string; type: number; state?: string }[];
  /** Token accounts of the mint, tracked from the create on; null until the create's raw record is seen. */
  holders: Map<string, { owner: string; amount: bigint; delegate: string | null; delegated: bigint }> | null;
  supply: bigint;
  /** Why the holder rebuild cannot be trusted any more (first problem seen). */
  holderProblem: string | null;
  candlesHead: Candle[];
  candlesTail: Candle[];
  creationBuyers: Set<string>;
  view: PoolView | null;
  checks: Map<string, number>;
  checkSeq: number;
  /** A pool trade event since migration was released (H5 needs one). */
  tailSeen: boolean;
}

const priceOf = (v: PoolView): Price | null => {
  const quote = v.quoteVault + v.virtualQuoteReserves;
  return quote > 0n && v.baseReserve > 0n ? { quote, base: v.baseReserve } : null;
};
const above = (a: Price, b: Price) => a.quote * b.base > b.quote * a.base;

export class FactProjector {
  readonly #o: FactOptions;
  readonly #mints = new Map<string, MintState>();
  readonly #lpMints = new Map<string, string>();
  readonly #poolMints = new Map<string, string>();
  readonly #labeller: RugLabeller;
  readonly #due = new Set<string>();
  /** Sampled mints with a migration: the only ones a check can be scheduled for. */
  readonly #graduates = new Set<string>();
  #started = false;
  #rugsStarted = false;
  #prunedAt = Number.MIN_SAFE_INTEGER;
  #height = 0n;
  #gapAt = 0;
  #solAt = 0;
  readonly #solPoints: { tMs: number; price: bigint }[] = [];
  readonly #tracker: SignalTracker | null;
  /** Graduating mints whose survival mark is not resolved yet, each with its own FACTS-1 producer. */
  readonly #survivalTracks = new Map<string, SurvivalTrack>();
  readonly #survivalPools = new Map<string, string>();
  readonly #graduateItems: { mint: string; migratedAtMs: number; reserveAfter: bigint }[] = [];
  #survivalSeq = 0;
  /** Stage-2/3 reads in flight, oldest landing first (one latency for all, so arrival order is ask order). */
  readonly #reads: { atMs: number; mint: string; universe: string; n: number; stage: 2 | 3 }[] = [];
  #readSeq = 0;
  /** Counts for the report: rows seen by kind and problems by cause (no outcomes). */
  readonly counts = { creates: 0, sampledCreates: 0, unjudged: 0, labels: 0, checks: 0, holderProblems: 0, undecodableRaw: 0 };

  constructor(o: FactOptions) {
    this.#o = o;
    this.#labeller = new RugLabeller(o.rugs);
    // SOL/USD for the tracker: the latest hourly close usable at the moment asked (the same points the gates see).
    this.#tracker = o.features === true ? new SignalTracker({
      solUsd: (ms) => {
        const p = this.#solPoints.filter((x) => x.tMs <= ms).at(-1);
        return p === undefined ? null : Number(p.price) / 1e6;
      },
    }) : null;
  }

  /** In the dataset's sample: its trades and raw records are recorded, so it can be judged and traded. */
  sampled(mint: string): boolean {
    const h = mintHashFraction(mint);
    return h !== null && this.#o.sampleRate !== null && h < this.#o.sampleRate;
  }

  /** State of a sampled mint (created on first sight); null for a mint outside the sample, which keeps none. */
  #state(mint: string): MintState | null {
    let s = this.#mints.get(mint);
    if (s === undefined) {
      if (!this.sampled(mint)) return null;
      s = {
        mint, sampled: true, create: null, graduatedAtMs: null, migration: null, pool: null,
        lp: { supply: 0n, known: false, minted: 0n, burned: 0n }, account: null, pendingExt: [], holders: null, supply: 0n, holderProblem: null,
        candlesHead: [], candlesTail: [], creationBuyers: new Set(), view: null, checks: new Map(), checkSeq: 0, tailSeen: false,
      };
      this.#mints.set(mint, s);
    }
    return s;
  }

  /** Mints the projector tracks (for tests and the report). */
  state(mint: string): Readonly<MintState> | undefined {
    return this.#mints.get(mint);
  }

  /** Events this row releases besides the market's own, all at the row's moment. */
  observe(row: DatasetRow, m: Moment, blockHeight: bigint): FeedEvent[] {
    this.#height = blockHeight;
    if (row.kind !== 'raw') this.#tracker?.push(row);
    const out: FeedEvent[] = [];
    if (!this.#started) {
      this.#started = true;
      out.push(this.#fact('cov:creates:start', m, coverageKeys('creates').start, { via: PROVIDER, fromSlot: row.slot }));
    }
    if (!this.#rugsStarted && m.receivedAt >= (this.#o.tradesFromMs ?? Number.MIN_SAFE_INTEGER)) {
      this.#rugsStarted = true;
      out.push(this.#fact('cov:rugs:start', m, coverageKeys('rugs').start, { via: PROVIDER, fromSlot: row.slot }));
    }
    switch (row.kind) {
      case 'event':
        this.#event(row, m, out);
        break;
      case 'curve':
        this.#curve(row, m, out);
        break;
      case 'amm':
        this.#ammTrade(row, m, out);
        break;
      case 'raw':
        this.#raw(row);
        break;
      case 'block':
        this.#block(row.slot, row.blockTime * 1000, m, out);
        break;
    }
    if (this.#o.survival !== undefined) this.#feedSurvival(row, m, out);
    return out;
  }

  /**
   * Graduate survival, dated by FACTS-1's own producer (its rule, never a copy). One producer per graduating mint, fed
   * that mint's completion, migration and pool creation, the pool's swaps up to its mark, and slot notices once the
   * mark has passed; it is dropped when the mark resolves or its read window ends. One producer for the whole run would
   * scan every pool's stream on every slot notice (about 94k pools over 16M slots in a 74-day run). The resolved items
   * are kept for the producer's own window (`graduatesKeepMs`) and released as one graduates fact, as FACTS-1 does.
   */
  #feedSurvival(row: DatasetRow, m: Moment, out: FeedEvent[]): void {
    const o = this.#o.survival!;
    const ev = (key: string, value: unknown): MarketEvent => ({ kind: 'market', id: `sv:${this.#survivalSeq++}`, moment: m, key, value });
    // As a fetched transaction (DEC-1's located event carries its signature): confirmed, as the dataset is.
    const program = (programName: string, name: string, data: Record<string, unknown>): MarketEvent =>
      ev('survival:event', { event: { program: programName, name, data, signature: (row as { signature?: string }).signature ?? '' }, txSlot: row.slot, source: PROVIDER });
    const now = m.receivedAt;
    let changed = false;
    const run = (s: SurvivalTrack, e: MarketEvent): void => {
      for (const w of s.producer.observe(e)) {
        if (w.key !== GRADUATES_KEY) continue;
        const g = parseGraduates(w.value);
        for (const item of g?.items ?? []) {
          this.#graduateItems.push(item);
          changed = true;
        }
        s.done = true;
      }
    };
    if (row.kind === 'event' && ['CompleteEvent', 'CompletePumpAmmMigrationEvent', 'CreatePoolEvent'].includes(row.event)) {
      const d = decoded(row.fields);
      const data = { ...d, timestamp: seconds(row, d['timestamp']) };
      const mint = (row.event === 'CreatePoolEvent' ? d['baseMint'] : d['mint']) as string | undefined;
      if (typeof mint !== 'string') return;
      let s = this.#survivalTracks.get(mint);
      if (s === undefined) {
        if (row.event !== 'CompleteEvent') return;
        s = { producer: new FactProducer(o), pool: null, markMs: null, done: false };
        this.#survivalTracks.set(mint, s);
      }
      if (row.event === 'CreatePoolEvent' && typeof d['pool'] === 'string' && s.pool === null) {
        s.pool = d['pool'];
        s.markMs = row.blockTime * 1000 + o.survivalAfterMs;
        this.#survivalPools.set(d['pool'], mint);
        // The dataset keeps every trade of a canonical pool from its creation (retention canonical-all).
        run(s, ev(`coverage:trades:${d['pool']}:start`, { via: PROVIDER, fromSlot: row.slot }));
      }
      run(s, program(row.program === 'amm' || row.program === 'pump_amm' ? 'pump_amm' : row.program, row.event, data));
    } else if (row.kind === 'amm') {
      const mint = this.#survivalPools.get(row.pool);
      const s = mint === undefined ? undefined : this.#survivalTracks.get(mint);
      if (s !== undefined && s.markMs !== null && row.blockTime * 1000 <= s.markMs) {
        const base = { pool: row.pool, timestamp: BigInt(row.blockTime), poolBaseTokenReserves: row.pre.baseReserve, poolQuoteTokenReserves: row.pre.quoteVault, virtualQuoteReserves: row.pre.virtualQuoteReserves };
        run(s, row.side === 'buy'
          ? program('pump_amm', 'BuyEvent', { ...base, baseAmountOut: row.baseAmount, quoteAmountInWithLpFee: row.quoteLpAdjusted })
          : program('pump_amm', 'SellEvent', { ...base, baseAmountIn: row.baseAmount, quoteAmountOutWithoutLpFee: row.quoteLpAdjusted }));
      }
    } else if (row.kind === 'block') {
      for (const [mint, s] of this.#survivalTracks) {
        if (s.markMs === null) {
          // A completion with no pool creation within a day never graduates here.
          if (now - (this.#mints.get(mint)?.graduatedAtMs ?? now) > 86_400_000) this.#survivalTracks.delete(mint);
          continue;
        }
        if (now < s.markMs) continue;
        // Past the mark: a slot notice moves the producer's head, a second one lets it judge the mark on that head.
        run(s, ev('chain:slot', { slot: row.slot }));
        if (!s.done) run(s, ev('chain:slot', { slot: row.slot }));
        if (s.done || now > s.markMs + o.survivalReadWindowMs) {
          this.#survivalTracks.delete(mint);
          if (s.pool !== null) this.#survivalPools.delete(s.pool);
        }
      }
    }
    if (changed) {
      const keepFrom = now - o.graduatesKeepMs;
      for (let i = this.#graduateItems.length - 1; i >= 0; i--) if (this.#graduateItems[i]!.migratedAtMs < keepFrom) this.#graduateItems.splice(i, 1);
      out.push(this.#fact(`gr:${row.slot}:${this.#survivalSeq++}`, m, GRADUATES_KEY, {
        obs: { provider: 'facts', slot: null, receivedAt: now, quality: [] },
        items: [...this.#graduateItems].sort((x, y) => x.migratedAtMs - y.migratedAtMs || (x.mint < y.mint ? -1 : x.mint > y.mint ? 1 : 0)),
      }));
    }
  }


  #fact(id: string, m: Moment, key: string, value: unknown): MarketEvent {
    return { kind: 'market', id, moment: m, key, value };
  }

  #label(events: readonly MarketEvent[], m: Moment, out: FeedEvent[]): void {
    for (const e of events) {
      if (e.key.startsWith(RUG_UNJUDGED_PREFIX)) this.counts.unjudged++;
      else this.counts.labels++;
      out.push({ ...e, moment: m });
    }
  }

  #event(row: EventRow, m: Moment, out: FeedEvent[]): void {
    const f = row.fields;
    const d = decoded(f);
    const name = row.event;
    const program = row.program === 'amm' || row.program === 'pump_amm' ? 'pump_amm' : row.program;
    const wrap = { event: { program, name, data: { ...d, timestamp: seconds(row, d['timestamp']) } }, signature: row.signature, txSlot: row.slot, source: PROVIDER };
    if (name === 'CreateEvent' && f['mint'] && f['creator']) {
      this.counts.creates++;
      // The deployer index reads every create; a dataset create is a finalized transaction.
      out.push(this.#fact(`cr:${row.signature}:${row.evIdx}`, m, `${TX_CREATE_PREFIX}${f['mint']}`, wrap));
      const quote = f['quote_mint'];
      const solQuote = quote === undefined || quote === '' || quote === SYSTEM || quote === NATIVE_MINT;
      const leadIn = m.receivedAt < (this.#o.tradesFromMs ?? Number.MIN_SAFE_INTEGER);
      const s = solQuote ? this.#state(f['mint']) : null;
      if (s !== null) {
        const supply = typeof d['tokenTotalSupply'] === 'bigint' && d['tokenTotalSupply'] > 0n ? d['tokenTotalSupply'] : null;
        s.create = {
          createdAtMs: Number(seconds(row, d['timestamp'])) * 1000, creator: f['creator'], user: f['user'] ?? null, supply,
          tokenProgram: f['token_program'] ?? null, slot: row.slot, receivedAt: m.receivedAt, signature: row.signature,
        };
        this.counts.sampledCreates++;
      }
      if (s !== null && !leadIn) {
        this.#label(this.#labeller.observe({ kind: 'market', id: `ev:${row.signature}:${row.evIdx}`, moment: m, key: 'pump', value: wrap }), m, out);
        return;
      }
      // Not judged is not "not a rug" (RUG-1): outside the sample its trades are not recorded; on a lead-in day they are
      // not in the window; a curve quoted in another mint carries its liquidity in fields the curve rows do not keep.
      this.counts.unjudged++;
      const key = `${RUG_UNJUDGED_PREFIX}${f['mint']}`;
      const reason = leadIn ? 'created on a lead-in day: its trades are not in this dataset window'
        : !solQuote ? 'curve quoted in another mint: its liquidity is not in the curve rows'
        : this.#o.sampleRate === null ? 'the dataset does not state its sample rate' : 'outside the dataset sample: its trades are not recorded';
      out.push(this.#fact(key, m, key, { mint: f['mint'], creator: f['creator'], reason, version: this.#o.rugs.version }));
      return;
    }
    if (name === 'CompleteEvent' && f['mint']) {
      const s = this.#state(f['mint']);
      if (s !== null) s.graduatedAtMs ??= Number(seconds(row, d['timestamp'])) * 1000;
      return;
    }
    if (name === 'CompletePumpAmmMigrationEvent' && f['mint'] && f['pool']) {
      const s = this.#state(f['mint']);
      if (s === null) return;
      if (s.migration === null && typeof d['solAmount'] === 'bigint' && typeof d['mintAmount'] === 'bigint') {
        s.migration = { migratedAtMs: Number(seconds(row, d['timestamp'])) * 1000, pool: f['pool'], sol: d['solAmount'], tokens: d['mintAmount'], slot: row.slot, receivedAt: m.receivedAt, signature: row.signature };
        this.#poolMints.set(f['pool'], f['mint']);
        this.#graduates.add(f['mint']);
      }
      this.#label(this.#labeller.observe({ kind: 'market', id: `ev:${row.signature}:${row.evIdx}`, moment: m, key: 'pump', value: wrap }), m, out);
      return;
    }
    if (name === 'CreatePoolEvent' && f['pool'] && f['base_mint'] && f['lp_mint']) {
      const s = this.#state(f['base_mint']);
      if (s !== null && s.pool === null) {
        const mayhem = f['is_mayhem_mode'] === 'true' ? true : f['is_mayhem_mode'] === 'false' ? false : undefined;
        s.pool = { address: f['pool'], index: Number(f['index'] ?? '-1'), creator: f['creator'] ?? '', quoteMint: f['quote_mint'] ?? '', lpMint: f['lp_mint'], mayhem, coinCreator: f['coin_creator'] || undefined, signature: row.signature };
        this.#lpMints.set(f['lp_mint'], f['base_mint']);
      }
      return;
    }
    if ((name === 'DepositEvent' || name === 'WithdrawEvent') && f['pool'] && typeof d['lpMintSupply'] === 'bigint') {
      const mint = this.#poolMints.get(f['pool']);
      const s = mint === undefined ? undefined : this.#mints.get(mint);
      if (s !== undefined && s.pool?.address === f['pool']) s.lp = { ...s.lp, supply: d['lpMintSupply'], known: true };
    }
  }

  /**
   * The trade event as FEED-1 keys it, with its tail, for H5 (GATE-1c). The check rejects any event whose tail is
   * not empty before the 2026-10-02 upgrade or not 8 zero bytes after it, needs at least one pool event since
   * migration, and passes a curve with no events. So the feed releases a pool's first event since migration and
   * every event that carries a tail (the only ones that can fail): the check sees the same answer as with every
   * event, and the store does not hold millions of empty tails. Only the fields the check reads are kept.
   */
  #tail(id: string, key: string, row: { readonly slot: bigint; readonly signature: string; readonly extraHex: string }, m: Moment, out: FeedEvent[]): void {
    out.push(this.#fact(id, m, key, { event: { trailing: row.extraHex.length / 2, extra: row.extraHex }, txSlot: row.slot, signature: row.signature }));
  }

  #curve(row: CurveTradeRow, m: Moment, out: FeedEvent[]): void {
    const s = this.#mints.get(row.mint);
    if (s === undefined) return;
    if (row.extraHex !== '') this.#tail(`te:${row.signature}:${row.evIdx}`, `pump:TradeEvent:${row.mint}`, row, m, out);
    if (s.create !== null && row.slot <= s.create.slot + 2n && row.isBuy) s.creationBuyers.add(row.user);
    const data = {
      mint: row.mint, solAmount: row.solAmount, tokenAmount: row.tokenAmount, isBuy: row.isBuy, user: row.user, timestamp: BigInt(row.blockTime),
      virtualSolReserves: row.virtualSolReserves, virtualTokenReserves: row.virtualTokenReserves, realSolReserves: row.realSolReserves,
      realTokenReserves: row.realTokenReserves, quoteMint: row.quoteMint === SYSTEM ? NATIVE_MINT : row.quoteMint, realQuoteReserves: row.realSolReserves,
    };
    this.#label(this.#labeller.observe({ kind: 'market', id: `ev:${row.signature}:${row.evIdx}`, moment: m, key: 'pump', value: { event: { program: 'pump', name: 'TradeEvent', data }, signature: row.signature } }), m, out);
  }

  #ammTrade(row: AmmSwapRow, m: Moment, out: FeedEvent[]): void {
    const s = this.#mints.get(row.baseMint);
    if (s === undefined || !s.sampled) return;
    const sell = row.side === 'sell';
    if (s.migration?.pool === row.pool && (!s.tailSeen || row.extraHex !== '')) {
      s.tailSeen = true;
      this.#tail(`te:${row.signature}:${row.evIdx}`, `pump_amm:${sell ? 'SellEvent' : 'BuyEvent'}:${row.pool}`, row, m, out);
    }
    const data = {
      pool: row.pool, user: row.user, timestamp: BigInt(row.blockTime), poolQuoteTokenReserves: row.pre.quoteVault, poolBaseTokenReserves: row.pre.baseReserve,
      virtualQuoteReserves: row.pre.virtualQuoteReserves, lpFee: row.lpFee,
      ...(sell ? { baseAmountIn: row.baseAmount, quoteAmountOut: row.quoteAmount } : { baseAmountOut: row.baseAmount }),
    };
    this.#label(this.#labeller.observe({ kind: 'market', id: `ev:${row.signature}:${row.evIdx}`, moment: m, key: 'pump_amm', value: { event: { program: 'pump_amm', name: sell ? 'SellEvent' : 'BuyEvent', data }, signature: row.signature } }), m, out);
  }

  /** The pool state after a real swap, as our trades left it (from the market): candles and the latest view. */
  onPool(view: PoolView, atMs: number): void {
    const mint = this.#poolMints.get(view.pool);
    if (mint === undefined) return;
    const s = this.#mints.get(mint);
    if (s === undefined || s.migration === null || s.migration.pool !== view.pool) return;
    s.view = view;
    const p = priceOf(view);
    if (p === null) return;
    const start = Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
    const tail = s.candlesTail;
    const last = tail[tail.length - 1];
    if (last !== undefined && last.startMs === start) {
      tail[tail.length - 1] = { ...last, high: above(p, last.high) ? p : last.high, close: p };
    } else {
      // The open of a minute is the first trade's price in it (no trade, no candle: gaps are not filled).
      const c: Candle = { startMs: start, open: p, high: p, close: p };
      tail.push(c);
      if (tail.length > this.#o.candlesTail) tail.shift();
    }
    const cur = tail[tail.length - 1]!;
    const head = s.candlesHead;
    if (head.length < this.#o.candlesHead || head[head.length - 1]?.startMs === start) {
      if (head[head.length - 1]?.startMs === start) head[head.length - 1] = cur;
      else head.push(cur);
    }
  }

  #raw(row: RawRow): void {
    if (row.undecodable !== null) {
      this.counts.undecodableRaw++;
      for (const mint of row.mints) {
        const s = this.#state(mint);
        if (s !== null) this.#problem(s, `raw record ${row.signature} could not be decoded: ${row.undecodable}`);
      }
      return;
    }
    const accountOps: (Extract<RawRow['ops'][number], { op: 'approve' | 'revoke' | 'set-authority' }>)[] = [];
    for (const op of row.ops) {
      if (op.op === 'approve' || op.op === 'revoke') {
        accountOps.push(op);
        continue;
      }
      if (op.op === 'set-authority') {
        accountOps.push(op);
        const s = this.#mints.get(op.account);
        if (s?.account) {
          if (op.authorityType === 0) s.account.mintAuthority = op.newAuthority;
          else if (op.authorityType === 1) s.account.freezeAuthority = op.newAuthority;
        }
        continue;
      }
      const lpOf = this.#lpMints.get(op.mint);
      if (lpOf !== undefined) {
        const s = this.#mints.get(lpOf)!;
        if (op.op === 'mint-to') s.lp.minted += op.amount;
        if (op.op === 'burn') s.lp.burned += op.amount;
        // The pool's creation transaction mints (and for a migration, burns) all LP there is; from it on, the supply is known.
        if (s.pool?.signature === row.signature) s.lp.known = true;
        if (s.lp.known) s.lp.supply = s.lp.minted - s.lp.burned;
        continue;
      }
      const s = this.#mints.get(op.mint);
      if (s === undefined) continue;
      if (op.op === 'init-mint') {
        if (s.account === null) s.account = { owner: op.program, mintAuthority: op.mintAuthority, freezeAuthority: op.freezeAuthority, extensions: s.pendingExt };
        else this.#problem(s, `mint initialised twice (${row.signature})`);
      } else if (op.op === 'extension') {
        // Fixed-size extensions come before InitializeMint, TokenMetadata and groups after it; H4 judges each kind.
        (s.account?.extensions ?? s.pendingExt).push({ ...op.ext });
      } else if (op.op === 'mint-to') {
        s.supply += op.amount;
      } else if (op.op === 'burn') {
        s.supply -= op.amount;
      }
    }
    for (const mint of row.mints) {
      const s = this.#state(mint);
      if (s !== null) this.#holders(s, row, accountOps);
    }
  }

  #problem(s: MintState, why: string): void {
    if (s.holderProblem === null) {
      s.holderProblem = why;
      this.counts.holderProblems++;
    }
  }

  /** Token accounts from the record's balances. A balance that does not match what we tracked means a missed flow. */
  #holders(s: MintState, row: RawRow, accountOps: readonly Extract<RawRow['ops'][number], { op: 'approve' | 'revoke' | 'set-authority' }>[]): void {
    const mine = row.balances.filter((b) => b.mint === s.mint);
    if (s.holders === null) {
      // Tracking starts at the create's record: the whole supply is minted there.
      if (s.create === null || s.create.signature !== row.signature) {
        if (mine.length > 0) this.#problem(s, 'token movements seen before the create was recorded');
        return;
      }
      s.holders = new Map();
    }
    for (const b of mine) {
      const prev = s.holders.get(b.account);
      const had = prev?.amount ?? 0n;
      if ((b.pre ?? 0n) !== had) this.#problem(s, `${b.account} held ${b.pre ?? 0n} before ${row.signature}, the rebuild has ${had}`);
      if (b.owner === null) this.#problem(s, `${b.account} has no owner in ${row.signature}`);
      if (b.post === null || b.post === 0n) s.holders.delete(b.account);
      else s.holders.set(b.account, { owner: b.owner ?? prev?.owner ?? b.account, amount: b.post, delegate: prev?.delegate ?? null, delegated: prev?.delegated ?? 0n });
    }
    // Delegates (GATE-1e), in instruction order, applied to the balances after the transaction. A delegate's own
    // transfers are not tracked down from the approved amount: the delegated amount only overstates its control
    // (the conservative side). An owner change (SetAuthority AccountOwner) moves the account and clears its delegate.
    for (const op of accountOps) {
      const h = s.holders.get(op.account);
      if (h === undefined) continue;
      if (op.op === 'approve') s.holders.set(op.account, { ...h, delegate: op.delegate, delegated: op.amount });
      else if (op.op === 'revoke') s.holders.set(op.account, { ...h, delegate: null, delegated: 0n });
      else if (op.authorityType === 2 && op.newAuthority !== null) s.holders.set(op.account, { ...h, owner: op.newAuthority, delegate: null, delegated: 0n });
    }
    let sum = 0n;
    for (const h of s.holders.values()) sum += h.amount;
    if (sum !== s.supply) this.#problem(s, `holder balances sum to ${sum}, the supply is ${s.supply} after ${row.signature}`);
  }

  /**
   * Drops state no check can need any more, once an hour of chain time: launches that did not graduate within
   * `ungraduatedKeepMs`, and graduates past every check window. Bounded memory over a 74-day run; no answer changes,
   * because a dropped mint is never checked again.
   */
  #prune(atMs: number): void {
    if (atMs < this.#prunedAt + 3_600_000) return;
    this.#prunedAt = atMs;
    const last = Math.max(0, ...this.#o.windows.map((w) => w.toMs));
    for (const [mint, s] of this.#mints) {
      const created = s.create?.createdAtMs ?? null;
      const stale = s.migration === null ? created !== null && atMs - created > UNGRADUATED_KEEP_MS : atMs - s.migration.migratedAtMs > last + 3_600_000;
      if (!stale) continue;
      this.#mints.delete(mint);
      this.#graduates.delete(mint);
      if (s.pool !== null) this.#lpMints.delete(s.pool.lpMint);
      if (s.migration !== null) this.#poolMints.delete(s.migration.pool);
    }
  }

  /** Mints tracked right now (memory check). */
  get tracked(): number {
    return this.#mints.size;
  }

  #block(slot: bigint, atMs: number, m: Moment, out: FeedEvent[]): void {
    this.#prune(atMs);
    const gaps = this.#o.gaps ?? [];
    while (this.#gapAt < gaps.length && gaps[this.#gapAt]!.toSlot < slot) {
      const g = gaps[this.#gapAt++]!;
      for (const stream of ['creates', 'rugs']) out.push(this.#fact(`cov:${stream}:gap:${g.fromSlot}`, m, coverageKeys(stream).gap, { via: PROVIDER, fromSlot: g.fromSlot, toSlot: g.toSlot }));
    }
    const sol = this.#o.solUsd;
    while (this.#solAt < sol.length && sol[this.#solAt]!.at <= atMs) {
      const b = sol[this.#solAt++]!.bar;
      this.#solPoints.push({ tMs: b.start + 3_600_000, price: solPriceMicroUsd(b.close) });
      if (this.#solPoints.length > this.#o.solUsdPoints) this.#solPoints.shift();
    }
    // Reads asked at earlier checks that have landed by now: the facts as of now, then the landing.
    while (this.#reads.length > 0 && this.#reads[0]!.atMs <= atMs) {
      const r = this.#reads.shift()!;
      const base = `r:${String(this.#readSeq++).padStart(9, '0')}:${r.mint}:${r.n}`;
      out.push(...this.snapshot(r.mint, m, base));
      out.push(this.#landed(`${base}:~landed`, m, r.mint, r.universe, r.n, r.stage));
    }
    this.#schedule(atMs);
    // Simultaneous signals: an earlier block's check always comes first, so the earliest fully eligible signal wins.
    // Checks due at the same block are true ties; they are released in the order of sha256(salt | universe | mint), so
    // the first eligible one takes a single position slot and no market feature (depth, universe) tilts the choice.
    const due = [...this.#due].map((key) => {
      const [mint, universe] = key.split('|') as [string, string];
      return { key, mint, universe, tie: tieHash(this.#o.tieSalt, universe, mint) };
    }).sort((a, b) => (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0));
    due.forEach(({ key, mint, universe }, rank) => {
      this.#due.delete(key);
      const s = this.#mints.get(mint);
      if (s === undefined) return;
      this.counts.checks++;
      const n = ++s.checkSeq;
      const base = `k:${String(rank).padStart(5, '0')}:${mint}:${n}`;
      out.push(...this.snapshot(mint, m, base));
      out.push(this.#fact(`${base}:~check`, m, `check:${mint}`, { mint, universe, n, rank, blockHeight: this.#height }));
      if (this.#o.readLatency === undefined) {
        out.push(this.#landed(`${base}:~landed2`, m, mint, universe, n, 2), this.#landed(`${base}:~landed3`, m, mint, universe, n, 3));
      } else {
        const at = landings(atMs, this.#o.readLatency);
        this.#reads.push({ atMs: at.stage2, mint, universe, n, stage: 2 }, { atMs: at.stage3, mint, universe, n, stage: 3 });
        this.#reads.sort((a, b) => a.atMs - b.atMs);
      }
    });
  }

  #landed(id: string, m: Moment, mint: string, universe: string, n: number, stage: 2 | 3): MarketEvent {
    return this.#fact(id, m, `${LANDED_PREFIX}${mint}`, { mint, universe, n, stage, blockHeight: this.#height });
  }

  /** Marks the checks that fall due at this block for every tracked graduate. */
  #schedule(atMs: number): void {
    const last = Math.max(0, ...this.#o.windows.map((w) => w.toMs));
    for (const mint of this.#graduates) {
      const s = this.#mints.get(mint)!;
      if (s.migration === null) continue;
      const since = atMs - s.migration.migratedAtMs;
      if (since > last) {
        this.#graduates.delete(mint);
        continue;
      }
      if (s.view === null) continue;
      for (const w of this.#o.windows) {
        if (since < w.fromMs || since > w.toMs) continue;
        const next = s.checks.get(w.universe) ?? s.migration.migratedAtMs + w.fromMs;
        if (atMs < next) continue;
        s.checks.set(w.universe, next + Math.ceil((atMs - next + 1) / w.everyMs) * w.everyMs);
        if (s.view.quoteVault + s.view.virtualQuoteReserves < w.minQuoteLamports) continue;
        this.#due.add(`${s.mint}|${w.universe}`);
      }
    }
  }

  /** Every gate fact of `mint` as of `m`: what a live read at that moment would return. Missing evidence is left out. */
  snapshot(mint: string, m: Moment, idBase: string): MarketEvent[] {
    const s = this.#mints.get(mint);
    if (s === undefined) return [];
    const out: MarketEvent[] = [];
    const quality = s.holderProblem === null ? [] : ['partial' as const];
    const obs = (q: readonly string[] = []): FactObs => ({ provider: PROVIDER, slot: m.slot, receivedAt: m.receivedAt, quality: q as FactObs['quality'], commitment: 'finalized' });
    const put = (k: string, key: string, value: unknown) => out.push(this.#fact(`${idBase}:${k}`, m, key, value));
    if (this.#tracker !== null && s.pool !== null) {
      // As of this moment only: the tracker refuses a question about a moment it has already passed (left out then).
      try {
        const features = this.#tracker.features(s.pool.address, Math.max(m.receivedAt, this.#tracker.nowMs), m.slot);
        put('features', featuresKey(mint), { obs: { provider: PROVIDER, slot: m.slot, receivedAt: m.receivedAt, quality: [], commitment: 'finalized' }, features });
      } catch {
        // Not tracked or not as of now: no features, so a feature rule finds no setup.
      }
    }
    if (s.create !== null) {
      put('create', createKey(mint), { obs: { provider: PROVIDER, slot: s.create.slot, receivedAt: s.create.receivedAt, quality: [], commitment: 'finalized' }, createdAtMs: s.create.createdAtMs, creator: s.create.creator });
    }
    if (s.migration !== null && s.graduatedAtMs !== null && s.migration.sol > 0n && s.migration.tokens > 0n) {
      put('migration', migrationKey(mint), {
        obs: { provider: PROVIDER, slot: s.migration.slot, receivedAt: s.migration.receivedAt, quality: [], commitment: 'finalized' },
        graduatedAtMs: s.graduatedAtMs, migratedAtMs: s.migration.migratedAtMs, pool: s.migration.pool, quoteAtMigration: s.migration.sol,
        price: { quote: s.migration.sol, base: s.migration.tokens },
      });
    }
    if (s.account !== null) {
      put('mint', mintKey(mint), {
        obs: obs(quality), owner: s.account.owner,
        account: { mintAuthority: s.account.mintAuthority, freezeAuthority: s.account.freezeAuthority, supply: s.supply, extensions: s.account.extensions.map((e) => ({ ...e, fields: e.state === undefined ? {} : { state: e.state }, data: '' })) },
      });
    }
    const v = s.view;
    if (s.pool !== null && v !== null && s.pool.address === v.pool) {
      const tokenProgram = s.account?.owner ?? s.create?.tokenProgram ?? null;
      if (tokenProgram === TOKEN_PROGRAM || tokenProgram === TOKEN_2022_PROGRAM) {
        const acct = this.#o.poolAccounts?.(s.pool.address) ?? null;
        const known = acct !== null && acct.knownAtMs <= m.receivedAt ? acct : null;
        const coinCreator = known?.coinCreator ?? s.pool.coinCreator;
        put('pool', poolKey(mint), {
          obs: obs(), address: s.pool.address, owner: PUMP_AMM_PROGRAM, ...(known === null ? {} : { accountBytes: known.accountBytes }),
          pool: {
            index: s.pool.index, creator: s.pool.creator, baseMint: mint, quoteMint: s.pool.quoteMint, lpMint: s.pool.lpMint,
            poolBaseTokenAccount: associatedTokenAddress(s.pool.address, mint, tokenProgram),
            poolQuoteTokenAccount: associatedTokenAddress(s.pool.address, s.pool.quoteMint, TOKEN_PROGRAM),
            lpSupply: s.lp.supply, ...(s.pool.mayhem === undefined ? {} : { isMayhemMode: s.pool.mayhem }), virtualQuoteReserves: v.virtualQuoteReserves,
            ...(known === null ? {} : { isCashbackCoin: known.isCashbackCoin }), ...(coinCreator === undefined ? {} : { coinCreator }),
          },
          baseVault: v.baseReserve, quoteVault: v.quoteVault,
        });
      }
      if (s.lp.known) put('lp', lpKey(mint), { obs: obs(), lpMint: s.pool.lpMint, supply: s.lp.supply });
    }
    const candles = [...s.candlesHead, ...s.candlesTail.filter((c) => !s.candlesHead.some((h) => h.startMs === c.startMs))].filter((c) => c.startMs <= m.receivedAt);
    if (s.migration !== null) put('candles', candlesKey(mint), { obs: obs(), intervalMs: MINUTE_MS, candles });
    if (s.holders !== null) {
      const accounts: HolderAccount[] = [...s.holders].map(([address, h]) => ({ address, mint, owner: h.owner, ownerProgram: null, amount: h.amount, delegate: h.delegate, delegatedAmount: h.delegate === null ? 0n : h.delegated }))
        .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.address < b.address ? -1 : 1));
      const holderQuality = quality.length === 0 && this.#o.delegatesComplete !== true ? ['partial' as const] : quality;
      put('holders', holdersKey(mint), { obs: obs(holderQuality), supply: s.supply, coverage: 'all', accounts });
    }
    // Deployer-funded wallets and the dev's cluster are not in the dataset (DATA-1 "Not covered"): complete only with a
    // funding source dated at or before now, and with the create (creation-slot buyers) recorded.
    const src = this.#o.insiders?.(mint) ?? null;
    const known = src !== null && src.knownAtMs <= m.receivedAt && s.create !== null;
    put('insiders', insidersKey(mint), {
      obs: { ...obs(), slot: s.create?.slot ?? m.slot }, complete: known,
      insiders: [...new Set([...s.creationBuyers, ...(known ? src.funded : [])])].sort(), devCluster: known ? [...src.devCluster].sort() : [],
    });
    if (this.#solPoints.length > 0) put('sol-usd', SOL_USD_KEY, { obs: { provider: 'sol-usd', slot: null, receivedAt: m.receivedAt, quality: [] }, points: this.#solPoints.map((p) => ({ ...p })) });
    return out;
  }
}

/** Gaps from the manifest's `coverage_gaps` ("from-to" slot ranges). */
export const gapsOf = (raw: readonly unknown[] | undefined): { fromSlot: bigint; toSlot: bigint }[] =>
  (raw ?? []).flatMap((g) => {
    const m = typeof g === 'string' ? /^(\d+)-(\d+)$/.exec(g) : null;
    return m === null ? [] : [{ fromSlot: BigInt(m[1]!), toSlot: BigInt(m[2]!) }];
  });

export type { Address };
