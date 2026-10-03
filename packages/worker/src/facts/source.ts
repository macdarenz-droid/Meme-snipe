// FACTS-1b: the live fact source, plugged into WORKER-1's FactSource hook. It never makes a fact: it asks FACTS-1's
// readers for raw answers, which go on the live Feed as `offchain` frames (recorded), and the engine's FactFeed turns
// them into gate facts with core's producer, exactly as a replay of the recording does.
//
// Staging (supervisor ruling, docs/DECISIONS.md "Evaluation staging"): a candidate's reads follow its last
// evaluation. Before the first one nothing is read. A reason that is not missing or unusable evidence (the regime is
// off, a stream-built gate rejects, a third party disagrees) means no read at all. Otherwise only the inputs the
// evidence reasons name are read, each at most once per `minReadGapMs` (the budget's evaluations a minute), and the
// complete holder scan only when the holder set is the last input missing. A refused or failed read makes no fact, so
// the gate keeps rejecting (H16); the source counts it per UTC day under `worker:fact-reads` for the coverage report.
// Three reads do not follow a candidate's reasons: hourly SOL/USD bars (H8, regime), hourly chain volume from DATA-1c's
// day releases (regime, FACTS-1d), and one pool read just after each graduate's survival mark (regime), for every
// migration the strategy shortlisted.
import type { EvidenceCode } from '../../../core/src/gates/index.ts';
import type { Policy } from '../../../core/src/config/index.ts';
import { producerOptions } from '../../../core/src/facts/index.ts';
import { heliusRpcUrl, type HttpClient, type Secrets } from '../providers/index.ts';
import type { Scheduler } from '../scheduler/index.ts';
import { ASSUMPTIONS } from './budget.ts';
import { join } from 'node:path';
import { FactReaders, FactRpc } from './readers.ts';
import { CHAIN_VOLUME_DIR, fileChainVolumeStore } from './volume-store.ts';
import type { CandidateReason } from '../engine/strategy.ts';
import type { FactContext, FactSource } from '../run/facts.ts';
import type { TimerHandle } from '../scheduler/timers.ts';

/** The reads the source asks for (FactReaders implements it). */
export interface LiveReaders {
  readAccounts(mint: string): Promise<boolean>;
  readHolders(mint: string): Promise<boolean>;
  readHoldersAll(mint: string): Promise<boolean>;
  readCrossChecks(mint: string): Promise<boolean[]>;
  readMintHistory(mint: string, o: MintHistoryOptions): Promise<boolean>;
  readSolUsd(hoursBack: number): Promise<boolean>;
  /** The regime's chain volume (FACTS-1d); absent when no release source is wired. */
  readChainVolume?(regime: ChainVolumeWindow): Promise<boolean>;
}

/** The policy's volume window, for the chain-volume read. */
export type ChainVolumeWindow = Pick<Policy['regime'], 'volumeLagDays' | 'volumeWindowDays'>;

/** `FactReaders.readMintHistory`'s options: page caps, the insider window and the decision slot. */
export interface MintHistoryOptions {
  readonly maxPages: number;
  readonly funderPages: number;
  readonly funderTransactions: number;
  readonly insiderSlots: number;
  readonly firstBuyers: number;
  readonly asOfSlot: bigint;
}

export interface LiveFactsOptions {
  /** Builds the readers at start, on the worker's Feed and schedulers. */
  readonly readers: (ctx: FactContext) => LiveReaders;
  /** How often the source looks at the candidates. */
  readonly tickMs: number;
  /** Least time between two reads of one kind for one mint (60 s: the budget's one evaluation a minute). */
  readonly minReadGapMs: number;
  /** The policy's survival mark after a migration (regime.survivalAfterMs) and how soon after it the pool is read. */
  readonly survivalAfterMs: number;
  readonly survivalReadDelayMs: number;
  /** Hours of SOL/USD bars read at start (the producer's kept window); each later hourly read takes 3. */
  readonly solUsdStartHours: number;
  readonly mintHistory: Omit<MintHistoryOptions, 'asOfSlot'>;
  /** The volume window: with it (and a reader that has a release source), chain volume is read each hour. */
  readonly chainVolume?: ChainVolumeWindow;
}

/** The counter fact: reads per UTC day by kind and outcome. Never read by a gate. */
export const FACT_READS_KEY = 'worker:fact-reads';

/** `{ detail, atMs }`: a verified chain-volume day whose release later changed (tamper signal; that day is unknown). */
export const CHAIN_VOLUME_ALERT_KEY = 'worker:chain-volume-alert';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const EVIDENCE: ReadonlySet<string> = new Set<EvidenceCode>(['missing', 'malformed', 'stale', 'degraded', 'gap', 'not-covered', 'inconsistent']);
/** The inputs a read can supply, by read kind. Every other input is stream-built or has no free live source. */
const ACCOUNTS: ReadonlySet<string> = new Set(['mint', 'pool', 'lp']);

