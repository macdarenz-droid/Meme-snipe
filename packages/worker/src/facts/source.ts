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
import { HARD_STAGE, RUG_LABELS_UNAVAILABLE, rugCheckFromMs, type EvidenceCode, type HardGate } from '../../../core/src/gates/index.ts';
import { RUG_CHECK_CONFIG, RUG_CONFIG, type RugConfig } from '../../../core/src/config/rugs.ts';
import { OFF_CHAIN } from '../../../core/src/engine/index.ts';
import { P2 } from '../scheduler/index.ts';
import { RpcHttp, rpcHistorySource, type RugCheckRequest } from '../providers/index.ts';
import type { Policy } from '../../../core/src/config/index.ts';
import { producerOptions } from '../../../core/src/facts/index.ts';
import type { ExecStats } from '../../../core/src/facts/raw.ts';
import { heliusRpcUrl, type HttpClient, type Secrets } from '../providers/index.ts';
import type { Scheduler } from '../scheduler/index.ts';
import { ASSUMPTIONS } from './budget.ts';
import { join } from 'node:path';
import { FactReaders, FactRpc, type BatchPart, type BatchRequest, type BatchResult, type SimFn } from './readers.ts';
import { CHAIN_VOLUME_DIR, fileChainVolumeStore } from './volume-store.ts';
import { DEPLOYER_CHECK_SPEND_FILE, DeployerChecks } from './deployer-checks.ts';
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
  /** RUG-1c's deployer check; absent when no history source is wired. */
  readDeployerCheck?(req: RugCheckRequest): Promise<boolean>;
  /** The regime's chain volume (FACTS-1d); absent when no release source is wired. */
  readChainVolume?(regime: ChainVolumeWindow): Promise<boolean>;
  /** H15's round-trip simulation at the candidate's own spend (WORKER-1e); absent when the worker wires none. */
  readSim?(mint: string, spend: bigint): Promise<boolean>;
  /** The worker's own execution statistics onto the feed (`read:exec-health`). */
  ingestExecStats?(stats: ExecStats): void;
  /** READ-COHERENT: a candidate's stage-2 and stage-3 inputs as one coherent batch (`FactReaders.readBatch`). */
  readBatch?(mint: string, req: BatchRequest): Promise<BatchResult>;
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
  /** WORKER-1e: the worker's execution statistics, published every `everyMs` (S0's diagnostic: measured, not judged). */
  readonly execStats?: { readonly read: () => ExecStats | null; readonly everyMs: number };
  /** RUG-1c: H14's look-back and the rug windows, for each check's `rugCheckFromMs`. Without it no deployer is checked. */
  readonly deployerCheck?: { readonly lookbackMs: number; readonly rugs: RugConfig };
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
/** The kinds a batch reads (READ-COHERENT): never on their own while the readers can batch. */
const BATCHED: ReadonlySet<Kind> = new Set<Kind>(['accounts', 'holders', 'holders-all', 'sim', 'xcheck']);
/** Inputs a batch reads again each time, so their age alone never keeps the scan back. */
const AGED: ReadonlySet<string> = new Set(['mint', 'pool', 'lp', 'xcheck', 'sim']);
/** The evaluation stage a reason belongs to: its gate's (an evidence reason's, the gate that needed it); 0 when none. */
const stageOf = (g: CandidateReason): number => {
  const gate = (g.neededBy ?? g.gate) as HardGate;
  return Object.hasOwn(HARD_STAGE, gate) ? HARD_STAGE[gate] : 0;
};
/** H14's detail when the rug half is not covered and the deployer check is missing or not accepted (gates/hard.ts). */
const DEPLOYER_CHECK_DETAIL = `${RUG_LABELS_UNAVAILABLE}: `;

