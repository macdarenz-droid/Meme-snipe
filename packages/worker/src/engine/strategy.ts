// The live paper strategy (WORKER-1): universe U2 through GATE-1's hard rejects and regime gate, RISK-1's entry
// controls and EXIT-1's exit engine, inside the one engine live and backtest share. Pure: it reads only what the engine
// hands it (as-of lookups, the book) and acts only through decisions, so recorded live data replays to the same log.
//
// Inputs it reads (keys of the as-of store):
//   FEED-1 events      migrations (`pump:CompletePumpAmmMigrationEvent:<mint>` or its `logs:` copy), creates, trades
//   gates/*            GATE-1 facts (FACTS-1 produces them live; missing facts reject under H16)
//   worker:fees:<mint> the pool's CORE-2 fee context, read with the pool
//   worker:account     the ledger's account snapshot and latches (published by the worker after each ledger change)
//   worker:restore     exit plans, trackers and price bars saved before a restart (published once at start)
//   chain:slot         the slot notice: the paper block height
// Entries stop at `approve_risk`: the reservation goes through the ledger outside the engine (RISK-1 with LEDGER-1c's
// account version) and comes back as a world event, `reserve_exposure` or `reject`.
import { createHash } from 'node:crypto';
import { type PoolFeeContext, type PoolState, effectiveQuoteReserve, poolBuyExactQuoteIn, poolSell } from '../../../core/src/amm/index.ts';
import { encodeBase58 } from '../../../core/src/chain/index.ts';
import type { PolicySession, RugConfig } from '../../../core/src/config/index.ts';
import { EXIT_UNIVERSES, type ExitUniverse, PRICE_SCALE, exitsFor } from '../../../core/src/config/index.ts';
import { type NetworkPolicy, type RentInputs, type RoundTripQuoter, pumpSwapRoundTrip } from '../../../core/src/costs/index.ts';
import {
  type IntentId, type PositionId, type QuoteContext, type TransactionAttempt,
  attemptId, blockhash, entryKey, intentId, mint as toMint, positionId, reservationId, signature,
} from '../../../core/src/domain/index.ts';
import { type AsOfEntry, type Decision, type MarketEvent, type Moment, type Strategy, type StrategyContext, compareMoments, flatCopy } from '../../../core/src/engine/index.ts';
import { RAW } from '../../../core/src/facts/raw.ts';
import { observedFeeContext, type SwapEvent, swapEventState } from '../../../core/src/fills/index.ts';
import {
  type EntryPlan, type ExitDecision, type FlowMinute, type ExitSettings, type ExitTracker, type Holding, type PriceBar,
  atr, attemptRung, checkStopDistance, decideExit, execPrice, liquidationValue, exitAttemptsOf, exitBookEvents, exitSettings, newTracker, noteAttempt,
} from '../../../core/src/exits/index.ts';
import {
  AsOfClamp, type Coverage, type DeployerIndexState, type GateContext, type GraduatesFact, type RugLabellerState, type S0DiagnosticPart, DeployerIndex, GRADUATES_KEY, hardAllowsEntry, LOG_CREATE_PREFIX, NOT_EVALUATED, stagedHardRejects, RugLabeller, S0_DIAGNOSTIC_PARTS, TX_CREATE_PREFIX, type PoolFact, carryKey, createKey, createKeepVerdict, CREATE_LATE_MS, createOf, createsCoverage, evaluateHardRejects, evaluateRegime, migrationKey, parseCreate, parseGraduates, parseMigration, parsePool, poolKey, pruneCoverage,
} from '../../../core/src/gates/index.ts';
import type { GraduatesSeed } from '../../../core/src/facts/raw.ts';
import { type Book, type BookEvent, type IntentState, isTerminal } from '../../../core/src/lifecycle/index.ts';
import { type AccountHistory, type Latches, type Timed, evaluateEntry, evaluateExit, maxTradeCosts, riskSnapshot } from '../../../core/src/risk/index.ts';
import { HourTags } from './hour-tags.ts';
import { latchable, type markedHistory, markSettings, riskAccount } from './marks.ts';
import { type Bps, BPS_DENOMINATOR, type Lamports, type MicroUsd, bps, lamportsToMicroUsd, mulDiv, microUsdToLamports } from '../../../core/src/units/index.ts';

/** PERSIST-2: the graduates series as saved (a `GraduatesSeed` without its source). */
export type SavedGraduates = Omit<GraduatesSeed, 'source'>;

export const ACCOUNT_KEY = 'worker:account';
/** Key prefixes of GATE-1's pool and migration facts. */
export const POOL_PREFIX = poolKey('');
export const CARRY_PREFIX = carryKey('');
export const MIGRATION_PREFIX = migrationKey('');
export const RESTORE_KEY = 'worker:restore';
/** A coverage fact PERSIST-1 keeps: `coverage:<stream>:start|gap|resume` (never a deployer check's own key). */
const COVERAGE_FACT = /^coverage:.+:(start|gap|resume)$/;
/** `{ value, atMs }`: the live SOL/USD price in micro-dollars (risk needs one younger than maxQuoteAgeMs). */
export const SOL_PRICE_KEY = 'worker:sol-price';
/**
 * `{ creates, coverage, fill, rugs, asOf, history }`: SEED-1's seed of the deployer index (the saved state and the day
 * or RPC seed). It may arrive after live events: while a halt names `SEEDING`, released events wait for the index and
 * are observed after the seed, in release order, so the index is still seeded before it observes any live event.
 * `history` is the saved and seeded coverage, dated in the slot the worker reserved at reconcile (ahead of every live
 * event); coverage reads see it there.
 */
export const SEED_KEY = 'worker:seed';
/** The halt reason while the seed is pending: entries wait, exits and monitoring go on. */
export const SEEDING = 'deployer index seeding';

/** The latest regime evaluation as the app's status shows it: when, on or off, and each reason's code and input. */
export interface RegimeView {
  readonly atMs: number;
  readonly on: boolean;
  readonly reasons: readonly { readonly code: string; readonly input: string | null }[];
  /** Regime parts the S0 diagnostic set did not judge (WORKER-1e): an "on" with any of these is practice only. */
  readonly waived: readonly string[];
}
/**
 * The account-level entry stops as of `atMs`: the codes of every entry control core risk reports tripped with no trade
 * (evaluateExit's `tripped`: daily, weekly and kill-switch loss, the loss pauses, the policy session, open positions,
 * SOL price and balance), for the app's status. `codes` is null when the account cannot be read or judged: unknown.
 */
export interface RiskStopsView {
  readonly atMs: number;
  readonly codes: readonly string[] | null;
  /**
   * Today's loss as R7 reads it (core riskSnapshot `dayLoss`, micro-dollars) on the same input, costs and marks
   * included (APP-MONEY): the app's daily-loss meter. Null whenever `codes` is (the account cannot be judged).
   */
  readonly dayLoss: bigint | null;
}
/**
 * The rung a close would go at now, as `#sendExit` would send it (core `attemptRung`; EXIT review B1/N1): an exit owner in
 * flight with no signed attempt uses its own start rung (a blocked retry's is the last); a blocked position with no owner
 * yet retries at the last rung; otherwise the next rung up. Unknown (no saved plan, `lastRung` undefined): the last rung.
 */
export const closeRungOf = (i: { readonly last: number; readonly status: string; readonly lastRung: number | null | undefined; readonly used: number; readonly owner: { readonly startRung: number; readonly signed: number } | null }): number => {
  if (i.lastRung === undefined) return i.last;
  if (i.owner !== null) return attemptRung(i.lastRung, i.used, i.last, i.owner);
  if (i.status === 'exit_blocked') return i.last;
  return attemptRung(i.lastRung, i.used, i.last, null);
};
/** Account stops are read again on the account's own event, else at most once per this much event time. */
export const STOPS_EVERY_MS = 1000;
/** A reject's typed reasons ride in its last reason as `gate_reasons <json>`; the desk journals them as `gate_reasons`. */
export const GATE_REASONS_PREFIX = 'gate_reasons ';
/** The S0 diagnostic parts a decision relied on ride in a reason as `s0_diagnostic <part,part>`; the desk journals them as `s0_diagnostic`. */
export const S0_DIAGNOSTIC_PREFIX = 's0_diagnostic ';
/** EXIT-1's flow bucket. */
const FLOW_MINUTE_MS = 60_000;
/** How far back flow minutes are kept and saved (EXIT-KEEP B2): well past any negative-flow run the policy reads. */
const FLOW_KEEP_MS = 30 * FLOW_MINUTE_MS;

/**
 * The one-minute flow buckets finished by `nowMs`, oldest first. The still-open minute is left out here, and EXIT-1
 * leaves it out again (`negativeRun`): two guards, so neither refactor alone lets a minute count before it closes.
 */
export const closedFlow = (minutes: ReadonlyMap<number, bigint>, nowMs: number): FlowMinute[] =>
  [...minutes].filter(([s]) => s + FLOW_MINUTE_MS <= nowMs).sort((a, b) => a[0] - b[0]).map(([startMs, net]) => ({ startMs, net }));
export interface GateReasonLine {
  /** H1–H16, `regime`, a risk control (R1–R14), `stop`, or `worker` (an input the worker lacks). */
  readonly gate: string;
  readonly code: string;
  readonly detail: string;
}

/** A reason of a candidate's last evaluation with the fact it is about, if any (FACTS-1b reads what evidence reasons name). */
/** A candidate as the fact source sees it: its window, its last evaluation's reasons and the spend it sized. */
export interface CandidateView {
  readonly migratedAtMs: number;
  readonly lastEvalMs: number | null;
  readonly gates: readonly CandidateReason[] | null;
  readonly spend: bigint | null;
  /** The mint's creator once its create was seen (RUG-1c), else null. */
  readonly creator: string | null;
}

export interface CandidateReason {
  readonly gate: string;
  readonly code: string;
  readonly input?: string;
  /** The gate an evidence reason is needed by (H16 `neededBy`), and its detail: FACTS-1b and RUG-1c read them. */
  readonly neededBy?: string;
  readonly detail?: string;
}

/** `{ halted, reasons }`: entries stop while a critical feed is down or stale (§18); exits and monitoring go on. */
export const HALT_KEY = 'worker:halt';
export const feesKey = (mint: string): string => `worker:fees:${mint}`;
/**
 * `{ pool, slot, atMs, state, ctx }`: WATCH-1's coherent snapshot of a held position's pool (run/snapshot.ts), read by
 * a second path when the feed's pool state went stale. When newer than the pool fact, it is the whole market: its
 * reserves and its fee context together, never mixed with the feed's.
 */
export const SNAPSHOT_PREFIX = 'worker:snapshot:';
export const snapshotKey = (mint: string): string => `${SNAPSHOT_PREFIX}${mint}`;

export interface SnapshotFact {
  readonly pool: string;
  readonly slot: bigint;
  readonly atMs: number;
  readonly state: PoolState;
  readonly ctx: PoolFeeContext;
}

/**
 * Whether a snapshot is newer than the pool fact (null: none). By slot when both carry one (the chain's own order),
 * the receipt time only breaking a tie or standing in when the pool fact has no slot.
 */
export const snapshotWins = (snap: SnapshotFact, pool: { readonly slot: bigint | null; readonly receivedAt: number } | null): boolean => {
  if (pool === null) return true;
  if (pool.slot !== null && snap.slot !== pool.slot) return snap.slot > pool.slot;
  return snap.atMs > pool.receivedAt;
};

export const parseSnapshotFact = (v: unknown): SnapshotFact | null => {
  if (!isObj(v) || typeof v['pool'] !== 'string' || typeof v['slot'] !== 'bigint' || typeof v['atMs'] !== 'number' || !isObj(v['state']) || !isObj(v['ctx'])) return null;
  const st = v['state'];
  if (typeof st['baseReserve'] !== 'bigint' || typeof st['quoteVault'] !== 'bigint' || typeof st['virtualQuoteReserves'] !== 'bigint') return null;
  return v as unknown as SnapshotFact;
};
/** WATCH-1c: the producer's proof that a pool's chain state is unchanged through `slot` (core gates `carryKey`). */
export interface CarryFact {
  readonly pool: string;
  readonly slot: bigint;
  readonly state: PoolState;
  readonly obs: { readonly receivedAt: number };
}

export const parseCarryFact = (v: unknown): CarryFact | null => {
  if (!isObj(v) || typeof v['pool'] !== 'string' || typeof v['slot'] !== 'bigint' || !isObj(v['state']) || !isObj(v['obs']) || typeof v['obs']['receivedAt'] !== 'number') return null;
  const st = v['state'];
  if (typeof st['baseReserve'] !== 'bigint' || typeof st['quoteVault'] !== 'bigint' || typeof st['virtualQuoteReserves'] !== 'bigint') return null;
  return v as unknown as CarryFact;
};

const sameReserves = (a: PoolState, p: PoolFact): boolean =>
  a.baseReserve === p.baseVault && a.quoteVault === p.quoteVault && a.virtualQuoteReserves === (p.pool.virtualQuoteReserves ?? 0n);

const isFlagged = (p: PoolFact): boolean => p.obs.quality.some((q) => q !== 'backfilled' && q !== 'deduplicated');

/**
 * A mint's newest whole market, as the strategy and the worker both price it (merge rule M, WATCH-1c):
 * - the pool fact moves to its carry's moment when the carry proves the same reserves unchanged since (never for a
 *   flagged fact, and never past a newer snapshot that disagrees with it: the chain then missed something);
 * - WATCH-1's snapshot when newer than that;
 * - else the pool fact, unless POS-1 flagged it.
 */
export type MarketChoice =
  | { readonly kind: 'snapshot'; readonly snap: SnapshotFact }
  | { readonly kind: 'pool'; readonly pool: PoolFact; readonly atMs: number; readonly carried: boolean; readonly confirmedAtMs: number | null }
  | { readonly kind: 'flagged'; readonly pool: PoolFact }
  | { readonly kind: 'none' };

export const chooseMarket = (pool: PoolFact | null, snap: SnapshotFact | null, carry: CarryFact | null): MarketChoice => {
  const disagrees = pool !== null && snap !== null && snapshotWins(snap, pool.obs) && !sameReserves(snap.state, pool);
  const carried = pool !== null && carry !== null && !isFlagged(pool) && !disagrees && carry.pool === pool.address && sameReserves(carry.state, pool)
    && carry.obs.receivedAt > pool.obs.receivedAt && (pool.obs.slot === null || carry.slot >= pool.obs.slot);
  const at = pool === null ? null : carried ? { slot: carry!.slot, receivedAt: carry!.obs.receivedAt } : pool.obs;
  if (snap !== null && snapshotWins(snap, at)) {
    // A newer snapshot that reads the very reserves of an unflagged pool fact confirms it (WATCH-1d): the pool fact stays
    // the market, as fresh as that read. Otherwise a confirmed bank a slot ahead of the feed would take the market over
    // after every verify read, and the watch would chase it read after read.
    if (pool !== null && !isFlagged(pool) && sameReserves(snap.state, pool)) return { kind: 'pool', pool, atMs: Math.max(at!.receivedAt, snap.atMs), carried, confirmedAtMs: snap.atMs };
    return { kind: 'snapshot', snap };
  }
  if (pool === null) return { kind: 'none' };
  if (isFlagged(pool)) return { kind: 'flagged', pool };
  return { kind: 'pool', pool, atMs: at!.receivedAt, carried, confirmedAtMs: null };
};

/** Machine-read reason on `approve_risk`: the reservation request the worker sends to the ledger. */
export const RESERVE_PREFIX = 'reserve ';
// FACTS-1f's staged hard rejects live in core (one implementation with the backtest study, BT review of #41).
export { HARD_STAGE_GROUPS, hardAllowsEntry, NOT_EVALUATED, stagedHardRejects } from '../../../core/src/gates/index.ts';
/** REC-1: a rejected candidate's pool not watched past its window because `maxTails` were already watched. */
export const NO_TAIL = 'no tail';

/** Reason on a `shortlist` decision: the worker fetches the mint's confirmed create (live H9, H12–H14). */
export const SHORTLIST = 'shortlist';
export const TRIP_PREFIX = 'trip ';
/** Reason on an exit decision: the entry controls tripped right now (they never block an exit), by code. */
export const TRIPPED_PREFIX = 'risk tripped ';
/** Reason on an exit decision: the position's mark risk judged it with, micro-dollars, or `unknown`. */
export const MARK_PREFIX = 'risk mark ';
/** Reason on an exit decision: risk could not evaluate the account (RISK-FAULT), and why; the exit still goes. */
export const RISK_FAULT_PREFIX = 'risk fault ';

/** The ledger's account as the worker publishes it. Marks of open positions are filled in by the strategy. */
export interface AccountFact {
  readonly history: AccountHistory;
  readonly latches: Latches;
  readonly solBalance: Timed<Lamports> | null;
  /**
   * A paper wallet changes only by our own booked fills, which this snapshot already holds: its balance is current at
   * any later moment, so it is read as of the decision. A live wallet's balance keeps its read time.
   */
  readonly paper: boolean;
  /** Rent of the one-time accounts this wallet still lacks (0 once its setup made them): risk's `rent.oneTime`. */
  readonly oneTimeRent: bigint;
}

/** Exit state of one position, saved after every step so a restart resumes the same stop and trail. */
export interface SavedExit {
  readonly plan: EntryPlan;
  readonly tracker: ExitTracker;
  readonly bars: readonly PriceBar[];
  /** The position's pool and its last spot price (PRICE_SCALE): the exposure rebuild after a kill reads them. */
  readonly pool?: string | null;
  readonly spot?: { readonly price: bigint; readonly atMs: number } | null;
  /** Since when a due full exit has waited for its first fresh quote (EXIT-1c); null or absent when none waits. */
  readonly waitingSinceMs?: number | null;
  /**
   * Why the position is in sell-only recovery (EXIT-1g); null or absent when it holds its own plan. Kept until the
   * position closes: whenever it is open with no exit owner, the emergency full exit is armed again, so a recovery exit
   * that ends unfilled, before or after a restart, never leaves the position held under the fallback plan.
   */
  readonly recovery?: string | null;
  /**
   * The exit owners made as blocked-exit retries, by intent id (EXIT-KEEP N1). The tracker counts a retry when it is
   * decided, and the plans reach disk before the ledger books the step; a restart counts only the retries the ledger
   * booked, so a kill in between never loses one of the retries.
   */
  readonly retryIds?: readonly string[];
  /**
   * PERSIST-3: the position mint's deployer sales (EXIT-1's `deployer_sell`) and net flow minutes (`negative_flow`),
   * with the dedupe ids, as of the save. Absent or malformed at a restart: the position is flattened (sell-only).
   */
  readonly deployerSales?: { readonly ids: readonly string[]; readonly list: readonly { readonly atMs: number; readonly amount: bigint }[] };
  readonly flow?: { readonly minutes: readonly (readonly [number, bigint])[]; readonly ids: readonly (readonly [string, number])[] };
  /** PERSIST-3: the mint's deployer (creator and the create's signer) and total supply, from its create; null when never seen. */
  readonly deployer?: { readonly sellers: readonly string[]; readonly supply: bigint | null } | null;
  /**
   * PERSIST-3's flag for inputs a restart could not restore, read only from files written before EXIT-KEEP: such a
   * position goes into sell-only recovery (`recovery`), which is saved instead and keeps it there at every later restart.
   */
  readonly inputsLost?: true;
}

export interface RestoreFact {
  readonly exits: Readonly<Record<string, SavedExit>>;
  /** Each position's entry fill moment as the ledger booked it (its first `open` event), by position (EXIT-1f). */
  readonly openedAt?: Readonly<Record<string, number>>;
  /** Entry decisions' plan inputs by entry intent, saved before the intent was booked (EXIT-1h). */
  readonly seeds?: Readonly<Record<string, EntrySeed>>;
  /** Where each booking sits against the boots (`live`, `reconcile`, or `unplaced: why`), from the journal (EXIT-1f N2). */
  readonly bookedWhen?: Readonly<Record<string, string>>;
}

