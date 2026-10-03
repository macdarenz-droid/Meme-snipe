// The live sources (FEED-1 adapters) the worker runs, within the free plans (docs/research/data.md §8): slot notices
// and two narrow log streams on Helius and on Alchemy (creates, by the pump mint authority; migrations, by pump's
// withdraw authority), and PumpPortal's free creates and migrations. Creates keep their log lines for the deployer
// index (coverage `creates` on Helius); migrations are fetched at confirmed. Full trade streams for every mint are far
// outside the free budgets (about 14M Helius credits a month for pump logs alone), so they are off by default and no
// `coverage:rugs:*` start is claimed: H14 stays not covered until a paid stream (`tradeStreams`) or a backfill covers
// trades (RUG-1's wiring rule).
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM } from '../../../core/src/chain/index.ts';
import type { SocketFactory, HttpClient, Secrets } from '../providers/index.ts';
import { alchemyRpcUrl, heliusRpcUrl, heliusWsUrl, PumpPortalSource, RpcHttp, RpcStream, TxFetcher } from '../providers/index.ts';
import {
  ALCHEMY_FREE, HELIUS_FREE, HELIUS_WS_CREDITS_PER_BYTE, HELIUS_WS_CREDITS_PER_CONNECTION, JUPITER_FREE, P1, P2, P3,
  RUGCHECK_FREE, Scheduler, type SchedulerSpec,
} from '../scheduler/index.ts';
import type { Timers } from '../scheduler/timers.ts';
import { type Credits, creditMonth, creditsFile } from './state.ts';
import type { FeedSource, SourcesContext } from './worker.ts';

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
}

export class LiveProviders {
  readonly helius: Scheduler;
  readonly alchemy: Scheduler;
  readonly jupiter: Scheduler;
  readonly rugcheck: Scheduler;
  #fetcher: TxFetcher | null = null;

  constructor(o: LiveProviderOptions) {
    this.helius = o.credits.scheduler(HELIUS_FREE);
    this.alchemy = o.credits.scheduler(ALCHEMY_FREE);
    this.jupiter = o.credits.scheduler(JUPITER_FREE);
    this.rugcheck = o.credits.scheduler(RUGCHECK_FREE);
    this.#o = o;
  }

  readonly #o: LiveProviderOptions;

  /** The feeds, built on the worker's live Feed. */
  feeds(ctx: SourcesContext): FeedSource[] {
    const o = this.#o;
    const { feed, timers } = ctx;
    const hRpc = new RpcHttp({ provider: 'helius', url: () => heliusRpcUrl(o.secrets), http: o.http, scheduler: this.helius, timeoutMs: 10_000 });
    const aRpc = new RpcHttp({ provider: 'alchemy', url: () => alchemyRpcUrl(o.secrets), http: o.http, scheduler: this.alchemy, timeoutMs: 10_000 });
    const fetcher = new TxFetcher({ clients: [hRpc, aRpc], feed, timers, retries: 3, retryMs: 1_000, remember: 50_000 });
    this.#fetcher = fetcher;
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
    const pumpportal = new PumpPortalSource({ factory: o.factory, timers, feed, fetcher, migrationFetch: P3 });
    return [
      { name: 'helius-ws', critical: true, sources: ['helius'], start: () => helius.start(), stop: () => helius.stop() },
      { name: 'pumpportal', critical: false, sources: ['pumpportal'], start: () => pumpportal.start(), stop: () => pumpportal.stop() },
    ];
  }

  /** A transaction at confirmed (P2), put on the feed; true when found. */
  /** SEED-1's backfill RPC: Helius, charged to its scheduler like every other call. */
  seedRpc(): RpcHttp {
    return new RpcHttp({ provider: 'helius', url: () => heliusRpcUrl(this.#o.secrets), http: this.#o.http, scheduler: this.helius, timeoutMs: 10_000 });
  }

  async fetchTx(signature: string): Promise<boolean> {
    if (this.#fetcher === null) return false;
    try {
      return (await this.#fetcher.fetch(signature, P2)) !== null;
    } catch {
      return false;
    }
  }
}
