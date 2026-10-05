// The live sources (FEED-1 adapters) the worker runs, within the free plans (docs/research/data.md §8): slot notices
// and two narrow log streams on Helius and on Alchemy (creates, by the pump mint authority; migrations, by pump's
// withdraw authority), and PumpPortal's free creates and migrations. Creates keep their log lines for the deployer
// index (coverage `creates` on Helius); migrations are fetched at confirmed. Full trade streams for every mint are far
// outside the free budgets (about 14M Helius credits a month for pump logs alone), so they are off by default and no
// `coverage:rugs:*` start is claimed: H14 stays not covered until a paid stream (`tradeStreams`) or a backfill covers
// trades (RUG-1's wiring rule).
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM, type TransactionRecord, transactionEvents } from '../../../core/src/chain/index.ts';
import type { Fetched, SocketFactory, HttpClient, Secrets } from '../providers/index.ts';
import { CoinbaseSolPrice, alchemyRpcUrl, heliusRpcUrl, heliusWsUrl, PumpPortalSource, RpcHttp, RpcStream, TxFetcher } from '../providers/index.ts';
import {
  ALCHEMY_FREE, HELIUS_FREE, HELIUS_WS_CREDITS_PER_BYTE, HELIUS_WS_CREDITS_PER_CONNECTION, JUPITER_FREE, P0, P1, P2, P3,
  RUGCHECK_FREE, Scheduler, type SchedulerSpec,
} from '../scheduler/index.ts';
import type { Timers } from '../scheduler/timers.ts';
import { type Credits, creditMonth, creditsFile } from './state.ts';
import { SOL_PRICE_KEY } from '../engine/strategy.ts';
import { PoolWatch, tradesStream } from './pool-watch.ts';
import type { DailyBudget } from '../persist/index.ts';
import { type GapFill, ingestingFill } from '../seed/fill.ts';
import { LOOKUP_BOUNDS_MS, type QuotaStatus } from '../../../runner/src/contract.ts';
import type { FeedSource, SourcesContext } from './worker.ts';
import type { WatchRead } from './watch.ts';
import { callCost, type SignatureInfo } from '../providers/solana-http.ts';

/** Pump's mint authority PDA: only `create`/`create_v2` mention it (venues.md, measured). */
export const PUMP_CREATE_AUTHORITY = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
/** Pump's withdraw authority, passed to `migrate`/`migrate_v2` (venues.md, measured). */
export const PUMP_MIGRATION_AUTHORITY = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';

/**
 * The month's credit use per provider, loaded at start and saved at most once a second and at stop (FEED-1 DECISIONS:
 * a restart never resets the 70% halt). A new UTC month starts from zero on the next start.
 */
export class CreditBook {
  readonly #file: ReturnType<typeof creditsFile>;
  readonly #timers: Timers;
  readonly #used: Record<string, number>;
  readonly #month: string;
  #dirty = false;
  #timer: ReturnType<Timers['setTimeout']> | null = null;

  constructor(stateDir: string, timers: Timers) {
    this.#file = creditsFile(stateDir);
    this.#timers = timers;
    this.#month = creditMonth(timers.now());
    const saved = this.#file.read({ month: this.#month, used: {} });
    this.#used = saved.month === this.#month ? { ...saved.used } : {};
    this.#save();
  }

  get used(): Readonly<Record<string, number>> {
    return this.#used;
  }

  scheduler(spec: SchedulerSpec): Scheduler {
    return new Scheduler(spec, {
      timers: this.#timers,
      creditsUsed: this.#used[spec.provider] ?? 0,
      onSpend: (used) => {
        this.#used[spec.provider] = used;
        this.#dirty = true;
        this.#timer ??= this.#timers.setTimeout(() => {
          this.#timer = null;
          if (this.#dirty) this.#save();
        }, 1_000);
      },
    });
  }

  #save(): void {
    this.#dirty = false;
    const c: Credits = { month: this.#month, used: { ...this.#used } };
    this.#file.write(c);
  }

  /** At stop. */
  flush(): void {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#save();
  }
}