/** Strategy settings that are not owner limits. The trading rules stay provisional until BT-2 registers U2's. */
export interface StrategyConfig {
  readonly version: string;
  readonly universe: ExitUniverse;
  /** `random`: S0's entry moment, drawn per candidate from `entrySalt` and the mint (see `strategyConfig`). */
  readonly entryTiming: 'gates' | 'random';
  readonly entrySalt: string;
  /** S0's diagnostic set (core `S0DiagnosticPart`): S0 only; each part it relies on is named on the decision. */
  readonly s0Diagnostic?: boolean;
  readonly windowFromMs: number;
  readonly windowToMs: number;
  readonly entryMinOutBelowBps: number;
  /** Conservative gross edge (§5.2), ppm of notional. 0 until research proves one: risk then refuses every entry. */
  readonly edgePpm: bigint;
  readonly medianTargetBps: number;
  readonly takeProfitOn: 'wick' | 'close';
  readonly network: NetworkPolicy;
  readonly rent: RentInputs;
  readonly blockhashValidBlocks: bigint;
  /** A candidate is evaluated at most once per this many ms. */
  readonly evaluateEveryMs: number;
  /** Width of the price bars kept per mint (the policy's ATR bar). */
  /**
   * An upper bound on mainnet's mean slot time, used only to date a fill the strategy did not see (a restart whose saved
   * plan is missing or refused) from its slot: the larger the bound, the earlier the open time, so a restart can never
   * extend a time stop (EXIT-1f).
   */
  readonly maxSlotMs: number;
  readonly barMs: number;
  /** Bars kept per mint. */
  readonly keepBars: number;
  /** REC-1: rejected candidates' pools watched past their window at once; one more is logged `no tail` (`tail cap`). */
  readonly maxTails: number;
  /** OOM-MINT: how long a create's facts are kept while its coin has not migrated (`CREATE_KEEP_MS`). */
  readonly createKeepMs: number;
}

/**
 * OOM-MINT (supervisor rulings): a coin that migrates more than `CREATE_KEEP_MS` after its create is refused
 * `create-expired` from the facts (`createKeepVerdict`, as the backtest refuses it). A create whose coin has not
 * migrated `CREATE_KEEP_MS + CREATE_LATE_MS` after it is let go: its keys in the store, its producer track and its place
 * in the wallets' mint lists; kept for ever, they were unbounded (about 4.3 KB a create).
 */
export { CREATE_KEEP_MS } from '../../../core/src/gates/index.ts';

/**
 * OOM-MINT: how long a let-go create is remembered, so its coin's migration is refused `create-expired`: a week, as an
 * 8-byte tag (`HourTags`: about 6 MB at 75 creates a minute). After that its coin is treated as one whose create this
 * process never saw (the create lookup of CREATE-AFTER-RESTART).
 */
export const EXPIRED_CREATE_KEEP_MS = 7 * 24 * 3_600_000;

/** The saved state a seed names (WORKER-GROW): the file in the boot's recording, its sha256 over every byte, its format version. */
export interface SavedStateRef {
  readonly file: string;
  readonly sha256: string;
  readonly version: number;
}

export interface StrategyDeps {
  readonly session: PolicySession;
  readonly rugs: RugConfig;
  readonly config: StrategyConfig;
  /**
   * The saved index and labeller a seed names by `SavedStateRef` (WORKER-GROW): live, what the worker restored from the
   * recording's copy; in the parity replay, read from that copy and checked against the hash. Throws when it cannot give
   * exactly that state (the seed is then refused, as a fresh process).
   */
  readonly savedState?: (ref: SavedStateRef) => { readonly index: DeployerIndex; readonly labeller: RugLabeller };
  /** Replaces marks.ts `markedHistory` (tests inject a failure; production never sets it). */
  readonly markedHistory?: typeof markedHistory;
  /** Test seam: replaces the size `#riskSize` settled on (tests force the probe and risk to disagree); production never sets it. */
  readonly sizeProbe?: (sized: { readonly spend: Lamports; readonly notional: MicroUsd }) => { readonly spend: Lamports; readonly notional: MicroUsd };
}

const NORMAL = { mayhemMode: false, transferFee: false, transferHook: false } as const;
const BPS = BPS_DENOMINATOR;
const MIGRATION = 'CompletePumpAmmMigrationEvent';

/** A deterministic 64-byte paper signature: the attempt id hashed twice. Never a real transaction. */
const paperSignature = (id: string) =>
  signature(encodeBase58(new Uint8Array([...createHash('sha256').update(`sig1:${id}`).digest(), ...createHash('sha256').update(`sig2:${id}`).digest()])));
const paperBlockhash = (id: string) => blockhash(encodeBase58(createHash('sha256').update(`bh:${id}`).digest()));

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** FEED-1 wraps off-chain values as `{ value, source, ... }`; worker facts arrive unwrapped. */
export const unwrap = (v: unknown): unknown => (isObj(v) && 'value' in v && 'source' in v ? v['value'] : v);

interface Market {
  readonly pool: PoolState;
  readonly ctx: PoolFeeContext;
  readonly atMs: number;
  readonly address: string;
}

interface Candidate {
  readonly mint: string;
  readonly migratedAtMs: number;
  lastEvalMs: number | null;
  lastReason: string | null;
  tries: number;
  /** The reasons of the last evaluation (null before the first, empty after a pass). */
  gates: readonly CandidateReason[] | null;
  /** The entry spend the last evaluation sized (lamports): what H15's simulation must be run at. */
  spend: bigint | null;
  /** The S0 diagnostic parts the last reject relied on (part of the reject line's dedupe key). */
  lastWaived: string;
  /** The mint's creator, from its released create (null until it is seen): RUG-1c checks this deployer. */
  creator?: string | null;
  /** ENTRY-MEMO: S0's drawn entry moment, drawn once (its window is fixed: the migration time and the config). */
  entryAt?: number;
}

/**
 * RESTART-KEEP: a candidate as saved with the state (public chain data and the strategy's own evaluation state), so a
 * restart inside its 60–240 min window keeps it. Gates and spend are judged again; the creator comes back with its create.
 */
export interface SavedCandidate {
  readonly mint: string;
  readonly pool: string | null;
  readonly migratedAtMs: number;
  readonly migrationSlot: bigint | null;
  readonly tries: number;
  readonly lastEvalMs: number | null;
  readonly lastReason: string | null;
  /** Its price bars (the entry's ATR stop needs a contiguous run of them), none started after the save. */
  readonly bars: readonly PriceBar[];
  /**
   * FEES-KEEP: the fee terms of the latest swap seen on its pool, as that swap reported them, with its receipt time; null
   * (or absent, in a save from before FEES-KEEP) when none was seen. A malformed one restores as none.
   */
  readonly fees?: SavedFees | null;
}

/** FEES-KEEP: a swap's own fee terms (public chain data), from which `observedFeeContext` builds the fee context again. */
export interface SavedFees {
  readonly atMs: number;
  readonly lp: number;
  readonly protocol: number;
  readonly creator: number;
  readonly buyback: number;
  readonly instruction: 'v1' | 'v2';
  readonly baseSupply: bigint;
  /**
   * The pool the reporting swap left (its base reserve and effective quote, vault + virtual), replayed from the event. A
   * restored term prices only that same pool: its rates are the tier of that market cap, and a swap not seen since (the
   * downtime) may have moved the pool across a tier.
   */
  readonly after: { readonly base: bigint; readonly quote: bigint };
}

/** The pool is exactly the one the terms' swap left (FEES-KEEP: restored terms price nothing else). */
const leftBy = (f: SavedFees, pool: PoolState): boolean => pool.baseReserve === f.after.base && effectiveQuoteReserve(pool) === f.after.quote;

const feeContextOf = (f: SavedFees): PoolFeeContext => observedFeeContext(
  { split: { lp: bps(f.lp), protocol: bps(f.protocol), creator: bps(f.creator) }, buybackFeeBps: bps(f.buyback), instruction: f.instruction },
  f.baseSupply, { mayhemMode: false, transferFee: false, transferHook: false },
);

/** Saved fee terms as the strategy can take them; null when absent or malformed (fail closed: no fee terms). */
const savedFees = (x: unknown): SavedFees | null => {
  if (!isObj(x)) return null;
  const rate = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 10_000;
  const ok = typeof x['atMs'] === 'number' && Number.isSafeInteger(x['atMs']) && rate(x['lp']) && rate(x['protocol']) && rate(x['creator']) && rate(x['buyback'])
    && (x['instruction'] === 'v1' || x['instruction'] === 'v2') && typeof x['baseSupply'] === 'bigint' && x['baseSupply'] > 0n
    && isObj(x['after']) && typeof x['after']['base'] === 'bigint' && x['after']['base'] > 0n && typeof x['after']['quote'] === 'bigint' && x['after']['quote'] > 0n;
  if (!ok) return null;
  const after = x['after'] as { base: bigint; quote: bigint };
  return { atMs: x['atMs'] as number, lp: x['lp'] as number, protocol: x['protocol'] as number, creator: x['creator'] as number, buyback: x['buyback'] as number, instruction: x['instruction'] as 'v1' | 'v2', baseSupply: x['baseSupply'] as bigint, after: { base: after.base, quote: after.quote } };
};

/** RESTART-KEEP: one filled swap of a restored candidate's downtime: its block time, reserves before and after, and the spot after. */
interface GapTrade {
  readonly atMs: number;
  readonly pre: string;
  readonly post: string;
  readonly price: bigint;
}

/**
 * The trades in chain order: each one's reserves before it are the previous one's after it. Null unless that orders
 * every trade into one run with block times that never go back (a trade missing, a duplicate state or a clock stepping
 * back cannot be proven).
 */
const chainOrder = (trades: readonly GapTrade[]): GapTrade[] | null => {
  if (trades.length === 0) return [];
  const byPre = new Map<string, GapTrade>();
  for (const t of trades) {
    if (byPre.has(t.pre)) return null;
    byPre.set(t.pre, t);
  }
  const posts = new Set(trades.map((t) => t.post));
  const firsts = trades.filter((t) => !posts.has(t.pre));
  if (firsts.length !== 1) return null;
  const out: GapTrade[] = [];
  for (let t: GapTrade | undefined = firsts[0]; t !== undefined; t = byPre.get(t.post)) {
    if (out.length > 0 && t.atMs < out.at(-1)!.atMs) return null;
    out.push(t);
    if (out.length > trades.length) return null;
  }
  return out.length === trades.length ? out : null;
};

/** RESTART-KEEP: a rejected candidate's pool watched after its window (REC-1), as saved. */
export interface SavedTail {
  readonly mint: string;
  readonly pool: string;
  readonly untilMs: number;
}

/** Decision naming a candidate restored from the saved state: the worker reads its migration and create again. */
export const CANDIDATE_RESTORED = 'candidate restored';

/** Why #market has no market for a mint, in words (the reject reason). */
const NO_POOL_STATE = 'pool state unknown';
const POOL_MALFORMED = 'pool state malformed';
const POOL_FLAGGED = 'pool state flagged';
const NO_FEE_CONTEXT = 'fee context unknown';

/**
 * POOL-DATA: the worker's typed code for each case #market has no market (once one `no-market`), so the journal's gate
 * reasons and the app's summary tell a pool never read, a flagged swap stream and unknown fee terms apart.
 */
export const MARKET_MISS_CODES = ['no-pool-state', 'pool-malformed', 'pool-flagged', 'no-fee-context'] as const;
export type MarketMissCode = (typeof MARKET_MISS_CODES)[number];
export const marketMissCode = (why: string): MarketMissCode =>
  why === NO_POOL_STATE ? 'no-pool-state' : why === NO_FEE_CONTEXT ? 'no-fee-context' : why.startsWith(POOL_FLAGGED) ? 'pool-flagged' : 'pool-malformed';

/** A saved candidate as the strategy can take it; null when malformed. */
const savedCandidate = (x: unknown): SavedCandidate | null => {
  if (!isObj(x)) return null;
  const ms = (v: unknown, nul: boolean): boolean => (nul && v === null) || (typeof v === 'number' && Number.isSafeInteger(v));
  const ok = typeof x['mint'] === 'string' && x['mint'] !== '' && (x['pool'] === null || typeof x['pool'] === 'string') && ms(x['migratedAtMs'], false)
    && (x['migrationSlot'] === null || (typeof x['migrationSlot'] === 'bigint' && x['migrationSlot'] >= 0n))
    && typeof x['tries'] === 'number' && Number.isSafeInteger(x['tries']) && x['tries'] >= 0 && ms(x['lastEvalMs'], true) && (x['lastReason'] === null || typeof x['lastReason'] === 'string')
    && Array.isArray(x['bars']) && x['bars'].every((b) => isObj(b) && ms(b['startMs'], false) && ['high', 'low', 'close'].every((k) => typeof b[k] === 'bigint' && (b[k] as bigint) > 0n));
  return ok ? { mint: x['mint'] as string, pool: x['pool'] as string | null, migratedAtMs: x['migratedAtMs'] as number, migrationSlot: x['migrationSlot'] as bigint | null, tries: x['tries'] as number, lastEvalMs: x['lastEvalMs'] as number | null, lastReason: x['lastReason'] as string | null, bars: x['bars'] as PriceBar[], fees: savedFees(x['fees']) } : null;
};

/** What an entry needs once it fills: fixed at the decision, completed with the fill. */
/** An entry decision's own plan inputs, saved before its intent is booked (EXIT-1h) so a restart rebuilds its plan. */
export interface EntrySeed {
  readonly mint: string;
  readonly universe: ExitUniverse;
  readonly notional: MicroUsd;
  readonly stopPrice: bigint;
  readonly entryReserve: bigint;
}

/** ENTRY-MEMO: how many entry moments were drawn (a hash each), for the test that each candidate draws once. */
export const S0_DRAWS = { count: 0 };

/**
 * S0's entry moment for a candidate: uniform in [from, to), from the first 48 bits of sha256(salt, mint). Independent
 * of arrival order, so a replay draws the same moments.
 */
export const s0EntryAt = (salt: string, mint: string, from: number, to: number): number => {
  S0_DRAWS.count++;
  const u = Number.parseInt(createHash('sha256').update(`s0|${salt}|${mint}`).digest('hex').slice(0, 12), 16) / 2 ** 48;
  return from + Math.floor(u * (to - from));
};

/** The universe in an entry intent key's decision id (`entry:<mint>:<universe>.<rest>`), or null for an older key. */
/** The plan universe of a position with none on record (no saved plan universe, no universe in its entry key). */
export const NO_UNIVERSE = 'none on record' as ExitUniverse;

export const universeOfKey = (key: string): ExitUniverse | null => {
  const local = key.split(':')[2] ?? '';
  const u = local.split('.')[0] ?? '';
  return (EXIT_UNIVERSES as readonly string[]).includes(u) ? (u as ExitUniverse) : null;
};

/** A position's universe: its saved plan's, else its entry key's; null when neither has one. */
export const resolveUniverse = (saved: string | undefined, entryKey: string | undefined): string | null =>
  saved ?? (entryKey === undefined ? null : universeOfKey(entryKey));

/**
 * Why a restored position puts the process in sell-only (no new entries; it is flattened through the global exit
 * ladder): its universe is not in the loaded policy, or none is on record (unknown means no entry). Null: neither.
 */
export const sellOnlyReason = (pid: string, universe: string | null, universes: Readonly<Record<string, unknown>>, policyVersion: string): string | null =>
  universe === null ? `sell-only: no universe on record for ${pid}`
    : Object.hasOwn(universes, universe) ? null
      : `sell-only: policy ${policyVersion} lacks universe ${universe} of ${pid}`;

/** A sell quote the pool refused: the one #sellQuote failure that is a real refusal, not missing market data. */
const NO_QUOTE = 'no quote: ';

/** A saved entry plan the exit rules can run on: every amount a bigint, the open time a number (EXIT-1e). */
/** A saved exit tracker the exit rules can run on: every field of its type (EXIT-1f). */
const runnableTracker = (t: Record<string, unknown>): boolean => {
  const big = (k: string, nullable: boolean) => typeof t[k] === 'bigint' || (nullable && t[k] === null);
  const num = (k: string, nullable: boolean) => (typeof t[k] === 'number' && Number.isFinite(t[k])) || (nullable && t[k] === null);
  const pending = t['pendingFull'];
  return big('peak', true) && big('trail', true) && big('lastSold', false)
    && num('partials', false) && num('partialSeq', true) && num('lastRung', true) && num('quoteFailures', false) && num('lastQuoteAtMs', true)
    && num('blockedAtMs', true) && num('blockedRetries', false) && typeof t['flatMet'] === 'boolean'
    && (pending === null || (Array.isArray(pending) && pending.every((r) => typeof r === 'string')));
};

const runnablePlan = (p: Record<string, unknown>): boolean =>
  typeof p['openedAtMs'] === 'number' && Number.isFinite(p['openedAtMs'])
  && ['notional', 'riskUnit', 'stopPrice', 'entryReserve'].every((k) => typeof p[k] === 'bigint')
  && (p['universe'] === undefined || typeof p['universe'] === 'string');

/** A saved recovery reason the worker can act on: absent, null or a reason (EXIT-1g review B1). */
const runnableRecovery = (r: unknown): boolean => r === undefined || r === null || typeof r === 'string';

/** Saved blocked-retry ids the worker can act on: absent, or a list of ids (EXIT-KEEP N1). */
const runnableRetryIds = (r: unknown): boolean => r === undefined || (Array.isArray(r) && r.every((x) => typeof x === 'string'));

export class LiveStrategy implements Strategy {
  readonly #d: StrategyDeps;
  readonly #settings: ExitSettings;
  #deployers = new DeployerIndex();
  #labeller: RugLabeller;
  /** Every released `coverage:<stream>:start|gap|resume` fact, the seed's coverage history included (PERSIST-1 saves them). */
  readonly #coverageFacts: MarketEvent[] = [];
  /** The latest moment released to the strategy: a save's as-of point (nothing the index has seen is after it). */
  #lastMoment: Moment | null = null;
  readonly #cands = new Map<string, Candidate>();
  readonly #seeds = new Map<string, EntrySeed>();
  /** Seeds that came from the restore, not from a decision in this process: their fill's moment is not this process's. */
  readonly #restoredSeeds = new Set<string>();
  /** Positions whose saved exit came from the restore, until the first step checks them against the rebuilt book. */
  readonly #restoredExits = new Set<string>();
  /** Entry intents whose saved seed the restore refused: their positions go into sell-only recovery, saying so. */
  readonly #refusedSeeds = new Set<string>();

