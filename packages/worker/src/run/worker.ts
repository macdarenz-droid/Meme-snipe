// The always-on paper worker (WORKER-1, docs/ARCHITECTURE.md §12.4, §20): the shared engine on the live Feed, with the
// market recorder and the dry-run simulation from its first minute, the ledger, the journal, the loopback health and
// drill endpoint, the signed heartbeat and the watchdog's pause. Paper only: no signing key exists, nothing is sent.
//
// Start order: journal `start` → ledger restore (the stored book events are fed back to the engine as recorded world
// frames, then `restart`) → reconcile every open intent through the paper world → journal `reconcile` and write
// `open_intents` → seed the deployer index (SEED-1's hook) → start the live sources → trade. Nothing enters before the
// reconcile line; a reconcile that cannot settle every intent exits 3.
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { journalLines, placeBookingsAt } from './booked.ts';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { PolicySession, RugConfig } from '../../../core/src/config/index.ts';
import { compareEvents, compareMoments, Engine, type LogRecord, type MarketEvent, type Moment, OFF_CHAIN } from '../../../core/src/engine/index.ts';
import { Ledger, openLedger } from '../../../core/src/ledger/index.ts';
import type { Book, BookEvent } from '../../../core/src/lifecycle/index.ts';
import { isTerminal, isUnresolved } from '../../../core/src/lifecycle/index.ts';
import { attemptFee, type FillNetwork, type FillScenario, lateFillOf } from '../../../core/src/fills/index.ts';
import type { MicroUsd } from '../../../core/src/units/index.ts';
import { EXIT, LOOKUP_BOUNDS_MS, STATE_FILES, type FeedHealth, type Health, type JournalKind, type QuotaStatus, type RecoveredFields } from '../../../runner/src/contract.ts';
import type { DryRunRecord } from '../dryrun/index.ts';
import { CANDIDATE_RESTORED, NO_UNIVERSE, type SavedGraduates, type SavedTail, resolveUniverse, sellOnlyReason } from '../engine/strategy.ts';
import { RAW } from '../../../core/src/facts/raw.ts';
import { GRADUATES_SEED_KEY } from '../../../core/src/facts/producer.ts';
import { ACCOUNT_KEY, HALT_KEY, LiveStrategy, unwrap, POOL_PREFIX, RESTORE_KEY, SEED_KEY, SEEDING, SHORTLIST, SNAPSHOT_PREFIX, SOL_PRICE_KEY, type SnapshotFact, type CarryFact, CARRY_PREFIX, type MarketChoice, chooseMarket, parseCarryFact, type StrategyConfig, type StrategyDeps, type SavedStateRef, TRIP_PREFIX, parseSnapshotFact, snapshotKey, snapshotWins } from '../engine/strategy.ts';
import { SLOT_MS, watchTimingProblem } from './config.ts';
import { PositionWatch, type WatchRead } from './watch.ts';
import { DEFAULT_LIVE_FEED, type Frame, HELIUS_EXHAUSTED, type HttpClient, LiveFeed, type Release, seqId } from '../providers/index.ts';
import type { Timers } from '../scheduler/timers.ts';
import { PaperAccount, type PaperLegs, accountFile } from './account.ts';
import type { WorkerConfig } from './config.ts';
import { Desk, FILL_RATE_UNKNOWN, journaledFillKeys, lineRate, lineReasons, openIntents } from './desk.ts';
import { DeployerStore, liveWatchToClose, type SavedDeployers } from './deployer-store.ts';
import { CoverageJournal } from './coverage-journal.ts';
import { rebuildMove } from './exposure.ts';
import { backfillAddress, SIGNATURE_PAGE, type SeedRpc } from '../seed/rpc.ts';
import { transactionEvents } from '../../../core/src/chain/index.ts';
import { P2, P3 } from '../scheduler/scheduler.ts';
import { callCost } from '../providers/solana-http.ts';
import { PUMP_MIGRATION_AUTHORITY } from './sources.ts';
import { DelayProbe, type DelayProbeOptions } from './delay-probe.ts';
import { type AlertSeen, type ApiInputs, type DecisionRow, checkOf, collectAlerts, melbourneDate, stageOf, startApiServer } from './api.ts';
import type { FactContext, FactSource } from './facts.ts';
import { engineFeed, type EngineFeed } from './engine-feed.ts';
import { startHealthServer } from './health.ts';
import { type HeartbeatPosition, heartbeatBody, sendHeartbeat } from './heartbeat.ts';
import { crashSite } from './crash-site.ts';
import { type DeathMem, MEM_EVERY_MS, cgroupMax, deathMem, fatalReport, nearLimit, parseDeathMem, readMem, sampleMem, writeMem } from './mem-trace.ts';
import { Summarizer, SummaryClock } from './summary.ts';
import { CappedMap } from './capped-map.ts';
import { jsonText } from './json.ts';
import { Journal } from './journal.ts';
import { type PaperMarket, type PaperState, PaperWorld, type SimLeg } from './paper-world.ts';
import { Recorder, sealLeftovers } from './recorder.ts';
import { entryPrice, openPositionsHealth } from './open-positions.ts';
import { type RiskInput, evaluateExit, riskSnapshot } from '../../../core/src/risk/index.ts';
import { latchable, markSettings, riskAccount } from '../engine/marks.ts';
import type { DeployerIndex, DeployerIndexState, RugLabeller, RugLabellerState } from '../../../core/src/gates/index.ts';
import { PERSIST_FILE, fileSha256, loadState, packFile, saveState, zstdContentHash, type SavedCandidateState } from '../persist/index.ts';
import type { CreateLookup } from './sources.ts';

/** PERSIST-1's saved deployer state in the worker's state dir, and how often it is written. */
export { PERSIST_FILE } from '../persist/index.ts';
/** RESTART-KEEP: the downtime migrations' credit cap. */
export const DOWNTIME_CREDIT_CAP = 3_000;
/** RESTART-KEEP: transactions read before a migration to find its curve's completion. */
const COMPLETION_READS = 5;
export const PERSIST_EVERY_MS = 5 * 60_000;
/** STATE-DEDUPE: the recorder folder holding each distinct saved state once, packed, named by the sha256 of its plain bytes. */
export const SAVED_STATES = 'saved-state';
import { type Control, NO_CONTROL, type Restart, StateFile, controlFile, exitsFile, seedsFile, exposedFile, NO_EXPOSED, exitKind, restartsAfterBoot, restartsFile } from './state.ts';
import { LOG_CREATE_PREFIX, type PoolFact, S0_DIAGNOSTIC_PARTS, TX_CREATE_PREFIX, parsePool } from '../../../core/src/gates/index.ts';
import type { ExecStats } from '../../../core/src/facts/raw.ts';

/** POS-1: a pool fact flagged beyond backfill or dedupe (a stale swap stream) is never priced from. */
const flagged = (p: PoolFact): boolean => p.obs.quality.some((q) => q !== 'backfilled' && q !== 'deduplicated');
import { type PoolFeeContext, effectiveQuoteReserve, poolSell } from '../../../core/src/amm/index.ts';
import { liveCollapse, liveRetention } from './store-rules.ts';

/** The halt reason while the book holds a late buy's position, which paper does not settle yet (risk ruling on #133). */
export const LATE_BUY = 'late buy not settled by paper; entries off';
/** The halt reason while WATCH-1's second price path cannot serve (not configured, or its budget halted). */
export const SECOND_PATH_UNAVAILABLE = 'second price path unavailable';
/** The window the paper execution statistics cover (WORKER-1e). */
export const EXEC_STATS_WINDOW_MS = 86_400_000;

/** An entry between reservation and its outcome: WATCH-1 keeps its pool's market fresh for the moment it lands. */
const ENTRY_IN_FLIGHT: ReadonlySet<string> = new Set(['exposure_reserved', 'prepared', 'signed', 'submitted', 'pending', 'unknown', 'confirmed_fill']);

/** One live source the worker runs (a provider stream). Its name is a health feed name, fixed for the whole run. */
export interface FeedSource {
  readonly name: string;
  /** Losing it halts entries (§18 "data freezes"); exits and monitoring go on. */
  readonly critical: boolean;
  /** The Frame `source` values this feed delivers (for its age). */
  readonly sources: readonly string[];
  start(): void;
  stop(): void;
}

export interface SourcesContext {
  readonly feed: LiveFeed;
  readonly timers: Timers;
  /** The pools to watch for swaps: candidates' and open positions' (the strategy's `watchedPools`). */
  readonly pools: () => ReadonlyMap<string, { readonly mint: string; readonly held: boolean; readonly fromSlot?: bigint }>;
  /** Writes a journal line (S0-ZERO: each in-run fill of a pool's trade gap, `trades_fill`). */
  readonly journal?: (kind: 'trades_fill', fields: Readonly<Record<string, unknown>>) => void;
}

export interface WorkerDeps {
  readonly config: WorkerConfig;
  /**
   * The boot id; default `<start time base36>-<pid>`. It names the recorder folder and seeds the paper world's fill
   * draws (`paper:<boot>`), so tests pin it: with the pid in it, whether a drawn landing tail or drop happens depended
   * on the test process's pid.
   */
  readonly boot?: string;
  readonly session: PolicySession;
  readonly rugs: RugConfig;
  readonly strategy: StrategyConfig;
  /** Test seam: replaces the strategy's position marking (marks.ts `markedHistory`). */
  readonly markedHistory?: StrategyDeps['markedHistory'];
  /** Test seam: replaces the strategy's entry-size probe result (`StrategyDeps.sizeProbe`). */
  readonly sizeProbe?: StrategyDeps['sizeProbe'];
  readonly scenario: FillScenario;
  readonly network: FillNetwork;
  readonly timers: Timers;
  /** Builds the live sources on the feed (tests pass scripted ones). Started only after the reconcile. */
  readonly sources: (ctx: SourcesContext) => readonly FeedSource[];
  /** Live fact producers (FACTS-1, RUG-1c): started after the reconcile and the deployer seed, before the feeds. */
  readonly facts?: readonly FactSource[];
  /** The provider schedulers producers must use. */
  readonly schedulers?: FactContext['schedulers'];
  /** TEST-2's dryRunTrade for one leg (used when simulation is on). */
  readonly simulate: (leg: SimLeg) => Promise<DryRunRecord>;
  /**
   * Fetches a transaction at confirmed and puts it on the feed; resolves true when it was found. Used for a shortlisted
   * mint's create (item 9: live H9, H12–H14 need the confirmed create) and for a cut trade log on a rug-covered stream.
   */
  readonly fetchTx: (signature: string, why: 'create' | 'cut-log' | 'restore') => Promise<boolean>;
  /**
   * RESTART-KEEP: signature reads on SEED-1's RPC, charged to the fill budget: the migrations of a restart's downtime.
   * Without it they are not read: coins that migrated while the worker was down are not candidates.
   */
  readonly restartReads?: { readonly rpc: SeedRpc; readonly budget: { remaining(nowMs: number): number; spend(credits: number, nowMs: number): void; refund(credits: number, nowMs: number): void } };
  /** Test seam: the pack of the recording's saved-state copy (persist's `packFile` unless a test holds it open). */
  readonly pack?: typeof packFile;
  /**
   * CREATE-AFTER-RESTART: looks up a shortlisted mint's create that neither this process nor the saved store holds
   * (sources.ts `findCreate`, under the fills' daily budget). Without it such a create waits, as before.
   */
  readonly findCreate?: (mint: string) => Promise<CreateLookup>;
  /**
   * SEED-1: the deployer index's seed (first start: days and RPC up to the live creates watch's first slot) or the
   * downtime fill (restart from saved state), built by `buildSeed`. `untilSlot` is null when the live watch did not
   * start in time; the worker then marks the downtime as a gap itself.
   */
  readonly seed: (o: SeedRequest) => Promise<SeedResult>;
  /** How long the start waits for the live creates watch's first slot before seeding without it. */
  readonly seedWaitMs: number;
  /**
   * The longest the start waits for the seed or the downtime fill; past it the downtime reads as a gap. The loop, and
   * every exit, waits for the seed (rehearsal 37148935094: a slow seed held the start for minutes).
   */
  readonly seedMaxMs?: number;
  /** The most create signatures kept (default `CREATE_SIGS_MAX`; a test passes a small one). */
  readonly createSigsMax?: number;
  /**
   * RESTART-CAUSE: 'reconcile' for the unit's `--reconcile` pre-step: its start line is marked, it records no restart,
   * and it hands its reading of the previous exit to the main boot.
   */
  readonly phase?: 'reconcile';
  /** The seed cap when no saved index restores (default `MAX_SEED_CREATES`; a test passes a small one). */
  readonly maxSeedCreates?: number;
  /** BT-1c's delay samples (the recorder's `delays` table): the confirmed read and the sampled processed watch. */
  readonly delayProbe?: { readonly confirmed: DelayProbeOptions['confirmed']; readonly via: string; readonly everyMs: number };
  /**
   * HELIUS-EXHAUSTED: Helius's answer that its credits are used up, as the Helius scheduler holds it (since boot): while
   * `exhausted`, entries halt (`HELIUS_EXHAUSTED`); the count and first time go in the daily summary.
   */
  readonly heliusExhaustion?: () => { readonly exhausted: boolean; readonly count: number; readonly firstAtMs: number | null };
  /** RUN-1c's quota (free-plan providers, credits since boot by class) and historical-lookup latency counts. */
  readonly ops?: () => { readonly quota: readonly QuotaStatus[]; readonly lookups: { readonly counts: readonly number[] } };
  /** RUN-1d's drop-rpc drill: refuses every RPC call for `ms` (main wraps the providers' HTTP in an RpcCut). */
  readonly cutRpc?: (ms: number) => void;
  /** RUN-1c's exposure rebuild: chain history reads (Helius) for each exposed trade's pool. */
  readonly exposureRpc?: SeedRpc;
  /** The commitment each live path uses, for the recorder manifest. */
  readonly commitments?: Readonly<Record<string, string>>;
  readonly heartbeat: { readonly http: HttpClient; readonly key: string | null; readonly ownerChatId: string | null };
  /** How long the start reconcile may take before it exits 3. */
  readonly reconcileTimeoutMs: number;
  /** Engine loop period. */
  readonly loopMs: number;
  /** A critical feed with no frame for this long is stale (entries halt). */
  readonly staleFeedMs: number;
  /** Plain status lines for the process log (never a key or a URL). */
  readonly log: (line: string) => void;
  /**
   * TEST-3's fault seam: every paper-world answer (send result, status, balance read) passes through it on its way to
   * the feed. Null loses it (an API call that timed out after the send); another event replaces it. Tests only.
   */
  readonly worldFault?: (event: BookEvent) => BookEvent | null;
  /** OPS-SUMMARY's fault seam: called before each summary reads the worker's state; a throw fails that summary. Tests only. */
  readonly summaryFault?: () => void;
  /** Test seam: the desk calls it right after each of a fill's two durable writes (ARCHITECTURE §12.4). */
  readonly crashPoint?: (point: 'fill-journaled' | 'fill-committed', intentId: string) => void;
  /**
   * WATCH-1's second path: one getMultipleAccounts at confirmed through the quota scheduler at P1, on a provider other
   * than the live feed's (Alchemy). Without it every stale held position raises the critical alert.
   */
  readonly watchRead?: (addresses: readonly string[], minContextSlot: bigint | null) => Promise<WatchRead>;
  /** True while the second path's provider budget is halted (its scheduler's haltShare): entries stop. */
  readonly watchHalted?: () => boolean;
}

export interface SeedRequest {
  readonly saved: SavedDeployers;
  /** The saved live watch to close (its open gap, or the watch), for a fill; null on a first start. */
  readonly close: { readonly via: string; readonly fromSlot: bigint | null } | null;
  readonly untilSlot: bigint | null;
  /** The live watch's `coverage:creates:start` moment as the feed placed it; null when it did not start in time. */
  readonly liveStart: Moment | null;
  readonly asOf: Moment;
  /** Aborted when the worker stops waiting for this seed (seedMaxMs, or a stop): no RPC page is fetched after it. */
  readonly signal: AbortSignal;
}

export interface SeedResult {
  readonly mode: 'seed' | 'fill' | 'none';
  readonly creates: readonly MarketEvent[];
  readonly coverage: readonly MarketEvent[];
  readonly report: string;
}