type Kind = 'batch' | 'accounts' | 'holders' | 'holders-all' | 'xcheck' | 'mint-history' | 'sim' | 'survival' | 'sol-usd' | 'chain-volume' | 'deployer-check';

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
    else if (g.input === 'sim') out.add('sim');
    else if (g.input === 'holders') out.add(g.code === 'not-covered' ? 'holders-all' : 'holders');
    // H14's rug half not covered and its deployer check missing or not accepted (RUG-1c): check the deployer. The
    // creates half (also input `coverage`) is not something a deployer check can cover, so it reads nothing.
    else if (g.input === 'coverage' && g.code === 'not-covered' && g.neededBy === 'H14' && g.detail?.startsWith(DEPLOYER_CHECK_DETAIL) === true) out.add('deployer-check');
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
  #execAt = Number.NEGATIVE_INFINITY;
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
    const exec = this.#o.execStats;
    if (exec !== undefined && now - this.#execAt >= exec.everyMs) {
      const s = exec.read();
      if (s !== null && this.#readers?.ingestExecStats !== undefined) {
        this.#execAt = now;
        this.#readers.ingestExecStats(s);
      }
    }
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
      const kinds = readsFor(c.gates);
      const batch = this.#readers?.readBatch === undefined ? null : this.#batchFor(mint, c.gates ?? [], kinds, c.spend);
      for (const kind of kinds) if (batch === null || !BATCHED.has(kind)) this.#read(kind, mint, now, c.spend, c.creator ?? null);
      if (batch !== null) this.#read('batch', mint, now, c.spend, null, batch);
    }
    for (const [mint, at] of this.#survival) {
      if (now < at + this.#o.survivalAfterMs + this.#o.survivalReadDelayMs) continue;
      this.#survival.delete(mint);
      this.#survivalDone.add(mint);
      this.#run('survival', mint, (r) => r.readAccounts(mint), true);
    }
  }

  /**
   * READ-COHERENT: the batch a candidate's reasons call for, or null when they call for none of its inputs. Every input
   * judged at one moment is read again in it, whichever one the reasons named, since all of them age together: the
   * accounts (mint, pool, LP) and the cross-checks always; once the candidate has passed stage 2, its holder view and
   * simulation too. The complete scan, as before, only once the bounded view was the last input missing (not covered)
   * and, from then on, while nothing but those inputs' age or the holder view stands in the way.
   */
  #batchFor(mint: string, gates: readonly CandidateReason[], kinds: readonly Kind[], spend: bigint | null): BatchRequest | null {
    if (!kinds.some((k) => BATCHED.has(k))) return null;
    if (kinds.includes('holders-all')) this.#scanTurn.add(mint);
    if (gates.some((g) => stageOf(g) >= 3)) this.#stage3.add(mint);
    if (!this.#stage3.has(mint)) return { holders: null, spend: null, xcheck: true };
    const scan = this.#scanTurn.has(mint) && gates.every((g) => g.input === 'holders' || (g.code === 'stale' && g.input !== undefined && AGED.has(g.input)));
    return { holders: scan ? 'all' : 'largest', spend, xcheck: true };
  }

  /** Candidates that have passed stage 2, and those whose bounded holder view was judged not enough (READ-COHERENT). */
  readonly #stage3 = new Set<string>();
  readonly #scanTurn = new Set<string>();

  #read(kind: Kind, mint: string, now: number, spend: bigint | null = null, creator: string | null = null, batch: BatchRequest | null = null): void {
    const last = this.#lastAt.get(`${kind}:${mint}`);
    if (last !== undefined && now - last < this.#o.minReadGapMs) return;
    switch (kind) {
      case 'batch': {
        if (batch === null) return;
        // Counted per part under the kinds it replaces, so the coverage report reads as before.
        return this.#run(kind, mint, async (r) => {
          const parts = r.readBatch === undefined ? null : await r.readBatch(mint, batch).catch(() => null);
          const asked: [BatchPart, boolean][] = parts === null ? [['accounts', false]] : (Object.entries(parts) as [BatchPart, boolean][]);
          for (const [part, ok] of asked) this.#count(part, ok);
          return null;
        });
      }
      case 'accounts': return this.#run(kind, mint, (r) => r.readAccounts(mint));
      case 'holders': return this.#run(kind, mint, (r) => r.readHolders(mint));
      case 'holders-all': return this.#run(kind, mint, (r) => r.readHoldersAll(mint));
      case 'xcheck': return this.#run(kind, mint, async (r) => (await r.readCrossChecks(mint)).some(Boolean));
      case 'sim': {
        // At the spend the evaluation sized: H15 refuses a simulation at any other.
        if (spend === null) return;
        return this.#run(kind, mint, (r) => r.readSim?.(mint, spend) ?? Promise.resolve(false));
      }
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
      case 'deployer-check': {
        const ctx = this.#ctx;
        const tip = ctx?.tip() ?? null;
        const w = this.#o.deployerCheck;
        // Point in time, for a known creator, with the index's prior mints: otherwise nothing to check yet.
        if (ctx === null || tip === null || creator === null || w === undefined || ctx.priorMints === undefined) return;
        const fromMs = rugCheckFromMs(now - w.lookbackMs, w.rugs);
        const mints = ctx.priorMints(creator, now).filter((m) => m.mint !== mint && m.createdAtMs >= fromMs);
        const asOf = { slot: tip, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: now };
        return this.#run(kind, mint, (r) => (r.readDeployerCheck === undefined ? Promise.resolve(false) : r.readDeployerCheck({ creator, mints, fromMs, asOf, asOfMs: now })));
      }
      default: return;
    }
  }

  /** Runs one read, single flight per kind and mint; `f` answering null has counted its own parts (a batch). */
  #run(kind: Kind, mint: string, f: (r: LiveReaders) => Promise<boolean | null>, force = false): void {
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
        if (ok !== null) this.#count(kind, ok);
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
  /** H15's round-trip simulation (WORKER-1e, `simReader`); without it H15 rejects every candidate live. */
  readonly sim?: (ctx: FactContext) => SimFn;
  /** The paper world's execution statistics (WORKER-1e, S0's diagnostic only); without it no exec-health fact is made. */
  readonly execStats?: () => ExecStats | null;
  /** The worker's state dir: the deployer checks keep their daily spend there across restarts. */
  readonly stateDir?: string;
}