export interface LiveProviderOptions {
  /**
   * Full pump and PumpSwap trade log streams with rug coverage (`coverage:rugs:*`). Off on the free plans (about 14M
   * Helius credits a month for pump logs alone, data.md); without them H14 stays not covered.
   */
  readonly tradeStreams: boolean;
  readonly secrets: Secrets;
  readonly http: HttpClient;
  readonly factory: SocketFactory;
  readonly credits: CreditBook;
  /**
   * The fills' daily credit budget (FILL-2, shared with the restart fill; S0-ZERO): the pool watches' in-run fills spend
   * from it, each at most `TRADES_FILL_CREDITS`. Without it no in-run fill is made, so those gaps close as lossy.
   */
  readonly fillBudget?: DailyBudget;
}

/** S0-ZERO: credits one in-run fill of a pool's trade gap may spend (a candidate's catch-up from its migration is a few transactions). */
export const TRADES_FILL_CREDITS = 500;

/** STEP-B: in-run fills that may read at once; more wait their turn (oldest first), so a boot's catch-up stays flat. */
export const TRADES_FILLS_IN_FLIGHT = 2;

/**
 * S0-ZERO: FILL-2's in-run fill for the pool watches (a candidate's catch-up from its migration, any reconnect gap).
 * Each fill may spend at most `TRADES_FILL_CREDITS` and never more than the daily budget has left (none left: no call,
 * the gap stays lossy); the fill is journaled as `trades_fill` so the shakedown measures its size and credits.
 * STEP-B: the cap is booked to the budget before the fill reads and what it did not use is given back after (as the
 * seed and restart reads do), so fills running together never spend past the budget and a death mid-fill keeps the
 * charge; at most `TRADES_FILLS_IN_FLIGHT` fills read at once.
 */