type Kind = 'accounts' | 'holders' | 'holders-all' | 'xcheck' | 'mint-history' | 'survival' | 'sol-usd' | 'chain-volume';

/** What one candidate's last reasons ask the source to read; empty when it must not read. */
export const readsFor = (gates: readonly CandidateReason[] | null): Kind[] => {
  if (gates === null || gates.length === 0) return [];
  const out = new Set<Kind>();
  let holdersOnly = true;
  for (const g of gates) {
    // The worker has no market for the mint yet: its pool fact comes from the account read.
    if (g.gate === 'worker' && g.code === 'no-market') {
      out.add('accounts');
      holdersOnly = false;
      continue;
    }
    if (g.gate !== 'H16' || !EVIDENCE.has(g.code) || g.input === undefined) return [];
    if (ACCOUNTS.has(g.input)) out.add('accounts');
    else if (g.input === 'xcheck') out.add('xcheck');
    else if (g.input === 'insiders') out.add('mint-history');
    else if (g.input === 'holders') out.add(g.code === 'not-covered' ? 'holders-all' : 'holders');
    if (g.input !== 'holders') holdersOnly = false;
  }
  // The complete scan is the last read (and the dearest): only when nothing else is missing.
  if (out.has('holders-all') && !holdersOnly) {
    out.delete('holders-all');
    out.add('holders');
  }
  return [...out].sort();
};

export class LiveFacts implements FactSource {
  readonly name = 'facts';
  readonly #o: LiveFactsOptions;
  #ctx: FactContext | null = null;
  #readers: LiveReaders | null = null;
  #tick: TimerHandle | null = null;
  readonly #inFlight = new Set<string>();
  readonly #lastAt = new Map<string, number>();
  /** Shortlisted mints whose survival read is still to come, with their migration time. */
  readonly #survival = new Map<string, number>();
  readonly #survivalDone = new Set<string>();
  readonly #historyDone = new Set<string>();
  #solHour = -1;
  #day = -1;
  #counts: Record<string, { ok: number; failed: number }> = {};

  constructor(o: LiveFactsOptions) {
    this.#o = o;
  }