export type StartResult = { readonly ok: true } | { readonly ok: false; readonly code: number; readonly message: string };

interface FeedState {
  readonly src: FeedSource;
  connected: boolean;
  last: number | null;
  droppedUntil: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Refused API commands journaled one by one per minute; more are counted on one line. */
export const COMMAND_LINES_PER_MINUTE = 10;
const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : 'error');
/**
 * The most saved creates a start seeds the index with when no saved index restores (WORKER-GROW): about three days of
 * creates, which a boot holds well under MemoryMax (measured: docs/DECISIONS.md, WORKER-GROW G4b). Past it the seed is refused whole.
 */
export const MAX_SEED_CREATES = 200_000;

/** Present while the state dir began empty and no full start has journaled its `recovered` line yet. */
const COLD_START = 'cold_start';
/** CREATE-AFTER-RESTART: the wait before the one retry of a create lookup stopped by a transient error. */
export const CREATE_RETRY_MS = 60_000;
/** A saved create's id, live (`log:<signature>…`) or fetched (`ev:<signature>:…`): its transaction signature. */
const CREATE_ID = /^(?:log|ev):([1-9A-HJ-NP-Za-km-z]{64,88})(?=[:#]|$)/;

/** The most create signatures (CREATE-AFTER-RESTART) and token symbols a process keeps, oldest forgotten first. */
export const CREATE_SIGS_MAX = 200_000;
export const SYMBOLS_MAX = 200_000;
/** RESTART-KEEP: the most curve-completion and migration signatures kept, each. */
export const TX_SIGS_MAX = 200_000;

/** A create event's mint and signature (the field, else the id), or null when it is not a create or names neither. */
const createSigOf = (e: MarketEvent): readonly [string, string] | null => {
  const mint = e.key.startsWith(LOG_CREATE_PREFIX) ? e.key.slice(LOG_CREATE_PREFIX.length) : e.key.startsWith(TX_CREATE_PREFIX) ? e.key.slice(TX_CREATE_PREFIX.length) : null;
  const sig = isObj(e.value) && typeof e.value['signature'] === 'string' ? e.value['signature'] : CREATE_ID.exec(e.id)?.[1];
  return mint !== null && mint !== '' && sig !== undefined ? [mint, sig] : null;
};

/**
 * The `entry` and `exit` lines of a journal file (none when it is missing); torn or unreadable lines are skipped. The
 * journal of a long run is large and this runs at every boot, so it is streamed in chunks (`journalLines`) and only
 * fill lines are parsed: never the whole file in memory at once.
 */
export const readJournalFills = (path: string, chunkBytes?: number): Record<string, unknown>[] => {
  if (!existsSync(path)) return [];
  const out: Record<string, unknown>[] = [];
  for (const l of journalLines(path, chunkBytes)) {
    if (!l.includes('"kind":"entry"') && !l.includes('"kind":"exit"')) continue;
    try {
      out.push(JSON.parse(l) as Record<string, unknown>);
    } catch {
      // a torn line
    }
  }
  return out;
};

/** RESTART-CAUSE: the `--reconcile` pre-step's reading of the previous exit, for the main boot that follows it. */
export const EXIT_HANDOFF = 'last_exit.json';

/** The pre-step's handoff, read and removed: its reading when recent and well formed (null is a first start), else undefined. */
export const takeHandoff = (path: string, nowMs: number, onMem?: (mem: DeathMem | null) => void): string | null | undefined => {
  if (!existsSync(path)) return undefined;
  let out: string | null | undefined;
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as { exit?: unknown; at?: unknown; mem?: unknown };
    if ((typeof m.exit === 'string' || m.exit === null) && typeof m.at === 'number' && nowMs - m.at >= 0 && nowMs - m.at < PLANNED_RESTART_MS) {
      out = typeof m.exit === 'string' ? m.exit.slice(0, 300) : null;
      // MEM-SUMMARY: the dead process's memory as the pre-step read it (numbers only, checked again here).
      onMem?.(parseDeathMem(m.mem ?? null));
    }
  } catch {}
  rmSync(path, { force: true });
  return out;
};

/** A planned restart's marker younger than this is believed; an older one is stale (its kill never came). */
export const PLANNED_RESTART_MS = 10 * 60_000;

/**
 * RESTART-ALERT: the runner's marker for a drill's kill or reboot, read and removed at boot: `planned: <cause>` when it
 * is recent and well formed, else null (the journal's reading stands).
 */
export const plannedRestart = (path: string, nowMs: number): string | null => {
  if (!existsSync(path)) return null;
  let out: string | null = null;
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as { cause?: unknown; at?: unknown };
    if (typeof m.cause === 'string' && m.cause !== '' && typeof m.at === 'number' && nowMs - m.at >= 0 && nowMs - m.at < PLANNED_RESTART_MS) out = `planned: ${m.cause.slice(0, 80)}`;
  } catch {}
  rmSync(path, { force: true });
  return out;
};

/** `no clean stop`, with how the memory stood at the death when that is known (MEM-TRACE). */
export const withMemNote = (exit: string, note: string | null): string => (note === null ? exit : `${exit} (${note})`);