export const tradesFill = (o: {
  readonly feed: Parameters<typeof ingestingFill>[0]['feed'];
  readonly rpc: Parameters<typeof ingestingFill>[0]['rpc'];
  readonly timers: Timers;
  readonly budget: Pick<DailyBudget, 'remaining' | 'spend' | 'refund'>;
  readonly pools: SourcesContext['pools'];
  readonly journal?: NonNullable<SourcesContext['journal']>;
  readonly inFlight?: number;
}) => {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (gap: Parameters<ReturnType<typeof ingestingFill>>[0]): Promise<boolean> => {
    if (active >= (o.inFlight ?? TRADES_FILLS_IN_FLIGHT)) await new Promise<void>((go) => waiting.push(go));
    active++;
    try {
      const cap = Math.min(TRADES_FILL_CREDITS, o.budget.remaining(o.timers.now()));
      if (cap > 0) o.budget.spend(cap, o.timers.now());
      let used = 0;
      const ok = await ingestingFill({
        feed: o.feed, rpc: o.rpc, timers: o.timers, provider: 'helius',
        creditCap: () => cap,
        streamOf: tradesStream,
        kindOf: (address) => (o.pools().get(address)?.held === true ? 'position' : 'candidate'),
        onReport: (f: GapFill) => {
          used = f.report.creditsUsed;
          o.journal?.('trades_fill', {
            pool: f.gap.pool, mint: o.pools().get(f.gap.pool)?.mint ?? null, kind: f.gap.kind, from_slot: f.gap.fromSlot, until_slot: f.gap.untilSlot,
            complete: f.complete, transactions: f.records.length, credits: f.report.creditsUsed, calls: f.report.calls, stopped_by: f.report.stoppedBy, latency_ms: f.report.latencyMs,
          });
        },
      })(gap);
      // A fill that threw keeps its whole reservation (fail safe on spend: what it read is not known).
      if (cap > 0) o.budget.refund(Math.max(0, cap - used), o.timers.now());
      return ok;
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
};

/**
 * CREATE-AFTER-RESTART: the most one create lookup may spend: pages of the mint's signatures (1,000 each, newest first)
 * and the create's own read. A history longer than that stays "missing create"; it is never guessed.
 */
export const CREATE_LOOKUP_CREDITS = 25;

/** Why a create lookup stopped. Only `found` puts a create on the feed. */
export type CreateLookupStop = 'found' | 'skipped-no-budget' | 'credit-cap' | 'no-signature' | 'not-found' | 'not-create' | 'no-feed' | 'error';

/** One create lookup, as journaled (`create_lookup`). */
export interface CreateLookup {
  readonly mint: string;
  readonly found: boolean;
  readonly signature: string | null;
  readonly slot: string | null;
  readonly pages: number;
  readonly credits: number;
  readonly stopped_by: CreateLookupStop;
  readonly latency_ms: number;
}

/**
 * CREATE-AFTER-RESTART: a shortlisted mint whose create this process never saw (it came before the start, and the saved
 * store does not hold it). The mint's signatures are paged back to the start: its oldest successful transaction is the
 * one that created the mint. That transaction is read at confirmed here, and only when it holds the pump CreateEvent
 * of this mint is it put on the feed (`ingest`), where the producer makes the create fact from it; anything else leaves
 * the create missing. (Not through the shared fetcher: it answers a repeat ask without the record, and only the
 * transaction itself proves the create.) The whole cap is counted from the fills' daily budget before the first call
 * and the unused part given back after, so lookups running together never spend past it.
 */
export const findCreate = async (mint: string, o: {
  readonly rpc: {
    getSignaturesForAddress(address: string, opts: { readonly before?: string; readonly limit: number }, priority: typeof P2): Promise<readonly Pick<SignatureInfo, 'signature' | 'err'>[]>;
    getTransaction(signature: string, priority: typeof P2): Promise<TransactionRecord | null>;
  };
  /** Puts the verified create transaction on the feed; false when there is no feed to put it on. */
  readonly ingest: (record: TransactionRecord) => boolean;
  readonly timers: Timers;
  readonly budget: Pick<DailyBudget, 'remaining' | 'spend' | 'refund'> | undefined;
}): Promise<CreateLookup> => {
  const started = o.timers.now();
  const page = callCost('helius', 'getSignaturesForAddress');
  const read = callCost('helius', 'getTransaction');
  let pages = 0;
  let used = 0;
  const done = (stopped_by: CreateLookupStop, rec: TransactionRecord | null = null): CreateLookup => ({
    mint, found: stopped_by === 'found', signature: rec?.signature ?? null, slot: rec === null ? null : String(rec.slot), pages, credits: used, stopped_by, latency_ms: o.timers.now() - started,
  });
  const cap = o.budget === undefined ? 0 : Math.min(CREATE_LOOKUP_CREDITS, o.budget.remaining(started));
  if (cap < page + read) return done('skipped-no-budget');
  o.budget!.spend(cap, started);
  try {
    let before: string | undefined;
    let oldest: string | null = null;
    for (;;) {
      if (used + page + read > cap) return done('credit-cap');
      used += page;
      pages++;
      const sigs = await o.rpc.getSignaturesForAddress(mint, before === undefined ? { limit: 1000 } : { before, limit: 1000 }, P2);
      for (const x of sigs) if (x.err === null) oldest = x.signature;
      if (sigs.length < 1000) break;
      before = sigs.at(-1)!.signature;
    }
    if (oldest === null) return done('no-signature');
    used += read;
    const rec = await o.rpc.getTransaction(oldest, P2);
    if (rec === null) return done('not-found');
    if (!transactionEvents(rec).some((e) => e.name === 'CreateEvent' && e.data.mint === mint)) return done('not-create');
    return o.ingest(rec) ? done('found', rec) : done('no-feed');
  } catch {
    return done('error');
  } finally {
    o.budget!.refund(cap - used, o.timers.now());
  }
};

export class LiveProviders {
  readonly helius: Scheduler;
  readonly alchemy: Scheduler;
  readonly jupiter: Scheduler;
  readonly rugcheck: Scheduler;
  #fetcher: TxFetcher | null = null;
  /** The worker's feed, once `feeds` has run: where a create lookup puts the create it verified. */
  #feed: SourcesContext['feed'] | null = null;

  constructor(o: LiveProviderOptions) {
    this.helius = o.credits.scheduler(HELIUS_FREE);
    this.alchemy = o.credits.scheduler(ALCHEMY_FREE);
    this.jupiter = o.credits.scheduler(JUPITER_FREE);
    this.rugcheck = o.credits.scheduler(RUGCHECK_FREE);
    this.#o = o;
  }

  readonly #o: LiveProviderOptions;
  readonly #lookups = LOOKUP_BOUNDS_MS.map(() => 0).concat(0);

  #lookup(ms: number): void {
    const k = LOOKUP_BOUNDS_MS.findIndex((b) => ms <= b);
    this.#lookups[k === -1 ? LOOKUP_BOUNDS_MS.length : k]!++;
  }

  /**
   * RUN-1c's health fields: each free-plan provider's credits since this boot (by class, rounded up to whole credits so
   * they sum), its plan's monthly credits, grants, sheds and halt; and the historical-lookup latency counts.
   */
  ops(): { readonly quota: readonly QuotaStatus[]; readonly lookups: { readonly counts: readonly number[] } } {
    const quota = [this.helius, this.alchemy, this.jupiter].map((s): QuotaStatus => {
      const st = s.status();
      const cls = st.creditsByClass.map((c) => Math.ceil(c)) as [number, number, number, number];
      return {
        provider: st.provider, credits_used: cls[0] + cls[1] + cls[2] + cls[3], credits_by_class: cls,
        monthly_credits: s.spec.budget?.monthlyCredits ?? null, granted: st.granted, shed: st.shed, halted: st.halted,
      };
    });
    return { quota, lookups: { counts: [...this.#lookups] } };
  }

  /** The feeds, built on the worker's live Feed. */
  feeds(ctx: SourcesContext): FeedSource[] {
    const o = this.#o;
    const { feed, timers } = ctx;
    const hRpc = new RpcHttp({ provider: 'helius', url: () => heliusRpcUrl(o.secrets), http: o.http, scheduler: this.helius, timeoutMs: 10_000 });
    const aRpc = new RpcHttp({ provider: 'alchemy', url: () => alchemyRpcUrl(o.secrets), http: o.http, scheduler: this.alchemy, timeoutMs: 10_000 });
    const fetcher = new TxFetcher({ clients: [hRpc, aRpc], feed, timers, retries: 3, retryMs: 1_000, remember: 50_000, onLookup: (ms) => this.#lookup(ms) });
    this.#fetcher = fetcher;
    this.#feed = feed;
    const socket = { initialMs: 1_000, maxMs: 30_000, idleMs: 30_000 };
    const helius = new RpcStream({
      provider: 'helius', url: () => heliusWsUrl(o.secrets), factory: o.factory, timers, feed, scheduler: this.helius,
      creditsPerByte: HELIUS_WS_CREDITS_PER_BYTE, creditsPerConnection: HELIUS_WS_CREDITS_PER_CONNECTION, http: hRpc, fetcher, socket, backfillLimit: 100,
    });
    helius.watchSlots(P1);
    helius.watchLogs(PUMP_CREATE_AUTHORITY, { priority: P3, decodeLogs: true, coverage: 'creates' });
    helius.watchLogs(PUMP_MIGRATION_AUTHORITY, { priority: P2, decodeLogs: true, fetch: P2 });
    if (o.tradeStreams) {
      helius.watchLogs(PUMP_PROGRAM, { priority: P3, decodeLogs: true, coverage: 'rugs' });
      helius.watchLogs(PUMP_AMM_PROGRAM, { priority: P3, decodeLogs: true, coverage: 'rugs' });
    }
    // No Alchemy socket: on mainnet (rehearsal 37142749019) it refused slotSubscribe and logsSubscribe (-32601) and only
    // idled out every 30 s, each reconnect costing a 100-signature backfill. Alchemy stays the fetcher's second RPC.
    const budget = o.fillBudget;
    const fill = budget === undefined ? undefined : tradesFill({ feed, rpc: hRpc, timers, budget, pools: ctx.pools, ...(ctx.journal === undefined ? {} : { journal: ctx.journal }) });
    const pools = new PoolWatch({ stream: helius, timers, pools: ctx.pools, everyMs: 2_000, ...(fill === undefined ? {} : { fill }) });
    const pumpportal = new PumpPortalSource({ factory: o.factory, timers, feed, fetcher, migrationFetch: P3 });
    const sol = new CoinbaseSolPrice({ factory: o.factory, timers, feed, key: SOL_PRICE_KEY });
    return [
      {
        name: 'helius-ws', critical: true, sources: ['helius'],
        start: () => {
          helius.start();
          pools.start();
        },
        stop: () => {
          pools.stop();
          helius.stop();
        },
      },
      { name: 'pumpportal', critical: false, sources: ['pumpportal'], start: () => pumpportal.start(), stop: () => pumpportal.stop() },
      // Critical: without a fresh SOL price risk refuses every entry anyway; marked so the halt says why.
      { name: 'coinbase-ws', critical: true, sources: ['coinbase'], start: () => sol.start(), stop: () => sol.stop() },
    ];
  }

  /**
   * WATCH-1's second path: Alchemy over HTTP, independent of the Helius socket the feed runs on, charged to Alchemy's
   * scheduler at P0 (review of #87): it prices a held position's exit, only for open positions, only while their market
   * is stale, at most T_max each, so the monthly budget's halt never takes the price an exit needs.
   */
  watchRead(): (addresses: readonly string[], minContextSlot: bigint | null) => Promise<WatchRead> {
    const rpc = new RpcHttp({ provider: 'alchemy', url: () => alchemyRpcUrl(this.#o.secrets), http: this.#o.http, scheduler: this.alchemy, timeoutMs: 10_000 });
    return (addresses, minContextSlot) => rpc.getMultipleAccounts(addresses, P0, minContextSlot ?? undefined);
  }

  /** SEED-1's backfill RPC: Helius, charged to its scheduler like every other call. */
  seedRpc(): RpcHttp {
    return new RpcHttp({ provider: 'helius', url: () => heliusRpcUrl(this.#o.secrets), http: this.#o.http, scheduler: this.helius, timeoutMs: 10_000 });
  }

  /** A transaction read at confirmed (P3) and put on the feed, for the delay probe; null when not found. */
  async confirmed(signature: string): Promise<Fetched | null> {
    return this.#fetcher === null ? null : this.#fetcher.fetch(signature, P3);
  }

  /** CREATE-AFTER-RESTART: a shortlisted mint's create looked up from its oldest signature, under the fills' budget. */
  async findCreate(mint: string, timers: Timers): Promise<CreateLookup> {
    const ingest = (record: TransactionRecord): boolean => {
      const feed = this.#feed;
      if (feed === null) return false;
      feed.ingest('helius', { type: 'tx', record }, { receivedAt: timers.now(), lookup: true });
      return true;
    };
    return findCreate(mint, { rpc: this.seedRpc(), ingest, timers, budget: this.#o.fillBudget });
  }

  /**
   * A transaction at confirmed (P2), put on the feed; true when found and readable. One DEC-1 cannot decode reads as
   * not found, so a cut trade log it was fetched for still becomes a rugs gap (a decode failure is a fact gap).
   */
  async fetchTx(signature: string): Promise<boolean> {
    if (this.#fetcher === null) return false;
    try {
      const found = await this.#fetcher.fetch(signature, P2);
      return found !== null && found.undecodable !== true;
    } catch {
      return false;
    }
  }
}

/**
 * The commitment each live path actually uses (recorder manifest, for BT-1c's measured delay scenario). Helius
 * subscriptions are made at processed (FEED-1); transactions are read at confirmed.
 */
export const FEED_COMMITMENTS: Readonly<Record<string, string>> = {
  'helius-ws slotSubscribe': 'processed (slot notifications as the node processes them)',
  'helius-ws logsSubscribe': 'processed',
  'helius getTransaction': 'confirmed',
  'helius getSignaturesForAddress (backfill)': 'confirmed',
  pumpportal: 'not published by PumpPortal',
  'coinbase-ws ticker': 'exchange trade time (off-chain)',
};