/** How often the paper execution statistics are published: logged, never judged, so freshness does not bind it. */
export const EXEC_STATS_EVERY_MS = 10_000;


/** Mint-history page caps (trial values, configuration): 20 signature pages, then 3 pages and 10 transactions a funder. */
export const MINT_HISTORY_CAPS = { maxPages: 20, funderPages: 3, funderTransactions: 10 } as const;

/** The readers with H15's simulation, its answer going onto the feed through the readers' own `ingestSim`. */
const withSim = (r: FactReaders, sim: SimFn | undefined): LiveReaders => {
  if (sim === undefined) return r;
  r.simulate = sim;
  return Object.assign(r, { readSim: (mint: string, spend: bigint) => sim(mint, spend, (read) => r.ingestSim(read)) });
};

/** The production source: FACTS-1's readers on the worker's Feed and schedulers, sized from the locked policy. */
export const liveFacts = (w: LiveFactsWiring): LiveFacts => {
  const p = producerOptions(w.policy);
  return new LiveFacts({
    readers: (ctx) => withSim(new FactReaders({
      feed: ctx.ingest, http: w.http, timers: ctx.timers, timeoutMs: 10_000,
      rpc: new FactRpc({ url: () => heliusRpcUrl(w.secrets), http: w.http, scheduler: ctx.schedulers.helius, timeoutMs: 10_000 }),
      rugcheck: { scheduler: ctx.schedulers.rugcheck }, goplus: { scheduler: w.goplus },
      jupiter: { scheduler: ctx.schedulers.jupiter, secrets: w.secrets }, coinbase: { scheduler: w.coinbase },
      // RUG-1c: each check's RPC goes through the Helius scheduler at P2, under the per-candidate and daily credit caps,
      // cached per creator for the life of the readers.
      deployerChecks: new DeployerChecks({
        history: rpcHistorySource(new RpcHttp({ provider: 'helius', url: () => heliusRpcUrl(w.secrets), http: w.http, scheduler: ctx.schedulers.helius, timeoutMs: 10_000 }), P2),
        rugs: RUG_CONFIG, config: RUG_CHECK_CONFIG, minGapMs: 60_000 / ASSUMPTIONS.evaluationsPerMinute,
        ...(w.stateDir === undefined ? {} : { spendFile: join(w.stateDir, DEPLOYER_CHECK_SPEND_FILE) }),
      }),
      ...(w.github === undefined ? {} : {
        releases: {
          api: { scheduler: w.github.api }, downloads: { scheduler: w.github.downloads },
          ...(w.github.stateDir === undefined ? {} : { store: fileChainVolumeStore(join(w.github.stateDir, CHAIN_VOLUME_DIR)) }),
          alert: (detail: string) => ctx.sink.fact(CHAIN_VOLUME_ALERT_KEY, { detail, atMs: ctx.timers.now() }),
        },
      }),
    }), w.sim?.(ctx)),
    ...(w.execStats === undefined ? {} : { execStats: { read: w.execStats, everyMs: EXEC_STATS_EVERY_MS } }),
    deployerCheck: { lookbackMs: w.policy.gates.deployerRugLookbackDays * DAY_MS, rugs: RUG_CONFIG },
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