  /** Entry decisions' plan inputs not yet made into a plan, by entry intent: saved before the intent is booked (EXIT-1h). */
  seeds(): Record<string, EntrySeed> {
    return Object.fromEntries(this.#seeds);
  }
  readonly #exits = new Map<string, SavedExit>();
  readonly #bars = new Map<string, PriceBar[]>();
  /** Per exit owner: the rung its first attempt uses and how many attempts it may sign (EXIT-1's decision). */
  readonly #owners = new Map<string, { readonly startRung: number; readonly maxAttempts: number }>();
  #height: bigint | null = null;

  constructor(deps: StrategyDeps) {
    this.#d = deps;
    this.#labeller = new RugLabeller(deps.rugs);
    const n = deps.config.network;
    this.#settings = exitSettings(deps.session.policy, deps.config.takeProfitOn, { signaturesPerTx: n.signaturesPerTx, baseFeePerSignature: n.baseFeePerSignature, tip: n.tip });
    // The kept flow window must hold a whole negative run and the minute before it, or a run could be cut off.
    if ((deps.session.policy.exits.negativeFlowMinutes + 1) * FLOW_MINUTE_MS > FLOW_KEEP_MS) throw new RangeError('negativeFlowMinutes is longer than the kept flow window');
  }

  /**
   * MEM-PROBE: counts only: every map and list this strategy keeps, entries inside the per-mint ones summed, and the
   * deployer index's counts.
   */
  sizes(): Record<string, number> {
    const sum = <V>(m: ReadonlyMap<string, V>, n: (v: V) => number): number => {
      let t = 0;
      for (const v of m.values()) t += n(v);
      return t;
    };
    const d = this.#deployers.sizes();
    return {
      cands: this.#cands.size, seeds: this.#seeds.size, exits: this.#exits.size, bars: sum(this.#bars, (b) => b.length),
      seed_history: sum(this.#seedHistory, (l) => l.length), coverage_facts: this.#coverageFacts.length,
      pool_of_mint: this.#poolOfMint.size, mint_of_pool: this.#mintOfPool.size, migration_slot: this.#migrationSlot.size,
      observed_fees: this.#observedFees.size, trade_at: this.#tradeAt.size, swap_at: this.#swapAt.size,
      deployer_sales: sum(this.#deployerSales, (s) => s.ids.size), flow_ids: sum(this.#flow, (f) => f.ids.size), deployer_memo: this.#deployerMemo.size,
      tail: this.#tail.size, owners: this.#owners.size,
      deployer_creators: d.creators, deployer_mints: d.mints, deployer_mint_bytes: d.mint_bytes, deployer_rugs: d.rugs, deployer_unjudged: d.unjudged, deployer_vias: d.vias, deployer_lost: d.lost,
    };
  }

  /** Exit state to save after each step (the worker writes it before the next event). */
  saved(): Record<string, SavedExit> {
    const out: Record<string, SavedExit> = {};
    for (const [pid, s] of this.#exits) {
      const mint = this.#mintOf(pid);
      out[pid] = { ...s, bars: this.#bars.get(pid) ?? s.bars, pool: this.#poolOfMint.get(mint) ?? s.pool ?? null, spot: this.#spot.get(pid) ?? s.spot ?? null, ...this.#exitInputs(mint) };
    }
    return out;
  }

  /** PERSIST-3: a mint's deployer sales and flow as saved, nothing after the latest released moment. */
  #exitInputs(mint: string): Pick<SavedExit, 'deployerSales' | 'flow' | 'deployer'> {
    const until = this.#lastMoment?.receivedAt ?? Number.NEGATIVE_INFINITY;
    const sales = this.#deployerSales.get(mint);
    const f = this.#flow.get(mint);
    const minutes = [...(f?.minutes ?? [])].filter(([start]) => start <= until).sort((a, b) => a[0] - b[0]);
    return {
      deployer: this.#deployerMemo.get(mint) ?? null,
      deployerSales: { ids: [...(sales?.ids ?? [])].sort(), list: (sales?.list ?? []).filter((x) => x.atMs <= until) },
      flow: { minutes, ids: [...(f?.ids ?? [])].filter(([, start]) => start <= until).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) },
    };
  }

  /** Each candidate's migration time and the typed reasons of its last evaluation (FACTS-1b stages its reads on them). */
  candidates(): ReadonlyMap<string, CandidateView> {
    return new Map([...this.#cands].map(([m, c]) => [m, { migratedAtMs: c.migratedAtMs, lastEvalMs: c.lastEvalMs, gates: c.gates, spend: c.spend, creator: c.creator ?? null }]));
  }

  /** Mints that need live facts: candidates in their window and every position not closed. */
  watched(): Set<string> {
    const out = new Set(this.#cands.keys());
    for (const pid of this.#exits.keys()) out.add(this.#mintOf(pid));
    return out;
  }

  #coverage: Coverage | null = null;
  /** SEED-1's coverage history by key, dated in the reserved slot; merged into every history read. */
  readonly #seedHistory = new Map<string, AsOfEntry[]>();
  /** Events released while the seed is pending, observed after it; null when not waiting. */
  #waiting: MarketEvent[] | null = null;
  #seedApplied = false;
  /** Each watched mint's PumpSwap pool, from its migration or its pool fact, and back. */
  readonly #poolOfMint = new Map<string, string>();
  /** S0-ZERO: each candidate's migration slot, where its pool's trade coverage must start (the oldest seen). */
  readonly #migrationSlot = new Map<string, bigint>();
  readonly #mintOfPool = new Map<string, string>();
  /** The fee terms of the latest released swap on each mint's pool (rates are per trade on chain). */
  /**
   * FEES-KEEP: with the terms the context was built from, as a save keeps them (null when the swap did not replay, so
   * nothing says which pool it left: not saved), and whether they came back from a save (`restored`: they then price only
   * the pool their swap left, until a swap seen in this run replaces them).
   */
  readonly #observedFees = new Map<string, { readonly ctx: PoolFeeContext; readonly terms: SavedFees | null; readonly restored: boolean }>();
  /** Receipt time of the latest released swap on each mint's pool: how current the sales below are. */
  readonly #tradeAt = new Map<string, number>();
  /** Sales by each mint's deployer (its creator and the create's signer), deduplicated by event id. */
  readonly #deployerSales = new Map<string, { readonly ids: Set<string>; readonly list: { readonly atMs: number; readonly amount: bigint }[] }>();
  /**
   * WORKER-1e: one-minute net SOL flow (pool side: buys' quoteAmountIn − sells' quoteAmountOut) on each held mint's
   * pool, from released swaps, deduplicated like the deployer's sales (each id with its minute); EXIT-1's negative-flow trigger reads
   * it. Saved with each held position's exit (PERSIST-3), every id included, so a restart continues the run of minutes.
   */
  readonly #flow = new Map<string, { readonly ids: Map<string, number>; readonly minutes: Map<number, bigint> }>();
  /** PERSIST-3: each held mint's deployer as last read from its create (a restart does not see the create again). */
  readonly #deployerMemo = new Map<string, { readonly sellers: readonly string[]; readonly supply: bigint | null }>();
  /** Positions whose deployer-sell trigger could not be judged, reported once each. */
  readonly #unjudgedDeployer = new Set<string>();
  /** Each held position's last spot price, for the saved plan (the exposure rebuild's reference). */
  readonly #spot = new Map<string, { readonly price: bigint; readonly atMs: number }>();

  /** Each held position's latest display quote (sale price per token, PRICE_SCALE) with when it was read; never risk's mark. */
  readonly #displayQuotes = new Map<string, { readonly price: bigint; readonly atMs: number; readonly slot: bigint }>();

  /**
   * Exit owners said to be waiting for a fresh market in this process (EXIT-1d), by intent, with their position. The wait
   * start itself is the position's saved `waitingSinceMs`, so a restart keeps it.
   */
  readonly #waitingMarket = new Map<string, string>();

  /**
   * Positions whose exit waits for a fresh quote, with the moment it started waiting (saved with the plan, so a restart
   * keeps it): a due full exit not yet owned (EXIT-1c) or an exit owner's next attempt (EXIT-1d).
   */
  waitingExits(): ReadonlyMap<string, number> {
    return new Map([...this.#exits].flatMap(([pid, s]) => (s.waitingSinceMs == null ? [] : [[pid, s.waitingSinceMs] as const])));
  }

  /** Starts (keeping an earlier start) or ends a position's wait for a fresh quote. */
  #setWaiting(pid: string, nowMs: number | null): void {
    const saved = this.#exits.get(pid);
    if (saved === undefined) return;
    const since = nowMs === null ? null : (saved.waitingSinceMs ?? nowMs);
    if (since !== (saved.waitingSinceMs ?? null)) this.#exits.set(pid, { ...saved, waitingSinceMs: since });
  }

  /**
   * A held position's display quote per token (PRICE_SCALE) and when it was read: the whole holding sold into the pool
   * at its last read, venue fees and price impact included, network fees, slippage allowance and landing not. Display
   * only (/health and the heartbeat): risk's mark is marks.ts's executable mark, never this (review N3).
   */
  displayQuoteOf(pid: string): { readonly price: bigint; readonly atMs: number; readonly slot: bigint } | null {
    return this.#displayQuotes.get(pid) ?? null;
  }

  /** The latest regime evaluation (every candidate's first check), for the app's status; null before the first. */
  #regime: RegimeView | null = null;

  regime(): RegimeView | null {
    return this.#regime;
  }

  /** The latest account stops (RiskStopsView); null before the first event. */
  #stops: RiskStopsView | null = null;

  /** The rung a close of position `pid` would go at now (`closeRungOf`, from this strategy's plan, owners and the book). */
  closeRung(pid: string, status: string, book: Book): number {
    const saved = this.#exits.get(pid);
    const live = Object.values(book.intents).filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === pid && !isTerminal(i)).at(-1);
    const owner = live === undefined ? undefined : this.#owners.get(live.intent.id);
    return closeRungOf({
      last: this.#d.session.policy.exits.ladder.steps.length - 1, status, lastRung: saved === undefined ? undefined : saved.tracker.lastRung,
      used: exitAttemptsOf(book.intents, pid as PositionId), owner: live !== undefined && owner !== undefined ? { startRung: owner.startRung, signed: live.attempts.length } : null,
    });
  }

  /** The rung already signed, recorded by #sendExit before its synchronous broadcast effect. */
  signedRung(pid: string, book: Book): number {
    const last = this.#d.session.policy.exits.ladder.steps.length - 1;
    const remembered = this.#exits.get(pid)?.tracker.lastRung;
    // The book includes this signature already; without a remembered rung, its global count starts at rung zero.
    return Math.min(remembered ?? Math.max(0, exitAttemptsOf(book.intents, pid as PositionId) - 1), last);
  }

  riskStops(): RiskStopsView | null {
    return this.#stops;
  }

  /** Reads the account stops for status. Read-only: a trip found here is not latched (entries and exits latch theirs). */
  #readStops(e: MarketEvent, ctx: StrategyContext): void {
    const now = ctx.now.receivedAt;
    if (this.#stops !== null && e.key !== ACCOUNT_KEY && now - this.#stops.atMs < STOPS_EVERY_MS) return;
    const risk = this.#account(ctx);
    if (risk === null) return void (this.#stops = { atMs: now, codes: null, dayLoss: null });
    try {
      // Judged as the entry path judges it: marked with no fallback (a mark that fails refuses the entry there), and
      // unknown when core cannot evaluate the account (riskSnapshot is null exactly when its account check throws,
      // where evaluateExit would report nothing tripped).
      const sol = this.#spotSol(ctx);
      const account = this.#marked(risk.history, ctx, sol, { fallback: false });
      const input = { session: this.#d.session, mode: 'paper' as const, clock: { now: () => ctx.now }, account, latches: risk.latches, market: { solPrice: sol, solBalance: this.#balance(risk, ctx), regime: 'unknown' as const } };
      const snap = riskSnapshot(input);
      if (snap === null) return void (this.#stops = { atMs: now, codes: null, dayLoss: null });
      const r = evaluateExit(input);
      const codes = new Set<string>(r.tripped.map((x) => x.code));
      // R7 per entry, as evaluateEntry judges it (API-1 N2a): when today's loss plus one trade's worst-case costs reaches
      // the daily limit, no entry can pass, so the status serves the daily-loss stop instead of "Entries: On".
      if (sol !== null) {
        const policy = this.#d.session.policy;
        const limit = mulDiv(policy.capital.bankroll, BigInt(policy.loss.dailyBps), BPS, 'floor');
        const costs = maxTradeCosts(policy, { network: this.#d.config.network, rent: { ...this.#d.config.rent, oneTime: risk.oneTimeRent } }).total;
        if (snap.dayLoss + lamportsToMicroUsd(costs, sol.value, 'ceil') >= limit) codes.add('daily_loss');
      }
      this.#stops = { atMs: now, codes: [...codes].sort(), dayLoss: snap.dayLoss };
    } catch {
      this.#stops = { atMs: now, codes: null, dayLoss: null };
    }
  }

  /** Positions whose universe the policy lacks, being flattened (said once each). */
  readonly #flattening = new Set<string>();

  /** Positions whose partials were checked against the book in this process. */
  readonly #fromBook = new Set<string>();
  /**
   * Whether this boot's restore fact (saved plans and trackers) has been applied, refused or not. Until then no position
   * is managed: the stored book comes back first, and the boot's other start facts (or a market event dated before the
   * restore) must never plan a restored position from its fill under the policy-maximum stop, even for one step (EXIT-1e).
   */
  #restoreSeen = false;
  /** Entry fill moments the ledger booked, from the restore fact: a fallback plan's exact open time (EXIT-1f). */
  readonly #bookedOpenAt = new Map<string, number>();
  /** Where each booking sits against the boots (restore fact): only a reconcile-time booking may be late (EXIT-1f N2). */
  readonly #bookedWhen = new Map<string, string>();
  /** Why a position has no usable saved plan, from the restore (EXIT-1g): it goes into sell-only recovery. */
  readonly #recoveryWhy = new Map<string, string>();
  /** Positions whose fallback plan waits for the first slot to date their fill (said once each). */
  readonly #planWaitsForSlot = new Set<string>();
  /** Said once per boot when positions wait for the restore. */
  #saidRestoreWait = false;

  /** The fee terms of the latest swap seen on a mint's pool (for the paper fill when no fee-context fact exists). */
  observedFees(mint: string, pool: PoolState | null = null): PoolFeeContext | undefined {
    return this.#feesFor(mint, pool);
  }

  /** The observed fee context for pricing `pool`: a restored one only for the pool its swap left (FEES-KEEP). */
  #feesFor(mint: string, pool: PoolState | null): PoolFeeContext | undefined {
    const o = this.#observedFees.get(mint);
    if (o === undefined) return undefined;
    if (!o.restored) return o.ctx;
    return pool !== null && o.terms !== null && leftBy(o.terms, pool) ? o.ctx : undefined;
  }

  /**
   * The pools to watch for swaps (WORKER-1 subscribes `trades:<pool>`): every candidate in its window and every open
   * position, with whether a position holds it (exit traffic).
   */
  watchedPools(): Map<string, { readonly mint: string; readonly held: boolean; readonly fromSlot?: bigint }> {
    const held = new Set([...this.#exits.keys()].map((pid) => this.#mintOf(pid)));
    const out = new Map<string, { mint: string; held: boolean; fromSlot?: bigint }>();
    for (const mint of this.watched()) {
      const pool = this.#poolOfMint.get(mint);
      // A candidate's pool is watched from its migration (S0-ZERO): its candles are observed from the pool's creation.
      // A held pool is already watched (an exit never waits on a catch-up).
      const from = this.#cands.has(mint) && !held.has(mint) ? this.#migrationSlot.get(mint) : undefined;
      if (pool !== undefined) out.set(pool, { mint, held: held.has(mint), ...(from === undefined ? {} : { fromSlot: from }) });
    }
    for (const [mint, t] of this.#tail) if (!out.has(t.pool)) out.set(t.pool, { mint, held: false });
    return out;
  }

  /**
   * REC-1 (supervisor ruling): the pool of a candidate that was evaluated and rejected stays watched after its window,
   * until the window end plus its universe's maximum hold, so the recording holds every swap a counterfactual entry at
   * any moment of the window would need (G3's scorer). At P3 like any candidate (held: false): the budget halt sheds it
   * first and the stream records the gap. Kept through `untilMs`, pruned at the first event after it.
   */
  readonly #tail = new Map<string, { readonly pool: string; readonly untilMs: number }>();

  /** The rejected candidates' pools still watched past their window, by mint (REC-1). */
  get tail(): ReadonlyMap<string, { readonly pool: string; readonly untilMs: number }> {
    return this.#tail;
  }

  /** H14's creates coverage as of the last slot, coverage fact or seed released; null before any. */
  get coverage(): Coverage | null {
    return this.#coverage;
  }

  /** True once the seed (or the restore) was applied: before it the index's state is not the process's to save. */
  get seedApplied(): boolean {
    return this.#seedApplied;
  }

  /**
   * PERSIST-1: what a save holds, as of the latest released moment: the index (entries older than `retainFromMs`
   * left out), the labeller's tables and the coverage facts that still matter from `retainFromMs` on (WORKER-1d,
   * `pruneCoverage`). Null before anything was released or the seed applied.
   */
  persistable(retainFromMs: number): { readonly state: { readonly asOf: Moment; readonly index: DeployerIndexState; readonly labeller: RugLabellerState; readonly coverage: readonly MarketEvent[]; readonly graduates: SavedGraduates; readonly candidates: readonly SavedCandidate[]; readonly tails: readonly SavedTail[] }; readonly mintRows: Iterable<readonly [string, readonly (readonly [string, number])[]]>; readonly clamp: AsOfClamp } | null {
    const asOf = this.#lastMoment;
    if (asOf === null || !this.#seedApplied || this.#waiting !== null) return null;
    // PERSIST-2: the newest graduates fact released so far, with only the entries whose survival mark was reached by
    // the save moment (the fact itself is never newer than the last released event).
    const items = (this.#graduatesFact?.items ?? []).filter((g) => g.migratedAtMs + this.#d.session.policy.regime.survivalAfterMs <= asOf.receivedAt);
    // RESTART-KEEP: every candidate in its window. SAVE-ASOF: every saved time as at the moment, never after
    // (`AsOfClamp`): moments order by slot first and receipt times need not follow, so an evaluation can carry a time
    // after the moment (an event of an earlier slot received later), and a migration's time is its chain block time,
    // routinely seconds off local receipt. Each candidate came from a released event, so none is left out for it.
    const clamp = new AsOfClamp(asOf.receivedAt);
    const candidates = [...this.#cands.values()].sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0))
      .map((c): SavedCandidate => ({ mint: c.mint, pool: this.#poolOfMint.get(c.mint) ?? null, migratedAtMs: clamp.ms(c.migratedAtMs), migrationSlot: this.#migrationSlot.get(c.mint) ?? null, tries: c.tries, lastEvalMs: c.lastEvalMs === null ? null : clamp.ms(c.lastEvalMs), lastReason: c.lastReason, bars: (this.#bars.get(c.mint) ?? []).filter((b) => b.startMs <= asOf.receivedAt), fees: this.#feeTermsAsOf(c.mint, asOf.receivedAt) }));
    // WORKER-GROW: the index's mint rows are streamed into the file by the save, never built whole; the graduates ride
    // in the payload line.
    return {
      state: { asOf, index: this.#deployers.snapshot(asOf, retainFromMs, { mints: false, clamp }), labeller: this.#labeller.snapshot(clamp), coverage: pruneCoverage(this.#coverageFacts, retainFromMs).map((e) => (e.moment.receivedAt <= asOf.receivedAt ? e : { ...e, moment: clamp.moment(e.moment) })), graduates: { asOfMs: asOf.receivedAt, items }, candidates, tails: [...this.#tail].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([mint, t]) => ({ mint, pool: t.pool, untilMs: t.untilMs })) },
      mintRows: this.#deployers.mintRows(retainFromMs, clamp),
      clamp,
    };
  }

  /** PERSIST-2: the newest graduates fact released (the regime's survival series), for the saved state. */
  #graduatesFact: GraduatesFact | null = null;

  get deployers(): DeployerIndex {
    return this.#deployers;
  }

  onMarket(e: MarketEvent, ctx: StrategyContext): readonly Decision[] {
    this.#book = ctx.book;
    const out: Decision[] = [];
    // FACTS-1b: reads that landed on earlier events are judged now, after the facts their own release made (FactFeed
    // releases a read's facts right after it, at its moment). A mark set below applies from the next event on.
    const due = this.#due;
    this.#due = new Map();
    if (e.key === HALT_KEY) this.#seedWait(unwrap(e.value));
    // The latest released moment: events come in order (the engine refuses a late one before the strategy sees it), and
    // the guard keeps a save's as-of point from ever moving back if that changed (the index snapshot refuses it too).
    if (this.#lastMoment === null || compareMoments(e.moment, this.#lastMoment) > 0) this.#lastMoment = e.moment;
    if (COVERAGE_FACT.test(e.key)) this.#coverageFacts.push(e);
    this.#gapBarsMerge(e.moment);
    this.#gapBarsClose(e);
    if (e.key === GRADUATES_KEY) this.#graduatesFact = parseGraduates(unwrap(e.value)) ?? this.#graduatesFact;
    this.#observe(e);
    this.#noteCreate(e);
    this.#expireCreates(e.moment.receivedAt);
    this.#pruneIndex(e.moment.receivedAt);
    if (e.key === RESTORE_KEY) this.#restore(unwrap(e.value), out, e.moment.receivedAt);
    if (e.key === SEED_KEY) this.#seed(e.value, out);
    if (e.key === 'chain:slot') {
      const s = unwrap(e.value);
      if (isObj(s) && typeof s['slot'] === 'bigint' && (this.#height === null || s['slot'] > this.#height)) this.#height = s['slot'];
    }
    this.#discover(e, ctx, out);
    this.#readLanded(e);
    // READ-COHERENT: a batch's close is judged at once, on its own event, when every member's facts are out.
    const closed = this.#batchLanded(e);
    if (closed !== null) due.set(closed.mint, closed.read);
    this.#poolTrade(e, ctx);
    if (e.key === SEED_KEY || e.key === 'chain:slot' || e.key.startsWith('coverage:creates:')) {
      // H14's creates coverage over its look-back as of each slot and coverage change, for health and the restart drill.
      this.#coverage = createsCoverage(this.#history(ctx), ctx.now, ctx.now.receivedAt - this.#d.session.policy.gates.deployerRugLookbackDays * 86_400_000);
    }
    // The feed releases events at their own chain slots, so the newest chain slot released is the clock's slot.
    const gctx: GateContext = { now: ctx.now, lookup: (k, a) => ctx.lookup(k, a), history: this.#history(ctx), deployers: this.#deployers, observedTip: ctx.now.slot };
    this.#track(e, ctx);
    this.#lifecycle(ctx, out);
    this.#manage(ctx, out);
    // At most one entry step per call, and only while nothing else acted: ctx.book is the book before these decisions.
    this.#windowEnds(ctx.now.receivedAt, out);
    if (!out.some((d) => d.action !== null)) this.#entries(ctx, gctx, out, due);
    // Through `untilMs` itself: an exit at exactly the maximum hold (EXIT-1 fires at elapsed >= tMax) needs that moment.
    for (const [mint, t] of this.#tail) {
      if (ctx.now.receivedAt <= t.untilMs) continue;
      this.#tail.delete(mint);
      this.#retire(mint, t.pool);
    }
    this.#readStops(e, ctx);
    return out;
  }

  /** Every released event feeds the deployer index and the rug labeller; labels go to the index as they are made. */
  #observe(e: MarketEvent): void {
    // The worker's own facts are not chain events: the index's start is the first chain event it sees (or the seed's).
    if (e.key.startsWith('worker:')) return;
    if (this.#waiting !== null) {
      this.#waiting.push(e);
      return;
    }
    this.#deployers.observe(e);
    for (const label of this.#labeller.observe(e)) this.#deployers.observe(label);
  }

  /** A halt naming SEEDING starts the wait; only the seed ends it (the worker places one whatever the seed's outcome). */
  #seedWait(h: unknown): void {
    if (isObj(h) && Array.isArray(h['reasons']) && h['reasons'].includes(SEEDING) && this.#waiting === null && !this.#seedApplied) this.#waiting = [];
  }

  /** Observes the events that waited for the seed, in release order. */
  #release(): void {
    const xs = this.#waiting ?? [];
    this.#waiting = null;
    for (const x of xs) this.#observe(x);
  }

  /** The engine's history with SEED-1's coverage history merged in (the same bounds, oldest first). */
  #history(ctx: StrategyContext): GateContext['history'] {
    return (k, f, t) => {
      const r = ctx.history(k, f, t);
      const pre = this.#seedHistory.get(k);
      if (pre === undefined || !Array.isArray(r)) return r;
      const to = t ?? ctx.now;
      const inRange = pre.filter((x) => compareMoments(x.moment, f) >= 0 && compareMoments(x.moment, to) <= 0);
      return inRange.length === 0 ? r : [...inRange, ...(r as readonly AsOfEntry[])].sort((a, b) => compareMoments(a.moment, b.moment));
    };
  }

  /**
   * RESTART-KEEP: the saved candidates come back as of the restore. A list that is malformed, or holds a candidate
   * migrated or evaluated after the restore moment (a host clock behind the save), is refused whole, never in part.
   */
  #restoreCandidates(v: unknown, atMs: number, out: Decision[]): void {
    const list = Array.isArray(v) ? v.map(savedCandidate) : null;
    const why = list === null || list.some((c) => c === null) ? 'malformed saved candidates'
      : list.some((c) => c!.migratedAtMs > atMs || (c!.lastEvalMs ?? Number.NEGATIVE_INFINITY) > atMs || c!.bars.some((b) => b.startMs > atMs) || (c!.fees != null && c!.fees.atMs > atMs)) ? 'a saved candidate is dated after the restore' : null;
    if (why !== null) {
      out.push({ action: null, reasons: ['candidates refused', why] });
      return;
    }
    for (const c of list as SavedCandidate[]) {
      if (this.#cands.has(c.mint)) continue;
      // The pool's trade coverage starts at the saved migration slot (S0-ZERO's catch-up), as for a candidate seen live.
      this.#noteMigrationSlot(c.mint, c.migrationSlot);
      this.#cands.set(c.mint, { mint: c.mint, migratedAtMs: c.migratedAtMs, lastEvalMs: c.lastEvalMs, lastReason: c.lastReason, lastWaived: '', tries: c.tries, gates: null, spend: null });
      if (c.pool !== null) this.#notePool(c.mint, c.pool);
      // FEES-KEEP: the last swap's fee terms come back with it, so a restart does not leave it unpriced until its next swap.
      // Terms from a swap seen in this run are never replaced by saved ones (a candidate already listed is not restored at
      // all, so no case reaches this today; kept so an order change cannot regress).
      if (c.fees != null && !this.#observedFees.has(c.mint)) this.#observedFees.set(c.mint, { ctx: feeContextOf(c.fees), terms: c.fees, restored: true });
      // STEP-B: a window that ended during the downtime ends here, as the first event after the restore would end it,
      // before the candidate is listed: it is not restored, so none of its transactions is read again and its pool
      // gets no catch-up, which no decision could use (a boot after a long stop restored every saved candidate and read
      // each one again, then dropped them all at the first event).
      if (atMs >= c.migratedAtMs + this.#d.config.windowToMs) {
        this.#endWindow(c, out);
        continue;
      }
      if (c.bars.length > 0 && !this.#bars.has(c.mint)) this.#bars.set(c.mint, [...c.bars]);
      // The downtime's bars, from the saved last bar (or the migration) to the restore, come from the pool's filled trades.
      const barMs = this.#d.config.barMs;
      const fromMs = c.bars.at(-1)?.startMs ?? Math.floor(c.migratedAtMs / barMs) * barMs;
      if (fromMs < atMs) this.#barGap.set(c.mint, { fromMs, untilMs: atMs, trades: [], seen: new Set(), broken: false, closed: null });
      out.push({ action: null, reasons: [CANDIDATE_RESTORED, this.#d.config.universe, c.mint, `migrated at ${c.migratedAtMs}`, `tries ${c.tries}`] });
    }
  }

  /**
   * RESTART-KEEP: a restored candidate's price bars over the downtime, rebuilt from its pool's filled trades (S0-ZERO's
   * catch-up from the migration releases every trade). Taken only when that catch-up closes complete (`resume`) and
   * the trades' reserves chain into one run: after a lossy close or a broken chain the downtime's bars stay unknown
   * and the ATR waits for a fresh contiguous run, never a guess.
   */
  readonly #barGap = new Map<string, { readonly fromMs: number; readonly untilMs: number; readonly trades: GapTrade[]; readonly seen: Set<string>; broken: boolean; closed: { readonly at: Moment; readonly complete: boolean } | null }>();

  /** The price bars kept for a candidate (by mint) or a position (by id). */
  barsOf(key: string): readonly PriceBar[] {
    return this.#bars.get(key) ?? [];
  }

  /**
   * One filled swap inside a restored candidate's downtime, sampled as a never-restarted worker samples it: the pool
   * state right after the swap (FACTS-1's chain, `swapEventState`), at the spot formula of `#track`, in the swap's minute.
   */
  #gapBarTrade(mint: string, e: MarketEvent, v: Record<string, unknown>, ev: Record<string, unknown>, d: Record<string, unknown>): void {
    const g = this.#barGap.get(mint);
    if (g === undefined || typeof d['timestamp'] !== 'bigint') return;
    const atMs = Number(d['timestamp']) * 1000;
    if (atMs < g.fromMs || atMs >= g.untilMs) return;
    // The same trade from a fetched transaction and a log line counts once.
    const id = `${String(v['signature'] ?? e.id.split(':')[1])}:${String(d['poolBaseTokenReserves'])}:${String(d['poolQuoteTokenReserves'])}`;
    if (g.seen.has(id)) return;
    g.seen.add(id);
    let r: ReturnType<typeof swapEventState>;
    try {
      r = swapEventState(ev as unknown as SwapEvent);
    } catch {
      r = { ok: false, reason: 'undecodable swap' };
    }
    // A swap that does not replay leaves the live chain stale too (no sample there): the downtime cannot be proven.
    if (!r.ok || r.after.baseReserve <= 0n) {
      g.broken = true;
      return;
    }
    const price = (effectiveQuoteReserve(r.after) * PRICE_SCALE) / r.after.baseReserve;
    if (price <= 0n) {
      g.broken = true;
      return;
    }
    const pre = `${String(d['poolBaseTokenReserves'])}/${String(d['poolQuoteTokenReserves'] as bigint + (typeof d['virtualQuoteReserves'] === 'bigint' ? d['virtualQuoteReserves'] : 0n))}`;
    g.trades.push({ atMs, pre, post: `${r.after.baseReserve}/${effectiveQuoteReserve(r.after)}`, price });
  }

  /**
   * The close of a restored candidate pool's catch-up: complete (`resume`) or lossy (a bounded gap). The fill's trades
   * and its close reach the feed at one moment, where events go in id order, so the close may come first: it is noted,
   * and the bars are merged at the first event after that moment, once every trade of the fill is in.
   */
  #gapBarsClose(e: MarketEvent): void {
    const m = /^coverage:trades:(.+):(resume|gap)$/.exec(e.key);
    if (m === null) return;
    const mint = this.#mintOfPool.get(m[1]!);
    const g = mint === undefined ? undefined : this.#barGap.get(mint);
    if (g === undefined || g.closed !== null) return;
    const v = unwrap(e.value);
    const payload = isObj(v) && isObj(v['value']) ? v['value'] : v;
    // The catch-up's own opening gap (toSlot null) is not its close.
    if (m[2] === 'gap' && isObj(payload) && payload['toSlot'] === null) return;
    g.closed = { at: e.moment, complete: m[2] === 'resume' };
  }

  /**
   * After a catch-up's close, at a later moment: a complete one merges the downtime's bars; after a lossy one, a broken
   * reserve chain or a swap that does not replay, they stay unknown. A minute with no trade gets no bar, as live (`#track`
   * samples only on a pool update).
   */
  #gapBarsMerge(now: Moment): void {
    for (const [mint, g] of this.#barGap) {
      if (g.closed === null || compareMoments(now, g.closed.at) <= 0) continue;
      this.#barGap.delete(mint);
      if (!g.closed.complete || g.broken) continue;
      const ordered = chainOrder(g.trades);
      // The fill's trades do not reach the feed in chain order (one moment, ordered by id): their reserves give the order,
      // and prove none is missing between the first and the last. A broken chain leaves the downtime unknown.
      if (ordered === null) continue;
      const barMs = this.#d.config.barMs;
      const pending = new Map<number, PriceBar>();
      for (const t of ordered) {
        const start = Math.floor(t.atMs / barMs) * barMs;
        const b = pending.get(start);
        pending.set(start, b === undefined ? { startMs: start, high: t.price, low: t.price, close: t.price } : { startMs: start, high: t.price > b.high ? t.price : b.high, low: t.price < b.low ? t.price : b.low, close: t.price });
      }
      const bars = this.#bars.get(mint) ?? [];
      const kept = bars.filter((b) => b.startMs < g.fromMs || b.startMs >= g.untilMs);
      const byStart = new Map(bars.map((b) => [b.startMs, b]));
      const merged: PriceBar[] = [];
      for (let start = g.fromMs; start < g.untilMs; start += barMs) {
        const p = pending.get(start);
        const had = byStart.get(start);
        // The saved last bar ends with the filled trades after it; a bar live samples made after the restart keeps its close.
        const bar = p !== undefined && had !== undefined
          ? { startMs: start, high: p.high > had.high ? p.high : had.high, low: p.low < had.low ? p.low : had.low, close: start === g.fromMs ? p.close : had.close }
          : p ?? had;
        if (bar !== undefined) merged.push(bar);
      }
      const all = [...kept, ...merged].sort((a, b) => a.startMs - b.startMs);
      if (all.length > this.#d.config.keepBars) all.splice(0, all.length - this.#d.config.keepBars);
      this.#bars.set(mint, all);
    }
  }

  /**
   * RESTART-KEEP: REC-1's tail watches come back, so a rejected candidate's counterfactual keeps its pool watched to
   * windowEnd + tMax across a restart (the downtime is a gap on that pool's stream, never read as covered). One that
   * ended by the restore is dropped, as it would have been; past the cap the rest are logged `no tail`.
   */
  #restoreTails(v: unknown, atMs: number, out: Decision[]): void {
    const ok = Array.isArray(v) && v.every((t) => isObj(t) && typeof t['mint'] === 'string' && t['mint'] !== '' && typeof t['pool'] === 'string' && t['pool'] !== '' && typeof t['untilMs'] === 'number' && Number.isSafeInteger(t['untilMs']));
    if (!ok) {
      out.push({ action: null, reasons: ['tails refused', 'malformed saved tails'] });
      return;
    }
    const c = this.#d.config;
    for (const t of v as SavedTail[]) {
      if (t.untilMs < atMs || this.#tail.has(t.mint)) continue;
      if (this.#tail.size >= c.maxTails) out.push({ action: null, reasons: [NO_TAIL, c.universe, t.mint, `tail cap ${c.maxTails}`] });
      else this.#tail.set(t.mint, { pool: t.pool, untilMs: t.untilMs });
    }
  }

  /** PERSIST-3: restores a mint's deployer sales and flow from a saved exit; the reason when they cannot be. */
  /** Mints whose saved exit inputs this process has restored (once per mint). */
  readonly #inputsRestored = new Set<string>();

  #restoreInputs(mint: string, s: Record<string, unknown>, atMs: number): string | null {
    const ds = s['deployerSales'];
    const fl = s['flow'];
    const dp = s['deployer'];
    if (ds === undefined || fl === undefined || dp === undefined) return 'not in the saved exit';
    const deployer = dp === null ? null
      : isObj(dp) && Array.isArray(dp['sellers']) && dp['sellers'].length > 0 && dp['sellers'].every((x) => typeof x === 'string') && (dp['supply'] === null || (typeof dp['supply'] === 'bigint' && dp['supply'] > 0n))
        ? { sellers: dp['sellers'] as string[], supply: dp['supply'] as bigint | null } : undefined;
    if (deployer === undefined) return 'malformed';
    const sales = isObj(ds) && Array.isArray(ds['ids']) && ds['ids'].every((x) => typeof x === 'string') && Array.isArray(ds['list'])
      && ds['list'].every((x) => isObj(x) && typeof x['atMs'] === 'number' && Number.isFinite(x['atMs']) && typeof x['amount'] === 'bigint' && x['amount'] >= 0n)
      ? { ids: ds['ids'] as string[], list: ds['list'] as { atMs: number; amount: bigint }[] } : null;
    const pair = (x: unknown, t: 'bigint' | 'number'): boolean => Array.isArray(x) && x.length === 2 && typeof x[0] === (t === 'bigint' ? 'number' : 'string') && typeof x[1] === t;
    const flow = isObj(fl) && Array.isArray(fl['minutes']) && fl['minutes'].every((x) => pair(x, 'bigint')) && Array.isArray(fl['ids']) && fl['ids'].every((x) => pair(x, 'number'))
      ? { minutes: fl['minutes'] as [number, bigint][], ids: fl['ids'] as [string, number][] } : null;
    if (sales === null || flow === null) return 'malformed';
    // As of the restore: an entry dated after it (a host clock behind the save) refuses the inputs whole, like a future
    // seed (PERSIST-2); dropping it alone would keep its dedupe id and lose a real sale.
    if (sales.list.some((x) => x.atMs > atMs) || flow.minutes.some(([start]) => start > atMs) || flow.ids.some(([, start]) => start > atMs)) return 'dated after the restore';
    // A mint's inputs are the same in each of its saved exits (all written from one memory): taken once, so two saved
    // exits on one mint never count a sale or a flow minute twice (EXIT-KEEP review B1). Each is still checked above.
    if (this.#inputsRestored.has(mint)) return null;
    this.#inputsRestored.add(mint);
    if (deployer !== null && !this.#deployerMemo.has(mint)) this.#deployerMemo.set(mint, deployer);
    const s0 = this.#deployerSales.get(mint) ?? { ids: new Set<string>(), list: [] };
    for (const id of sales.ids) s0.ids.add(id);
    s0.list.push(...sales.list);
    this.#deployerSales.set(mint, s0);
    const f0 = this.#flow.get(mint) ?? { ids: new Map<string, number>(), minutes: new Map<number, bigint>() };
    for (const [start, net] of flow.minutes) f0.minutes.set(start, (f0.minutes.get(start) ?? 0n) + net);
    for (const [id, start] of flow.ids) f0.ids.set(id, start);
    this.#flow.set(mint, f0);
    return null;
  }

  #restore(v: unknown, out: Decision[], atMs: number): void {
    this.#restoreSeen = true;
    if (isObj(v) && v['candidates'] !== undefined) this.#restoreCandidates(v['candidates'], atMs, out);
    if (isObj(v) && v['tails'] !== undefined) this.#restoreTails(v['tails'], atMs, out);
    if (isObj(v) && isObj(v['openedAt'])) {
      for (const [pid, at] of Object.entries(v['openedAt'])) if (typeof at === 'number' && Number.isFinite(at)) this.#bookedOpenAt.set(pid, at);
    }
    if (isObj(v) && isObj(v['seeds'])) {
      for (const [id, x] of Object.entries(v['seeds'])) {
        if (isObj(x) && typeof x['mint'] === 'string' && typeof x['universe'] === 'string' && typeof x['notional'] === 'bigint' && typeof x['stopPrice'] === 'bigint' && typeof x['entryReserve'] === 'bigint') {
          this.#seeds.set(id, x as unknown as EntrySeed);
          this.#restoredSeeds.add(id);
        } else {
          out.push({ action: null, reasons: ['restore seed refused', id, 'malformed saved seed'] });
          this.#refusedSeeds.add(id);
        }
      }
    }
    if (isObj(v) && isObj(v['bookedWhen'])) {
      for (const [pid, when] of Object.entries(v['bookedWhen'])) if (typeof when === 'string') this.#bookedWhen.set(pid, when);
    }
    if (!isObj(v) || !isObj(v['exits'])) {
      out.push({ action: null, reasons: ['restore refused', 'malformed restore fact'] });
      return;
    }
    let n = 0;
    for (const [pid, s] of Object.entries(v['exits'])) {
      // A saved exit the exit rules could not run on is refused, never applied: its position goes into sell-only recovery
      // (EXIT-1g), so one bad entry neither stalls nor crashes the management of the others.
      if (!isObj(s) || !isObj(s['plan']) || !isObj(s['tracker']) || !Array.isArray(s['bars']) || !runnablePlan(s['plan']) || !runnableRecovery(s['recovery']) || !runnableRetryIds(s['retryIds'])) {
        out.push({ action: null, reasons: ['restore entry refused', pid, 'malformed saved plan'] });
        this.#recoveryWhy.set(pid, 'saved plan refused');
        continue;
      }
      // PERSIST-3: the exit inputs come back as saved; without them (or lost at an earlier restart, the flag kept in the
      // file) the position's deployer_sell and negative_flow exits would count from zero, so it is flattened instead.
      // A position whose exit inputs did not come back goes into EXIT-1g's sell-only recovery, the one mechanism for a
      // position held without its own exit evidence (EXIT-KEEP): its reason is saved, so every later restart keeps it
      // there, and the whole holding exits at the next fresh quote. A file from before this change may carry PERSIST-3's
      // `inputsLost` flag: read as lost at an earlier restart.
      const why = s['inputsLost'] !== undefined ? 'lost at an earlier restart' : this.#restoreInputs(this.#mintOf(pid), s, atMs);
      let saved = s as unknown as SavedExit;
      if (why !== null) {
        const reason = saved.recovery ?? `exit inputs not restored (${why})`;
        out.push({ action: null, reasons: ['recovery exit', pid, reason, 'the whole holding exits at the next fresh quote'] });
        const { inputsLost: _lost, ...rest } = saved;
        saved = { ...rest, tracker: { ...saved.tracker, pendingFull: ['emergency'] }, recovery: reason };
      }
      if (!runnableTracker(s['tracker'] as Record<string, unknown>)) {
        // A tracker the exit rules would throw on is never applied. Its trail, peak and flat target cannot be recovered, and
        // starting them again would weaken the position's protection: sell-only recovery instead (EXIT-1g).
        out.push({ action: null, reasons: ['restore tracker refused', pid, 'malformed saved tracker; sell-only recovery'] });
        out.push({ action: null, reasons: ['recovery exit', pid, 'saved tracker refused', 'the whole holding exits at the next fresh quote'] });
        saved = { ...saved, tracker: { ...newTracker(), pendingFull: ['emergency'] }, recovery: 'saved tracker refused' };
      }
      this.#exits.set(pid, saved);
      this.#restoredExits.add(pid);
      this.#bars.set(pid, [...saved.bars]);
      if (typeof saved.pool === 'string') this.#notePool(this.#mintOf(pid), saved.pool);
      if (saved.spot != null) this.#spot.set(pid, saved.spot);
      n++;
    }
    out.push({ action: null, reasons: ['restore', `${n} exit plans and trackers restored`] });
  }

  /** Seeds the index (SEED-1): saved and seeded creates and coverage, then the downtime fill, then saved rug labels. */
  #seed(v: unknown, out: Decision[]): void {
    try {
      this.#seedOnce(v, out);
    } finally {
      this.#seedApplied = true;
      this.#release();
    }
  }

  #seedOnce(v: unknown, out: Decision[]): void {
    if (this.#seedApplied) {
      out.push({ action: null, reasons: ['seed refused', 'already seeded'] });
      return;
    }
    if (!isObj(v) || !Array.isArray(v['creates']) || !Array.isArray(v['coverage']) || !Array.isArray(v['fill']) || !Array.isArray(v['rugs']) || !isObj(v['asOf']) || !Array.isArray(v['history'])
      || !v['history'].every((h) => isObj(h) && typeof h['key'] === 'string' && typeof h['id'] === 'string' && isObj(h['moment']))) {
      out.push({ action: null, reasons: ['seed refused', 'malformed seed'] });
      return;
    }
    for (const h of v['history'] as MarketEvent[]) {
      const list = this.#seedHistory.get(h.key) ?? [];
      list.push(Object.freeze({ moment: h.moment, value: h.value, source: h.id }));
      this.#seedHistory.set(h.key, list);
      if (COVERAGE_FACT.test(h.key)) this.#coverageFacts.push(h);
    }
    for (const list of this.#seedHistory.values()) list.sort((a, b) => compareMoments(a.moment, b.moment));
    const asOf = v['asOf'] as unknown as MarketEvent['moment'];
    if (isObj(v['state'])) {
      // PERSIST-1: the saved index and labeller (checked by the worker when it loaded them; checked again here, all or
      // nothing), then the downtime fill and the saved rug facts.
      try {
        const st = v['state'];
        let index: DeployerIndex;
        let labeller: RugLabeller;
        if (isObj(st['ref'])) {
          // WORKER-GROW: the seed names the saved file by its hash; the state itself never travels in the seed.
          if (this.#d.savedState === undefined) throw new Error('the seed names a saved state file and nothing reads it');
          ({ index, labeller } = this.#d.savedState(st['ref'] as unknown as SavedStateRef));
        } else {
          index = DeployerIndex.restore(st['index'] as DeployerIndexState);
          labeller = RugLabeller.restore(this.#d.rugs, st['labeller'] as RugLabellerState, asOf);
        }
        const f = index.fill(v['fill'] as MarketEvent[], asOf);
        this.#deployers = index;
        this.#labeller = labeller;
        for (const r of v['rugs'] as MarketEvent[]) this.#deployers.observe(r);
        out.push({ action: null, reasons: ['seed', `saved state restored, ${f.creates} filled, ${(v['rugs'] as unknown[]).length} rug facts`] });
      } catch (err) {
        // Refused in full: as a fresh process, the index starts at its first live event (H14 not covered for a look-back).
        out.push({ action: null, reasons: ['seed refused', `saved state: ${err instanceof Error ? err.message : 'error'}`] });
      }
      return;
    }
    try {
      const s = this.#deployers.seed(v['creates'] as MarketEvent[], v['coverage'] as MarketEvent[], asOf);
      const f = this.#deployers.fill(v['fill'] as MarketEvent[], asOf);
      for (const r of v['rugs'] as MarketEvent[]) this.#deployers.observe(r);
      out.push({ action: null, reasons: ['seed', `${s.creates} creates seeded, ${f.creates} filled, ${(v['rugs'] as unknown[]).length} rug facts`, s.fromMs === null ? 'no seeded coverage start' : `index watched from ${s.fromMs}`] });
    } catch (err) {
      // Refused in full: the index starts at its first live event, so H14 stays not covered for a look-back.
      out.push({ action: null, reasons: ['seed refused', err instanceof Error ? err.message : 'error'] });
    }
  }

  /** Position ids are `p:<mint>:<n>`. */
  #mintOf(pid: string): string {
    return pid.split(':')[1] ?? pid;
  }

  #discover(e: MarketEvent, ctx: StrategyContext, out: Decision[]): void {
    if (e.key.startsWith(MIGRATION_PREFIX)) {
      // GATE-1's migration fact (a fetched, confirmed migration) also names a candidate.
      const f = parseMigration(e.value);
      const mint = e.key.slice(MIGRATION_PREFIX.length);
      if (f !== null) {
        this.#notePool(mint, f.pool);
        this.#noteMigrationSlot(mint, f.obs.slot);
      }
      if (f !== null && !this.#cands.has(mint)) {
        this.#cands.set(mint, { mint, migratedAtMs: f.migratedAtMs, lastEvalMs: null, lastReason: null, lastWaived: '', tries: 0, gates: null, spend: null });
        out.push({ action: null, reasons: [SHORTLIST, this.#d.config.universe, mint, `migrated at ${f.migratedAtMs}`] });
      }
      return;
    }
    const v = e.value;
    if (!isObj(v) || !isObj(v['event'])) return;
    const ev = v['event'];
    if (ev['name'] !== MIGRATION || !isObj(ev['data'])) return;
    const d = ev['data'];
    const mint = typeof d['mint'] === 'string' ? d['mint'] : null;
    const ts = typeof d['timestamp'] === 'bigint' ? Number(d['timestamp']) * 1000 : null;
    if (mint !== null && typeof d['pool'] === 'string') {
      this.#notePool(mint, d['pool']);
      // The migration transaction's own slot (a logs sighting carries it as txSlot): the pool cannot trade before it.
      this.#noteMigrationSlot(mint, typeof v['txSlot'] === 'bigint' ? v['txSlot'] : e.moment.slot);
    }
    if (mint === null || this.#cands.has(mint)) return;
    // Block time of the migration when the event states it, else when it was received.
    const migratedAtMs = ts ?? ctx.now.receivedAt;
    this.#cands.set(mint, { mint, migratedAtMs, lastEvalMs: null, lastReason: null, lastWaived: '', tries: 0, gates: null, spend: null });
    out.push({ action: null, reasons: [SHORTLIST, this.#d.config.universe, mint, `migrated at ${migratedAtMs}`] });
  }

  /** FEES-KEEP: the fee terms a save keeps for a mint: the latest swap's, unless it was received after the save moment. */
  #feeTermsAsOf(mint: string, atMs: number): SavedFees | null {
    const f = this.#observedFees.get(mint)?.terms;
    return f != null && f.atMs <= atMs ? f : null;
  }

  /** Drops a mint's pool state once nothing watches it (its window ended and no position holds it). */
  /**
   * OOM-MINT review B1: a mint still in play: a candidate, an exit plan, an entry proposed and not yet booked (its seed),
   * or any position of it in the book that is not closed (a late fill books one after the window ends).
   */
  #held(mint: string): boolean {
    if (this.watched().has(mint)) return true;
    return this.#money(mint);
  }

  /**
   * BEHIND (facts review): money is or may be on this mint: an exit plan, an entry proposed and not yet booked (its
   * seed), a position not closed, or an attempt that may still land. Its trade stream is never shed.
   */
  committed(mint: string): boolean {
    for (const pid of this.#exits.keys()) if (this.#mintOf(pid) === mint) return true;
    return this.#money(mint);
  }

  #money(mint: string): boolean {
    for (const s of this.#seeds.values()) if (s.mint === mint) return true;
    for (const p of Object.values(this.#book?.positions ?? {})) if (String(p.mint) === mint && p.status !== 'closed') return true;
    return this.#mayLand(mint);
  }

  /**
   * OOM-MINT facts review B3: an intent of this mint with an attempt that may still land (an orphan fill would open a
   * position on it), or a landing not yet booked. An intent that is not terminal holds it; a terminal one until each
   * attempt read failed at finalized or is past its last valid height by another validity window (time for the status
   * read that would find a landing), so no position ever opens on a let-go coin.
   */
  #mayLand(mint: string): boolean {
    const book = this.#book;
    if (book === null) return false;
    for (const o of Object.values(book.orphans)) if (String(book.intents[o.intentId]?.intent.mint) === mint) return true;
    const height = this.#height;
    for (const s of Object.values(book.intents)) {
      if (String(s.intent.mint) !== mint) continue;
      if (!isTerminal(s)) return true;
      for (const a of s.attempts) {
        if (s.failedSignatures.includes(a.signature) || s.fills.some((f) => f.signature === a.signature)) continue;
        if (height === null || height <= a.lastValidBlockHeight + this.#d.config.blockhashValidBlocks) return true;
      }
    }
    return false;
  }

  /** Mints a seed drop could not let go yet (`#mayLand`); retried each event until nothing holds them. */
  readonly #letGoLater = new Set<string>();

  /** The book as of the event being judged (`#held`). */
  #book: StrategyContext['book'] | null = null;

  #forget(mint: string): void {
    if (this.#held(mint)) return;
    const pool = this.#poolOfMint.get(mint);
    if (pool !== undefined) this.#mintOfPool.delete(pool);
    for (const m of [this.#poolOfMint, this.#observedFees, this.#tradeAt, this.#deployerSales, this.#flow, this.#deployerMemo, this.#migrationSlot, this.#swapAt, this.#inputsRestored]) m.delete(mint);
    this.#retire(mint, pool ?? null);
  }

  /**
   * OOM-MINT: a mint no longer held (`#held`) and with no tail is let go with its pool: nothing reads their facts again
   * (`retired`). A tail keeps them until it ends.
   */
  #retire(mint: string, pool: string | null): void {
    if (this.#held(mint) || this.#tail.has(mint)) return;
    this.#letGo.push(mint);
    if (pool !== null) this.#letGo.push(pool);
  }

  readonly #letGo: string[] = [];

  /** OOM-MINT: creates seen and not yet let go, by mint, with their chain time (in release order). */
  readonly #creates = new Map<string, number>();
  /** OOM-MINT: let-go creates, kept `EXPIRED_CREATE_KEEP_MS`. */
  readonly #expired = new HourTags(EXPIRED_CREATE_KEEP_MS);

  #noteCreate(e: MarketEvent): void {
    const prefix = e.key.startsWith(LOG_CREATE_PREFIX) ? LOG_CREATE_PREFIX : e.key.startsWith(TX_CREATE_PREFIX) ? TX_CREATE_PREFIX : null;
    if (prefix === null) return;
    const mint = e.key.slice(prefix.length);
    if (this.#creates.has(mint) || this.#expired.has(mint)) return;
    // Its age is the create's own chain time (a create read late, by a seed fill or a lookup, is as old as it is), else
    // when it was released.
    const created = createOf(e.value)?.createdAtMs ?? e.moment.receivedAt;
    this.#creates.set(flatCopy(mint), created);
  }

  /**
   * OOM-MINT: creates older than `createKeepMs + CREATE_LATE_MS` by their chain time whose coin is not held or tailed
   * are let go (`retired`) and remembered as expired; a held or tailed one is just dropped from the list (its coin
   * migrated, and its facts go with the candidate).
   */
  #expireCreates(now: number): void {
    // Once a minute of event time, every create is checked (chain times need not follow release order).
    if (now - this.#createsCheckedAt < 60_000) return;
    this.#createsCheckedAt = now;
    const after = this.#d.config.createKeepMs + CREATE_LATE_MS;
    for (const [mint, at] of this.#creates) {
      if (at + after > now) continue;
      this.#creates.delete(mint);
      // A candidate (its pool and migration slot are noted with it), a pending entry, an open position or a tail.
      if (this.#held(mint) || this.#tail.has(mint)) continue;
      this.#expired.add(mint, now);
      this.#letGo.push(mint);
    }
    this.#expired.prune(now);
  }

  #createsCheckedAt = Number.NEGATIVE_INFINITY;
  #indexPrunedAt = Number.NEGATIVE_INFINITY;

  /**
   * OOM-MINT: once an hour of event time, the deployer index drops what its save leaves out (the H14 look-back plus a day,
   * the worker's PERSIST-1 line), so its memory holds what a restart would restore and no more.
   */
  #pruneIndex(now: number): void {
    if (now - this.#indexPrunedAt < 3_600_000) return;
    this.#indexPrunedAt = now;
    this.#deployers.prune(now - (this.#d.session.policy.gates.deployerRugLookbackDays + 1) * 86_400_000);
  }

  /** OOM-MINT: this mint's create was let go before its coin migrated (`create-expired`). */
  createExpired(mint: string): boolean {
    return this.#expired.has(mint);
  }

  /** OOM-MINT: the mints and pools let go since the last call (`Strategy.retired`). */
  retired(): readonly string[] {
    return this.#letGo.splice(0, this.#letGo.length);
  }

  #noteMigrationSlot(mint: string, slot: bigint | null): void {
    if (slot === null) return;
    const was = this.#migrationSlot.get(mint);
    if (was === undefined || slot < was) this.#migrationSlot.set(mint, slot);
  }

  #notePool(mint: string, pool: string): void {
    const was = this.#poolOfMint.get(mint);
    if (was === pool) return;
    if (was !== undefined) this.#mintOfPool.delete(was);
    this.#poolOfMint.set(mint, pool);
    this.#mintOfPool.set(pool, mint);
  }

  /**
   * A released PumpSwap swap on a watched pool: its fee terms become the mint's fee context (a flat schedule at the
   * observed rates, BT-1's `observedFeeContext`), and a sale by the mint's deployer is counted for EXIT-1's
   * deployer-sell trigger.
   */
  #poolTrade(e: MarketEvent, ctx: StrategyContext): void {
    const v = e.value;
    if (!isObj(v) || !isObj(v['event'])) return;
    const ev = v['event'];
    if (ev['program'] !== 'pump_amm' || (ev['name'] !== 'BuyEvent' && ev['name'] !== 'SellEvent') || !isObj(ev['data'])) return;
    const d = ev['data'];
    const mint = typeof d['pool'] === 'string' ? this.#mintOfPool.get(d['pool']) : undefined;
    if (typeof d['timestamp'] === 'bigint') {
      const slot = typeof v['txSlot'] === 'bigint' ? v['txSlot'] : e.moment.slot;
      const ms = Number(d['timestamp']) * 1000;
      if (this.#blockClock === null || slot >= this.#blockClock.slot) this.#blockClock = { slot, ms };
      // The pool's last released swap, in any slot order: its pool update comes next (a fill's older swap included).
      if (mint !== undefined) this.#swapAt.set(mint, { slot, ms });
    }
    if (mint === undefined) return;
    this.#gapBarTrade(mint, e, v, ev, d);
    this.#tradeAt.set(mint, e.moment.receivedAt);
    const n = (k: string): number | null => (typeof d[k] === 'bigint' && (d[k] as bigint) >= 0n && (d[k] as bigint) <= 10_000n ? Number(d[k]) : null);
    const lp = n('lpFeeBasisPoints');
    const protocol = n('protocolFeeBasisPoints');
    const supply = typeof d['baseSupply'] === 'bigint' && d['baseSupply'] > 0n ? d['baseSupply'] : null;
    if (lp !== null && protocol !== null && supply !== null) {
      const ix = typeof d['ixName'] === 'string' && d['ixName'].endsWith('_v2') ? 'v2' : 'v1';
      const creator = n('coinCreatorFeeBasisPoints') ?? 0;
      const buyback = n('buybackFeeBasisPoints') ?? 0;
      let r: ReturnType<typeof swapEventState>;
      try {
        r = swapEventState(ev as unknown as SwapEvent);
      } catch {
        r = { ok: false, reason: 'undecodable swap' };
      }
      const terms: SavedFees | null = r.ok ? { atMs: e.moment.receivedAt, lp, protocol, creator, buyback, instruction: ix, baseSupply: supply, after: { base: r.after.baseReserve, quote: effectiveQuoteReserve(r.after) } } : null;
      const ctx = observedFeeContext({ split: { lp: bps(lp), protocol: bps(protocol), creator: bps(creator) }, buybackFeeBps: bps(buyback), instruction: ix }, supply, { mayhemMode: false, transferFee: false, transferHook: false });
      this.#observedFees.set(mint, { ctx, terms, restored: false });
    }
    this.#addFlow(mint, e, v, ev['name'], d);
    if (ev['name'] !== 'SellEvent' || typeof d['user'] !== 'string' || typeof d['baseAmountIn'] !== 'bigint') return;
    const sellers = this.#deployerOf(mint, ctx);
    if (sellers === null || !sellers.sellers.includes(d['user'])) return;
    const s = this.#deployerSales.get(mint) ?? { ids: new Set<string>(), list: [] };
    this.#deployerSales.set(mint, s);
    const id = `${String(v['signature'] ?? e.id)}|${d['user']}|${d['baseAmountIn']}`;
    if (s.ids.has(id)) return;
    s.ids.add(id);
    s.list.push({ atMs: e.moment.receivedAt, amount: d['baseAmountIn'] });
  }

  #addFlow(mint: string, e: MarketEvent, v: Record<string, unknown>, name: unknown, d: Record<string, unknown>): void {
    if (![...this.#exits.keys()].some((pid) => this.#mintOf(pid) === mint)) {
      this.#flow.delete(mint);
      return;
    }
    const amount = name === 'BuyEvent' ? d['quoteAmountIn'] : d['quoteAmountOut'];
    if (typeof amount !== 'bigint' || amount < 0n) return;
    const f = this.#flow.get(mint) ?? { ids: new Map<string, number>(), minutes: new Map<number, bigint>() };
    this.#flow.set(mint, f);
    const id = `${String(v['signature'] ?? e.id)}|${String(name)}|${String(d['user'])}|${String(d['baseAmountIn'] ?? d['baseAmountOut'])}|${amount}`;
    if (f.ids.has(id)) return;
    const start = Math.floor(e.moment.receivedAt / FLOW_MINUTE_MS) * FLOW_MINUTE_MS;
    f.ids.set(id, start);
    f.minutes.set(start, (f.minutes.get(start) ?? 0n) + (name === 'BuyEvent' ? amount : -amount));
    // Only the recent minutes can be part of a negative run: older ones (and their ids) are dropped, so memory and the
    // saved evidence stay bounded on a long hold.
    for (const m of f.minutes.keys()) if (m < start - FLOW_KEEP_MS) f.minutes.delete(m);
    for (const [k, m] of f.ids) if (m < start - FLOW_KEEP_MS) f.ids.delete(k);
  }

  /** The held mint's finished flow minutes, oldest first (EXIT-1 `ExitObservation.flow`). */
  #flowOf(mint: string, nowMs: number): FlowMinute[] {
    const f = this.#flow.get(mint);
    return f === undefined ? [] : closedFlow(f.minutes, nowMs);
  }

  /** The deployer of a mint (creator and the create's signer) and its total supply, from the released create. */
  #deployerOf(mint: string, ctx: StrategyContext): { readonly sellers: readonly string[]; readonly supply: bigint | null } | null {
    for (const key of [`${TX_CREATE_PREFIX}${mint}`, `${LOG_CREATE_PREFIX}${mint}`]) {
      const r = ctx.lookup(key);
      const v = r.ok ? r.value : null;
      const d = isObj(v) && isObj(v['event']) && isObj(v['event']['data']) ? v['event']['data'] : null;
      if (d === null || typeof d['creator'] !== 'string') continue;
      const sellers = typeof d['user'] === 'string' && d['user'] !== d['creator'] ? [d['creator'], d['user']] : [d['creator']];
      const dep = { sellers, supply: typeof d['tokenTotalSupply'] === 'bigint' && d['tokenTotalSupply'] > 0n ? d['tokenTotalSupply'] : null };
      if ([...this.#exits.keys()].some((pid) => this.#mintOf(pid) === mint)) this.#deployerMemo.set(mint, dep);
      return dep;
    }
    return this.#deployerMemo.get(mint) ?? null;
  }

  /** EXIT-1's deployer-sell observation for a position: the share of supply its deployer sold since the entry. */
  #deployerSold(pid: string, mint: string, openedAtMs: number, ctx: StrategyContext, out: Decision[]): { atMs: number; value: number } | null {
    const dep = this.#deployerOf(mint, ctx);
    const why = dep === null ? 'its create was not seen' : dep.supply === null ? 'the create carries no total supply' : !this.#poolOfMint.has(mint) ? 'its pool is unknown' : null;
    if (why !== null) {
      if (!this.#unjudgedDeployer.has(pid)) {
        this.#unjudgedDeployer.add(pid);
        out.push({ action: null, reasons: ['deployer sell not judged', pid, why] });
      }
      return null;
    }
    const sold = (this.#deployerSales.get(mint)?.list ?? []).filter((x) => x.atMs >= openedAtMs).reduce((t, x) => t + x.amount, 0n);
    return { atMs: this.#tradeAt.get(mint) ?? openedAtMs, value: Number((sold * BPS) / dep!.supply!) };
  }

  /** The pool market of a mint as of now: the gate pool fact and the fee context. */
  /**
   * `carry: false` for entries (risk review of #121): a candidate gets no verify read, so a carry would let a silent
   * stream stall or a vault transfer date its quote without bound; an entry judges the pool fact's own moment.
   */
  #market(ctx: StrategyContext, mint: string, o: { readonly carry: boolean } = { carry: true }): Market | string {
    const p = ctx.lookup(poolKey(mint));
    const sr = ctx.lookup(snapshotKey(mint));
    const snap = sr.ok ? parseSnapshotFact(unwrap(sr.value)) : null;
    const pool = p.ok ? parsePool(p.value) : null;
    const cr = ctx.lookup(carryKey(mint));
    const choice = chooseMarket(pool, snap, o.carry && cr.ok ? parseCarryFact(unwrap(cr.value)) : null);
    // WATCH-1: a snapshot newer than the pool fact (carried or not) is the market, reserves and fee context alike.
    if (choice.kind === 'snapshot') {
      this.#notePool(mint, choice.snap.pool);
      return { pool: choice.snap.state, ctx: choice.snap.ctx, atMs: choice.snap.atMs, address: choice.snap.pool };
    }
    if (!p.ok) return NO_POOL_STATE;
    if (pool === null) return POOL_MALFORMED;
    // A flagged pool fact (POS-1: the swap stream lost continuity) is never priced from, whatever its age.
    const flags = pool.obs.quality.filter((q) => q !== 'backfilled' && q !== 'deduplicated');
    if (choice.kind === 'flagged') return `${POOL_FLAGGED} ${flags.join(', ')}${typeof (p.value as { stale?: unknown }).stale === 'string' ? ` (${(p.value as { stale: string }).stale})` : ''}`;
    this.#notePool(mint, pool.address);
    // A fee-context fact when one is published, else the terms of the latest swap seen on the pool (restored ones only
    // for the pool their swap left).
    const state: PoolState = { baseReserve: pool.baseVault, quoteVault: pool.quoteVault, virtualQuoteReserves: pool.pool.virtualQuoteReserves ?? 0n };
    const f = ctx.lookup(feesKey(mint));
    const fees = f.ok ? (unwrap(f.value) as PoolFeeContext) : this.#feesFor(mint, state);
    if (fees === undefined) return NO_FEE_CONTEXT;
    return {
      pool: state,
      ctx: fees, atMs: choice.kind === 'pool' ? choice.atMs : pool.obs.receivedAt, address: pool.address,
    };
  }

  /** Price bars per mint: the spot price (effective quote per base, PRICE_SCALE) at each pool update. */
  #track(e: MarketEvent, ctx: StrategyContext): void {
    const prefix = e.key.startsWith(POOL_PREFIX) ? POOL_PREFIX : e.key.startsWith(SNAPSHOT_PREFIX) ? SNAPSHOT_PREFIX : null;
    if (prefix === null) return;
    const mint = e.key.slice(prefix.length);
    const held = [...this.#exits.keys()].filter((pid) => this.#mintOf(pid) === mint);
    if (!this.#cands.has(mint) && held.length === 0) return;
    const m = this.#market(ctx, mint);
    if (typeof m === 'string' || m.pool.baseReserve <= 0n) return;
    const price = (effectiveQuoteReserve(m.pool) * PRICE_SCALE) / m.pool.baseReserve;
    const barMs = this.#d.config.barMs;
    // RESTART-KEEP (run/CI ruling): bars are on block time, the one clock live, a restart's rebuild and a replay share
    // (the backtest has only block time). A swap's pool update is at the swap's block time; any other update (an account
    // read, a snapshot) at its slot's time from the newest block-time anchor, never past the engine clock.
    const start = Math.floor(this.#sampleAt(e, mint, ctx.now.receivedAt) / barMs) * barMs;
    const add = (key: string): void => {
      const bars = this.#bars.get(key) ?? [];
      const last = bars[bars.length - 1];
      if (last !== undefined && last.startMs === start) {
        bars[bars.length - 1] = { startMs: start, high: price > last.high ? price : last.high, low: price < last.low ? price : last.low, close: price };
      } else if (last !== undefined && start < last.startMs) {
        // A sample whose slot time falls in an earlier bar (an estimate): it widens that bar, never moves a close back.
        const i = bars.findIndex((b) => b.startMs >= start);
        const b = bars[i]!;
        if (b.startMs === start) bars[i] = { ...b, high: price > b.high ? price : b.high, low: price < b.low ? price : b.low };
        else bars.splice(i, 0, { startMs: start, high: price, low: price, close: price });
      } else bars.push({ startMs: start, high: price, low: price, close: price });
      if (bars.length > this.#d.config.keepBars) bars.splice(0, bars.length - this.#d.config.keepBars);
      this.#bars.set(key, bars);
    };
    add(mint);
    for (const pid of held) {
      add(pid);
      this.#spot.set(pid, { price, atMs: ctx.now.receivedAt });
    }
  }

  /** Solana's target slot time: a slot's time from a block-time anchor (an estimate, used only off a swap). */
  static readonly SLOT_MS = 400;
  /** The farthest (in slots, about 60 s) an anchor dates another slot from; past it the anchor is stale. */
  static readonly ANCHOR_MAX_SLOTS = 150n;
  /**
   * The newest block-time anchor from any PumpSwap swap released: slot (the swap's own `txSlot`: a fill's trades sit
   * at the open slot) and block time. Only an update with no swap of its own (an account read, a snapshot) is dated
   * from it; a swap's pool update takes its own swap's time (`#swapAt`).
   */
  #blockClock: { slot: bigint; ms: number } | null = null;
  /** Each watched mint's pool's last released swap: its slot and block time, which date that swap's pool update. */
  readonly #swapAt = new Map<string, { readonly slot: bigint; readonly ms: number }>();

  /** The block time a pool update belongs to (see `#track`); the engine clock when nothing dates it. */
  #sampleAt(e: MarketEvent, mint: string, nowMs: number): number {
    const v = unwrap(e.value);
    const slot = isObj(v) && isObj(v['obs']) && typeof v['obs']['slot'] === 'bigint' ? v['obs']['slot'] : isObj(v) && typeof v['slot'] === 'bigint' ? v['slot'] : null;
    // The pool's own swap at this slot: its exact block time, whatever other pools' swaps moved the anchor to.
    const own = this.#swapAt.get(mint);
    if (own !== undefined && slot !== null && own.slot === slot) return Math.min(own.ms, nowMs);
    const a = this.#blockClock;
    if (a === null || slot === null) return nowMs;
    // A stale anchor (supervisor ruling): past ANCHOR_MAX_SLOTS the 400 ms guess drifts tens of seconds (slots run
    // slower), enough to cross a minute; the receipt time is the better date then, as with no anchor at all.
    const gap = slot - a.slot;
    if ((gap < 0n ? -gap : gap) > LiveStrategy.ANCHOR_MAX_SLOTS) return nowMs;
    return Math.min(a.ms + Number(gap) * LiveStrategy.SLOT_MS, nowMs);
  }

  #attempt(id: IntentId, n: number, quote: QuoteContext, height: bigint): TransactionAttempt {
    const a = `${id}.a${n}`;
    return {
      id: attemptId(a), intentId: id, signedBytesRef: `paper:${a}`, signature: paperSignature(a), blockhash: paperBlockhash(a),
      lastValidBlockHeight: height + this.#d.config.blockhashValidBlocks, quote,
    };
  }

  /** The live SOL price for risk: a spot read, never the hourly series (whose points are up to an hour old). */
  #spotSol(ctx: StrategyContext): Timed<MicroUsd> | null {
    const r = ctx.lookup(SOL_PRICE_KEY);
    if (!r.ok) return null;
    const v = unwrap(r.value);
    return isObj(v) && typeof v['value'] === 'bigint' && v['value'] > 0n && typeof v['atMs'] === 'number' ? { value: v['value'] as MicroUsd, atMs: v['atMs'] } : null;
  }

  #balance(a: AccountFact, ctx: StrategyContext): Timed<Lamports> | null {
    if (a.solBalance === null) return null;
    return a.paper ? { value: a.solBalance.value, atMs: ctx.now.receivedAt } : a.solBalance;
  }

  #account(ctx: StrategyContext): AccountFact | null {
    const r = ctx.lookup(ACCOUNT_KEY);
    if (!r.ok) return null;
    const v = unwrap(r.value);
    return isObj(v) && isObj(v['history']) && isObj(v['latches']) && typeof v['oneTimeRent'] === 'bigint' ? (v as unknown as AccountFact) : null;
  }

  /** Entry intents that resolved without a fill end; exit owners that did get a new attempt or are booked blocked. */
  #lifecycle(ctx: StrategyContext, out: Decision[]): void {
    // A waiting owner that settled or was booked another way no longer waits. #manage also ends the saved wait from the
    // book on every step (which covers a restart, when this list is empty); both are kept.
    // A seed whose entry ended without a fill is never made into a plan (EXIT-1h).
    // A restored seed whose intent is not in the rebuilt book (the kill came before the desk booked it) never will be:
    // dropped at the restore's first step, so the file does not grow by one per such kill (EXIT-1h review N1).
    for (const id of this.#seeds.keys()) {
      const e = ctx.book.intents[id];
      const mint = this.#seeds.get(id)?.mint;
      if (e !== undefined && isTerminal(e) && e.fills.length === 0) {
        this.#seeds.delete(id);
        this.#restoredSeeds.delete(id);
        if (mint !== undefined) this.#letGoLater.add(mint);
      } else if (e === undefined && this.#restoredSeeds.has(id)) {
        this.#seeds.delete(id);
        this.#restoredSeeds.delete(id);
        out.push({ action: null, reasons: ['restored seed dropped', id, 'its intent never reached the book'] });
        if (mint !== undefined) this.#letGoLater.add(mint);
      }
    }
    // A dropped seed's mint is let go once nothing holds it: no attempt that may still land, no position (an orphan
    // fill's included), no candidate.
    for (const mint of this.#letGoLater) {
      if (this.#held(mint)) continue;
      this.#letGoLater.delete(mint);
      this.#forget(mint);
    }
    // A restored saved exit whose position is not in the rebuilt book (the plans are written before the desk books the
    // step, so a kill between the two leaves one) never will be: dropped at the restore's first step, so exits.json
    // keeps only booked positions (EXIT-1h follow-up).
    for (const pid of this.#restoredExits) {
      this.#restoredExits.delete(pid);
      if (ctx.book.positions[pid] !== undefined) continue;
      this.#exits.delete(pid);
      this.#bars.delete(pid);
      this.#spot.delete(pid);
      this.#forget(this.#mintOf(pid));
      out.push({ action: null, reasons: ['restored exit dropped', pid, 'its position never reached the book'] });
    }
    for (const [id, pid] of this.#waitingMarket) {
      const i = ctx.book.intents[id];
      if (i === undefined || isTerminal(i) || (i.status !== 'exposure_reserved' && !(i.status === 'reconciled' && i.fills.length === 0))) {
        this.#waitingMarket.delete(id);
        if (ctx.book.positions[pid]?.status !== 'open') this.#setWaiting(pid, null);
      }
    }
    for (const i of Object.values(ctx.book.intents)) {
      if (isTerminal(i)) continue;
      const mint = i.intent.mint;
      if (i.intent.purpose === 'entry') {
        if (i.status === 'reconciled' && i.fills.length === 0) out.push({ action: { type: 'intent', intentId: i.intent.id, event: { type: 'abandon' } }, reasons: ['entry not filled', mint] });
        else if (i.status === 'exposure_reserved') this.#sendEntry(i, ctx, out);
        continue;
      }
      if (i.status !== 'exposure_reserved' && !(i.status === 'reconciled' && i.fills.length === 0)) continue;
      // Never more than the position holds now (a late sale may have taken some or all of it, PAPER-2); nothing left:
      // the exit is cancelled, never sent.
      const held = ctx.book.positions[i.intent.positionId]?.quantity ?? 0n;
      if (held === 0n) {
        out.push({ action: { type: 'intent', intentId: i.intent.id, event: { type: 'cancel' } }, reasons: ['exit cancelled', mint, 'nothing left to sell'] });
        continue;
      }
      const quantity = i.intent.quantity < held ? i.intent.quantity : held;
      if (i.status === 'exposure_reserved') this.#sendExit(i.intent.id, i.intent.positionId, mint, quantity, 0, ctx, out);
      else this.#replaceExit(i, quantity, ctx, out);
    }
  }

  #sendEntry(i: IntentState, ctx: StrategyContext, out: Decision[]): void {
    const mint = i.intent.mint;
    const id = i.intent.id;
    const cancel = (why: string) => out.push({ action: { type: 'intent', intentId: id, event: { type: 'cancel' } }, reasons: ['entry cancelled', mint, why] });
    if (i.intent.purpose !== 'entry') return;
    if (this.#height === null) return void cancel('no slot height yet');
    const m = this.#market(ctx, mint, { carry: false });
    if (typeof m === 'string') return void cancel(m);
    if (ctx.now.receivedAt - m.atMs > this.#d.session.policy.gates.maxQuoteAgeMs) return void cancel('pool state is stale');
    const q = poolBuyExactQuoteIn(m.pool, i.intent.spend, m.ctx);
    if (!q.ok) return void cancel(`no quote: ${q.reason}`);
    const slip = bps(this.#d.config.entryMinOutBelowBps);
    const quote: QuoteContext = {
      provider: 'pumpswap-local', requestId: null, inAmount: i.intent.spend, quotedOut: q.trade.base,
      minOut: mulDiv(q.trade.base, BPS - BigInt(slip), BPS, 'floor'), slippage: slip, quotedAtSlot: this.#height,
    };
    const act = (event: BookEvent, why: string) => out.push({ action: event, reasons: [why, mint] });
    act({ type: 'intent', intentId: id, event: { type: 'prepare', quote } }, 'prepare entry');
    act({ type: 'intent', intentId: id, event: { type: 'sign', attempt: this.#attempt(id, 1, quote, this.#height) } }, 'sign entry (paper)');
    act({ type: 'intent', intentId: id, event: { type: 'submit' } }, 'submit entry (paper)');
  }

  /** Sell quote for `tokens` at the ladder rung, or why none can be made. */
  #sellQuote(ctx: StrategyContext, mint: string, tokens: bigint, rung: number): QuoteContext | string {
    const m = this.#market(ctx, mint);
    if (typeof m === 'string') return m;
    if (ctx.now.receivedAt - m.atMs > this.#d.session.policy.gates.maxQuoteAgeMs) return 'pool state is stale';
    const q = poolSell(m.pool, tokens, m.ctx);
    if (!q.ok) return `${NO_QUOTE}${q.reason}`;
    const step = this.#d.session.policy.exits.ladder.steps[rung]!;
    const below = BigInt(step.minOutBelowTriggerBps);
    return {
      provider: 'pumpswap-local', requestId: null, inAmount: tokens, quotedOut: q.trade.userQuote,
      minOut: mulDiv(q.trade.userQuote, BPS - below, BPS, 'floor'), slippage: step.minOutBelowTriggerBps as Bps, quotedAtSlot: this.#height,
    };
  }

  /** Signs and submits the next attempt of exit owner `id`; books it blocked when no quote can be made. */
  #sendExit(id: IntentId, pid: PositionId, mint: string, quantity: bigint, signed: number, ctx: StrategyContext, out: Decision[]): void {
    const saved = this.#exits.get(pid);
    const steps = this.#d.session.policy.exits.ladder.steps;
    const last = steps.length - 1;
    const owner = this.#owners.get(id);
    const used = exitAttemptsOf(ctx.book.intents, pid);
    // Escalation never goes down: one rung above the highest tried, and never below the position's attempt count; a new
    // owner's first attempt goes at its own start rung (core attemptRung, which the app's close fee also reads).
    const lastRung = saved?.tracker.lastRung ?? null;
    const rung = attemptRung(lastRung, used, last, owner === undefined ? null : { startRung: owner.startRung, signed });
    const height = this.#height;
    const q = height === null ? 'no slot height yet' : this.#sellQuote(ctx, mint, quantity, rung);
    if (typeof q === 'string' && !q.startsWith(NO_QUOTE)) {
      // No slot yet (a restart's reconcile runs before the feeds start) or no fresh market state (unknown, malformed, no
      // fee terms, or stale) is timing, not a refusal: the owner waits for the first fresh market, said once and kept
      // visible (EXIT-1d; the no-slot case is also TEST-3's, #83). Booked blocked, it would wait out the blocked-retry
      // time and go as a single last-rung retry. Blocked stays for a market that refuses the sale.
      if (!this.#waitingMarket.has(id)) {
        this.#waitingMarket.set(id, pid);
        out.push({ action: null, reasons: ['exit waiting for a fresh market', mint, q] });
      }
      this.#setWaiting(pid, ctx.now.receivedAt);
      return;
    }
    // Sent or booked blocked below: the wait, of this owner or of the due exit it carries (EXIT-1c), is over.
    this.#waitingMarket.delete(id);
    this.#setWaiting(pid, null);
    if (typeof q === 'string' || height === null) {
      out.push({ action: { type: 'exit_blocked', positionId: pid, reason: String(q) }, reasons: ['exit blocked', mint, String(q)] });
      return;
    }
    // Read again: the wait was just cleared on this same saved exit.
    const now = this.#exits.get(pid);
    if (now !== undefined) this.#exits.set(pid, { ...now, tracker: noteAttempt(now.tracker, rung) });
    const attempt = this.#attempt(id, signed + 1, q, height);
    if (signed === 0) {
      out.push({ action: { type: 'intent', intentId: id, event: { type: 'prepare', quote: q } }, reasons: ['prepare exit', mint, `rung ${rung}`] });
      out.push({ action: { type: 'intent', intentId: id, event: { type: 'sign', attempt } }, reasons: ['sign exit (paper)', mint] });
    } else {
      out.push({ action: { type: 'intent', intentId: id, event: { type: 'sign_replacement', attempt, blockHeight: height } }, reasons: [`exit attempt ${signed + 1}`, mint, `rung ${rung}`] });
    }
    out.push({ action: { type: 'intent', intentId: id, event: { type: 'submit' } }, reasons: ['submit exit (paper)', mint] });
  }

  /** An exit owner whose attempt resolved without a fill: the next rung while its budget lasts, else blocked. */
  #replaceExit(i: IntentState, quantity: bigint, ctx: StrategyContext, out: Decision[]): void {
    if (i.intent.purpose !== 'exit') return;
    const pid = i.intent.positionId;
    const used = exitAttemptsOf(ctx.book.intents, pid);
    const owner = this.#owners.get(i.intent.id);
    // After a restart the owner's own budget is gone; the position's ladder (from the book) still bounds it.
    const spent = owner === undefined ? used >= this.#d.session.policy.exits.ladder.maxAttempts : i.attempts.length >= owner.maxAttempts;
    if (spent) {
      out.push({ action: { type: 'exit_blocked', positionId: pid, reason: `exit attempts used: ${i.attempts.length} on this exit, ${used} on the position` }, reasons: ['exit blocked', i.intent.mint, 'attempts used'] });
      return;
    }
    this.#sendExit(i.intent.id, pid, i.intent.mint, quantity, i.attempts.length, ctx, out);
  }

  /** Every open position: one EXIT-1 step per call, as book events. Exits are never blocked by risk (evaluateExit). */
  #manage(ctx: StrategyContext, out: Decision[]): void {
    for (const p of Object.values(ctx.book.positions)) {
      if (p.status === 'closed') {
        if (this.#exits.delete(p.id)) this.#forget(p.mint);
        this.#displayQuotes.delete(p.id);
        this.#spot.delete(p.id);
        this.#bars.delete(p.id);
        this.#unjudgedDeployer.delete(p.id);
        continue;
      }
      if (p.status === 'opening') continue;
      if (!this.#restoreSeen) {
        if (!this.#saidRestoreWait) {
          this.#saidRestoreWait = true;
          out.push({ action: null, reasons: ['positions wait for the restore', `${Object.values(ctx.book.positions).filter((x) => x.status !== 'closed' && x.status !== 'opening').length} open`] });
        }
        return;
      }
      let saved = this.#exits.get(p.id) ?? this.#planFromFill(p.id, p.entryIntentId, ctx, out);
      if (saved === null) continue;
      const exitIntents = Object.values(ctx.book.intents).filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === p.id);
      if (saved.plan.universe === undefined) {
        // A plan saved before universes were stored: its universe from the entry's intent key, never a default.
        const entry = ctx.book.intents[p.entryIntentId];
        const u = entry === undefined ? null : universeOfKey(entry.intent.key);
        // None on record: unknown is never guessed. The position is flattened like one whose universe the policy lacks.
        saved = { ...saved, plan: { ...saved.plan, universe: u ?? NO_UNIVERSE } };
        this.#exits.set(p.id, saved);
        out.push({ action: null, reasons: ['plan universe restored', p.id, u === null ? 'no universe on record; flattened through the global exit ladder' : u] });
      }
      if (!this.#fromBook.has(p.id)) {
        // Once per position per process (after a restart): partials come from the book, not the saved file. Each exit
        // owner that sold is one partial; the last of them is the owner whose further fills stay the same partial.
        this.#fromBook.add(p.id);
        const sold = exitIntents.filter((i) => i.fills.length > 0).map((i) => Number(String(i.intent.key).split(':').at(-1))).filter((n) => Number.isSafeInteger(n));
        const partialSeq = sold.length === 0 ? null : Math.max(...sold);
        const t = saved.tracker;
        if (t.partials !== sold.length || t.lastSold !== p.sold || t.partialSeq !== partialSeq) {
          saved = { ...saved, tracker: { ...t, partials: sold.length, partialSeq, lastSold: p.sold } };
          this.#exits.set(p.id, saved);
          out.push({ action: null, reasons: ['partials from the book', p.id, `${sold.length} partials, ${p.sold} sold (saved: ${t.partials}, ${t.lastSold})`] });
        }
        // Blocked-exit retries the ledger never booked (a kill after the plans were saved, before the desk booked the
        // step) are not spent: the count follows the book, and a lost retry, already due when it was decided, is due at
        // once (EXIT-KEEP N1).
        const ids = saved.retryIds;
        if (ids !== undefined && ids.length > 0) {
          const booked = ids.filter((id) => ctx.book.intents[id] !== undefined);
          if (booked.length < ids.length) {
            const tr = saved.tracker;
            const lost = ids.length - booked.length;
            saved = { ...saved, retryIds: booked, tracker: { ...tr, blockedRetries: Math.max(0, tr.blockedRetries - lost), blockedAtMs: 0 } };
            this.#exits.set(p.id, saved);
            out.push({ action: null, reasons: ['blocked retry not booked', p.id, `${lost} retry not in the ledger; due again at once`] });
          }
        }
      }
      const recoveryWhy = saved.recovery ?? null;
      if (recoveryWhy !== null && p.status === 'open' && saved.tracker.pendingFull === null && exitIntents.every(isTerminal)) {
        // Sell-only recovery lasts until the position closes (EXIT-1g review B1): the recovery exit was taken (which
        // clears the remembered full exit) and ended without selling everything, here or before a restart. The position
        // is open with no exit owner, so the whole holding exits again at the next fresh quote, never held under the
        // fallback plan.
        saved = { ...saved, tracker: { ...saved.tracker, pendingFull: ['emergency'] } };
        this.#exits.set(p.id, saved);
        out.push({ action: null, reasons: ['recovery exit', p.id, recoveryWhy, 'the whole holding exits at the next fresh quote'] });
      }
      const realized = exitIntents.reduce((t, i) => t + i.fills.reduce((s, f) => s + f.sol, 0n), 0n);
      const entry = ctx.book.intents[p.entryIntentId];
      const entryFees = entry === undefined ? 0n : entry.fills.reduce((t, f) => t + f.fees, 0n);
      const exitFees = exitIntents.reduce((t, i) => t + i.fills.reduce((s, f) => s + f.fees, 0n), 0n);
      const n = this.#d.config.network;
      const holding: Holding = {
        status: p.status, quantity: p.quantity, sold: p.sold, costBasis: p.cost + entryFees + exitFees, realized,
        exitCost: n.signaturesPerTx * n.baseFeePerSignature + this.#d.session.policy.exits.ladder.steps[0]!.priorityFeeLamports + n.tip,
        exitSeq: p.exitSeq, exitAttempts: exitAttemptsOf(ctx.book.intents, p.id),
        // The engine sees only the book, so it plans a clean account. Whether a sell closes the account is settled where
        // it lands (PAPER-1): the paper world draws dust and close failures with the backtest's model (core's
        // TokenAccounts), a failed close fails that attempt and the retry sells from a sell-only account. Live, the
        // signer reads the real account (a before-live item, DECISIONS).
        tokenAccountBalance: p.quantity, closeFailed: false,
      };
      const m = this.#market(ctx, p.mint);
      if (typeof m !== 'string' && p.quantity > 0n) {
        // The display quote: the sale value of the whole holding as a price, at the market's read (not risk's mark).
        const liq = liquidationValue({ venue: 'pumpswap', pool: m.pool, ctx: m.ctx }, p.quantity);
        if (liq.ok) this.#displayQuotes.set(p.id, { price: execPrice(liq.value, p.quantity), atMs: m.atMs, slot: ctx.now.slot });
      }
      // A universe the loaded policy no longer has (a restart under a policy that dropped it): its own time stops and
      // partials are unknown, so the position is flattened at once through the global exit ladder (supervisor ruling).
      // Exits are never blocked: no throw, no missing decision.
      const inPolicy = Object.hasOwn(this.#d.session.policy.exits.universes, saved.plan.universe);
      // A position whose exit inputs did not come back is in EXIT-1g recovery instead (set at the restore).
      const known = inPolicy;
      if (!inPolicy && !this.#flattening.has(p.id)) {
        this.#flattening.add(p.id);
        out.push({ action: null, reasons: ['universe missing', p.id, `${String(saved.plan.universe)} is not in policy ${this.#d.session.versionHash}; flattened through the global exit ladder`] });
      }
      const step = decideExit(known ? this.#settings : this.#flatten(saved.plan.universe), saved.plan, holding, saved.tracker, {
        nowMs: ctx.now.receivedAt, slotClose: true,
        market: typeof m === 'string' ? null : { atMs: m.atMs, value: { venue: 'pumpswap', pool: m.pool, ctx: m.ctx } },
        deployerSoldBps: this.#deployerSold(p.id, p.mint, saved.plan.openedAtMs, ctx, out), sellRoute: null, flow: this.#flowOf(p.mint, ctx.now.receivedAt), bars: this.#bars.get(p.id) ?? saved.bars,
      });
      // A due full exit with no quote yet is held, remembered in the tracker (EXIT-1c): said once, and kept visible as
      // pending (and as an alert once it has waited the blocked-retry time) until the first fresh quote takes it.
      // Only an open position's wait is decided here; an exit owner's wait (EXIT-1d) is #sendExit's.
      const waiting = p.status === 'open' && step.tracker.pendingFull !== null;
      if (waiting && saved.waitingSinceMs == null) out.push({ action: null, reasons: ['exit waiting for a fresh quote', p.mint, step.tracker.pendingFull!.join(', ')] });
      // A position being exited keeps its wait only while one of its exit owners can still be waiting for a market (not
      // yet sent, or resolved without a fill); booked blocked, run out of budget, cancelled or settled, the wait is over.
      // Read from the book on every step, so a restart (which forgets which owners were said to wait) agrees.
      const ownerMayWait = exitIntents.some((i) => !isTerminal(i) && (i.status === 'exposure_reserved' || (i.status === 'reconciled' && i.fills.length === 0)));
      const waitingSinceMs = p.status !== 'open' ? (ownerMayWait ? (saved.waitingSinceMs ?? null) : null) : waiting ? (saved.waitingSinceMs ?? ctx.now.receivedAt) : null;
      saved = { ...saved, tracker: step.tracker, bars: this.#bars.get(p.id) ?? saved.bars, waitingSinceMs };
      this.#exits.set(p.id, saved);
      for (const why of step.ignored) out.push({ action: null, reasons: ['exit input ignored', p.mint, why] });
      this.#exitDecision(p.id, p.mint, p.exitSeq, step.decision, ctx, out, known ? [] : ['universe missing: flatten']);
    }
  }

  /**
   * Exit settings for a universe the policy lacks: the global ladder and limits, with that universe's block set to
   * flatten (time stops at 0, so the whole position goes at once; no partial or trail is ever taken).
   */
  #flatten(universe: string): ExitSettings {
    const s = this.#settings;
    const base = Object.values(s.exits.universes)[0]!;
    const flat = { ...base, tFlatMs: 0, tMaxMs: 0, partialAtRBps: Number.MAX_SAFE_INTEGER, partialAtGainBps: Number.MAX_SAFE_INTEGER };
    return { ...s, exits: { ...s.exits, universes: { ...s.exits.universes, [universe]: flat } } };
  }

  #exitDecision(pid: PositionId, mint: string, exitSeq: number, d: ExitDecision, ctx: StrategyContext, out: Decision[], note: readonly string[] = []): void {
    if (d.kind === 'hold') return;
    // A merge that adds no new reason to the exit owner changes nothing: not logged, not stored.
    const owner = ctx.book.positions[pid]?.exitOwner;
    if (d.kind === 'merge' && owner != null && d.reasons.every((x) => owner.reasons.includes(x))) return;
    const risk = this.#account(ctx);
    const why = [...note, ...d.fired.map((t) => `${t.code}: ${t.detail}`)];
    if (risk !== null) {
      // Exits are never blocked; tripped controls are logged and latched.
      const sol = this.#spotSol(ctx);
      const account = this.#marked(risk.history, ctx, sol, { fallback: true });
      const r = evaluateExit({ session: this.#d.session, mode: 'paper', clock: { now: () => ctx.now }, account, latches: risk.latches, market: { solPrice: sol, solBalance: this.#balance(risk, ctx), regime: 'unknown' } });
      // RISK-LATCH: only a fully marked account at a fresh SOL price latches; a fallback or unmarked one is still logged.
      if (latchable(account, sol, ctx.now.receivedAt, this.#d.session.policy.gates.maxQuoteAgeMs)) for (const t of r.trips) why.push(`${TRIP_PREFIX}${t}`);
      const own = account.openPositions.find((o) => o.mint === mint);
      if (own !== undefined) why.push(`${MARK_PREFIX}${own.mark ?? 'unknown'}`);
      if (r.tripped.length > 0) why.push(`${TRIPPED_PREFIX}${[...new Set(r.tripped.map((x) => x.code))].sort().join(',')}`);
      if (r.fault !== null) why.push(`${RISK_FAULT_PREFIX}${r.fault}`);
    }
    const id = intentId(`x${pid.slice(1)}:${exitSeq + 1}`);
    const events = exitBookEvents(pid, d, id);
    const label = d.kind === 'merge' ? 'exit reasons merged' : d.kind === 'exit' && d.retry ? 'retry blocked exit' : d.kind === 'exit' && d.partial ? 'partial exit' : 'exit';
    for (const ev of events) out.push({ action: ev, reasons: [label, mint, ...(why.length > 0 ? why : ['no trigger detail'])] });
    // A new owner that is not booked blocked goes out in the same step, at the rung EXIT-1 chose.
    if (d.kind === 'exit' && d.retry) {
      const saved = this.#exits.get(pid);
      if (saved !== undefined) this.#exits.set(pid, { ...saved, retryIds: [...(saved.retryIds ?? []), id] });
    }
    if (d.kind === 'exit' && events.length === 1) {
      this.#owners.set(id, { startRung: d.startRung, maxAttempts: d.maxAttempts });
      this.#sendExit(id, pid, mint, d.quantity, 0, ctx, out);
    }
  }

  /** The entry plan of a position that just filled, from its decision seed and the fill. */
  #planFromFill(pid: PositionId, entryId: IntentId, ctx: StrategyContext, out: Decision[]): SavedExit | null {
    const seed = this.#seeds.get(entryId);
    // A seed saved by an earlier process (EXIT-1h) rebuilds the plan, but its fill was not seen here: dated like a fill
    // without one (the booked moment, else the slot), never at this process's clock.
    const seen = seed !== undefined && !this.#restoredSeeds.has(entryId);
    const entry = ctx.book.intents[entryId];
    const p = ctx.book.positions[pid]!;
    // The open time: the fill's moment when this process saw it (it holds the decision seed); else the moment the ledger
    // booked it (exact, from the restore fact); else, with neither, the fill dated from its slot with an upper bound on
    // the slot time. A restart never restarts T_flat or T_max (EXIT-1f). Until the first slot is seen the slot dating
    // cannot be made, and nothing could be sent either: the plan waits for it.
    // A fill booked during a boot's reconcile may have landed earlier (found by a status read after downtime): it opens
    // at the earlier of its booking and its slot dating. A live booking is the fill's own moment and stays exact; one the
    // journal could not place stays exact too, and says why (EXIT-1f N2).
    const fill = entry?.fills[0];
    const booked = this.#bookedOpenAt.get(pid);
    const when = this.#bookedWhen.get(pid);
    let fillAt = ctx.now.receivedAt;
    if (!seen && booked !== undefined && !(when === 'reconcile' && fill !== undefined)) {
      fillAt = Math.min(booked, ctx.now.receivedAt);
      if (when !== undefined && when.startsWith('unplaced')) out.push({ action: null, reasons: ['open time from the booking', p.mint, when] });
    } else if (!seen && fill !== undefined) {
      if (this.#height === null) {
        if (!this.#planWaitsForSlot.has(pid)) {
          this.#planWaitsForSlot.add(pid);
          out.push({ action: null, reasons: ['entry plan waits for the first slot', p.mint, 'the fill is dated from its slot'] });
        }
        return null;
      }
      const slots = this.#height > fill.slot ? this.#height - fill.slot : 0n;
      fillAt = Math.min(ctx.now.receivedAt - Number(slots) * this.#d.config.maxSlotMs, booked ?? Number.POSITIVE_INFINITY);
    }
    // A position without its own plan (no decision seed in this process, and no usable saved plan) is never held under a
    // substituted plan: its stop, trail, peak and flat target cannot be recovered, and a new holding period or a looser
    // stop would weaken its protection. Sell-only recovery: the whole holding exits at the next fresh executable quote,
    // on the normal ladder (EXIT-1g). The plan below only describes the position (its open time, entry price, universe).
    const recovery = seed === undefined || entry === undefined;
    let why: string | null = null;
    if (recovery) {
      why = this.#recoveryWhy.get(pid) ?? (this.#refusedSeeds.has(entryId) ? 'saved seed refused' : null) ?? (this.#restoreSeen && !this.#exits.has(pid) && this.#bookedOpenAt.has(pid) ? 'no saved plan' : 'no decision seed');
      out.push({ action: null, reasons: ['no entry plan', p.mint, 'sell-only recovery'] });
      out.push({ action: null, reasons: ['recovery exit', pid, why, 'the whole holding exits at the next fresh quote'] });
    }
    const cost = p.cost;
    // The entry price from the book: cost over the tokens bought (a partial sale since leaves the cost of the entry as is).
    const entryPx = p.bought > 0n ? (cost * PRICE_SCALE) / p.bought : 0n;
    const stopPrice = seed?.stopPrice ?? entryPx - (entryPx * BigInt(this.#d.session.policy.loss.stopMaxBps)) / BPS;
    const stopValue = (p.bought * stopPrice) / PRICE_SCALE;
    const riskUnit = cost - stopValue > 0n ? cost - stopValue : 1n;
    // The universe the entry was made under: its plan, else its intent key (`entry:<mint>:<universe>.<version>.<n>`).
    const universe = seed?.universe ?? (entry === undefined ? null : universeOfKey(entry.intent.key));
    if (universe === null) out.push({ action: null, reasons: ['no entry universe', p.mint, 'no universe on record; flattened through the global exit ladder'] });
    const plan: EntryPlan = { openedAtMs: fillAt, universe: universe ?? NO_UNIVERSE, notional: seed?.notional ?? this.#d.session.policy.capital.minNotional, riskUnit, stopPrice, entryReserve: seed?.entryReserve ?? 0n };
    const saved: SavedExit = { plan, tracker: recovery ? { ...newTracker(), pendingFull: ['emergency'] } : newTracker(), bars: this.#bars.get(p.mint) ?? [], ...(why === null ? {} : { recovery: why }) };
    this.#bars.set(pid, [...saved.bars]);
    this.#exits.set(pid, saved);
    this.#seeds.delete(entryId);
    this.#restoredSeeds.delete(entryId);
    out.push({ action: null, reasons: ['entry plan', p.mint, `stop ${stopPrice}`, `1R ${riskUnit} lamports`] });
    return saved;
  }

  /** Candidates whose read landed, with the read's slot (null for an off-chain read) and receipt: judged once more at the
   * next event, outside the evaluation cadence, while the read is still fresh (FACTS-1e). */
  #due = new Map<string, { readonly slot: bigint | null; readonly receivedAt: number }>();

  /** Whether a landed read is still fresh at `now`: chain reads by slot lag, off-chain reads by age (evidence.ts's rules). */
  #fresh(read: { readonly slot: bigint | null; readonly receivedAt: number }, now: StrategyContext['now']): boolean {
    const g = this.#d.session.policy.gates;
    return read.slot !== null ? now.slot - read.slot <= BigInt(g.maxStateSlotLag) : now.receivedAt - read.receivedAt <= g.maxQuoteAgeMs;
  }

  /**
   * A raw read (`read:<kind>:<mint>`) landing for a candidate marks it for one more evaluation, so its fact is judged
   * while fresh instead of at the next cadence tick (supervisor ruling: the read's own recorded frame is the trigger,
   * so a replay re-evaluates at the same release position). Freshness follows evidence.ts and is judged when the mark
   * is used, at the next event: a chain read more than the state lag behind, or an off-chain read (RugCheck, GoPlus,
   * Jupiter: no slot) older than the quote age, brings no evaluation (a quiet feed can outlive a read). Only
   * candidates are evaluated, so a mark for any other mint is never used.
   */
  #readLanded(e: MarketEvent): void {
    if (!e.key.startsWith('read:')) return;
    const mint = e.key.slice(e.key.indexOf(':', 'read:'.length) + 1);
    const v = unwrap(e.value);
    // Judged fresh when the mark is used (`#landedFresh`): at the read's own moment it cannot be older than that.
    this.#due.set(mint, { slot: isObj(v) && typeof v['slot'] === 'bigint' ? v['slot'] : null, receivedAt: e.moment.receivedAt });
  }

  /** Mints whose read batch is on the feed but not closed yet: never judged on part of a batch. */
  readonly #batchOpen = new Set<string>();

  /**
   * READ-COHERENT: a coherent batch of reads (FactReaders.readBatch) is put on the feed between `RAW.batchOpen` and
   * `RAW.batchClose`, and at one moment the open is released before its members and the close after them and after
   * every fact they made. While open the candidate is not evaluated (`#entries`), so no decision is made on part of a
   * batch; the close is the batch's landing, judged at its own event (not the next one, which may be
   * a slot later), with the batch's oldest slot-judged member as its age. Recorded frames, so a replay does the same.
   */
  #batchLanded(e: MarketEvent): { readonly mint: string; readonly read: { readonly slot: bigint | null; readonly receivedAt: number } } | null {
    const open = RAW.batchOpen('');
    const close = RAW.batchClose('');
    if (e.key.startsWith(open)) {
      this.#batchOpen.add(e.key.slice(open.length));
      return null;
    }
    if (!e.key.startsWith(close)) return null;
    const mint = e.key.slice(close.length);
    this.#batchOpen.delete(mint);
    const v = unwrap(e.value);
    return { mint, read: { slot: isObj(v) && typeof v['slot'] === 'bigint' ? v['slot'] : null, receivedAt: e.moment.receivedAt } };
  }

  /** A read landed for the mint and is still fresh now: a slower event after it (a quiet feed) can outlive it. */
  #landedFresh(due: ReadonlyMap<string, { readonly slot: bigint | null; readonly receivedAt: number }>, mint: string, ctx: StrategyContext): boolean {
    const read = due.get(mint);
    return read !== undefined && this.#fresh(read, ctx.now);
  }

  /**
   * Candidates whose window has ended leave, on every event: also while entries are halted (a feed down, a pause,
   * seeding, sell-only, a divergence), so a rejected candidate's tail starts at its window end and never late (REC-1
   * review). Evaluated and rejected: its pool stays watched until windowEnd + tMax, or is logged `no tail` at the cap.
   */
  #windowEnds(now: number, out: Decision[]): void {
    const c = this.#d.config;
    for (const cand of [...this.#cands.values()]) if (now >= cand.migratedAtMs + c.windowToMs) this.#endWindow(cand, out);
  }

  /** A candidate's window has ended: it leaves, with its tail when it was evaluated and rejected (`#windowEnds`). */
  #endWindow(cand: { readonly mint: string; readonly migratedAtMs: number; readonly lastReason: string | null }, out: Decision[]): void {
    const c = this.#d.config;
    const to = cand.migratedAtMs + c.windowToMs;
    const pool = this.#poolOfMint.get(cand.mint);
    if (cand.lastReason !== null && pool !== undefined) {
      // At the cap the pool is not watched: logged, so G3 censors that coin with the reason, never imputes it.
      if (this.#tail.size >= c.maxTails) out.push({ action: null, reasons: [NO_TAIL, c.universe, cand.mint, `tail cap ${c.maxTails}`] });
      else this.#tail.set(cand.mint, { pool, untilMs: to + exitsFor(this.#d.session.policy.exits, c.universe).tMaxMs });
    }
    this.#cands.delete(cand.mint);
    this.#bars.delete(cand.mint);
    this.#forget(cand.mint);
    out.push({ action: null, reasons: ['no entry', c.universe, cand.mint, cand.lastReason === null ? 'window ended' : `window ended; last reason: ${cand.lastReason}`] });
  }

  #entries(ctx: StrategyContext, gctx: GateContext, out: Decision[], due: ReadonlyMap<string, { readonly slot: bigint | null; readonly receivedAt: number }>): void {
    const now = ctx.now.receivedAt;
    const c = this.#d.config;
    // Fails closed: entries only on a readable halt fact that says not halted.
    const halt = ctx.lookup(HALT_KEY);
    const h = halt.ok ? unwrap(halt.value) : null;
    if (!isObj(h) || h['halted'] !== false) return;
    // The halt that ends SEEDING may be released just before the seed itself: no entry until the index has it.
    if (this.#waiting !== null) return;
    for (const cand of this.#cands.values()) {
      const from = cand.migratedAtMs + c.windowFromMs;
      const to = cand.migratedAtMs + c.windowToMs;
      // Backstop: `#windowEnds` has already removed it on this event; an ended window is never an entry whatever the order.
      if (now >= to) continue;
      if (this.#batchOpen.has(cand.mint)) continue;
      if (now < from || (cand.lastEvalMs !== null && now - cand.lastEvalMs < c.evaluateEveryMs && !this.#landedFresh(due, cand.mint, ctx))) continue;
      if (c.entryTiming === 'random' && now < this.#entryAt(cand, from, to)) continue;
      if (Object.values(ctx.book.positions).some((p) => p.mint === cand.mint && p.status !== 'closed')) continue;
      if (Object.values(ctx.book.intents).some((i) => i.intent.mint === cand.mint && !isTerminal(i))) continue;
      cand.lastEvalMs = now;
      const created = ctx.lookup(createKey(cand.mint));
      const cf = created.ok ? parseCreate(created.value) : null;
      if (cf !== null) cand.creator = cf.creator;
      const r = this.#evaluate(cand, ctx, gctx, out);
      cand.gates = r === null ? [] : this.#lastNeeds;
      // A reject is logged when its reason changes (numbers aside), so a long wait does not fill the journal.
      // The S0 diagnostic parts relied on count too: the same reason with a different set is a new line.
      const key = (x: string | null) => (x === null ? null : x.replace(/\d+/g, '#'));
      const waived = this.#waived.join(',');
      // A line that carries a trip is always written: risk reports a trip only while it is not latched, so it is never
      // swallowed as "the same reason" (after an owner's re-arm the same reject must latch again) and never repeats once latched.
      if (r !== null && (key(r) !== key(cand.lastReason) || waived !== cand.lastWaived || this.#lastTrips.length > 0)) out.push({ action: null, reasons: ['reject', c.universe, cand.mint, r, `${GATE_REASONS_PREFIX}${JSON.stringify(this.#lastGates)}`, ...this.#lastTrips, ...this.#diagnostic()] });
      if (r !== null) {
        cand.lastReason = r;
        cand.lastWaived = waived;
      }
      if (out.some((d) => d.action !== null)) return;
    }
  }

  /**
   * ENTRY-MEMO: the candidate's S0 entry moment, drawn once. It was drawn for every waiting candidate on every
   * event: after a restart restored 400+ candidates, that hashing took over half the worker's CPU and the backlog filled
   * the heap (the profile of a restored boot). The same salt, mint and window give the same moment, so replays agree.
   */
  #entryAt(cand: Candidate, from: number, to: number): number {
    cand.entryAt ??= s0EntryAt(this.#d.config.entrySalt, cand.mint, from, to);
    return cand.entryAt;
  }

  /** The S0 diagnostic parts the last `#evaluate` relied on. */
  #waived: S0DiagnosticPart[] = [];

  #diagnostic(): string[] {
    return this.#waived.length === 0 ? [] : [`${S0_DIAGNOSTIC_PREFIX}${this.#waived.join(',')}`];
  }

  /** The typed reasons of the last reject `#evaluate` returned (RUN-1c's `gate_reasons`). */
  #lastGates: readonly GateReasonLine[] = [];

  /**
   * ENTRY-TRIPS: the `trip X` reasons risk found on the last refused entry (a weekly loss or NAV kill reached while flat),
   * each its own reason on the reject line, so the worker latches it (worker.ts reads elements that start `trip `).
   */
  #lastTrips: readonly string[] = [];

  /** The same reasons with their inputs, for the candidate (not journaled: gate_reasons keeps its shape). */
  #lastNeeds: readonly CandidateReason[] = [];

  #fail(text: string, gates: readonly GateReasonLine[], needs: readonly CandidateReason[] = gates): string {
    this.#lastGates = gates;
    this.#lastNeeds = needs.map((x) => ({
      gate: x.gate, code: x.code, ...(x.input === undefined ? {} : { input: x.input }), ...(x.neededBy === undefined ? {} : { neededBy: x.neededBy }),
      ...(x.detail === undefined ? {} : { detail: x.detail }),
    }));
    return text;
  }

  /** One candidate through regime, hard rejects and risk. Returns the reject reason, or null when it proposed an entry. */
  #evaluate(cand: Candidate, ctx: StrategyContext, gctx: GateContext, out: Decision[]): string | null {
    this.#lastTrips = [];
    const c = this.#d.config;
    const session = this.#d.session;
    const policy = session.policy;
    const diag = c.s0Diagnostic === true ? { s0Diagnostic: true } as const : {};
    // OOM-MINT: a coin that migrated more than `createKeepMs` after its create is refused before anything is judged,
    // from the facts as the backtest does; when its create's facts were let go, from the expired mark.
    const kept = createKeepVerdict(gctx, cand.mint, c.createKeepMs);
    if (kept?.expired === true) return this.#fail('create expired', [{ gate: 'worker', code: 'create-expired', detail: kept.detail }]);
    if (kept === null && this.createExpired(cand.mint)) return this.#fail('create expired', [{ gate: 'worker', code: 'create-expired', detail: `its create was let go ${(c.createKeepMs + CREATE_LATE_MS) / 3_600_000} h after it with no migration seen` }]);
    const regime = evaluateRegime(gctx, { session, mode: 'live', ...diag });
    this.#waived = [...regime.waived];
    // Served: while the set is on, every part it configures, whatever this candidate reached (API-1 N1'), so the card
    // never reads a plain "On" while any part (H14's creates coverage) is waived; set order, then anything else waived.
    const served = c.s0Diagnostic === true ? [...S0_DIAGNOSTIC_PARTS, ...regime.waived.filter((w) => !S0_DIAGNOSTIC_PARTS.includes(w))] : [...regime.waived];
    this.#regime = { atMs: gctx.now.receivedAt, on: regime.on, reasons: regime.reasons.map((x) => ({ code: x.code, input: x.input ?? null })), waived: served };
    if (!regime.on) return this.#fail(`regime off: ${regime.reasons.map((x) => x.detail).join('; ') || 'no reason given'}`, regime.reasons.map((x) => ({ gate: 'regime', code: x.code, detail: x.detail })), regime.reasons.map((x) => ({ gate: 'regime', ...x })));
    const sol = this.#spotSol(ctx);
    if (sol === null) return this.#fail('live SOL price unknown', [{ gate: 'worker', code: 'no-sol-price', detail: 'no live SOL/USD price' }]);
    const m = this.#market(ctx, cand.mint, { carry: false });
    if (typeof m === 'string') return this.#fail(m, [{ gate: 'worker', code: marketMissCode(m), detail: m }]);
    const quoter = pumpSwapRoundTrip(m.pool, m.ctx);
    // AUDIT-RM4 F3: the gates and H15's simulation judge the size risk will use. At q_min unless the owner approved the
    // step-up and no drawdown returns it to the minimum; then the size risk settles on, found before the gates run.
    const minSpend = microUsdToLamports(policy.capital.minNotional, sol.value, 'ceil');
    const probed = this.#riskSize(cand, ctx, sol, m, quoter, minSpend);
    const sized = this.#d.sizeProbe === undefined ? probed : this.#d.sizeProbe(probed);
    const notional = sized.notional;
    const spend = sized.spend;
    cand.spend = spend;
    const { hard, notEvaluated } = stagedHardRejects(gctx, { session, mode: 'live', rugLabeller: 'RUG-1', ...diag }, { mint: cand.mint, universe: c.universe, notional, spend, roundTrip: quoter(spend) });
    // The S0 diagnostic set's H14 note, from whichever stages ran (WORKER-1e).
    if (hard.notes.some((n) => n.code === 's0-diagnostic')) {
      this.#waived.push('h14-creates-coverage');
    }
    if (!hardAllowsEntry(hard)) {
      // Fails closed: a pass that left a gate out (groups that stop covering every hard gate) is no entry.
      if (hard.reasons.length === 0) return this.#fail('hard rejects incomplete', [{ gate: 'worker', code: 'hard-incomplete', detail: 'not every hard gate was evaluated' }]);
      const later = notEvaluated.length > 0 ? `; ${NOT_EVALUATED}${notEvaluated.join(',')}` : '';
      return this.#fail(`hard reject ${hard.failed.join(',')}: ${hard.reasons.map((x) => `${x.gate} ${x.code} ${x.detail}`).join('; ')}${later}`, hard.reasons.map((x) => ({ gate: x.gate, code: x.code, detail: x.detail })), hard.reasons);
    }
    const acct = this.#account(ctx);
    if (acct === null) return this.#fail('account snapshot unknown', [{ gate: 'worker', code: 'no-account', detail: 'account snapshot unknown' }]);
    const st = this.#stopAt(cand, ctx, quoter, spend);
    if (!st.ok) return this.#fail(st.text, [st.line]);
    const { stopPrice, stopBps } = st;
    // Numbered from the book (restored at start), so a restart never reuses an intent id or key.
    // Past every entry intent the book holds for the mint and every try saved before a restart (RESTART-KEEP): ids never repeat.
    cand.tries = 1 + Math.max(cand.tries, Object.values(ctx.book.intents).filter((i) => i.intent.purpose === 'entry' && i.intent.mint === cand.mint).length);
    const id = intentId(`en:${cand.mint}:${cand.tries}`);
    const rid = reservationId(`r:${cand.mint}:${cand.tries}`);
    const reserveLiq = effectiveQuoteReserve(m.pool);
    // A failure while marking refuses this candidate (fail closed); it never stops the worker.
    let account: AccountHistory;
    try {
      account = this.#marked(acct.history, ctx, sol, { fallback: false });
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'error';
      return this.#fail(`risk mark failed: ${detail}`, [{ gate: 'worker', code: 'risk-mark-failed', detail }]);
    }
    // RISK-FAULT: risk that cannot evaluate refuses the entry (fail-closed), logged, and the step goes on.
    let r: ReturnType<typeof evaluateEntry>;
    try {
      r = this.#entryRisk(cand, ctx, sol, m, quoter, acct, account, stopBps, id, rid);
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'error';
      return this.#fail(`risk fault: ${detail}`, [{ gate: 'R1', code: 'risk_fault', detail }]);
    }
    // RISK-LATCH: an entry latches R9/R10 only from a fully marked account at a fresh SOL price; an unknown or stale mark
    // counts as a total loss, which refuses the entry but proves no breach. The refusal still names every trip it saw.
    const seen = r.trips.map((t) => `${TRIP_PREFIX}${t}`);
    const trips = latchable(account, sol, ctx.now.receivedAt, policy.gates.maxQuoteAgeMs) ? seen : [];
    if (!r.allow) {
      this.#lastTrips = trips;
      return this.#fail(`risk ${r.reasons.map((x) => `${x.control} ${x.code}: ${x.detail}`).join(', ')}${seen.length > 0 ? `; ${seen.join(', ')}` : ''}`, r.reasons.map((x) => ({ gate: x.control, code: x.code, detail: x.detail })));
    }
    if (r.spendLamports !== spend) {
      return this.#fail(`risk sized ${r.spendLamports} lamports, gates judged ${spend}`, [{ gate: 'worker', code: 'size-mismatch', detail: `risk sized ${r.spendLamports}, gates judged ${spend}` }]);
    }
    const pid = positionId(`p:${cand.mint}:${cand.tries}`);
    const tm = toMint(cand.mint);
    this.#seeds.set(id, { mint: cand.mint, universe: c.universe, notional: r.notional, stopPrice, entryReserve: reserveLiq });
    const q = r.reservation;
    const request = { reservationId: q.reservationId, intentId: q.intentId, amount: String(q.amount), maxHeld: String(q.limits.maxHeld), maxCount: q.limits.maxCount, accountVersion: String(q.accountVersion) };
    const base = [c.universe, cand.mint];
    out.push({ action: { type: 'propose_entry', intent: { id, key: entryKey(tm, `${c.universe}.${c.version}.${cand.tries}`), purpose: 'entry', side: 'buy', mint: tm, venue: 'pumpswap', positionId: pid, spend: spend as Lamports } }, reasons: ['enter', ...base, `notional ${r.notional}`, `stop ${stopBps} bps`, ...this.#diagnostic()] });
    out.push({ action: { type: 'intent', intentId: id, event: { type: 'mark_eligible' } }, reasons: ['gates passed', ...base, `H1-H16 pass (${hard.passed.length} gates)`, ...this.#diagnostic()] });
    out.push({ action: { type: 'intent', intentId: id, event: { type: 'approve_risk' } }, reasons: ['risk approved', ...base, `${RESERVE_PREFIX}${JSON.stringify(request)}`, ...trips, ...this.#diagnostic()] });
    return null;
  }

  /**
   * The stop for an entry of `spend`: the tighter of the ATR limit and the policy's maximum distance, from the
   * executable price after the buy (the planned exit's proceeds per token at that size).
   */
  #stopAt(cand: Candidate, ctx: StrategyContext, quoter: RoundTripQuoter, spend: bigint):
    { readonly ok: true; readonly stopPrice: bigint; readonly stopBps: number } | { readonly ok: false; readonly text: string; readonly line: GateReasonLine } {
    const policy = this.#d.session.policy;
    const rt = quoter(spend);
    if (!rt.ok) return { ok: false, text: `no round trip: ${rt.reason}`, line: { gate: 'worker', code: 'no-round-trip', detail: rt.reason } };
    const entryPx = execPrice(rt.trade.proceeds, rt.trade.tokens);
    const ux = exitsFor(policy.exits, this.#d.config.universe);
    const range = atr(this.#bars.get(cand.mint) ?? [], ux.atrPeriod, ux.atrBarMs, ctx.now.receivedAt);
    if (range === null) return { ok: false, text: 'stop: not enough price bars for the ATR', line: { gate: 'stop', code: 'no-atr', detail: 'not enough price bars for the ATR' } };
    const byAtr = (BigInt(ux.stopAtrTenths) * range) / 10n;
    const byMax = (entryPx * BigInt(policy.loss.stopMaxBps)) / BPS;
    const distance = byAtr < byMax ? byAtr : byMax;
    const stopPrice = entryPx - distance;
    const stop = checkStopDistance(policy, this.#d.config.universe, entryPx, stopPrice, range);
    if (!stop.ok) return { ok: false, text: `stop: ${stop.reason} ${stop.detail}`, line: { gate: 'stop', code: stop.reason, detail: stop.detail } };
    return { ok: true, stopPrice, stopBps: Number(mulDiv(distance, BPS, entryPx, 'ceil')) };
  }

  /** Risk's entry decision for this candidate at `stopBps` (R1–R15, sizing included): pure, nothing latches from it here. */
  #entryRisk(cand: Candidate, ctx: StrategyContext, sol: Timed<MicroUsd>, m: Market, quoter: RoundTripQuoter, acct: AccountFact, account: AccountHistory, stopBps: number, id: IntentId, rid: ReturnType<typeof reservationId>): ReturnType<typeof evaluateEntry> {
    const c = this.#d.config;
    return evaluateEntry(
      { session: this.#d.session, mode: 'paper', clock: { now: () => ctx.now }, account, latches: acct.latches, market: { solPrice: sol, solBalance: this.#balance(acct, ctx), regime: 'on' } },
      {
        intentId: id, reservationId: rid, mint: toMint(cand.mint), universe: c.universe, stopBps, edgePpm: c.edgePpm, medianTargetBps: c.medianTargetBps,
        quote: quoter, quoteAtMs: m.atMs, poolLiquidity: lamportsToMicroUsd((effectiveQuoteReserve(m.pool) * 2n) as Lamports, sol.value, 'floor'), network: c.network, rent: { ...c.rent, oneTime: acct.oneTimeRent },
      },
    );
  }

  /**
   * AUDIT-RM4 F3: the size the gates and the simulation judge, the one risk will use. Risk sizes at q_min unless the
   * owner approved the step-up (and no drawdown returns it to the minimum); then above it, by its caps. The stop
   * depends on the size (the executable price after the buy) and risk's caps on the stop, so the size is settled by
   * asking risk again at the stop of the size it chose, up to three times; a size that does not settle, or anything
   * risk cannot judge yet (no account, no stop, a refusal), leaves q_min, and the decision after the gates still
   * refuses any size risk did not settle on (`size-mismatch`). This probe never decides or latches anything.
   */
  #riskSize(cand: Candidate, ctx: StrategyContext, sol: Timed<MicroUsd>, m: Market, quoter: RoundTripQuoter, minSpend: Lamports): { readonly spend: Lamports; readonly notional: MicroUsd } {
    const atMin = { spend: minSpend, notional: this.#d.session.policy.capital.minNotional };
    const acct = this.#account(ctx);
    if (acct === null || !acct.latches.sizeStepUpApproved) return atMin;
    let account: AccountHistory;
    try {
      account = this.#marked(acct.history, ctx, sol, { fallback: false });
    } catch {
      return atMin;
    }
    const probe = { id: intentId(`size:${cand.mint}`), rid: reservationId(`size:${cand.mint}`) };
    let spend: bigint = minSpend;
    for (let k = 0; k < 3; k++) {
      const st = this.#stopAt(cand, ctx, quoter, spend);
      if (!st.ok) return atMin;
      let r: ReturnType<typeof evaluateEntry>;
      try {
        r = this.#entryRisk(cand, ctx, sol, m, quoter, acct, account, st.stopBps, probe.id, probe.rid);
      } catch {
        return atMin;
      }
      if (!r.allow) return atMin;
      if (r.spendLamports === spend) return spend === minSpend ? atMin : { spend: r.spendLamports as Lamports, notional: r.notional };
      spend = r.spendLamports;
    }
    return atMin;
  }

  /** The account risk judges: each open position at its executable mark now, or null when it cannot be (marks.ts). */
  #marked(h: AccountHistory, ctx: StrategyContext, sol: Timed<MicroUsd> | null, o: { readonly fallback: boolean }): AccountHistory {
    return riskAccount(h, (mint) => {
      const p = Object.values(ctx.book.positions).find((x) => x.mint === mint && x.status !== 'closed');
      if (p === undefined) return undefined;
      const m = this.#market(ctx, mint);
      return { quantity: p.quantity, market: typeof m === 'string' ? null : m };
    }, sol, ctx.now.receivedAt, markSettings(this.#d.session.policy, this.#d.config.network), { ...o, ...(this.#d.markedHistory === undefined ? {} : { mark: this.#d.markedHistory }) });
  }
}

/** Reads the reservation request of an `approve_risk` decision (see RESERVE_PREFIX). */
export const reservationOf = (reasons: readonly string[]): { reservationId: string; intentId: string; amount: bigint; maxHeld: bigint; maxCount: number; accountVersion: bigint } | null => {
  const r = reasons.find((x) => x.startsWith(RESERVE_PREFIX));
  if (r === undefined) return null;
  try {
    const v = JSON.parse(r.slice(RESERVE_PREFIX.length)) as Record<string, unknown>;
    const big = (x: unknown): bigint | null => (typeof x === 'string' && /^\d+$/.test(x) ? BigInt(x) : null);
    const amount = big(v['amount']);
    const maxHeld = big(v['maxHeld']);
    const accountVersion = big(v['accountVersion']);
    if (typeof v['reservationId'] !== 'string' || typeof v['intentId'] !== 'string' || amount === null || maxHeld === null || accountVersion === null) return null;
    if (typeof v['maxCount'] !== 'number' || !Number.isSafeInteger(v['maxCount'])) return null;
    return { reservationId: v['reservationId'], intentId: v['intentId'], amount, maxHeld, maxCount: v['maxCount'], accountVersion };
  } catch {
    return null;
  }
};