export class Worker {
  readonly #d: WorkerDeps;
  readonly #boot: string;
  /** How the previous process ended (RESTART-ALERT): a planned restart's marker, else the journal's last line. */
  readonly #lastExit: string | null;
  /** MEM-SUMMARY: the previous process's memory at its death, when it left no stop line (`deathMem`), else null. */
  #deathMem: DeathMem | null = null;
  readonly #restartsFile: ReturnType<typeof restartsFile>;
  #restarts: readonly Restart[];
  readonly #started: number;
  readonly #journal: Journal;
  #recorder: Recorder | null = null;
  /**
   * The recorder's first failure (a full disk, ENOSPC): recording stops, entries halt for the rest of the process and
   * the alert goes up; exits and the rest of the worker go on. Never a crash, so a disk that stays full is no crash loop.
   */
  #recorderFault: string | null = null;
  /** API command refusals journaled in the current minute, and those counted only (see `#commandRefused`). */
  readonly #refusals = { since: -Infinity, written: 0, dropped: 0 };
  readonly #ledger: Ledger;
  readonly #control: StateFile<Control>;
  readonly #exitsFile: ReturnType<typeof exitsFile>;
  readonly #seedsFile: ReturnType<typeof seedsFile>;
  #savedSeeds = '';
  readonly #account: PaperAccount;
  readonly #feed: LiveFeed;
  readonly #facts: EngineFeed;
  readonly #strategy: LiveStrategy;
  readonly #engine: Engine;
  readonly #world: PaperWorld;
  readonly #desk: Desk;
  readonly #feeds = new Map<string, FeedState>();
  readonly #drillToken: string;
  #ctl: Control;
  #reconciled = false;
  #lastSlot: bigint | null = null;
  /** When `#lastSlot` was released (WATCH-1d holds a snapshot's bank to a live head). */
  #lastSlotAt: number | null = null;
  #ticked: bigint | null = null;
  #solPrice: MicroUsd | null = null;
  /** Whether this process settled at its first SOL price after the reconcile (a stray fee needs a price; PAPER-1). */
  #pricedSettle = false;
  /** When that price was seen (its fact's `atMs`), for risk's freshness check in the account marks. */
  #solPriceAt: number | null = null;
  /** RISK-FAULT: why risk last could not value the account, while it still cannot (logged once per episode). */
  #valuationFault: string | null = null;
  /** The journal's `entry` and `exit` lines at start (WORKER-ORDER). */
  readonly #fillLines: Record<string, unknown>[];
  /** Fills the ledger holds and account.json does not, recorded once a SOL price is known. */
  #accountBehind: { readonly positionId: string; readonly purpose: 'entry' | 'exit' }[] = [];
  #pools = new Map<string, unknown>();
  /** When each mint's latest pool fact was released to the engine (WATCH-1 judges a feed fact by its release). */
  readonly #poolReleasedAt = new Map<string, number>();
  /** WATCH-1c: each mint's latest carry (its pool state proven unchanged through a slot) and when it was released. */
  readonly #carries = new Map<string, { readonly carry: CarryFact; readonly releasedAt: number }>();
  #fees = new Map<string, PoolFeeContext>();
  /** WATCH-1's latest snapshot per held mint, as released. */
  #snapshots = new Map<string, SnapshotFact>();
  #watch: PositionWatch | null = null;
  /** Positions open at the last step (WATCH-1 reads once when one opens). */
  #opened = new Set<string>();
  /** CREATE-AFTER-RESTART: each known create's signature by mint, the newest CREATE_SIGS_MAX. */
  readonly #createSig: CappedMap<string, string>;
  /** RESTART-KEEP: each mint's curve completion and migration transactions, as seen (logs or fetched). */
  readonly #completeSig = new CappedMap<string, string>(TX_SIGS_MAX);
  readonly #migrationSig = new CappedMap<string, string>(TX_SIGS_MAX);
  /** RESTART-KEEP: the saved state's slot (the downtime's migrations are looked up after it); null on a fresh start. */
  #downtimeFrom: bigint | null = null;
  /** RESTART-KEEP: restored candidates whose transactions wait for the sources to start. */
  readonly #restoredMints: string[] = [];
  /** Mints shortlisted while the seed is being built, with no create signature yet: the downtime fill may bring it. */
  #createPending: string[] = [];
  /** Mints whose create this process has looked up (once each). */
  readonly #createLookups = new Set<string>();
  /** Watches that carry rug coverage (`coverage:rugs:start` vias): a cut log on one is a gap until its transaction is read. */
  #rugVias = new Set<string>();
  #intentAt = new Map<string, number>();
  /** Entries start halted: nothing enters before the first feed check says otherwise. */
  #halted: readonly string[] = ['starting'];
  /** SEED-1's seed is not placed yet: entries halt (SEEDING), exits run. */
  #seeding = false;
  /** A ledger/book divergence: a halt reason for the rest of the process. */
  #diverged: readonly string[] = [];
  /** Critical alerts the engine raised since boot (code and subject, first time seen), newest last; memory only. */
  #alerts: AlertSeen[] = [];
  #savedExits = '';
  #probe: DelayProbe | null = null;
  #rpcDownUntil = 0;
  /** Halt reasons for the whole process: open positions whose universe the policy lacks. */
  readonly #sellOnly: string[] = [];
  /** The reconcile-only process: the engine takes nothing after the reconcile. */
  #observing = false;
  #exposedFile: ReturnType<typeof exposedFile>;
  readonly #coverageJournal = new CoverageJournal((fields) => this.#journal.write('coverage_gap', fields));
  readonly #deployerStore: DeployerStore;
  readonly #saved: SavedDeployers;
  /** The live creates watch's first slot (its `coverage:creates:start`), for the seed's `untilSlot`. */
  #liveStart: bigint | null = null;
  /** The moment the feed placed that start at (SEED-1's fill dates its close from it). */
  #liveStartAt: Moment | null = null;
  /** The empty slot the reconcile reserved for SEED-1's events (see `#seedIndex`). */
  #reserved: bigint | null = null;
  /** PERSIST-1: the saved index and labeller this process restores (null on a fresh start). */
  #restored: { readonly asOf: Moment; readonly ref: SavedStateRef } | null = null;
  /** The restored index and labeller, given once to the strategy when it applies the seed that names them. */
  #handoff: { readonly ref: SavedStateRef; readonly index: DeployerIndex; readonly labeller: RugLabeller } | null = null;
  /** G4c: the recording's plain saved-state copy this boot restored from, packed at start. */
  #unpacked: { readonly path: string; readonly sha256: string; readonly bytes: number } | null = null;
  /** The pack of the recording's saved-state copy, while it runs beside the start (a stop waits for it). */
  #packing: Promise<void> | null = null;
  #lastSaveMs = 0;
  #saveRefused = false;
  #beatSeq = 0;
  #loop: ReturnType<Timers['setTimeout']> | null = null;
  #beat: ReturnType<Timers['setTimeout']> | null = null;
  #memTimer: ReturnType<Timers['setTimeout']> | null = null;
  readonly #cgroupMax = cgroupMax();
  #summaryClock: SummaryClock | null = null;
  #summary: Summarizer | null = null;
  #server: Server | null = null;
  #api: Server | null = null;
  /** The app's views: recent candidate decisions, the funnel, token symbols seen on creates. */
  readonly #rows: DecisionRow[] = [];
  readonly #funnel = { fromMs: 0, stage: new Map<string, { day: string; stage: number; check: string | null }>(), enteredByDay: new Map<string, number>() };
  readonly #symbols = new CappedMap<string, string>(SYMBOLS_MAX);
  #stopping = false;
  /** The code of the stop under way (the first `stop` call's). */
  #stopCode: number = EXIT.clean;
  #stoppingNow: (code: number) => void = () => {};
  #stoppedNow: (code: number) => void = () => {};
  /** Resolves with the stop's code when a stop begins (a signal, a refused start or a loop crash). */
  readonly stopping = new Promise<number>((r) => (this.#stoppingNow = r));
  /** Resolves with the stop's code once the stop has finished: the entry exits with it (a loop crash exits 1). */
  readonly stopped = new Promise<number>((r) => (this.#stoppedNow = r));
  #sources: readonly FeedSource[] = [];

  constructor(d: WorkerDeps) {
    this.#d = d;
    this.#createSig = new CappedMap<string, string>(d.createSigsMax ?? CREATE_SIGS_MAX);
    const c = d.config;
    const now = d.timers.now();
    this.#started = now;
    this.#funnel.fromMs = now;
    this.#boot = d.boot ?? `${now.toString(36)}-${process.pid}`;
    mkdirSync(c.stateDir, { recursive: true });
    this.#journal = new Journal(join(c.stateDir, STATE_FILES.journal), this.#boot, () => d.timers.now());
    this.#fillLines = readJournalFills(join(c.stateDir, STATE_FILES.journal));
    rmSync(join(c.stateDir, STATE_FILES.cleanStop), { force: true });
    // RESTART-CAUSE: the systemd unit runs a `--reconcile` pre-step (its own process) before each start, and it writes
    // journal lines of its own. So the pre-step reads how the previous process ended and hands that reading to the main
    // boot (EXIT_HANDOFF), which would otherwise read the pre-step's lines. A drill's marker is read the same way.
    const handoff = join(c.stateDir, EXIT_HANDOFF);
    // A handoff of null (the pre-step saw a first start) stands: it is not "no handoff".
    let handedMem: DeathMem | null | undefined;
    const handed = takeHandoff(handoff, now, (m) => {
      handedMem = m;
    });
    // MEM-TRACE: a death with no stop line just after a sample near a memory limit says so.
    // HEAP-GUARD: a fresh fatal-error report (the heap limit) names the death as a crash at its site, first.
    const fatal = this.#journal.previousExit === 'no clean stop' ? fatalReport(c.stateDir, this.#journal.previousMs) : null;
    const journalExit = fatal !== null ? `fatal error (${fatal})`
      : this.#journal.previousExit === 'no clean stop' ? withMemNote(this.#journal.previousExit, nearLimit(readMem(c.stateDir), this.#journal.previousMs)) : this.#journal.previousExit;
    this.#lastExit = handed !== undefined ? handed : plannedRestart(join(c.stateDir, STATE_FILES.plannedRestart), now) ?? journalExit;
    // MEM-SUMMARY: how much memory a process that left no stop line held when it died (the pre-step reads it, the main
    // boot journals it for the daily summary). Its uptime runs from its own boot, the last entry of restarts.json.
    if (handed !== undefined) this.#deathMem = handedMem ?? null;
    else if (this.#journal.previousExit === 'no clean stop') {
      let bootMs: number | null = null;
      try {
        bootMs = restartsFile(c.stateDir).read([]).at(-1)?.at ?? null;
      } catch {}
      this.#deathMem = deathMem(c.stateDir, this.#journal.previousMs, bootMs);
    }
    if (d.phase === 'reconcile') writeFileSync(handoff, JSON.stringify({ exit: this.#lastExit, at: now, mem: this.#deathMem }));
    // Restarts in the last 24 h, planned (a runner drill), deploys and unplanned, for the heartbeat and the daily summary.
    // The pre-step is not a boot of its own: only the main start records one.
    this.#restartsFile = restartsFile(c.stateDir);
    let saved: Restart[] = [];
    try {
      saved = this.#restartsFile.read([]);
    } catch {
      // A damaged count never blocks a boot: it starts again from this boot.
      d.log('Restart counts unreadable (restarts.json): started again from this boot.');
    }
    this.#restarts = saved;
    if (d.phase !== 'reconcile') {
      this.#restarts = restartsAfterBoot(saved, now, this.#lastExit, c.gitSha);
      try {
        this.#restartsFile.write([...this.#restarts]);
      } catch {
        d.log('Restart counts not saved (restarts.json).');
      }
    }
    const timing = watchTimingProblem(d.config.watch, d.session.policy.gates.maxQuoteAgeMs, DEFAULT_LIVE_FEED.horizonSlots * SLOT_MS);
    if (timing !== null) throw new RangeError(timing);
    const seed = `paper:${this.#boot}`;

    const recRoot = join(c.stateDir, STATE_FILES.recorder);
    try {
      mkdirSync(recRoot, { recursive: true });
      for (const b of sealLeftovers(recRoot, this.#boot)) d.log(`Recorder: sealed files of boot ${b} left by a stop without a clean stop.`);
      this.#recorder = c.recorder ? new Recorder({ root: recRoot, boot: this.#boot, gitSha: c.gitSha, rotateBytes: 64 * 1024 * 1024, ...(d.commitments === undefined ? {} : { commitments: d.commitments }) }) : null;
    } catch (e) {
      if (c.recorder) this.#recorderFailed(e);
      else d.log(`Recorder: leftovers not sealed: ${errorText(e)}.`);
    }
    this.#probe = d.delayProbe === undefined || this.#recorder === null ? null : new DelayProbe({
      timers: d.timers, confirmed: d.delayProbe.confirmed, via: d.delayProbe.via, everyMs: d.delayProbe.everyMs,
      record: (row, at) => this.#record((r) => r.delay(row, at)),
      onError: (e) => d.log(`Delay probe: sample not recorded: ${errorText(e)}.`),
    });

    // RUN-1d: no ledger at all means a cold start (host lost with no backup): what comes back comes from the chain. A
    // paper position is not on chain, so nothing does. Marked until a full start journals its `recovered` line.
    if (!existsSync(join(c.stateDir, Ledger.FILE))) writeFileSync(join(c.stateDir, COLD_START), new Date(now).toISOString());
    this.#ledger = openLedger(join(c.stateDir, Ledger.FILE), 'paper');
    this.#control = controlFile(c.stateDir);
    this.#ctl = this.#control.read(NO_CONTROL);
    this.#exitsFile = exitsFile(c.stateDir);
    this.#seedsFile = seedsFile(c.stateDir);
    this.#account = new PaperAccount(accountFile(c.stateDir), d.session.policy.capital.bankroll, now, d.strategy.rent.oneTime);

    this.#feed = new LiveFeed({
      ...DEFAULT_LIVE_FEED,
      onFrame: (f) => this.#onFrame(f),
      onRelease: (e, r) => this.#onRelease(e, r),
    });
    this.#strategy = new LiveStrategy({ session: d.session, rugs: d.rugs, config: d.strategy, savedState: (ref) => this.savedStateFor(ref), ...(d.markedHistory === undefined ? {} : { markedHistory: d.markedHistory }), ...(d.sizeProbe === undefined ? {} : { sizeProbe: d.sizeProbe }) });
    const bookConfig = { maxOpenPositions: d.session.policy.positions.maxOpen };
    const stored = this.#ledger.storedBookEvents(bookConfig);
    // RUN-1c: trades open or in flight when the previous process stopped writing, kept until a full start journals them.
    const killed = [...new Set([
      ...Object.values(stored.book.positions).filter((p) => p.status !== 'closed').map((p) => p.id as string),
      ...Object.values(stored.book.intents).filter((i) => isUnresolved(i)).map((i) => i.intent.positionId as string),
    ])].sort();
    // A restored position whose universe the loaded policy lacks: sell-only for this process (no new entries), and the
    // strategy flattens it through the global exit ladder (supervisor ruling on the EXIT-1b review).
    const savedPlans = exitsFile(c.stateDir).read({});
    for (const p of Object.values(stored.book.positions)) {
      if (p.status === 'closed') continue;
      const entry = stored.book.intents[p.entryIntentId];
      const why = sellOnlyReason(p.id, resolveUniverse(savedPlans[p.id]?.plan.universe, entry?.intent.key), d.session.policy.exits.universes, d.session.versionHash);
      if (why !== null) this.#sellOnly.push(why);
    }
    // The start line goes first in this boot's journal lines, with everything above known (nothing above writes one).
    this.#journal.write('start', {
      git_sha: c.gitSha, run_id: c.runId, label: c.runLabel, recorder: c.recorder, simulation: c.simulate, mode: c.mode,
      policy_version: d.session.versionHash, strategy: d.strategy.version, seed, pid: process.pid,
      entry_rule: c.strategy.name, qualifying: c.strategy.qualifying, paper_edge_ppm: c.strategy.paperEdgePpm, s0_salt: d.strategy.entryTiming === 'random' ? d.strategy.entrySalt : null,
      s0_diagnostic: d.strategy.s0Diagnostic === true ? S0_DIAGNOSTIC_PARTS : null,
      sell_only: [...this.#sellOnly],
      // RESTART-CAUSE: the unit's `--reconcile` pre-step is marked, so the daily summary counts real boots only.
      // The main boot names its restart's kind and how the previous process ended, for the daily summary's counts.
      ...(d.phase === 'reconcile' ? { phase: 'reconcile' } : { restart: this.#restarts[this.#restarts.length - 1]?.kind ?? null, exit: exitKind(this.#lastExit), ...(this.#lastExit?.startsWith('fatal error (') ? { crash_site: this.#lastExit.slice('fatal error ('.length, -1) } : {}), ...(this.#deathMem === null ? {} : { death_mem: this.#deathMem }) }),
    });
    if (this.#journal.repaired) this.#journal.write('journal_repair', { detail: 'torn last line removed' });
    if (this.#sellOnly.length > 0) {
      this.#journal.write('halt', { reasons: ['sell-only: no new entries; the positions below are flattened', ...this.#sellOnly] });
      d.log(`ALERT ${this.#sellOnly.join('; ')}`);
    }
    this.#exposedFile = exposedFile(c.stateDir);
    const before = this.#exposedFile.read(NO_EXPOSED);
    const since = this.#journal.previousMs;
    if (killed.length > 0 && since !== null) {
      this.#exposedFile.write({ trades: [...new Set([...before.trades, ...killed])].sort(), fromMs: before.trades.length === 0 ? since : Math.min(before.fromMs, since) });
    }
    this.#world = new PaperWorld({
      report: (event) => {
        const e = d.worldFault === undefined ? event : d.worldFault(event);
        if (e !== null) this.#report(e);
      },
      book: () => this.#engine.book,
      seed, scenario: d.scenario, network: d.network,
      ladderFees: d.session.policy.exits.ladder.steps.map((s) => s.priorityFeeLamports as bigint),
      market: (mint) => this.#paperMarket(mint),
      maxSolOut: (i) => {
        const n = d.network;
        const ladder = d.session.policy.exits.ladder;
        return i.intent.purpose === 'entry'
          ? (i.reservation?.amount ?? i.intent.spend)
          : n.signaturesPerTx * n.baseFeePerSignature + ladder.maxFeePerAttempt + n.tip + n.tokenAccountRent;
      },
      simulate: c.simulate ? d.simulate : null,
      journal: (fields) => this.#journal.write('simulation', fields),
      now: () => d.timers.now(),
      file: new StateFile<PaperState>(c.stateDir, 'paper.json', (v) => (isObj(v) && isObj(v['attempts']) ? (v as unknown as PaperState) : null)),
      changed: () => this.#writeOpenIntents(),
      // A landed failure paid its fee (PAPER-1, M4): the account settles it and risk sees the new snapshot.
      landedFailed: (a) => {
        // Its trade may have closed already (PAPER-2): that trade is settled again with this fee.
        const late = this.#account.resettle(this.#desk.book, a.trade, this.#legs(), this.#d.timers.now());
        if (this.#settle() || late) this.#publishAccount();
      },
    });
    // FACTS-1b: the engine reads through core's FactFeed (engine-feed.ts); a replay of the recording uses the same.
    this.#facts = engineFeed(this.#feed, d.session.policy, (e) => {
      if (e.key.startsWith(POOL_PREFIX)) this.#setPool(e.key.slice(POOL_PREFIX.length), e.value);
      else if (e.key.startsWith(CARRY_PREFIX)) {
        const carry = parseCarryFact(e.value);
        if (carry !== null) this.#carries.set(e.key.slice(CARRY_PREFIX.length), { carry, releasedAt: d.timers.now() });
      }
      if (e.key === GRADUATES_SEED_KEY) this.#graduatesSeed(e.value);
    });
    this.#engine = new Engine({ clock: this.#feed.clock, feed: this.#facts.feed, strategy: this.#strategy, runner: this.#world, seed, book: bookConfig, retention: liveRetention, collapse: liveCollapse });
    this.#deployerStore = new DeployerStore(c.stateDir);
    const storeFrom = now - (d.session.policy.gates.deployerRugLookbackDays + 1) * 86_400_000;
    // PERSIST-1: the saved index, labeller and coverage, when the file holds up (else a fresh start: not covered).
    // Restored through the seed fact (recorded, so a replay rebuilds the same state) before any decision; the
    // downtime fill starts at the saved moment, closing the restart gap on the live creates watch.
    // WORKER-GROW: the boot's recording keeps a byte copy of the saved state, and the restore reads that copy; the seed
    // names it by the sha256 of those bytes, so the parity replay restores exactly what this boot restored.
    const statePath = join(c.stateDir, PERSIST_FILE);
    let loadFrom = statePath;
    if (this.#recorder !== null && existsSync(statePath)) {
      const copy = join(this.#recorder.dir, PERSIST_FILE);
      try {
        copyFileSync(statePath, copy);
        loadFrom = copy;
      } catch (e) {
        d.log(`Recorder: the saved state was not copied (${e instanceof Error ? e.message : 'error'}); restored from the state dir, and this boot cannot be replayed.`);
      }
    }
    const restored = loadState(loadFrom, d.rugs);
    // WORKER-GROW: the store is trimmed either way; its creates are held in memory only when they seed the index.
    // CREATE-AFTER-RESTART: the creates earlier processes saw are noted (mint and signature) as the store streams, even
    // when PERSIST-1's state replaces them for the index and they stay in the file only.
    // Only the newest CREATE_SIGS_MAX are kept, in a ring while the store streams, then noted once: noting a million
    // creates one by one into the capped map cost 360 MB and 75 s more at boot (measured, 1M creates).
    const sigsMax = d.createSigsMax ?? CREATE_SIGS_MAX;
    const ring: (readonly [string, string])[] = [];
    let seen = 0;
    const noteCreate = (e: MarketEvent): void => {
      const p = createSigOf(e);
      if (p === null) return;
      ring[seen % sigsMax] = p;
      seen++;
    };
    this.#saved = this.#deployerStore.load(storeFrom, restored.ok ? { keepCreates: false, onCreate: noteCreate } : { maxCreates: d.maxSeedCreates ?? MAX_SEED_CREATES, onCreate: noteCreate });
    for (let i = Math.max(0, seen - sigsMax); i < seen; i++) {
      const [mint, sig] = ring[i % sigsMax]!;
      this.#noteCreateSig(mint, sig);
    }
    ring.length = 0;
    if (this.#saved.refused !== undefined) d.log(`Deployer store not seeded (${this.#saved.refused}): H14 is not covered until the look-back passes.`);
    let graduates: SavedGraduates | null = null;
    let candidates: readonly SavedCandidateState[] = [];
    let tails: readonly SavedTail[] = [];
    if (restored.ok) {
      graduates = restored.graduates;
      // RESTART-KEEP: the saved candidates go back to the strategy with the restore fact; their transactions are read
      // again once the sources are up, and the migrations of the downtime are looked up from the saved slot.
      candidates = restored.candidates;
      tails = restored.tails;
      this.#downtimeFrom = restored.asOf.slot;
      for (const c of candidates) {
        for (const [k, map] of [['create', this.#createSig], ['complete', this.#completeSig], ['migration', this.#migrationSig]] as const) {
          const sig = c.signatures[k];
          if (sig !== null && !map.has(c.mint)) map.set(c.mint, sig);
        }
      }
      const ref: SavedStateRef = { file: PERSIST_FILE, sha256: fileSha256(loadFrom), version: restored.version };
      if (loadFrom !== statePath) {
        const bytes = statSync(loadFrom).size;
        this.#record((r) => r.attach(PERSIST_FILE, ref.sha256, bytes));
        this.#unpacked = { path: loadFrom, sha256: ref.sha256, bytes };
      }
      this.#restored = { asOf: restored.asOf, ref };
      this.#handoff = { ref, index: restored.index, labeller: restored.labeller };
      this.#saved = { creates: [], rugs: [], coverage: restored.coverage, last: { slot: restored.asOf.slot, ms: restored.asOf.receivedAt } };
      d.log(`Saved state restored as of slot ${restored.asOf.slot}; ${restored.coverage.length} coverage facts, ${restored.fills.length} gaps to fill.`);
    } else if (restored.reason !== 'no saved state') d.log(`Saved state discarded (${restored.reason}): starting as a fresh process.`);
    this.#desk = new Desk({
      ledger: this.#ledger, config: bookConfig, restored: stored.book,
      journal: (kind, fields) => this.#journal.write(kind, fields),
      // Fill lines written before a kill that came ahead of the ledger: the restart books those fills again, once.
      journaledFills: journaledFillKeys(this.#fillLines),
      solUsd: () => this.#solPrice,
      ...(d.crashPoint === undefined ? {} : { crashPoint: d.crashPoint }),
      report: (event) => this.#report(event),
      // An entry that ended with no fill books its failed attempts' fees here (PAPER-1, M4), before the snapshot.
      accountChanged: () => {
        this.#settle();
        this.#publishAccount();
      },
      intentsChanged: () => this.#writeOpenIntents(),
      // Entries stop for the rest of this process; exits go on. A restart rebuilds the book from the ledger.
      diverged: (reason) => {
        if (this.#diverged.length === 0) this.#journal.write('halt', { reasons: ['ledger and book diverged; entries off until a restart', reason] });
        this.#diverged = ['ledger and book diverged'];
        this.#checkHalt(this.#d.timers.now());
      },
      // A late buy's position is not settled by paper yet (risk ruling on #133): one alert, and entries stay off while
      // the book holds such a position (#checkHalt reads the book, so a restart keeps the halt). Exits go on.
      lateBuy: (r) => {
        this.#journal.write('alert', { level: 'critical', code: 'late_buy', trade: r.positionId, intent: r.intentId, mint: r.mint, signature: r.signature, reasons: [LATE_BUY] });
        this.#checkHalt(this.#d.timers.now());
      },
      reserved: (r) => this.#account.reserved(r.mint, r.atMs),
      // The recorder fault refuses entries from the moment it is found, ahead of its halt fact (WORKER-CRASH review B1).
      entriesBlocked: () => this.#recorderFault,
      filled: (r) => {
        // A fill re-booked from its held journal line carries that line's rate (PAPER-1); otherwise the price now.
        this.#account.filled(r, r.solUsd !== undefined ? r.solUsd : this.#solPrice, this.#legs());
        if (r.purpose === 'entry') this.#entered(r.mint, r.positionId, r.atMs);
      },
    });
    // WORKER-ORDER: fills the ledger holds that account.json missed (a kill between the two), caught up at the first price.
    this.#accountBehind = this.#account.behind(stored.book);
    // The stored book goes back to the engine as world frames (recorded, so a replay rebuilds the same book).
    // PAPER-2: exits' trigger reasons survive the restart (a late stop still counts as a stop).
    this.#desk.rebuild(stored.events, bookConfig);
    for (const e of stored.events) this.#desk.written(this.#report(e));
    // The worker's own start facts are dated 1 ms after the last restored frame, so every restored event sorts before
    // them whatever the clock's resolution: the engine rebuilds the stored book before the strategy sees anything and
    // decides on an intent the ledger already carried further (which left the two books disagreeing; `--reconcile`
    // then wrote `open_intents` 1 from the ledger's book after reporting success from the engine's). Measured after
    // the restore, not from the constructor's start: opening the ledger and reading the book takes milliseconds.
    const startAt = Math.max(this.#d.timers.now(), this.#feed.lastReceivedAt) + 1;
    // Each position's entry fill moment, as the ledger booked it (its first `open` event): the exact open time of a
    // position whose saved plan is missing or refused (EXIT-1f).
    const openedAt: Record<string, number> = {};
    for (const e of this.#ledger.positionEvents()) if (e.status === 'open' && openedAt[e.positionId] === undefined) openedAt[e.positionId] = Number(e.ts);
    // Where each booking sits against the boots (live, or at a reconcile), from the journal's earlier lines (EXIT-1f N2).
    const journalPath = join(c.stateDir, STATE_FILES.journal);
    const bookedWhen = placeBookingsAt(journalPath, openedAt);
    // The saved exit plans come first, alone in their millisecond: the strategy manages positions on any market event,
    // and on the halt fact (which sorted first by id at a tie) it built fresh plans and trackers from the fills and
    // decided exits with them, before the saved ones arrived. The halt and the restart follow 1 ms later.
    this.#fact(RESTORE_KEY, { exits: this.#exitsFile.read({}), openedAt, bookedWhen, seeds: this.#seedsFile.read({}), candidates, tails }, startAt);
    // PERSIST-2: the saved graduates series goes to the producer as a raw read (recorded, so a replay rebuilds it), so
    // the regime's survival check keeps its 15 days across a restart.
    if (graduates !== null) this.#feed.ingest('worker', { type: 'offchain', key: RAW.graduatesSeed, value: { source: 'persist', ...graduates } }, { receivedAt: startAt });
    this.#fact(HALT_KEY, { halted: true, reasons: [...this.#halted] }, startAt + 1);
    if (stored.events.length > 0) this.#report({ type: 'restart' }, startAt + 1);
    if (this.#ctl.paused) this.#report({ type: 'pause_entries', reason: 'owner' }, startAt + 1);
    this.#drillToken = randomBytes(16).toString('hex');
    if (c.drills) writeFileSync(join(c.stateDir, STATE_FILES.drillToken), this.#drillToken, { mode: 0o600 });
  }

  get boot(): string {
    return this.#boot;
  }

  get book(): Book {
    return this.#engine.book;
  }


  /** The live Feed (sources and drills ingest here). */
  get feed(): LiveFeed {
    return this.#feed;
  }

  get journal(): Journal {
    return this.#journal;
  }

  get strategyConfig(): StrategyConfig {
    return this.#d.strategy;
  }

  get strategy(): LiveStrategy {
    return this.#strategy;
  }

  get desk(): Desk {
    return this.#desk;
  }

  /** Puts a world event on the feed; returns its event id. */
  #report(event: BookEvent, atMs: number = this.#d.timers.now()): string {
    const f = this.#feed.ingest('worker', { type: 'world', event }, { receivedAt: atMs });
    return `world#${seqId(f.seq)}`;
  }

  /** PERSIST-2: the last graduates seed's outcome, for /health. */
  #seedOutcome: NonNullable<Health['graduates_seed']> | null = null;

  /** PERSIST-2: a seed taken or refused is journaled and shown in /health; a refusal leaves survival unknown, so it is logged too. */
  #graduatesSeed(v: unknown): void {
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    const out = { source: typeof o['source'] === 'string' ? o['source'] : null, accepted: o['accepted'] === true, added: typeof o['added'] === 'number' ? o['added'] : 0, reason: typeof o['reason'] === 'string' ? o['reason'] : null };
    this.#seedOutcome = out;
    this.#journal.write('graduates_seed', out);
    if (!out.accepted) this.#d.log(`ALERT graduates seed refused: ${out.reason ?? 'no reason given'}; regime survival stays unknown until the series rebuilds.`);
  }

  #fact(key: string, value: unknown, atMs: number = this.#d.timers.now()): void {
    this.#feed.ingest('worker', { type: 'fact', key, value }, { receivedAt: atMs });
  }

  /**
   * G4c: the recording's saved-state copy is packed (about a ninth of its size) once the restore has read it; the seed's
   * sha256 stays that of the plain bytes, which the packed file is checked to decompress to. A failure keeps the plain
   * copy (the boot stays replayable) and is logged.
   */
  async #packCopy(): Promise<void> {
    const c = this.#unpacked;
    if (c === null) return;
    this.#unpacked = null;
    // STATE-DEDUPE: each distinct saved state is kept once, packed, in `recorder/saved-state/<sha256>.zst`; a boot that
    // restored the same bytes (every boot of a restart loop shorter than a save) gets a hard link to it, never a copy.
    const shared = join(this.#d.config.stateDir, STATE_FILES.recorder, SAVED_STATES, `${c.sha256}.zst`);
    const own = `${c.path}.zst`;
    try {
      if (existsSync(shared)) {
        // Linked only once the stored file is checked to decompress to exactly the bytes this boot restored.
        const held = await zstdContentHash(shared);
        if (held.sha256 === c.sha256 && held.bytes === c.bytes) {
          linkSync(shared, own);
          rmSync(c.path);
          this.#record((r) => r.packed(PERSIST_FILE, { sha256: fileSha256(shared), bytes: statSync(shared).size }, { sha256: c.sha256, bytes: c.bytes }));
          return;
        }
        this.#d.log(`Recorder: the stored saved state ${c.sha256} decompresses to sha256 ${held.sha256}; this boot packs its own copy.`);
      }
      const p = await (this.#d.pack ?? packFile)(c.path, { sha256: c.sha256, bytes: c.bytes });
      this.#record((r) => r.packed(PERSIST_FILE, p.packed, p.content));
      if (!existsSync(shared)) {
        try {
          mkdirSync(join(shared, '..'), { recursive: true });
          linkSync(own, shared);
        } catch (e) {
          this.#d.log(`Recorder: the packed saved state was not stored for later boots (${e instanceof Error ? e.message : 'error'}).`);
        }
      }
    } catch (e) {
      this.#d.log(`Recorder: the saved-state copy was kept unpacked (${e instanceof Error ? e.message : 'error'}).`);
    }
  }

  /**
   * A refused API command, journaled; at most COMMAND_LINES_PER_MINUTE lines a minute, so a client on the tailnet cannot
   * grow the journal without bound. The refusals past that are counted on one line when the next minute's first comes.
   */
  #commandRefused(command: string, auth: string | null): void {
    const now = this.#d.timers.now();
    const r = this.#refusals;
    if (now - r.since >= 60_000) {
      this.#countRefusals();
      r.since = now;
      r.written = 0;
    }
    if (r.written >= COMMAND_LINES_PER_MINUTE) {
      r.dropped++;
      return;
    }
    r.written++;
    this.#journal.write('decision', { action: 'command_refused', reasons: [`command ${command.slice(0, 32)} refused`, auth === null ? 'unknown command' : `needs ${auth}`] });
  }

  /** The refusals counted but not journaled, on one line; also at the heartbeat once the minute is over (a flood that stopped). */
  #countRefusals(): void {
    const r = this.#refusals;
    if (r.dropped === 0) return;
    this.#journal.write('decision', { action: 'command_refused', reasons: [`${r.dropped} more commands refused`, `not journaled one by one (over ${COMMAND_LINES_PER_MINUTE} a minute)`] });
    r.dropped = 0;
  }

  /** Every recorder write goes through here: a throw (ENOSPC) is the recorder's fault, never the caller's crash. */
  #record(write: (r: Recorder) => void): void {
    const r = this.#recorder;
    if (r === null || this.#recorderFault !== null) return;
    try {
      write(r);
    } catch (e) {
      this.#recorderFailed(e);
    }
  }

  /**
   * The recorder failed: it records nothing more in this process (its open files are sealed by the next start), entries
   * halt with the reason from the next step on, and the critical alert goes up in /health and the heartbeat. It does not
   * ingest or halt here: it can run inside the feed's ingest.
   */
  #recorderFailed(e: unknown): void {
    if (this.#recorderFault !== null) return;
    const code = isObj(e) && typeof e['code'] === 'string' ? e['code'] : e instanceof Error ? e.name : 'error';
    this.#recorderFault = `recorder failed (${code}): recording stopped, entries off until a restart`;
    this.#d.log(`Recorder failed: ${errorText(e)}. Recording stopped; entries halt, exits go on.`);
    try {
      this.#journal.write('alert', { level: 'critical', code: 'recorder_failed', reasons: [this.#recorderFault, errorText(e)] });
    } catch (j) {
      this.#d.log(`Journal: the recorder alert was not written: ${errorText(j)}.`);
    }
  }

  /** Resolves once the recording's saved-state copy is packed (or there was none to pack). */
  whenPacked(): Promise<void> {
    return this.#packing ?? Promise.resolve();
  }

  /** The strategy's `savedState`: the restored index and labeller, once, only for the seed that names exactly them. */
  savedStateFor(ref: SavedStateRef): { readonly index: DeployerIndex; readonly labeller: RugLabeller } {
    const h = this.#handoff;
    if (h === null || h.ref.file !== ref.file || h.ref.sha256 !== ref.sha256 || h.ref.version !== ref.version) throw new Error('the saved state the seed names is not the one this process restored');
    this.#handoff = null;
    return h;
  }

  #onFrame(f: Frame): void {
    this.#record((r) => r.frame(f));
    this.#probe?.frame(f);
    for (const s of this.#feeds.values()) if (s.src.sources.includes(f.source)) s.last = f.receivedAt;
    const b = f.body;
    if (b.type === 'offchain' && b.key.startsWith('feed:status:') && isObj(b.value)) {
      const name = b.key.slice('feed:status:'.length);
      const feed = [...this.#feeds.values()].find((s) => s.src.sources.includes(name));
      const state = b.value['state'];
      if (feed !== undefined && (state === 'up' || state === 'down')) {
        if (feed.connected !== (state === 'up')) this.#journal.write('feed', { feed: feed.src.name, connected: state === 'up', detail: jsonText(b.value) });
        feed.connected = state === 'up';
      }
    }
    if (b.type === 'offchain' && b.key === 'coverage:creates:start' && isObj(b.value) && typeof b.value['via'] === 'string' && b.value['via'].startsWith('logs:') && typeof b.value['fromSlot'] === 'bigint') {
      if (this.#liveStart === null) {
        this.#liveStart = b.value['fromSlot'];
        this.#liveStartAt = { slot: f.place.slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: f.receivedAt };
      }
    }
    if ((b.type === 'offchain' || b.type === 'fact') && /^coverage:.+:gap$/.test(b.key)) this.#record((r) => r.gap({ key: b.key, value: isObj(b.value) ? b.value : null, receivedAt: f.receivedAt }));
    if (b.type === 'offchain' || b.type === 'fact') this.#coverageJournal.fact(b.key, b.value, f.receivedAt);
  }

  #onRelease(e: { readonly kind: string; readonly key?: string; readonly value?: unknown; readonly moment: { readonly receivedAt: number } }, r: Release): void {
    this.#record((rec) => rec.release(r, e.moment.receivedAt));
    if (e.kind !== 'market') return;
    const m = e as unknown as MarketEvent;
    // The deployer index's inputs and the creates/rugs coverage, kept across restarts (SEED-1 ruling).
    if (!r.late) this.#deployerStore.keep(m);
    // A late slot notice is refused by the engine (out of order): the paper height follows only accepted ones.
    if (m.key === 'chain:slot' && !r.late && isObj(m.value) && typeof m.value['slot'] === 'bigint' && (this.#lastSlot === null || m.value['slot'] > this.#lastSlot)) {
      this.#lastSlot = m.value['slot'];
      this.#lastSlotAt = this.#d.timers.now();
    }
    else if (m.key.startsWith(POOL_PREFIX)) this.#setPool(m.key.slice(POOL_PREFIX.length), m.value);
    // An off-chain frame (the batch's FEE-TIER-NOW read) arrives wrapped; a worker fact does not.
    else if (m.key.startsWith('worker:fees:')) this.#fees.set(m.key.slice('worker:fees:'.length), unwrap(m.value) as PoolFeeContext);
    else if (m.key.startsWith(SNAPSHOT_PREFIX)) {
      const snap = parseSnapshotFact(m.value);
      if (snap !== null) this.#snapshots.set(m.key.slice(SNAPSHOT_PREFIX.length), snap);
    }
    else if (m.key === SOL_PRICE_KEY) {
      const p = isObj(m.value) && typeof m.value['value'] === 'bigint' && m.value['value'] > 0n ? { price: m.value['value'] } : null;
      if (p !== null) {
        this.#solPrice = p.price as MicroUsd;
        this.#solPriceAt = isObj(m.value) && typeof m.value['atMs'] === 'number' ? m.value['atMs'] : m.moment.receivedAt;
        this.#account.price(this.#solPrice, m.moment.receivedAt);
        if (this.#accountBehind.length > 0) this.#catchUpAccount();
        // The paper wallet exists from the first price on: risk needs its balance (R4). Every process settles once at its
        // first price after the reconcile: fees of entries that ended unfilled while no price was known (in that
        // reconcile, a restart's) are booked here, not at some later book event.
        if (!this.#pricedSettle && this.#account.state.walletLamports !== null && this.#reconciled) {
          this.#pricedSettle = true;
          this.#settle();
          this.#publishAccount();
        }
      }
    } else if (m.key === 'coverage:rugs:start') {
      const v = isObj(m.value) && isObj(m.value['value']) ? m.value['value'] : m.value;
      if (isObj(v) && typeof v['via'] === 'string') this.#rugVias.add(v['via']);
    }
    this.#cutTradeLog(m);
    if (m.key.startsWith('logs:pump:CreateEvent:') && isObj(m.value) && isObj(m.value['event']) && isObj(m.value['event']['data'])) {
      const sym = m.value['event']['data']['symbol'];
      if (typeof sym === 'string' && sym.trim() !== '') {
        this.#symbols.set(m.key.slice('logs:pump:CreateEvent:'.length), sym.trim().slice(0, 32));
      }
    }
    if (m.key.startsWith('logs:pump:CreateEvent:') && isObj(m.value) && typeof m.value['signature'] === 'string') this.#noteCreateSig(m.key.slice('logs:pump:CreateEvent:'.length), m.value['signature']);
    this.#noteSignature(m);
  }

  #noteCreateSig(mint: string, signature: string): void {
    this.#createSig.set(mint, signature);
  }

  /**
   * CREATE-AFTER-RESTART: each saved or seeded create's signature, so a coin created before this start is read by its
   * signature (one call) when it is shortlisted. The store keeps creates compacted, without the signature field; the
   * event id carries it (`log:<signature>:…` live, `ev:<signature>:…` fetched). Oldest first, so the newest stay.
   */
  #noteCreates(events: readonly MarketEvent[]): void {
    for (const e of events) {
      const p = createSigOf(e);
      if (p !== null) this.#noteCreateSig(p[0], p[1]);
    }
  }

  /** RESTART-KEEP: each restored candidate's migration, curve completion and create, read again at confirmed. */
  #readRestored(): void {
    for (const mint of this.#restoredMints.splice(0)) {
      const sigs = [this.#migrationSig.get(mint), this.#completeSig.get(mint)];
      for (const sig of sigs) if (sig !== undefined) void this.#d.fetchTx(sig, 'restore');
      // The create: fetched again by its saved signature, or looked up from the mint's oldest transaction (SEED-2).
      this.#createFor(mint);
      if (sigs[0] === undefined) this.#d.log(`Restored candidate ${mint}: its migration was not seen; H9 waits for it.`);
    }
  }

  /**
   * RESTART-KEEP: the migrations of the downtime, from the migration authority's signatures after the saved slot up
   * to the head seen now (the live watch, started before, covers the rest; the feed drops what both read). Each
   * transaction goes on the feed at confirmed, as the live watch's fetch would put it, so the producer and the strategy
   * find those candidates as they would live. A curve completion in its own transaction is read from the curve.
   * Charged to the fill budget; a partial read is logged and the coins it missed are not candidates.
   */
  async #downtimeMigrations(): Promise<void> {
    const rr = this.#d.restartReads;
    const from = this.#downtimeFrom;
    if (rr === undefined || from === null) return;
    for (let i = 0; this.#lastSlot === null && i < 100 && !this.#stopping; i++) await new Promise<void>((r) => this.#d.timers.setTimeout(r, 200));
    const until = this.#lastSlot;
    if (until === null || until <= from) {
      this.#d.log(`Downtime migrations not read: ${until === null ? 'no slot seen' : 'no downtime'}.`);
      return;
    }
    const now = this.#d.timers.now();
    const cap = Math.min(DOWNTIME_CREDIT_CAP, rr.budget.remaining(now));
    rr.budget.spend(cap, now);
    let used = 0;
    try {
      const res = await backfillAddress({ rpc: rr.rpc, timers: this.#d.timers, afterSlot: from, untilSlot: until, creditCap: cap, provider: 'helius', address: PUMP_MIGRATION_AUTHORITY, priority: P2, accept: () => [] });
      used = res.creditsUsed;
      let migrations = 0;
      for (const record of res.records) {
        this.#feed.ingest('helius', { type: 'tx', record }, { receivedAt: this.#d.timers.now(), backfilled: true, lookup: true });
        const evs = transactionEvents(record);
        const m = evs.find((e) => e.name === 'CompletePumpAmmMigrationEvent');
        if (m === undefined) continue;
        migrations++;
        if (!evs.some((e) => e.name === 'CompleteEvent') && 'bondingCurve' in m.data) used += await this.#readCompletion(rr, String(m.data.bondingCurve), record.signature, cap - used);
      }
      this.#d.log(`Downtime migrations: ${migrations} from slot ${from + 1n} to ${until}, ${used} credits, ${res.stoppedBy}${res.gaps.length > 0 ? `, ${res.gaps.length} unread` : ''}.`);
    } finally {
      rr.budget.refund(Math.max(0, cap - used), this.#d.timers.now());
    }
  }

  /** The curve's completing transaction just before its migration (after it nothing trades on the curve): 1 page. */
  async #readCompletion(rr: NonNullable<WorkerDeps['restartReads']>, curve: string, migration: string, credits: number): Promise<number> {
    const cost = callCost('helius', 'getSignaturesForAddress');
    if (credits < cost + COMPLETION_READS * callCost('helius', 'getTransaction')) return 0;
    let used = cost;
    try {
      const sigs = await rr.rpc.getSignaturesForAddress(curve, { before: migration, limit: COMPLETION_READS }, P2);
      for (const x of sigs) {
        if (x.err !== null) continue;
        used += callCost('helius', 'getTransaction');
        const record = await rr.rpc.getTransaction(x.signature, P2);
        if (record === null) continue;
        this.#feed.ingest('helius', { type: 'tx', record }, { receivedAt: this.#d.timers.now(), backfilled: true, lookup: true });
        if (transactionEvents(record).some((e) => e.name === 'CompleteEvent')) break;
      }
    } catch (e) {
      this.#d.log(`Curve completion of ${curve} not read: ${e instanceof Error ? e.message : 'error'}.`);
    }
    return used;
  }

  /**
   * RESTART-KEEP: the transactions a candidate's gate facts come from (its curve completion and its migration, from a
   * log or a fetched transaction; a fetched create too), so the saved state can name them for a restart to read again.
   */
  #noteSignature(m: MarketEvent): void {
    const tx = /^ev:([^:]+):/.exec(m.id);
    const at = /^(?:logs:)?pump:(CreateEvent|CompleteEvent|CompletePumpAmmMigrationEvent):(.+)$/.exec(m.key);
    if (at === null) return;
    const sig = tx !== null && !m.key.startsWith('logs:') ? tx[1]! : isObj(m.value) && typeof m.value['signature'] === 'string' ? m.value['signature'] : null;
    if (sig === null) return;
    const map = at[1] === 'CreateEvent' ? this.#createSig : at[1] === 'CompleteEvent' ? this.#completeSig : this.#migrationSig;
    if (map === this.#createSig && m.key.startsWith('logs:')) return;
    // The first seen wins; each map forgets its oldest past its cap in O(1).
    if (!map.has(at[2]!)) map.set(at[2]!, sig);
  }

  /**
   * A shortlisted mint's create: read by its signature when one is known; held while the seed is built (its downtime
   * fill may bring it); else looked up once from the mint's oldest signature. A lookup that fails leaves it missing.
   */
  #createFor(mint: string): void {
    const sig = this.#createSig.get(mint);
    if (sig !== undefined) return void this.#d.fetchTx(sig, 'create');
    if (this.#seeding) return void this.#createPending.push(mint);
    const find = this.#d.findCreate;
    if (find === undefined) return this.#d.log(`Shortlisted ${mint}: its create was not seen by this process; H9 and H12-H14 wait for it.`);
    if (this.#createLookups.has(mint)) return;
    this.#createLookups.add(mint);
    this.#lookupCreate(find, mint, 1);
  }

  /**
   * One create lookup, journaled. A lookup stopped by a transient error (a rate limit, a timeout) is tried once more
   * after CREATE_RETRY_MS, within the same budget; a mint whose history answered (not the create, no signature, the
   * cap) is never retried: that answer stands.
   */
  #lookupCreate(find: NonNullable<WorkerDeps['findCreate']>, mint: string, attempt: 1 | 2): void {
    const failed = (): CreateLookup => ({ mint, found: false, signature: null, slot: null, pages: 0, credits: 0, stopped_by: 'error', latency_ms: 0 });
    void find(mint).catch(failed).then((r) => {
      this.#journal.write('create_lookup', { ...r, attempt });
      const retry = r.stopped_by === 'error' && attempt === 1 && !this.#stopping;
      this.#d.log(r.found
        ? `Shortlisted ${mint}: its create (slot ${r.slot}) found from the mint's oldest signature, ${r.credits} credits.`
        : `Shortlisted ${mint}: create lookup stopped (${r.stopped_by}, ${r.credits} credits)${retry ? '; trying once more in a minute' : ''}; H9 and H12-H14 wait for it.`);
      if (retry) this.#d.timers.setTimeout(() => (this.#stopping ? undefined : this.#lookupCreate(find, mint, 2)), CREATE_RETRY_MS);
    });
  }

  /** WORKER-1e: the paper attempts' execution statistics over the last 24 h (S0's diagnostic exec-health). */
  execStats(): ExecStats {
    return this.#world.execStats(this.#d.timers.now(), EXEC_STATS_WINDOW_MS);
  }

  /** The latest pool fact of a mint, with its fee context: what the paper fill and the dry-run build use. */
  /** Gate facts core's producer has released to the engine so far (FACTS-1b). */
  get factsReleased(): number {
    return this.#facts.released();
  }

  /** The latest pool fact of a mint as released (flagged or not), for health and tests. */
  poolFact(mint: string): unknown {
    return this.#pools.get(mint);
  }

  /**
   * The mint's newest whole market (merge rule M, as the strategy's #market): WATCH-1's snapshot when it is newer than
   * the pool fact; else the pool fact, unless POS-1 flagged it (a stale swap stream), which is no market at all.
   */
  #setPool(mint: string, value: unknown): void {
    this.#pools.set(mint, value);
    this.#poolReleasedAt.set(mint, this.#d.timers.now());
  }

  /** The mint's newest whole market by the strategy's own rule (`chooseMarket`). */
  #choice(mint: string): MarketChoice {
    return chooseMarket(parsePool(this.#pools.get(mint)), this.#snapshots.get(mint) ?? null, this.#carries.get(mint)?.carry ?? null);
  }

  /**
   * The moment WATCH-1 judges a held mint's market by (null: no market). A pool fact from the feed counts from its
   * release, or from its latest carry's release while a carry proves it unchanged (WATCH-1c): a live feed releases
   * facts already up to the horizon old by design, so judging them by receipt would read the second path all the time.
   * WATCH-1's own snapshot counts from its read, as its age bound needs.
   */
  #watchMarketAt(mint: string): number | null {
    const c = this.#choice(mint);
    if (c.kind === 'snapshot') return c.snap.atMs;
    if (c.kind !== 'pool') return null;
    const released = c.carried ? this.#carries.get(mint)!.releasedAt : this.#poolReleasedAt.get(mint) ?? null;
    // A confirming snapshot counts from its read, like any snapshot.
    return c.confirmedAtMs === null ? released : Math.max(released ?? c.confirmedAtMs, c.confirmedAtMs);
  }

  /**
   * A mint's pool reserves as read, without the fee terms poolOf also needs (APP-TRADE): Discovered's liquidity needs
   * only the reserves, and a new pool has no fee terms until its first swap is seen.
   */
  reservesOf(mint: string): PaperMarket['pool'] | null {
    const p = parsePool(this.#pools.get(mint));
    const snap = this.#snapshots.get(mint);
    if (snap !== undefined && snapshotWins(snap, p === null ? null : p.obs)) return snap.state;
    if (p === null || flagged(p)) return null;
    return { baseReserve: p.baseVault, quoteVault: p.quoteVault, virtualQuoteReserves: p.pool.virtualQuoteReserves ?? 0n };
  }

  poolOf(mint: string): { readonly address: string; readonly state: PaperMarket['pool']; readonly ctx: PoolFeeContext; readonly atMs: number } | null {
    const c = this.#choice(mint);
    if (c.kind === 'snapshot') return { address: c.snap.pool, state: c.snap.state, ctx: c.snap.ctx, atMs: c.snap.atMs };
    if (c.kind !== 'pool') return null;
    const p = c.pool;
    const state = { baseReserve: p.baseVault, quoteVault: p.quoteVault, virtualQuoteReserves: p.pool.virtualQuoteReserves ?? 0n };
    // FEES-KEEP: restored fee terms price only the pool their swap left.
    const ctx = this.#fees.get(mint) ?? this.#strategy.observedFees(mint, state);
    if (ctx === undefined) return null;
    return { address: p.address, state, ctx, atMs: c.atMs };
  }

  /**
   * RUG-1's wiring rule: a missed dump trade is a missed label, so a cut or undecodable log on a rug-covered watch is a
   * coverage gap unless its transaction can be read. The transaction is fetched; if it is not found, a bounded
   * `coverage:rugs:gap` for that slot goes on the feed (H14 is then not covered across it).
   */
  #cutTradeLog(m: MarketEvent): void {
    const v = m.value;
    if (!isObj(v) || typeof v['signature'] !== 'string') return;
    const via = m.key.startsWith('logs:truncated:') ? m.key.slice('logs:truncated:'.length)
      : m.key.startsWith('logs:undecodable:') ? m.key.slice('logs:undecodable:'.length)
        : m.key.startsWith('logs:') && v['truncated'] === true && typeof v['via'] === 'string' ? v['via'] : null;
    if (via === null || !this.#rugVias.has(via)) return;
    const sig = v['signature'];
    const slot = m.moment.slot;
    void this.#d.fetchTx(sig, 'cut-log').catch(() => false).then((found) => {
      if (found || this.#stopping) return;
      this.#feed.ingest('worker', { type: 'offchain', key: 'coverage:rugs:gap', value: { fromSlot: slot, toSlot: slot, reason: `cut trade log ${sig}, transaction not found`, via } }, { receivedAt: this.#d.timers.now() });
    });
  }

  #paperMarket(mint: string): PaperMarket | null {
    const m = this.poolOf(mint);
    return m === null ? null : { pool: m.state, ctx: m.ctx };
  }

  /** What the paper account settles a trade from: the paper world's attempts and token accounts (PAPER-1). */
  #legs(): PaperLegs {
    return { network: this.#d.network, attempts: this.#world.attempts, closedAccount: (sig) => this.#world.closedAccount(sig) };
  }

  /** Fees paid outside fills, each signature once (PAPER-1, M4); true when the wallet moved. */
  #settle(): boolean {
    return this.#account.settle(this.#desk.book, this.#legs(), this.#solPrice, this.#d.timers.now());
  }

  #publishAccount(): void {
    this.#fact(ACCOUNT_KEY, this.#account.fact(this.#ledger, this.#desk.book, this.#ctl.latches, this.#solPrice, this.#d.timers.now()));
  }

  #writeOpenIntents(): void {
    const n = Math.max(openIntents(this.#desk.book), this.#reconciled ? 0 : openIntents(this.#engine.book));
    writeFileSync(join(this.#d.config.stateDir, STATE_FILES.openIntents), `${n}\n`);
  }

  /** The strategy's exit plans and trackers, written when they changed. */
  #saveExits(): void {
    const saved = this.#strategy.saved();
    const text = jsonText(saved);
    if (text !== this.#savedExits) {
      this.#exitsFile.write(saved);
      this.#savedExits = text;
    }
  }

  /** One engine step: release what is due, decide, record, write. */
  step(): void {
    const now = this.#d.timers.now();
    this.#record((r) => r.flush());
    this.#feed.advance(now);
    this.#engine.drain();
    this.#record((r) => r.flush());
    this.#watchOpened();
    // Entry decisions' plan inputs reach disk before the desk books anything this step decided (EXIT-1h, the same order
    // as WORKER-ORDER: the durable record first, then the ledger), so an entry that fills is never without its plan.
    // The plans go first: a plan made this step replaced its seed, so the seed may leave the disk only once the plan is
    // on it (EXIT-1h review B1: a kill between the two writes left neither).
    this.#saveExits();
    const seeds = jsonText(this.#strategy.seeds());
    if (seeds !== this.#savedSeeds) {
      this.#seedsFile.write(this.#strategy.seeds());
      this.#savedSeeds = seeds;
    }
    const records = this.#engine.records as LogRecord[];
    const n = records.length;
    for (let k = 0; k < n; k++) this.#afterRecord(records[k]!);
    this.#desk.consume(records.slice(0, n));
    // Consumed records are dropped so a 48 h run keeps its memory flat; the engine keeps the log's hash.
    records.splice(0, n);
    if (this.#lastSlot !== null && this.#lastSlot !== this.#ticked) {
      // Once per new paper block height: attempts due land, and intents in flight get their tick (rebroadcast, expiry).
      this.#ticked = this.#lastSlot;
      this.#world.onSlot(this.#lastSlot);
      if (Object.values(this.#engine.book.intents).some((i) => !isTerminal(i) && (isUnresolved(i) || i.status === 'signed'))) {
        this.#report({ type: 'tick', blockHeight: this.#lastSlot });
      }
    }
    this.#saveExits();
    this.#markAccount(now);
    if (now - this.#lastSaveMs >= PERSIST_EVERY_MS) this.#persist(now);
    this.#checkHalt(now);
  }

  /**
   * PERSIST-1 save: the index, the labeller's tables and every coverage fact, as of the latest released moment.
   * Refused until the seed (or the restored state) is applied: before it, the index is not this process's to save, and
   * a save then would replace a good file with an unseeded one. Taken every PERSIST_EVERY_MS and at a clean stop.
   */
  #persist(now: number): boolean {
    this.#lastSaveMs = now;
    const lookback = (this.#d.session.policy.gates.deployerRugLookbackDays + 1) * 86_400_000;
    let state: ReturnType<LiveStrategy['persistable']>;
    try {
      state = this.#strategy.persistable(now - lookback);
    } catch (e) {
      this.#d.log(`Saved state not written: ${e instanceof Error ? e.message : 'error'}.`);
      return false;
    }
    if (state === null) {
      if (!this.#saveRefused) this.#d.log('Saved state not written: the seed is not applied yet.');
      this.#saveRefused = true;
      return false;
    }
    try {
      // RESTART-KEEP: each candidate with the transactions a restart reads again for its gate facts.
      const candidates = state.state.candidates.map((c) => ({ ...c, signatures: { create: this.#createSig.get(c.mint) ?? null, complete: this.#completeSig.get(c.mint) ?? null, migration: this.#migrationSig.get(c.mint) ?? null } }));
      saveState(join(this.#d.config.stateDir, PERSIST_FILE), { ...state.state, candidates }, { mintRows: state.mintRows });
      return true;
    } catch (e) {
      this.#d.log(`Saved state not written: ${e instanceof Error ? e.message : 'error'}.`);
      return false;
    }
  }

  /**
   * WORKER-ORDER: records the fills a kill between the ledger commit and account.json left out, from the book and the
   * fill's own journal line (always written before the ledger since §12.4: its time, reasons and SOL/USD rate).
   */
  #catchUpAccount(): void {
    const book = this.#desk.book;
    for (const b of this.#accountBehind) {
      const p = book.positions[b.positionId];
      if (p === undefined) continue;
      const line = this.#fillLines.filter((l) => l['kind'] === b.purpose && l['trade'] === b.positionId && (b.purpose === 'entry' || l['position'] === 'closed')).at(-1);
      const at = typeof line?.['ts'] === 'string' ? Date.parse(line['ts']) : Number.NaN;
      const reasons = lineReasons(line) ?? [`${b.purpose} filled (paper)`];
      // Valued at the fill's own SOL/USD rate from its line (PAPER-1). Null there means no price at booking, which the
      // live path valued as null too (the safe side); only a line without the field falls back to the price now, flagged.
      const fromLine = lineRate(line);
      const known = fromLine !== undefined;
      const rate = known ? fromLine : this.#solPrice;
      this.#account.filled({ purpose: b.purpose, positionId: p.id, mint: String(p.mint), book, atMs: Number.isFinite(at) ? at : this.#d.timers.now(), reasons: known ? reasons : [...reasons, FILL_RATE_UNKNOWN] }, rate, this.#legs());
      this.#d.log(`Account caught up: the ${b.purpose} of ${p.id} was in the ledger but not in account.json (a kill between the two)${known ? '' : `; ${FILL_RATE_UNKNOWN}`}.`);
    }
    this.#accountBehind = [];
    if (this.#reconciled) this.#publishAccount();
  }

  /**
   * WORKER-1c: the day and week boundary marks and the NAV peak, from the figures risk would use now on the marked
   * account (RISK-MARK: each open position at its executable mark from its newest market under rule M, valued at the
   * live SOL price; the same `riskAccount` path the strategy's exits use, falling back to the unmarked account on a
   * failure). A boundary is recorded only when every open position has a fresh mark; otherwise the next look takes it.
   * When they change, the account fact is put again, so the next evaluation's day and week loss take the stricter of
   * the realized and the marked measure and R10 sees the peak.
   */
  #markAccount(now: number): void {
    if (!this.#reconciled) return;
    const fact = this.#account.fact(this.#ledger, this.#desk.book, this.#ctl.latches, this.#solPrice, now);
    const sol = this.#solPrice === null || this.#solPriceAt === null ? null : { value: this.#solPrice, atMs: this.#solPriceAt };
    const policy = this.#d.session.policy;
    const held = Object.values(this.#engine.book.positions).filter((p) => p.status !== 'closed');
    const account = riskAccount(fact.history, (mint) => {
      const p = held.find((x) => x.mint === mint);
      if (p === undefined) return undefined;
      const m = this.poolOf(mint);
      return { quantity: p.quantity, market: m === null ? null : { pool: m.state, ctx: m.ctx, atMs: m.atMs } };
    }, sol, now, markSettings(policy, this.#d.strategy.network), { fallback: true, ...(this.#d.markedHistory === undefined ? {} : { mark: this.#d.markedHistory }) });
    const input: RiskInput = {
      session: this.#d.session, mode: 'paper', clock: { now: () => ({ slot: this.#lastSlot ?? 0n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: now }) },
      account, latches: fact.latches, market: { solPrice: sol, solBalance: fact.solBalance, regime: 'unknown' },
    };
    // RISK-FAULT: a valuation risk cannot make is said once when it starts and once when it clears, never silent.
    const exit = evaluateExit(input);
    if (exit.fault !== null && this.#valuationFault === null) this.#d.log(`Risk could not value the account: ${exit.fault}. Nothing is latched from it until it can.`);
    if (exit.fault === null && this.#valuationFault !== null) this.#d.log('Risk can value the account again.');
    this.#valuationFault = exit.fault;
    const snapshot = riskSnapshot(input);
    if (snapshot === null) return;
    const maxAge = policy.gates.maxQuoteAgeMs;
    const marked = account.openPositions.every((o) => o.mark !== null && o.markAtMs !== null && o.markAtMs <= now && now - o.markAtMs <= maxAge);
    // RISK-LATCH: an account-level trip (R9, R10) seen on this valuation is latched now, whether or not an entry or an
    // exit is being evaluated, so a breach that recovers before the next one still holds until the owner reviews it.
    // Only a fully marked valuation at a fresh SOL price latches: an unknown mark is a stand-in loss, not a breach.
    if (latchable(account, sol, now, maxAge)) {
      const trips = exit.trips;
      if (trips.length > 0) {
        this.#d.log(`Risk tripped on the account valuation: ${[...trips].sort().join(', ')} (equity ${snapshot.equity}, NAV ${snapshot.nav ?? 'unknown'}).`);
        this.#latch(trips, now);
      }
    }
    const day = this.#account.state.dayMark?.startMs;
    if (this.#account.mark(snapshot, marked, this.#ctl.latches.killRearmedAtMs, now)) {
      if (day !== this.#account.state.dayMark?.startMs) this.#d.log(`Account marks: equity ${snapshot.equity} at ${new Date(now).toISOString()} for the Melbourne day from ${new Date(snapshot.dayStartMs).toISOString()}.`);
      this.#publishAccount();
    }
  }

  /** Latches R10 and R9 at `at` (a latch already set keeps its moment), saves them in control.json and puts the account. */
  #latch(trips: readonly string[], at: number): void {
    const l = this.#ctl.latches;
    this.#ctl = {
      ...this.#ctl,
      latches: {
        ...l,
        killTrippedAtMs: trips.includes('kill_switch') && l.killTrippedAtMs === null ? at : l.killTrippedAtMs,
        weeklyTrippedAtMs: trips.includes('weekly_loss') && l.weeklyTrippedAtMs === null ? at : l.weeklyTrippedAtMs,
      },
    };
    this.#control.write(this.#ctl);
    this.#publishAccount();
  }

  #afterRecord(r: LogRecord): void {
    collectAlerts(this.#alerts, r);
    if (r.type !== 'decision') return;
    if (r.reasons[0] === SHORTLIST) {
      const mint = r.reasons[2];
      if (mint !== undefined) this.#createFor(mint);
    }
    if (r.reasons[0] === CANDIDATE_RESTORED && r.reasons[2] !== undefined) this.#restoredMints.push(r.reasons[2]);
    const trips = r.reasons.filter((x) => x.startsWith(TRIP_PREFIX)).map((x) => x.slice(TRIP_PREFIX.length));
    if (trips.length > 0) this.#latch(trips, r.at.receivedAt);
    if (r.action?.type === 'propose_entry') this.#intentAt.set(r.action.intent.id, r.at.receivedAt);
    this.#view(r);
  }

  /** Candidate decisions for the app: the decisions list (latest 500) and each candidate's furthest funnel stage. */
  #view(r: Extract<LogRecord, { type: 'decision' }>): void {
    const [kind, , mint, why] = r.reasons;
    const kinds: readonly string[] = [SHORTLIST, 'reject', 'enter', 'no entry', 'risk approved'];
    if (kind === undefined || mint === undefined || !kinds.includes(kind)) return;
    const at = r.at.receivedAt;
    const st = this.#funnel.stage.get(mint) ?? { day: melbourneDate(at), stage: 0, check: null };
    this.#funnel.stage.set(mint, st);
    let row: DecisionRow | null = null;
    if (kind === 'reject' && why !== undefined) {
      const check = checkOf(why);
      st.check = check;
      st.stage = Math.max(st.stage, stageOf(check));
      row = { id: `${r.eventId}/${r.seq}`, atMs: at, mint, outcome: 'rejected', check, reasons: r.reasons.slice(3), tradeId: null };
    } else if (kind === 'risk approved') {
      st.stage = Math.max(st.stage, 3);
      st.check = null;
    } else if (kind === 'no entry') {
      row = { id: `${r.eventId}/${r.seq}`, atMs: at, mint, outcome: 'no-trade', check: st.check, reasons: r.reasons.slice(3), tradeId: null };
    }
    if (row !== null) {
      this.#rows.push(row);
      if (this.#rows.length > 500) this.#rows.splice(0, this.#rows.length - 500);
    }
  }

  /** An entry filled: the candidate reached the last funnel stage. */
  #entered(mint: string, positionId: string, atMs: number): void {
    const st = this.#funnel.stage.get(mint) ?? { day: melbourneDate(atMs), stage: 0, check: null };
    st.stage = 4;
    this.#funnel.stage.set(mint, st);
    const day = melbourneDate(atMs);
    this.#funnel.enteredByDay.set(day, (this.#funnel.enteredByDay.get(day) ?? 0) + 1);
    this.#rows.push({ id: `entry/${positionId}`, atMs, mint, outcome: 'entered', check: null, reasons: ['entry filled (paper)'], tradeId: positionId });
    if (this.#rows.length > 500) this.#rows.splice(0, this.#rows.length - 500);
  }

  /** What the app's read API shows, as of now. */
  apiInputs(): ApiInputs {
    const d = this.#d;
    return {
      nowMs: d.timers.now(), policy: d.session.policy, policyVersion: d.session.versionHash, strategyVersion: d.strategy.version,
      connected: this.#reconciled && [...this.#feeds.values()].some((f) => f.connected), halted: this.#halted, paused: this.#ctl.paused,
      exitCapable: this.#exitCapable(d.timers.now()), budgetHalted: (d.ops?.().quota ?? []).filter((q) => q.halted).map((q) => q.provider),
      alerts: [...this.#alerts], regime: this.#strategy.regime(), regimeMaxAgeMs: 2 * d.strategy.evaluateEveryMs, stops: this.#strategy.riskStops(),
      book: this.#engine.book, trades: this.#account.state.trades, accountCosts: this.#account.costRecords(), attempts: this.#world.attempts, legs: this.#legs(), decisions: this.#rows, funnel: this.#funnel,
      exitFee: attemptFee(d.network, BigInt(d.session.policy.exits.ladder.steps[0]?.priorityFeeLamports ?? 0), 'filled'),
      solPrice: this.#solPrice, symbol: (mint) => this.#symbols.get(mint) ?? `${mint.slice(0, 4)}…`, waitingExits: this.#strategy.waitingExits(),
      discovered: [...this.#strategy.candidates()].map(([mint, c]) => {
        const r = this.reservesOf(mint);
        return { mint, symbol: this.#symbols.get(mint) ?? null, migratedAtMs: c.migratedAtMs, lastEvalMs: c.lastEvalMs, gates: c.gates, quoteReserve: r === null ? null : effectiveQuoteReserve(r) };
      }),
      open: (p) => {
        const saved = this.#strategy.saved()[p.id];
        const m = this.poolOf(p.mint);
        const q = m === null ? null : poolSell(m.state, p.quantity, m.ctx);
        return saved === undefined ? null : { stopPrice: saved.plan.stopPrice, trail: saved.tracker.trail, liquidation: q !== null && q.ok ? q.trade.userQuote : null, openedAtMs: saved.plan.openedAtMs, universe: saved.plan.universe, markedAtMs: q !== null && q.ok ? m!.atMs : null };
      },
    };
  }

  /** Entries halt while a critical feed is down, stale or dropped by a drill; the state goes to the engine as a fact. */
  #checkHalt(now: number): void {
    if (!this.#reconciled) return;
    const reasons: string[] = [];
    for (const s of this.#feeds.values()) {
      if (!s.src.critical) continue;
      if (s.droppedUntil > now) reasons.push(`feed ${s.src.name} dropped by drill`);
      else if (!s.connected) reasons.push(`feed ${s.src.name} disconnected`);
      else if (s.last === null || now - s.last > this.#d.staleFeedMs) reasons.push(`feed ${s.src.name} stale`);
    }
    if (this.#ctl.paused) reasons.push('owner pause (watchdog)');
    // A position entered now could lose its price with no second path to read it (review of #87): entries stop.
    if (this.#d.watchRead === undefined || this.#d.watchHalted?.() === true) reasons.push(SECOND_PATH_UNAVAILABLE);
    // HELIUS-EXHAUSTED: no entry is judged while Helius refuses for credits; named, never an evidence refusal.
    if (this.#d.heliusExhaustion?.().exhausted === true) reasons.push(HELIUS_EXHAUSTED);
    if (this.#seeding) reasons.push(SEEDING);
    if (this.#recorderFault !== null) reasons.push(this.#recorderFault);
    if (Object.keys(this.#desk.book.positions).some((id) => lateFillOf(id) !== null)) reasons.push(LATE_BUY);
    reasons.push(...this.#diverged, ...this.#sellOnly);
    const same = reasons.length === this.#halted.length && reasons.every((x, k) => x === this.#halted[k]);
    if (same) return;
    const was = this.#halted.length > 0;
    this.#halted = reasons;
    this.#fact(HALT_KEY, { halted: reasons.length > 0, reasons });
    if (reasons.length > 0) this.#journal.write('halt', { reasons });
    else if (was) this.#journal.write('resume', { reasons: ['all critical feeds fresh, no pause'] });
  }

  /** Settles every open intent before any entry: exits 3 (via the result) if it cannot within the timeout. */
  async reconcile(): Promise<StartResult> {
    const d = this.#d;
    const deadline = d.timers.now() + d.reconcileTimeoutMs;
    // Intents not on the network at the stop (not yet sent, or resolved without a fill) are cancelled: an entry's
    // reservation is released, an exit's position re-triggers. Intents that may have been sent settle through the
    // restart's status reads first.
    const asked = new Set<string>();
    for (;;) {
      if (this.#stopping) return { ok: false, code: this.#stopCode, message: 'stopped during the start reconcile' };
      this.step();
      const book = this.#engine.book;
      for (const i of Object.values(book.intents)) {
        if (isTerminal(i) || isUnresolved(i) || i.status === 'signed' || asked.has(i.intent.id)) continue;
        this.#report({ type: 'intent', intentId: i.intent.id, event: { type: 'cancel' } });
        asked.add(i.intent.id);
      }
      const open = Object.values(book.intents).filter((i) => !isTerminal(i));
      // Done once everything put on the feed so far (the restored book, the restart, the paper world's answers) was
      // released and applied, and nothing is open.
      const fs = this.#feed.status();
      if (fs.held === 0 && fs.ready === 0 && open.length === 0 && !book.recovering) break;
      if (d.timers.now() >= deadline) {
        this.#journal.write('reconcile', { ok: false, open: open.length, reasons: [`${open.length} intents left unresolved after ${d.reconcileTimeoutMs} ms`] });
        return { ok: false, code: EXIT.reconcileFailed, message: 'Reconcile failed: intents left unresolved; exiting before any entry.' };
      }
      await new Promise<void>((r) => d.timers.setTimeout(r, Math.min(d.loopMs, 200)));
    }
    this.#reconciled = true;
    // The feed is drained here: the slot for SEED-1's events, ahead of the account fact below and every live event.
    this.#reserved = this.#feed.reserveSlot();
    this.#writeOpenIntents();
    // A guard: it re-books open trades from the restored book. No SOL price is known yet in a new process, so stray fees
    // wait for the first price (above).
    this.#settle();
    this.#publishAccount();
    const positions = Object.values(this.#engine.book.positions).filter((p) => p.status !== 'closed').map((p) => p.id);
    this.#journal.write('reconcile', { ok: true, restored_events: this.#ledgerEvents(), cancelled: asked.size, open_positions: positions });
    return { ok: true };
  }

  #ledgerEvents(): number {
    return this.#ledger.intentEvents().length;
  }

  /**
   * Starts the health and API servers, the live sources, the fact producers, the loop and the heartbeat, then seeds the
   * deployer index (SEED-1: once the live creates watch reports its first slot). Exits never wait for the seed: until it
   * is placed, entries halt with SEEDING and the strategy holds the index's live events back (see `SEED_KEY`).
   */
  async start(): Promise<StartResult> {
    const d = this.#d;
    const r = await this.reconcile();
    if (!r.ok) return r;
    // Packing the recording's saved-state copy is housekeeping: it runs beside the start, never ahead of the feeds (its
    // disk time would delay them, by however long the disk takes). A stop waits for it before the recorder closes.
    this.#packing = this.#packCopy();
    this.#journalRecovered();
    // Entries wait for the seed; this halt is released ahead of every live event, so the index waits with them.
    this.#seeding = true;
    this.#checkHalt(d.timers.now());
    this.#sources = d.sources({ feed: this.#feed, timers: d.timers, pools: () => this.#strategy.watchedPools(), journal: (kind, fields) => this.#journal.write(kind, fields) });
    for (const s of this.#sources) this.#feeds.set(s.name, { src: s, connected: false, last: null, droppedUntil: 0 });
    try {
      this.#server = await startHealthServer(d.config.health.host, d.config.health.port, {
        health: () => this.health(),
        drill: d.config.drills ? { token: this.#drillToken, dropFeed: (feed, ms) => this.dropFeed(feed, ms), dropRpc: (ms) => this.dropRpc(ms) } : null,
      });
    } catch (e) {
      return { ok: false, code: EXIT.crash, message: `health server: ${e instanceof Error ? e.message : 'error'}` };
    }
    try {
      this.#api = await startApiServer(d.config.api.host, d.config.api.port, () => this.apiInputs(), (command, auth) => this.#commandRefused(command, auth));
    } catch (e) {
      return { ok: false, code: EXIT.crash, message: `API server: ${e instanceof Error ? e.message : 'error'}` };
    }
    for (const s of this.#sources) s.start();
    this.#probe?.start();
    this.#watch = this.#positionWatch();
    this.#watch.start();
    // In the background: the exits must not wait for a chain history read.
    void this.#journalExposure().catch((e: unknown) => d.log(`Exposure rebuild failed: ${e instanceof Error ? e.message : 'error'}.`));
    if (d.facts !== undefined && d.facts.length > 0) {
      if (d.schedulers === undefined) return { ok: false, code: EXIT.config, message: 'fact producers need the provider schedulers' };
      const ctx: FactContext = {
        sink: { fact: (key, value) => this.#fact(key, value), now: () => d.timers.now() },
        timers: d.timers, schedulers: d.schedulers, watched: () => this.#strategy.watched(),
        ingest: this.#feed, candidates: () => this.#strategy.candidates(), tip: () => this.#feed.tip,
        priorMints: (creator, nowMs) => this.#strategy.deployers.factFor(creator, { slot: this.#feed.tip ?? 0n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: nowMs }, 0).mints,
      };
      for (const f of d.facts) f.start(ctx);
    }
    const loop = (): void => {
      if (this.#stopping) return;
      try {
        this.step();
      } catch (e) {
        d.log(`Engine step failed: ${e instanceof Error ? `${e.name}: ${e.message}` : 'error'}`);
        process.exitCode = EXIT.crash;
        void this.stop(EXIT.crash, crashSite(e, this.#engine.lastHandled));
        return;
      }
      this.#loop = d.timers.setTimeout(loop, d.loopMs);
    };
    this.#loop = d.timers.setTimeout(loop, d.loopMs);
    const beat = (): void => {
      if (this.#stopping) return;
      void this.heartbeat().finally(() => {
        if (!this.#stopping) this.#beat = d.timers.setTimeout(beat, d.config.heartbeatMs);
      });
    };
    beat();
    this.#traceMem();
    this.#startSummary();
    // The loop already runs (exits never wait for the seed); entries resume once the seed is placed or given up.
    try {
      await this.#seedIndex(this.#reserved);
    } finally {
      this.#seeding = false;
      // CREATE-AFTER-RESTART: the shortlists that waited for the seed, now with every saved and seeded create known.
      const pending = this.#createPending;
      this.#createPending = [];
      for (const mint of pending) this.#createFor(mint);
      this.#checkHalt(d.timers.now());
    }
    // RESTART-KEEP: after the seed (whose fill reserves the shared budget while it runs), in the background.
    this.#readRestored();
    void this.#downtimeMigrations().catch((e: unknown) => d.log(`Downtime migrations not read: ${e instanceof Error ? e.message : 'error'}.`));
    // A loop crash during the seed stopped the worker with the crash code: the start reports that code, never 0.
    if (this.#stopping) return { ok: false, code: this.#stopCode, message: 'stopped during the start' };
    d.log(`Worker up: boot ${this.#boot}, release ${d.config.gitSha.slice(0, 12)}, recorder ${d.config.recorder ? 'on' : 'off'}, simulation ${d.config.simulate ? 'on' : 'off'}, ${this.#sources.length} feeds.`);
    return { ok: true };
  }

  /**
   * RUN-1d's `--reconcile-only` (the host-loss tabletop): cold-start on this state dir, reconcile, journal `recovered`,
   * and serve /health with `reconciled` and `exit_capable`. It sends nothing: no entries, no exits, no heartbeat, no
   * drills, no API. The live feeds run only so `exit_capable` is real; their events are drained unread (the engine
   * never sees them, so nothing can be decided). It runs until stopped.
   */
  async observeOnly(): Promise<StartResult> {
    const d = this.#d;
    this.#observing = true;
    const r = await this.reconcile();
    if (!r.ok) return r;
    // Packing the recording's saved-state copy is housekeeping: it runs beside the start, never ahead of the feeds (its
    // disk time would delay them, by however long the disk takes). A stop waits for it before the recorder closes.
    this.#packing = this.#packCopy();
    this.#journalRecovered();
    this.#sources = d.sources({ feed: this.#feed, timers: d.timers, pools: () => new Map() });
    for (const s of this.#sources) this.#feeds.set(s.name, { src: s, connected: false, last: null, droppedUntil: 0 });
    try {
      this.#server = await startHealthServer(d.config.health.host, d.config.health.port, { health: () => this.health(), drill: null });
    } catch (e) {
      return { ok: false, code: EXIT.crash, message: `health server: ${e instanceof Error ? e.message : 'error'}` };
    }
    for (const s of this.#sources) s.start();
    const drain = (): void => {
      if (this.#stopping) return;
      this.#feed.advance(d.timers.now());
      while (this.#feed.next() !== null) {
        // Drained unread: the reconcile-only process decides nothing.
      }
      this.#loop = d.timers.setTimeout(drain, d.loopMs);
    };
    this.#loop = d.timers.setTimeout(drain, d.loopMs);
    d.log(`Reconcile-only up: boot ${this.#boot}, ${this.#sources.length} feeds, nothing is sent.`);
    return { ok: true };
  }

  /**
   * SEED-1 at start. Waits (bounded) for the live creates watch's first slot, builds the seed or the downtime fill, and
   * puts the `worker:seed` fact on the feed: saved and seeded creates, the fill, saved rug facts, and the creates and
   * rugs coverage history (saved, then seeded) dated in the slot reserved at reconcile, ahead of every live event, so
   * H14 reads it in that order. Coverage history keeps its receipt time (what coverage is judged by). Without a fill on
   * a restart, the downtime is marked an open gap on the saved watch, which the watch's new start settles as lossy: the
   * downtime never reads as covered. A seed slower than seedMaxMs is abandoned (its RPC stops) and reads as none.
   */
  async #seedIndex(reserved: bigint | null): Promise<void> {
    const d = this.#d;
    const until = d.timers.now() + d.seedWaitMs;
    while (this.#liveStart === null && d.timers.now() < until && !this.#stopping) await new Promise<void>((r) => d.timers.setTimeout(r, 100));
    const now = d.timers.now();
    const tip = this.#feed.tip;
    const untilSlot = this.#liveStart;
    const liveStart = this.#liveStartAt;
    const top = [tip, untilSlot, liveStart?.slot ?? null, this.#saved.last?.slot ?? null].reduce<bigint>((a, b) => (b !== null && b > a ? b : a), 0n);
    const asOf: Moment = { slot: top, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: now };
    const saved = this.#saved;
    const close = liveWatchToClose(saved.coverage);
    let result: SeedResult = { mode: 'none', creates: [], coverage: [], report: 'not run' };
    const abort = new AbortController();
    try {
      // Bounded: entries wait for the seed, so a slow fill gives up, stops its RPC, and the downtime reads as a gap.
      const max = d.seedMaxMs;
      result = await Promise.race([
        d.seed({ saved, close, untilSlot, liveStart, asOf, signal: abort.signal }),
        ...(max === undefined ? [] : [new Promise<never>((_, reject) => d.timers.setTimeout(() => reject(new Error(`no answer within ${max} ms`)), max))]),
      ]);
    } catch (e) {
      result = { mode: 'none', creates: [], coverage: [], report: `seed failed: ${e instanceof Error ? e.message : 'error'}` };
    } finally {
      abort.abort();
    }
    if (this.#stopping) return;
    const extra: MarketEvent[] = [];
    if (result.mode !== 'fill' && saved.last !== null && close !== null) {
      // A restart without a fill: the downtime is an open gap on the saved watch, settled by its new start as lossy.
      extra.push({ kind: 'market', id: 'worker:downtime-gap', moment: { ...asOf }, key: 'coverage:creates:gap', value: { value: { fromSlot: saved.last.slot + 1n, toSlot: null, reason: 'worker down; no downtime fill', via: close.via }, source: 'worker', backfilled: false, seq: 0 } });
    }
    const order = (xs: readonly MarketEvent[]) => {
      const byId = new Map(xs.map((e) => [e.id, e]));
      return [...byId.values()].sort(compareEvents);
    };
    // Without the reserved slot (cannot happen after a successful reconcile) no coverage is seeded rather than misordered:
    // the seed still goes out, since entries and the index wait for it.
    const coverage = reserved === null ? [] : [...saved.coverage, ...result.coverage, ...extra];
    if (reserved === null) d.log('Deployer index: no coverage seeded (no free slot ahead of the live events); H14 not covered until the look-back passes.');
    const pos = (k: number): Moment => ({ slot: reserved ?? 0n, txIndex: 0, ixIndex: k, receivedAt: now });
    this.#fact(SEED_KEY, {
      ...(this.#restored === null ? {} : { state: { ref: this.#restored.ref } }),
      creates: order(result.mode === 'fill' ? saved.creates : [...saved.creates, ...result.creates]),
      coverage: order(coverage.filter((e) => e.key.startsWith('coverage:creates:') && compareMoments(e.moment, asOf) <= 0)),
      fill: order(result.mode === 'fill' ? result.creates : []),
      rugs: order(saved.rugs), asOf,
      // WORKER-1d: a saved fact already carries an earlier boot's `#pre<k>`; it is replaced, not stacked, so ids stay short.
      history: coverage.map((e, k) => ({ ...e, id: `${e.id.replace(/(#pre\d+)+$/, '')}#pre${k}`, moment: { ...pos(1 + k), receivedAt: e.moment.receivedAt } })),
    });
    // The restored index is in the seed now (and the strategy's index): this copy is released (WORKER-GROW).
    this.#restored = null;
    for (const e of [...result.creates, ...result.coverage, ...extra]) this.#deployerStore.keep(e);
    this.#noteCreates(result.creates);
    d.log(`Deployer index: ${result.mode} (${result.report}); ${saved.creates.length} saved creates, ${saved.coverage.length} saved coverage facts.`);
  }

  /** Trades with an exit planned, requested or signed and not yet final, or a due exit waiting for its first fresh quote (EXIT-1c): what a restart must not lose (RUN-1d). */
  pendingExits(): string[] {
    const book = this.#engine.book;
    const out = new Set<string>();
    for (const p of Object.values(book.positions)) if (p.status === 'exit_requested' || p.status === 'exit_pending' || p.status === 'exit_blocked') out.add(p.id);
    for (const i of Object.values(book.intents)) if (i.intent.purpose === 'exit' && !isTerminal(i)) out.add(i.intent.positionId);
    // EXIT-1c: an open position whose due exit waits for its first fresh quote.
    const waiting = this.#strategy.waitingExits();
    for (const p of Object.values(book.positions)) if (p.status === 'open' && waiting.has(p.id)) out.add(p.id);
    return [...out].sort();
  }

  /** Each open position with the universe it was entered under (its plan, else its entry key). */
  #positionsWithUniverse(): { trade: string; universe: string }[] {
    const book = this.#engine.book;
    const saved = this.#strategy.saved();
    return Object.values(book.positions).filter((p) => p.status !== 'closed').map((p) => {
      const entry = book.intents[p.entryIntentId];
      // None on record is said as such (the strategy flattens it), never guessed and never a bare 'unknown'.
      const universe = resolveUniverse(saved[p.id]?.plan.universe, entry?.intent.key) ?? NO_UNIVERSE;
      return { trade: p.id, universe };
    }).sort((a, b) => (a.trade < b.trade ? -1 : 1));
  }

  /** RUN-1d: once per boot, right after the start reconcile, what was found and kept. */
  #journalRecovered(): void {
    const marker = join(this.#d.config.stateDir, COLD_START);
    const cold = existsSync(marker);
    // Through the runner's contract type: a field it renames or adds fails the worker's typecheck.
    const fields = { source: cold ? 'chain' : 'state', pending_exits: this.pendingExits(), positions: this.#positionsWithUniverse() } satisfies RecoveredFields;
    this.#journal.write('recovered', fields);
    if (cold) rmSync(marker, { force: true });
  }

  /**
   * RUN-1c: one `exposure` line per trade open or in flight when the previous process stopped, with the worst move of
   * its pool over the down window rebuilt from chain history; then the pending record is cleared.
   */
  async #journalExposure(): Promise<void> {
    const pending = this.#exposedFile.read(NO_EXPOSED);
    if (pending.trades.length === 0) return;
    const saved = this.#exitsFile.read({});
    const toMs = this.#d.timers.now();
    for (const trade of pending.trades) {
      const s = saved[trade];
      const r = this.#d.exposureRpc === undefined
        ? { worst_move_bps: null, swaps: 0, reason: 'no chain history reader configured' }
        : await rebuildMove({ rpc: this.#d.exposureRpc, pool: s?.pool ?? null, ref: s?.spot?.price ?? null, fromMs: pending.fromMs, toMs, maxTx: 200 });
      this.#journal.write('exposure', { trade, from_ts: new Date(pending.fromMs).toISOString(), to_ts: new Date(toMs).toISOString(), worst_move_bps: r.worst_move_bps, swaps: r.swaps, detail: r.reason, pool: s?.pool ?? null });
    }
    this.#exposedFile.write(NO_EXPOSED);
  }

  /**
   * An exit could go out now: reconciled, and the chain feed that carries the slots, the pool states and the quotes
   * (every critical feed with a chain source) is connected, fresh and not dropped. Paper lands by the paper world.
   */
  #exitCapable(now: number): boolean {
    if (!this.#reconciled || this.#rpcDownUntil > now) return false;
    const chain = [...this.#feeds.values()].filter((s) => s.src.critical && s.src.sources.some((x) => x === 'helius' || x === 'alchemy'));
    return chain.length > 0 && chain.every((s) => s.connected && s.droppedUntil <= now && s.last !== null && now - s.last <= this.#d.staleFeedMs);
  }

  /** A position's mark when read within the last 30 s (RUN-1c's MARK_MAX_AGE_MS); an older one is no price. */
  #freshDisplayQuote(pid: string): { readonly price: bigint; readonly atMs: number; readonly slot: bigint } | null {
    const m = this.#strategy.displayQuoteOf(pid);
    return m === null || this.#d.timers.now() - m.atMs > 30_000 ? null : m;
  }

  /**
   * RUN-1d's drill: every provider lost at once for `ms`. Every feed is dropped (entries halt, exit_capable is false)
   * and every RPC call is refused; P0 and P1 requests fail rather than being shed, and pending exits stay in the book.
   */
  dropRpc(ms: number): boolean {
    const now = this.#d.timers.now();
    this.#rpcDownUntil = Math.max(this.#rpcDownUntil, now + ms);
    this.#d.cutRpc?.(ms);
    this.#journal.write('feed', { feed: 'all providers', connected: false, cause: 'drop-rpc drill', ms });
    for (const name of this.#feeds.keys()) this.dropFeed(name, ms);
    return true;
  }

  /** WATCH-1: the independent watch on held positions, on its own timer. */
  /** WATCH-1: each position that opened since the last step gets one read at once. */
  #watchOpened(): void {
    const open = new Set<string>();
    for (const p of Object.values(this.#engine.book.positions)) {
      if (p.status === 'closed' || p.quantity <= 0n) continue;
      open.add(p.id);
      if (!this.#opened.has(p.id)) this.#watch?.opened(String(p.mint), this.poolOf(p.mint)?.address ?? this.#strategy.saved()[p.id]?.pool ?? null);
    }
    this.#opened = open;
  }

  #positionWatch(): PositionWatch {
    const d = this.#d;
    return new PositionWatch({
      timers: d.timers, everyMs: d.config.watch.everyMs, staleMs: d.config.watch.staleMs, latencyMs: d.config.watch.latencyMs, verifyMs: d.config.watch.verifyMs,
      held: () => {
        const book = this.#engine.book;
        const open = Object.values(book.positions).filter((p) => p.status !== 'closed' && p.quantity > 0n).map((p) => ({
          mint: String(p.mint), pool: this.poolOf(p.mint)?.address ?? this.#strategy.saved()[p.id]?.pool ?? null,
        }));
        // Entries in flight, on the pool their decision priced, through the fill until the position shows its quantity;
        // ones settled unfilled (rejected, cancelled, failed, expired) drop out, and a closed position takes its entry along.
        const entering = Object.values(book.intents).filter((i) => i.intent.purpose === 'entry' && (ENTRY_IN_FLIGHT.has(i.status) || i.fills.length > 0) && book.positions[i.intent.positionId]?.status !== 'closed')
          .map((i) => ({ mint: String(i.intent.mint), pool: this.poolOf(i.intent.mint)?.address ?? null }));
        const seen = new Set(open.map((h) => h.mint));
        return [...open, ...entering.filter((e) => !seen.has(e.mint) && seen.add(e.mint))];
      },
      marketAt: (mint) => this.#watchMarketAt(mint),
      read: d.watchRead ?? (() => Promise.reject(new Error('no second path configured'))),
      head: () => (this.#lastSlot === null || this.#lastSlotAt === null ? null : { slot: this.#lastSlot, atMs: this.#lastSlotAt }),
      maxLagSlots: d.session.policy.gates.maxStateSlotLag,
      put: (snap, atMs) => this.#fact(snapshotKey(snap.mint), { pool: snap.pool, slot: snap.slot, atMs, state: snap.state, ctx: snap.ctx }),
      alert: (mint, reason) => {
        this.#journal.write('alert', { level: 'critical', code: 'position_unpriced', mint, reasons: [`no fresh price for ${mint}`, reason] });
        d.log(`Critical: no fresh price for the position in ${mint} (${reason}).`);
      },
      cleared: (mint) => this.#journal.write('alert', { level: 'cleared', code: 'position_unpriced', mint, reasons: [`fresh price for ${mint} again`] }),
    });
  }

  /** The drill: close one feed for `ms`, then reconnect. False for an unknown feed. */
  dropFeed(name: string, ms: number): boolean {
    const s = this.#feeds.get(name);
    if (s === undefined) return false;
    const now = this.#d.timers.now();
    s.droppedUntil = now + ms;
    this.#journal.write('feed', { feed: name, connected: false, cause: 'drill', ms });
    s.src.stop();
    s.connected = false;
    this.#d.timers.setTimeout(() => {
      if (this.#stopping) return;
      s.src.start();
      this.#journal.write('feed', { feed: name, connected: true, cause: 'drill ended' });
    }, ms);
    return true;
  }

  health(): Health {
    const now = this.#d.timers.now();
    const feeds: Record<string, FeedHealth> = {};
    const ages: Record<string, number | null> = {};
    for (const [name, s] of this.#feeds) {
      const age = s.last === null ? null : now - s.last;
      ages[name] = age;
      feeds[name] = { connected: s.connected && s.droppedUntil <= now, age_ms: age, critical: s.src.critical, dropped_by_drill: s.droppedUntil > now };
    }
    const savedPlans = this.#strategy.saved();
    const universes = new Map(this.#positionsWithUniverse().map((x) => [x.trade, x.universe]));
    const positions = openPositionsHealth(Object.values(this.#engine.book.positions), {
      openedAt: (id) => this.#account.state.trades.find((t) => t.positionId === id)?.openedAtMs ?? null,
      plan: (id) => savedPlans[id]?.plan ?? null,
      universe: (id) => universes.get(id) ?? NO_UNIVERSE,
      mark: (id) => this.#strategy.displayQuoteOf(id),
    });
    const ops = this.#d.ops?.() ?? { quota: [], lookups: { counts: LOOKUP_BOUNDS_MS.map(() => 0).concat(0) } };
    const h: Health = {
      seq: this.#beatSeq, ts: now, git_sha: this.#d.config.gitSha, policy_version: this.#d.session.versionHash,
      last_processed_slot: this.#lastSlot === null ? null : Number(this.#lastSlot), feed_ages_ms: ages,
      open_position: positions[0] ?? null,
      open_positions: positions,
      pending_exits: this.pendingExits(),
      unresolved_intents: this.#desk.unresolved(now, (id) => this.#intentAt.get(id) ?? null),
      signer: 'none', lease_epoch: null,
      sol_reserve: this.#account.state.walletLamports === null ? null : String(this.#account.state.walletLamports),
      paused: this.#ctl.paused, boot: this.#boot, pid: process.pid, uptime_s: Math.round((now - this.#started) / 1000),
      rss_bytes: process.memoryUsage().rss, last_exit: this.#lastExit, restarts_24h: this.#restartCounts(now), mode: 'paper', recorder: this.#d.config.recorder && this.#recorderFault === null ? 'on' : 'off', simulation: this.#d.config.simulate ? 'on' : 'off',
      reconciled: this.#reconciled, exit_capable: this.#exitCapable(now), quota: ops.quota, lookups: ops.lookups, entries_halted: this.#halted.length > 0, halt_reasons: [...this.#halted], critical: [...(this.#watch?.critical ?? []), ...(this.#recorderFault === null ? [] : [this.#recorderFault])], feeds, journal_seq: this.#journal.seq, signing_key: false,
      entry_rule: this.#d.config.strategy.name,
      ...(this.#d.strategy.s0Diagnostic === true ? { s0_diagnostic: S0_DIAGNOSTIC_PARTS } : {}),
      ...(this.#seedOutcome === null ? {} : { graduates_seed: this.#seedOutcome }),
    };
    return h;
  }

  /**
   * OPS-SUMMARY: the daily summary, posted on the Melbourne wall-clock slots of `summaryMs`, just after Melbourne
   * midnight, and once shortly after this (reconciled) start (SUMMARY-CLOCK). Only with a watchdog and its key; it runs
   * beside the loop and never touches the engine, the ledger or the journal (it only reads it).
   */
  #startSummary(): void {
    const d = this.#d;
    const s = this.#summarizer();
    if (s === null || this.#stopping) return;
    this.#summaryClock = new SummaryClock({ timers: d.timers, everyMs: d.config.summaryMs, tick: () => this.summaryNow(), lastPostedMs: () => s.lastPostedMs });
    this.#summaryClock.start();
  }

  /** MEM-TRACE: the memory sample, every MEM_EVERY_MS, for the next boot's reading of how this process ended. Never throws. */
  #traceMem(): void {
    if (this.#stopping) return;
    try {
      writeMem(this.#d.config.stateDir, sampleMem(this.#d.timers.now(), this.#cgroupMax));
    } catch {
      // A sample not written (a full disk) only leaves the next boot without it.
    }
    this.#memTimer = this.#d.timers.setTimeout(() => this.#traceMem(), MEM_EVERY_MS);
  }

  /** The summarizer, made on first use; null without a watchdog or its key. */
  #summarizer(): Summarizer | null {
    const d = this.#d;
    const url = d.config.watchdogUrl;
    const key = d.heartbeat.key;
    if (url === null || key === null) return null;
    this.#summary ??= new Summarizer({
      journalPath: join(d.config.stateDir, STATE_FILES.journal), stateDir: d.config.stateDir, http: d.heartbeat.http,
      watchdogUrl: url, key, now: () => d.timers.now(), log: d.log,
      live: () => {
        d.summaryFault?.();
        return {
          gitSha: d.config.gitSha, entryRule: d.config.strategy.name, recorder: d.config.recorder ? 'on' : 'off',
          uptimeS: (d.timers.now() - this.#started) / 1000, trades: this.#account.state.trades,
          openPositions: Object.values(this.#engine.book.positions).filter((p) => p.status !== 'closed').length,
          solPrice: this.#solPrice, credits: d.ops?.().quota ?? [], heliusExhaustion: d.heliusExhaustion?.() ?? null,
        };
      },
    });
    return this.#summary;
  }

  /** One summary post now (the timer's and the tests' entry). Resolves when done; never rejects. */
  async summaryNow(): Promise<void> {
    await this.#summarizer()?.tick();
  }

  /** One signed heartbeat; the reply's pause is applied both ways. */
  async heartbeat(): Promise<void> {
    const hb = this.#d.heartbeat;
    const url = this.#d.config.watchdogUrl;
    this.#beatSeq++;
    if (this.#d.timers.now() - this.#refusals.since >= 60_000) this.#countRefusals();
    if (url === null || hb.key === null) return;
    const h = this.health();
    const p = Object.values(this.#engine.book.positions).find((x) => x.status !== 'closed' && x.status !== 'opening');
    const saved = p === undefined ? undefined : this.#strategy.saved()[p.id];
    const mark = p === undefined ? null : this.#freshDisplayQuote(p.id);
    const lastExit = p === undefined ? null : Math.max(...Object.values(this.#engine.book.intents).filter((i) => i.intent.positionId === p.id && i.intent.purpose === 'exit').map((i) => this.#intentAt.get(i.intent.id) ?? 0), 0);
    const position: HeartbeatPosition | null = p === undefined ? null : {
      // Unknown is null, never 0 (a 0 stop or mark reads as a price to the watchdog). Entry, stop and mark share one unit:
      // an executable price (PRICE_SCALE lamports per token).
      mint: p.mint, qty: Number(p.quantity), entry: Number(entryPrice(p)), stop: saved === undefined ? (null as unknown as number) : Number(saved.plan.stopPrice),
      mark: mark === null ? null : Number(mark.price),
      last_exit_attempt_ts: lastExit === 0 ? null : lastExit,
    };
    const r = await sendHeartbeat(hb.http, url, hb.key, heartbeatBody(h, position, hb.ownerChatId), this.#d.timers.now());
    if (!r.ok) {
      this.#d.log(`Heartbeat not accepted: ${r.reason}.`);
      return;
    }
    this.applyPause(r.paused);
  }

  /** The watchdog's flag, both ways: true stops new entries (exits go on), false allows them again. */
  applyPause(paused: boolean): void {
    if (paused === this.#ctl.paused) return;
    this.#ctl = { ...this.#ctl, paused, pausedAtMs: paused ? this.#d.timers.now() : null };
    this.#control.write(this.#ctl);
    this.#report(paused ? { type: 'pause_entries', reason: 'owner' } : { type: 'resume_entries', reason: 'owner' });
    this.#d.log(paused ? 'Entries paused by the owner (watchdog). Exits keep running.' : 'Entries allowed again (pause cleared).');
  }

  /** Clean stop: entries stop, simulations finish (bounded), journal and recorder close, the ledger closes. */
  /** `crash`: where a crash happened (crash-site.ts), written on the stop line for the next boot's `last_exit`. */
  async stop(code: number = EXIT.clean, crash?: string): Promise<number> {
    if (this.#stopping) return this.stopped;
    this.#stopping = true;
    this.#stopCode = code;
    this.#stoppingNow(code);
    try {
      await this.#stop(code, crash);
    } catch (e) {
      // A stop that fails half way (a full disk) still ends the process, as a crash.
      this.#d.log(`Stop failed: ${errorText(e)}.`);
      this.#stopCode = code = EXIT.crash;
    }
    this.#stoppedNow(code);
    return code;
  }

  async #stop(code: number, crash?: string): Promise<void> {
    const d = this.#d;
    if (this.#loop !== null) d.timers.clearTimeout(this.#loop);
    if (this.#beat !== null) d.timers.clearTimeout(this.#beat);
    if (this.#memTimer !== null) d.timers.clearTimeout(this.#memTimer);
    this.#summaryClock?.stop();
    for (const s of this.#sources) s.stop();
    this.#probe?.stop();
    this.#watch?.stop();
    for (const f of d.facts ?? []) f.stop();
    const pending = [...this.#world.pending.values()];
    if (pending.length > 0) {
      await Promise.race([Promise.allSettled(pending), new Promise<void>((r) => d.timers.setTimeout(r, 10_000))]);
    }
    if (!this.#observing) {
      try {
        this.step();
      } catch {}
    }
    // A clean stop saves the deployer state last thing (a crash keeps the last periodic save).
    if (code === EXIT.clean) this.#persist(d.timers.now());
    // Past this point the state files belong to the next process: a simulation answering late writes nothing.
    this.#world.stop();
    const open = Object.values(this.#engine.book.positions).filter((p) => p.status !== 'closed').map((p) => p.id);
    this.#journal.write('stop', { open_positions: open, open_intents: openIntents(this.#desk.book), reasons: code === EXIT.clean ? ['signal'] : crash === undefined ? ['crash'] : ['crash', crash] });
    if (this.#packing !== null) await this.#packing;
    this.#record((r) => r.close());
    this.#ledger.close();
    if (code === EXIT.clean) writeFileSync(join(d.config.stateDir, STATE_FILES.cleanStop), new Date(d.timers.now()).toISOString());
    await new Promise<void>((r) => (this.#server === null ? r() : this.#server.close(() => r())));
    await new Promise<void>((r) => (this.#api === null ? r() : this.#api.close(() => r())));
  }

  /** Restarts in the 24 h before `now`: planned (a runner drill's marker), deploys (a new release) and unplanned. */
  #restartCounts(now: number): { readonly planned: number; readonly deploy: number; readonly unplanned: number } {
    const recent = this.#restarts.filter((r) => r.at <= now && now - r.at < 86_400_000);
    const n = (k: Restart['kind']): number => recent.filter((r) => r.kind === k).length;
    return { planned: n('planned'), deploy: n('deploy'), unplanned: n('unplanned') };
  }

  /**
   * An uncaught exception or rejection (main's fatal handler): the stop line, with where it happened, is written at once,
   * since the process exits right after. Nothing else runs; the next boot reconciles as after any crash.
   */
  crashed(e: unknown): void {
    try {
      const open = Object.values(this.#engine.book.positions).filter((p) => p.status !== 'closed').map((p) => p.id);
      this.#journal.write('stop', { open_positions: open, open_intents: openIntents(this.#desk.book), reasons: ['crash', crashSite(e)] });
    } catch {}
  }

  /**
   * What SIGKILL leaves behind, for restart drills in tests: timers, sources and the server stop, the ledger's
   * connection closes (the kernel drops its lock when a killed process dies), and nothing else runs: no final step, no
   * `stop` line, no recorder seal, no `clean_stop`.
   */
  async kill(): Promise<void> {
    this.#stopping = true;
    // A killed process ends with no code of its own; a later `stop` on this object returns at once, as a crash.
    this.#stopCode = EXIT.crash;
    this.#stoppingNow(EXIT.crash);
    this.#stoppedNow(EXIT.crash);
    this.#world.stop();
    if (this.#loop !== null) this.#d.timers.clearTimeout(this.#loop);
    if (this.#beat !== null) this.#d.timers.clearTimeout(this.#beat);
    if (this.#memTimer !== null) this.#d.timers.clearTimeout(this.#memTimer);
    this.#summaryClock?.stop();
    for (const s of this.#sources) s.stop();
    this.#watch?.stop();
    this.#ledger.close();
    await new Promise<void>((r) => (this.#server === null ? r() : this.#server.close(() => r())));
    await new Promise<void>((r) => (this.#api === null ? r() : this.#api.close(() => r())));
  }

  /** For the `--reconcile` entry: settle, report, close without starting anything. */
  async reconcileOnly(): Promise<StartResult> {
    const r = await this.reconcile();
    // The unit's pre-step restores (and copies) the saved state too: packed, or linked to the stored copy, like a start's.
    if (!this.#stopping) await this.#packCopy();
    // A signal during the reconcile runs the clean stop, which closes both.
    if (!this.#stopping) {
      this.#record((r) => r.close());
      this.#ledger.close();
    }
    return r;
  }
}