  start(ctx: FactContext): void {
    this.#ctx = ctx;
    this.#readers = this.#o.readers(ctx);
    const loop = (): void => {
      if (this.#ctx === null) return;
      this.step();
      this.#tick = ctx.timers.setTimeout(loop, this.#o.tickMs);
    };
    loop();
  }

  stop(): void {
    if (this.#tick !== null) this.#ctx?.timers.clearTimeout(this.#tick);
    this.#tick = null;
    this.#ctx = null;
  }

  /** One look at the candidates (the timer calls it; tests call it directly). */
  step(): void {
    const ctx = this.#ctx;
    if (ctx === null) return;
    const now = ctx.timers.now();
    const hour = Math.floor(now / HOUR_MS);
    if (hour !== this.#solHour) {
      const first = this.#solHour < 0;
      this.#solHour = hour;
      this.#run('sol-usd', '', (r) => r.readSolUsd(first ? this.#o.solUsdStartHours : 3), true);
      // Each day is read once by the reader; an hourly call only picks up newly published days.
      const w = this.#o.chainVolume;
      if (w !== undefined && this.#readers?.readChainVolume !== undefined) this.#run('chain-volume', '', (r) => r.readChainVolume!(w), true);
    }
    for (const [mint, c] of ctx.candidates()) {
      if (!this.#survivalDone.has(mint)) this.#survival.set(mint, c.migratedAtMs);
      for (const kind of readsFor(c.gates)) this.#read(kind, mint, now);
    }
    for (const [mint, at] of this.#survival) {
      if (now < at + this.#o.survivalAfterMs + this.#o.survivalReadDelayMs) continue;
      this.#survival.delete(mint);
      this.#survivalDone.add(mint);
      this.#run('survival', mint, (r) => r.readAccounts(mint), true);
    }
  }

  #read(kind: Kind, mint: string, now: number): void {
    const last = this.#lastAt.get(`${kind}:${mint}`);
    if (last !== undefined && now - last < this.#o.minReadGapMs) return;
    switch (kind) {
      case 'accounts': return this.#run(kind, mint, (r) => r.readAccounts(mint));
      case 'holders': return this.#run(kind, mint, (r) => r.readHolders(mint));
      case 'holders-all': return this.#run(kind, mint, (r) => r.readHoldersAll(mint));
      case 'xcheck': return this.#run(kind, mint, async (r) => (await r.readCrossChecks(mint)).some(Boolean));
      case 'mint-history': {
        if (this.#historyDone.has(mint)) return;
        const tip = this.#ctx?.tip() ?? null;
        // Point in time: without a decision slot there is nothing to read as of.
        if (tip === null) return;
        return this.#run(kind, mint, async (r) => {
          const ok = await r.readMintHistory(mint, { ...this.#o.mintHistory, asOfSlot: tip });
          if (ok) this.#historyDone.add(mint);
          return ok;
        });
      }
      default: return;
    }
  }

  #run(kind: Kind, mint: string, f: (r: LiveReaders) => Promise<boolean>, force = false): void {
    const ctx = this.#ctx;
    const readers = this.#readers;
    if (ctx === null || readers === null) return;
    const id = `${kind}:${mint}`;
    if (this.#inFlight.has(id)) return;
    if (!force) this.#lastAt.set(id, ctx.timers.now());
    this.#inFlight.add(id);
    void f(readers)
      .catch(() => false)
      .then((ok) => {
        this.#inFlight.delete(id);
        this.#count(kind, ok);
      });
  }

  #count(kind: Kind, ok: boolean): void {
    const ctx = this.#ctx;
    if (ctx === null) return;
    const now = ctx.timers.now();
    const day = Math.floor(now / DAY_MS);
    if (day !== this.#day) {
      this.#day = day;
      this.#counts = {};
    }
    const c = (this.#counts[kind] ??= { ok: 0, failed: 0 });
    if (ok) c.ok++;
    else c.failed++;
    ctx.sink.fact(FACT_READS_KEY, { day: new Date(day * DAY_MS).toISOString().slice(0, 10), counts: structuredClone(this.#counts), atMs: now });
  }
}

export interface LiveFactsWiring {
  readonly policy: Policy;
  readonly secrets: Secrets;
  readonly http: HttpClient;
  /** Keyless APIs the worker has no scheduler for yet. */
  readonly goplus: Scheduler;
  readonly coinbase: Scheduler;
  /**
   * Chain volume from DATA-1c's releases: the REST API (GITHUB_RELEASES), github.com downloads (GITHUB_DOWNLOADS) and
   * the worker's state dir for verified days. Without it, live chain volume is unknown.
   */
  readonly github?: { readonly api: Scheduler; readonly downloads: Scheduler; readonly stateDir?: string };
}

/** Mint-history page caps (trial values, configuration): 20 signature pages, then 3 pages and 10 transactions a funder. */
export const MINT_HISTORY_CAPS = { maxPages: 20, funderPages: 3, funderTransactions: 10 } as const;

/** The production source: FACTS-1's readers on the worker's Feed and schedulers, sized from the locked policy. */
export const liveFacts = (w: LiveFactsWiring): LiveFacts => {
  const p = producerOptions(w.policy);
  return new LiveFacts({
    readers: (ctx) => new FactReaders({
      feed: ctx.ingest, http: w.http, timers: ctx.timers, timeoutMs: 10_000,
      rpc: new FactRpc({ url: () => heliusRpcUrl(w.secrets), http: w.http, scheduler: ctx.schedulers.helius, timeoutMs: 10_000 }),
      rugcheck: { scheduler: ctx.schedulers.rugcheck }, goplus: { scheduler: w.goplus },
      jupiter: { scheduler: ctx.schedulers.jupiter, secrets: w.secrets }, coinbase: { scheduler: w.coinbase },
      ...(w.github === undefined ? {} : {
        releases: {
          api: { scheduler: w.github.api }, downloads: { scheduler: w.github.downloads },
          ...(w.github.stateDir === undefined ? {} : { store: fileChainVolumeStore(join(w.github.stateDir, CHAIN_VOLUME_DIR)) }),
          alert: (detail: string) => ctx.sink.fact(CHAIN_VOLUME_ALERT_KEY, { detail, atMs: ctx.timers.now() }),
        },
      }),
    }),
    ...(w.github === undefined ? {} : { chainVolume: { volumeLagDays: w.policy.regime.volumeLagDays, volumeWindowDays: w.policy.regime.volumeWindowDays } }),
    tickMs: 1_000,
    minReadGapMs: 60_000 / ASSUMPTIONS.evaluationsPerMinute,
    survivalAfterMs: p.survivalAfterMs,
    // Well inside the producer's window for a survival read (survivalReadWindowMs after the mark).
    survivalReadDelayMs: Math.min(5_000, Math.floor(p.survivalReadWindowMs / 2)),
    solUsdStartHours: Math.ceil(p.solUsdKeepMs / HOUR_MS),
    mintHistory: { ...MINT_HISTORY_CAPS, insiderSlots: p.insiderSlots, firstBuyers: p.firstBuyers },
  });
};
