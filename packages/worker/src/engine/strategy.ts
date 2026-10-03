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
import { type NetworkPolicy, type RentInputs, pumpSwapRoundTrip } from '../../../core/src/costs/index.ts';
import {
  type IntentId, type PositionId, type QuoteContext, type TransactionAttempt,
  attemptId, blockhash, entryKey, intentId, mint as toMint, positionId, reservationId, signature,
} from '../../../core/src/domain/index.ts';
import { type AsOfEntry, type Decision, type MarketEvent, type Strategy, type StrategyContext, compareMoments } from '../../../core/src/engine/index.ts';
import { observedFeeContext } from '../../../core/src/fills/index.ts';
import {
  type EntryPlan, type ExitDecision, type ExitSettings, type ExitTracker, type Holding, type PriceBar,
  atr, checkStopDistance, decideExit, execPrice, liquidationValue, exitAttemptsOf, exitBookEvents, exitSettings, newTracker, noteAttempt,
} from '../../../core/src/exits/index.ts';
import {
  type Coverage, type GateContext, DeployerIndex, LOG_CREATE_PREFIX, RugLabeller, TX_CREATE_PREFIX, createsCoverage, evaluateHardRejects, evaluateRegime, migrationKey, parseMigration, parsePool, poolKey,
} from '../../../core/src/gates/index.ts';
import { type BookEvent, type IntentState, isTerminal } from '../../../core/src/lifecycle/index.ts';
import { type AccountHistory, type Latches, type Timed, evaluateEntry, evaluateExit } from '../../../core/src/risk/index.ts';
import { type Bps, BPS_DENOMINATOR, type Lamports, type MicroUsd, bps, lamportsToMicroUsd, mulDiv, microUsdToLamports } from '../../../core/src/units/index.ts';

export const ACCOUNT_KEY = 'worker:account';
/** Key prefixes of GATE-1's pool and migration facts. */
export const POOL_PREFIX = poolKey('');
export const MIGRATION_PREFIX = migrationKey('');
export const RESTORE_KEY = 'worker:restore';
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
/** A reject's typed reasons ride in its last reason as `gate_reasons <json>`; the desk journals them as `gate_reasons`. */
export const GATE_REASONS_PREFIX = 'gate_reasons ';
export interface GateReasonLine {
  /** H1–H16, `regime`, a risk control (R1–R14), `stop`, or `worker` (an input the worker lacks). */
  readonly gate: string;
  readonly code: string;
  readonly detail: string;
  /** The fact the reason is about, when it names one (G3 tells live-only vetoes by it: core/facts/kinds.ts). */
  readonly input?: string;
}

/** A reason of a candidate's last evaluation with the fact it is about, if any (FACTS-1b reads what evidence reasons name). */
export interface CandidateReason {
  readonly gate: string;
  readonly code: string;
  readonly input?: string;
}

/** `{ halted, reasons }`: entries stop while a critical feed is down or stale (§18); exits and monitoring go on. */
export const HALT_KEY = 'worker:halt';
export const feesKey = (mint: string): string => `worker:fees:${mint}`;
/** Machine-read reason on `approve_risk`: the reservation request the worker sends to the ledger. */
export const RESERVE_PREFIX = 'reserve ';
/** Reason on a `shortlist` decision: the worker fetches the mint's confirmed create (live H9, H12–H14). */
export const SHORTLIST = 'shortlist';
export const TRIP_PREFIX = 'trip ';

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
}

export interface RestoreFact {
  readonly exits: Readonly<Record<string, SavedExit>>;
}

/** Strategy settings that are not owner limits. The trading rules stay provisional until BT-2 registers U2's. */
export interface StrategyConfig {
  readonly version: string;
  readonly universe: ExitUniverse;
  /** `random`: S0's entry moment, drawn per candidate from `entrySalt` and the mint (see `strategyConfig`). */
  readonly entryTiming: 'gates' | 'random';
  readonly entrySalt: string;
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
  readonly barMs: number;
  /** Bars kept per mint. */
  readonly keepBars: number;
  /**
   * G3's offline counterfactual only (research/counterfactual.ts), never the live worker: `backtest` leaves the
   * live-only checks (H15's simulation, H16's cross-checks, the execution-health regime input) unapplied, as BT-2 does,
   * and `only` restricts the candidates to one mint.
   */
  readonly gateMode?: 'live' | 'backtest';
  readonly only?: string;
}

export interface StrategyDeps {
  readonly session: PolicySession;
  readonly rugs: RugConfig;
  readonly config: StrategyConfig;
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
const unwrap = (v: unknown): unknown => (isObj(v) && 'value' in v && 'source' in v ? v['value'] : v);

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
}

/** What an entry needs once it fills: fixed at the decision, completed with the fill. */
interface EntrySeed {
  readonly mint: string;
  readonly universe: ExitUniverse;
  readonly notional: MicroUsd;
  readonly stopPrice: bigint;
  readonly entryReserve: bigint;
}

/**
 * S0's entry moment for a candidate: uniform in [from, to), from the first 48 bits of sha256(salt, mint). Independent
 * of arrival order, so a replay draws the same moments.
 */
export const s0EntryAt = (salt: string, mint: string, from: number, to: number): number => {
  const u = Number.parseInt(createHash('sha256').update(`s0|${salt}|${mint}`).digest('hex').slice(0, 12), 16) / 2 ** 48;
  return from + Math.floor(u * (to - from));
};

/** The universe in an entry intent key's decision id (`entry:<mint>:<universe>.<rest>`), or null for an older key. */
export const universeOfKey = (key: string): ExitUniverse | null => {
  const local = key.split(':')[2] ?? '';
  const u = local.split('.')[0] ?? '';
  return (EXIT_UNIVERSES as readonly string[]).includes(u) ? (u as ExitUniverse) : null;
};

export class LiveStrategy implements Strategy {
  readonly #d: StrategyDeps;
  readonly #settings: ExitSettings;
  readonly #deployers = new DeployerIndex();
  readonly #labeller: RugLabeller;
  readonly #cands = new Map<string, Candidate>();
  readonly #seeds = new Map<string, EntrySeed>();
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
  }

  /** Exit state to save after each step (the worker writes it before the next event). */
  saved(): Record<string, SavedExit> {
    const out: Record<string, SavedExit> = {};
    for (const [pid, s] of this.#exits) {
      out[pid] = { ...s, bars: this.#bars.get(pid) ?? s.bars, pool: this.#poolOfMint.get(this.#mintOf(pid)) ?? s.pool ?? null, spot: this.#spot.get(pid) ?? s.spot ?? null };
    }
    return out;
  }

  /** Each candidate's migration time and the typed reasons of its last evaluation (FACTS-1b stages its reads on them). */
  candidates(): ReadonlyMap<string, { readonly migratedAtMs: number; readonly lastEvalMs: number | null; readonly gates: readonly CandidateReason[] | null }> {
    return new Map([...this.#cands].map(([m, c]) => [m, { migratedAtMs: c.migratedAtMs, lastEvalMs: c.lastEvalMs, gates: c.gates }]));
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
  readonly #mintOfPool = new Map<string, string>();
  /** The fee terms of the latest released swap on each mint's pool (rates are per trade on chain). */
  readonly #observedFees = new Map<string, PoolFeeContext>();
  /** Receipt time of the latest released swap on each mint's pool: how current the sales below are. */
  readonly #tradeAt = new Map<string, number>();
  /** Sales by each mint's deployer (its creator and the create's signer), deduplicated by event id. */
  readonly #deployerSales = new Map<string, { readonly ids: Set<string>; readonly list: { readonly atMs: number; readonly amount: bigint }[] }>();
  /** Positions whose deployer-sell trigger could not be judged, reported once each. */
  readonly #unjudgedDeployer = new Set<string>();
  /** Each held position's last spot price, for the saved plan (the exposure rebuild's reference). */
  readonly #spot = new Map<string, { readonly price: bigint; readonly atMs: number }>();

  /** Each held position's latest mark (executable price, PRICE_SCALE) with when it was read. */
  readonly #marks = new Map<string, { readonly price: bigint; readonly atMs: number; readonly slot: bigint }>();

  markOf(pid: string): { readonly price: bigint; readonly atMs: number; readonly slot: bigint } | null {
    return this.#marks.get(pid) ?? null;
  }

  /** Positions whose partials were checked against the book in this process. */
  readonly #fromBook = new Set<string>();

  /** The fee terms of the latest swap seen on a mint's pool (for the paper fill when no fee-context fact exists). */
  observedFees(mint: string): PoolFeeContext | undefined {
    return this.#observedFees.get(mint);
  }

  /**
   * The pools to watch for swaps (WORKER-1 subscribes `trades:<pool>`): every candidate in its window and every open
   * position, with whether a position holds it (exit traffic).
   */
  watchedPools(): Map<string, { readonly mint: string; readonly held: boolean }> {
    const held = new Set([...this.#exits.keys()].map((pid) => this.#mintOf(pid)));
    const out = new Map<string, { mint: string; held: boolean }>();
    for (const mint of this.watched()) {
      const pool = this.#poolOfMint.get(mint);
      if (pool !== undefined) out.set(pool, { mint, held: held.has(mint) });
    }
    return out;
  }

  /** H14's creates coverage as of the last slot, coverage fact or seed released; null before any. */
  get coverage(): Coverage | null {
    return this.#coverage;
  }

  get deployers(): DeployerIndex {
    return this.#deployers;
  }

  onMarket(e: MarketEvent, ctx: StrategyContext): readonly Decision[] {
    const out: Decision[] = [];
    // FACTS-1b: reads that landed on earlier events are judged now, after the facts their own release made (FactFeed
    // releases a read's facts right after it, at its moment). A mark set below applies from the next event on.
    const due = this.#due;
    this.#due = new Map();
    if (e.key === HALT_KEY) this.#seedWait(unwrap(e.value));
    this.#observe(e);
    if (e.key === RESTORE_KEY) this.#restore(unwrap(e.value), out);
    if (e.key === SEED_KEY) this.#seed(e.value, out);
    if (e.key === 'chain:slot') {
      const s = unwrap(e.value);
      if (isObj(s) && typeof s['slot'] === 'bigint' && (this.#height === null || s['slot'] > this.#height)) this.#height = s['slot'];
    }
    this.#discover(e, ctx, out);
    this.#readLanded(e);
    this.#poolTrade(e, ctx);
    if (e.key === SEED_KEY || e.key === 'chain:slot' || e.key.startsWith('coverage:creates:')) {
      // H14's creates coverage over its look-back as of each slot and coverage change, for health and the restart drill.
      this.#coverage = createsCoverage(this.#history(ctx), ctx.now, ctx.now.receivedAt - this.#d.session.policy.gates.deployerRugLookbackDays * 86_400_000);
    }
    const gctx: GateContext = { now: ctx.now, lookup: (k, a) => ctx.lookup(k, a), history: this.#history(ctx), deployers: this.#deployers };
    this.#track(e, ctx);
    this.#lifecycle(ctx, out);
    this.#manage(ctx, out);
    // At most one entry step per call, and only while nothing else acted: ctx.book is the book before these decisions.
    if (!out.some((d) => d.action !== null)) this.#entries(ctx, gctx, out, due);
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

  #restore(v: unknown, out: Decision[]): void {
    if (!isObj(v) || !isObj(v['exits'])) {
      out.push({ action: null, reasons: ['restore refused', 'malformed restore fact'] });
      return;
    }
    let n = 0;
    for (const [pid, s] of Object.entries(v['exits'])) {
      if (!isObj(s) || !isObj(s['plan']) || !isObj(s['tracker']) || !Array.isArray(s['bars'])) continue;
      const saved = s as unknown as SavedExit;
      this.#exits.set(pid, saved);
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
    }
    for (const list of this.#seedHistory.values()) list.sort((a, b) => compareMoments(a.moment, b.moment));
    const asOf = v['asOf'] as unknown as MarketEvent['moment'];
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
      if (f !== null) this.#notePool(mint, f.pool);
      if (f !== null && !this.#cands.has(mint) && this.#takes(mint)) {
        this.#cands.set(mint, { mint, migratedAtMs: f.migratedAtMs, lastEvalMs: null, lastReason: null, tries: 0, gates: null });
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
    if (mint !== null && typeof d['pool'] === 'string') this.#notePool(mint, d['pool']);
    if (mint === null || this.#cands.has(mint) || !this.#takes(mint)) return;
    // Block time of the migration when the event states it, else when it was received.
    const migratedAtMs = ts ?? ctx.now.receivedAt;
    this.#cands.set(mint, { mint, migratedAtMs, lastEvalMs: null, lastReason: null, tries: 0, gates: null });
    out.push({ action: null, reasons: [SHORTLIST, this.#d.config.universe, mint, `migrated at ${migratedAtMs}`] });
  }

  /** Whether this strategy takes a candidate in `mint` (all, unless restricted to one by `only`). */
  #takes(mint: string): boolean {
    return this.#d.config.only === undefined || this.#d.config.only === mint;
  }

  /** Drops a mint's pool state once nothing watches it (its window ended and no position holds it). */
  #forget(mint: string): void {
    if (this.watched().has(mint)) return;
    const pool = this.#poolOfMint.get(mint);
    if (pool !== undefined) this.#mintOfPool.delete(pool);
    for (const m of [this.#poolOfMint, this.#observedFees, this.#tradeAt, this.#deployerSales]) m.delete(mint);
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
    if (mint === undefined) return;
    this.#tradeAt.set(mint, e.moment.receivedAt);
    const n = (k: string): number | null => (typeof d[k] === 'bigint' && (d[k] as bigint) >= 0n && (d[k] as bigint) <= 10_000n ? Number(d[k]) : null);
    const lp = n('lpFeeBasisPoints');
    const protocol = n('protocolFeeBasisPoints');
    const supply = typeof d['baseSupply'] === 'bigint' && d['baseSupply'] > 0n ? d['baseSupply'] : null;
    if (lp !== null && protocol !== null && supply !== null) {
      const ix = typeof d['ixName'] === 'string' && d['ixName'].endsWith('_v2') ? 'v2' : 'v1';
      this.#observedFees.set(mint, observedFeeContext(
        { split: { lp: bps(lp), protocol: bps(protocol), creator: bps(n('coinCreatorFeeBasisPoints') ?? 0) }, buybackFeeBps: bps(n('buybackFeeBasisPoints') ?? 0), instruction: ix },
        supply, { mayhemMode: false, transferFee: false, transferHook: false },
      ));
    }
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

  /** The deployer of a mint (creator and the create's signer) and its total supply, from the released create. */
  #deployerOf(mint: string, ctx: StrategyContext): { readonly sellers: readonly string[]; readonly supply: bigint | null } | null {
    for (const key of [`${TX_CREATE_PREFIX}${mint}`, `${LOG_CREATE_PREFIX}${mint}`]) {
      const r = ctx.lookup(key);
      const v = r.ok ? r.value : null;
      const d = isObj(v) && isObj(v['event']) && isObj(v['event']['data']) ? v['event']['data'] : null;
      if (d === null || typeof d['creator'] !== 'string') continue;
      const sellers = typeof d['user'] === 'string' && d['user'] !== d['creator'] ? [d['creator'], d['user']] : [d['creator']];
      return { sellers, supply: typeof d['tokenTotalSupply'] === 'bigint' && d['tokenTotalSupply'] > 0n ? d['tokenTotalSupply'] : null };
    }
    return null;
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
  #market(ctx: StrategyContext, mint: string): Market | string {
    const p = ctx.lookup(poolKey(mint));
    if (!p.ok) return 'pool state unknown';
    const pool = parsePool(p.value);
    if (pool === null) return 'pool state malformed';
    this.#notePool(mint, pool.address);
    // A fee-context fact when one is published, else the terms of the latest swap seen on the pool.
    const f = ctx.lookup(feesKey(mint));
    const fees = f.ok ? (unwrap(f.value) as PoolFeeContext) : this.#observedFees.get(mint);
    if (fees === undefined) return 'fee context unknown';
    return {
      pool: { baseReserve: pool.baseVault, quoteVault: pool.quoteVault, virtualQuoteReserves: pool.pool.virtualQuoteReserves ?? 0n },
      ctx: fees, atMs: pool.obs.receivedAt, address: pool.address,
    };
  }

  /** Price bars per mint: the spot price (effective quote per base, PRICE_SCALE) at each pool update. */
  #track(e: MarketEvent, ctx: StrategyContext): void {
    if (!e.key.startsWith(POOL_PREFIX)) return;
    const mint = e.key.slice(POOL_PREFIX.length);
    const held = [...this.#exits.keys()].filter((pid) => this.#mintOf(pid) === mint);
    if (!this.#cands.has(mint) && held.length === 0) return;
    const m = this.#market(ctx, mint);
    if (typeof m === 'string' || m.pool.baseReserve <= 0n) return;
    const price = (effectiveQuoteReserve(m.pool) * PRICE_SCALE) / m.pool.baseReserve;
    const barMs = this.#d.config.barMs;
    const start = Math.floor(ctx.now.receivedAt / barMs) * barMs;
    const add = (key: string): void => {
      const bars = this.#bars.get(key) ?? [];
      const last = bars[bars.length - 1];
      if (last !== undefined && last.startMs === start) {
        bars[bars.length - 1] = { startMs: start, high: price > last.high ? price : last.high, low: price < last.low ? price : last.low, close: price };
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
    for (const i of Object.values(ctx.book.intents)) {
      if (isTerminal(i)) continue;
      const mint = i.intent.mint;
      if (i.intent.purpose === 'entry') {
        if (i.status === 'reconciled' && i.fills.length === 0) out.push({ action: { type: 'intent', intentId: i.intent.id, event: { type: 'abandon' } }, reasons: ['entry not filled', mint] });
        else if (i.status === 'exposure_reserved') this.#sendEntry(i, ctx, out);
        continue;
      }
      if (i.status === 'exposure_reserved') this.#sendExit(i.intent.id, i.intent.positionId, mint, i.intent.quantity, 0, ctx, out);
      else if (i.status === 'reconciled' && i.fills.length === 0) this.#replaceExit(i, ctx, out);
    }
  }

  #sendEntry(i: IntentState, ctx: StrategyContext, out: Decision[]): void {
    const mint = i.intent.mint;
    const id = i.intent.id;
    const cancel = (why: string) => out.push({ action: { type: 'intent', intentId: id, event: { type: 'cancel' } }, reasons: ['entry cancelled', mint, why] });
    if (i.intent.purpose !== 'entry') return;
    if (this.#height === null) return void cancel('no slot height yet');
    const m = this.#market(ctx, mint);
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
    if (!q.ok) return `no quote: ${q.reason}`;
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
    // Escalation never goes down: one rung above the highest tried, and never below the position's attempt count.
    const lastRung = saved?.tracker.lastRung ?? null;
    const rung = Math.min(signed === 0 && owner !== undefined ? owner.startRung : Math.max(lastRung === null ? 0 : lastRung + 1, used), last);
    const height = this.#height;
    const q = height === null ? 'no slot height yet' : this.#sellQuote(ctx, mint, quantity, rung);
    if (typeof q === 'string' || height === null) {
      out.push({ action: { type: 'exit_blocked', positionId: pid, reason: String(q) }, reasons: ['exit blocked', mint, String(q)] });
      return;
    }
    if (saved !== undefined) this.#exits.set(pid, { ...saved, tracker: noteAttempt(saved.tracker, rung) });
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
  #replaceExit(i: IntentState, ctx: StrategyContext, out: Decision[]): void {
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
    this.#sendExit(i.intent.id, pid, i.intent.mint, i.intent.quantity, i.attempts.length, ctx, out);
  }

  /** Every open position: one EXIT-1 step per call, as book events. Exits are never blocked by risk (evaluateExit). */
  #manage(ctx: StrategyContext, out: Decision[]): void {
    for (const p of Object.values(ctx.book.positions)) {
      if (p.status === 'closed') {
        if (this.#exits.delete(p.id)) this.#forget(p.mint);
        this.#marks.delete(p.id);
        this.#spot.delete(p.id);
        this.#bars.delete(p.id);
        this.#unjudgedDeployer.delete(p.id);
        continue;
      }
      if (p.status === 'opening') continue;
      let saved = this.#exits.get(p.id) ?? this.#planFromFill(p.id, p.entryIntentId, ctx, out);
      if (saved === null) continue;
      const exitIntents = Object.values(ctx.book.intents).filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === p.id);
      if (saved.plan.universe === undefined) {
        // A plan saved before universes were stored: its universe from the entry's intent key, never a default.
        const entry = ctx.book.intents[p.entryIntentId];
        const u = entry === undefined ? null : universeOfKey(entry.intent.key);
        saved = { ...saved, plan: { ...saved.plan, universe: u ?? this.#d.config.universe } };
        this.#exits.set(p.id, saved);
        out.push({ action: null, reasons: ['plan universe restored', p.id, u === null ? `no universe on record; ${this.#d.config.universe}, the only universe this worker trades` : u] });
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
        // Paper: the paper wallet's token account holds exactly our tokens, and a paper sell-and-close never fails at
        // the close (no dust or outside transfer exists in the paper world).
        tokenAccountBalance: p.quantity, closeFailed: false,
      };
      const m = this.#market(ctx, p.mint);
      if (typeof m !== 'string' && p.quantity > 0n) {
        // The mark: the executable sale value of the whole holding as a price (the stop's unit), at the market's read.
        const liq = liquidationValue({ venue: 'pumpswap', pool: m.pool, ctx: m.ctx }, p.quantity);
        if (liq.ok) this.#marks.set(p.id, { price: execPrice(liq.value, p.quantity), atMs: m.atMs, slot: ctx.now.slot });
      }
      const step = decideExit(this.#settings, saved.plan, holding, saved.tracker, {
        nowMs: ctx.now.receivedAt, slotClose: true,
        market: typeof m === 'string' ? null : { atMs: m.atMs, value: { venue: 'pumpswap', pool: m.pool, ctx: m.ctx } },
        deployerSoldBps: this.#deployerSold(p.id, p.mint, saved.plan.openedAtMs, ctx, out), sellRoute: null, flow: [], bars: this.#bars.get(p.id) ?? saved.bars,
      });
      saved = { ...saved, tracker: step.tracker, bars: this.#bars.get(p.id) ?? saved.bars };
      this.#exits.set(p.id, saved);
      for (const why of step.ignored) out.push({ action: null, reasons: ['exit input ignored', p.mint, why] });
      this.#exitDecision(p.id, p.mint, p.exitSeq, step.decision, ctx, out);
    }
  }

  #exitDecision(pid: PositionId, mint: string, exitSeq: number, d: ExitDecision, ctx: StrategyContext, out: Decision[]): void {
    if (d.kind === 'hold') return;
    // A merge that adds no new reason to the exit owner changes nothing: not logged, not stored.
    const owner = ctx.book.positions[pid]?.exitOwner;
    if (d.kind === 'merge' && owner != null && d.reasons.every((x) => owner.reasons.includes(x))) return;
    const risk = this.#account(ctx);
    const why = d.fired.map((t) => `${t.code}: ${t.detail}`);
    if (risk !== null) {
      // Exits are never blocked; tripped controls are logged and latched.
      const r = evaluateExit({ session: this.#d.session, mode: 'paper', clock: { now: () => ctx.now }, account: risk.history, latches: risk.latches, market: { solPrice: this.#spotSol(ctx), solBalance: this.#balance(risk, ctx), regime: 'unknown' } });
      for (const t of r.trips) why.push(`${TRIP_PREFIX}${t}`);
    }
    const id = intentId(`x${pid.slice(1)}:${exitSeq + 1}`);
    const events = exitBookEvents(pid, d, id);
    const label = d.kind === 'merge' ? 'exit reasons merged' : d.kind === 'exit' && d.retry ? 'retry blocked exit' : d.kind === 'exit' && d.partial ? 'partial exit' : 'exit';
    for (const ev of events) out.push({ action: ev, reasons: [label, mint, ...(why.length > 0 ? why : ['no trigger detail'])] });
    // A new owner that is not booked blocked goes out in the same step, at the rung EXIT-1 chose.
    if (d.kind === 'exit' && events.length === 1) {
      this.#owners.set(id, { startRung: d.startRung, maxAttempts: d.maxAttempts });
      this.#sendExit(id, pid, mint, d.quantity, 0, ctx, out);
    }
  }

  /** The entry plan of a position that just filled, from its decision seed and the fill. */
  #planFromFill(pid: PositionId, entryId: IntentId, ctx: StrategyContext, out: Decision[]): SavedExit | null {
    const seed = this.#seeds.get(entryId);
    const entry = ctx.book.intents[entryId];
    const p = ctx.book.positions[pid]!;
    if (seed === undefined || entry === undefined) {
      // A position the strategy did not plan (none should exist): manage it with the tightest stop the policy allows.
      out.push({ action: null, reasons: ['no entry plan', p.mint, 'position managed with the policy maximum stop'] });
    }
    const fillAt = ctx.now.receivedAt;
    const cost = p.cost;
    const entryPx = p.quantity > 0n ? (cost * PRICE_SCALE) / p.quantity : 0n;
    const stopPrice = seed?.stopPrice ?? entryPx - (entryPx * BigInt(this.#d.session.policy.loss.stopMaxBps)) / BPS;
    const stopValue = (p.quantity * stopPrice) / PRICE_SCALE;
    const riskUnit = cost - stopValue > 0n ? cost - stopValue : 1n;
    // The universe the entry was made under: its plan, else its intent key (`entry:<mint>:<universe>.<version>.<n>`).
    const universe = seed?.universe ?? (entry === undefined ? null : universeOfKey(entry.intent.key));
    if (universe === null) out.push({ action: null, reasons: ['no entry universe', p.mint, `managed with ${this.#d.config.universe}'s exits, the only universe this worker trades`] });
    const plan: EntryPlan = { openedAtMs: fillAt, universe: universe ?? this.#d.config.universe, notional: seed?.notional ?? this.#d.session.policy.capital.minNotional, riskUnit, stopPrice, entryReserve: seed?.entryReserve ?? 0n };
    const saved: SavedExit = { plan, tracker: newTracker(), bars: this.#bars.get(p.mint) ?? [] };
    this.#bars.set(pid, [...saved.bars]);
    this.#exits.set(pid, saved);
    this.#seeds.delete(entryId);
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

  /** A read landed for the mint and is still fresh now: a slower event after it (a quiet feed) can outlive it. */
  #landedFresh(due: ReadonlyMap<string, { readonly slot: bigint | null; readonly receivedAt: number }>, mint: string, ctx: StrategyContext): boolean {
    const read = due.get(mint);
    return read !== undefined && this.#fresh(read, ctx.now);
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
      if (now >= to) {
        this.#cands.delete(cand.mint);
        this.#bars.delete(cand.mint);
        this.#forget(cand.mint);
        out.push({ action: null, reasons: ['no entry', c.universe, cand.mint, cand.lastReason === null ? 'window ended' : `window ended; last reason: ${cand.lastReason}`] });
        continue;
      }
      if (now < from || (cand.lastEvalMs !== null && now - cand.lastEvalMs < c.evaluateEveryMs && !this.#landedFresh(due, cand.mint, ctx))) continue;
      if (c.entryTiming === 'random' && now < s0EntryAt(c.entrySalt, cand.mint, from, to)) continue;
      if (Object.values(ctx.book.positions).some((p) => p.mint === cand.mint && p.status !== 'closed')) continue;
      if (Object.values(ctx.book.intents).some((i) => i.intent.mint === cand.mint && !isTerminal(i))) continue;
      cand.lastEvalMs = now;
      const r = this.#evaluate(cand, ctx, gctx, out);
      cand.gates = r === null ? [] : this.#lastNeeds;
      // A reject is logged when its reason changes (numbers aside), so a long wait does not fill the journal.
      const key = (x: string | null) => (x === null ? null : x.replace(/\d+/g, '#'));
      if (r !== null && key(r) !== key(cand.lastReason)) out.push({ action: null, reasons: ['reject', c.universe, cand.mint, r, `${GATE_REASONS_PREFIX}${JSON.stringify(this.#lastGates)}`] });
      if (r !== null) cand.lastReason = r;
      if (out.some((d) => d.action !== null)) return;
    }
  }

  /** The typed reasons of the last reject `#evaluate` returned (RUN-1c's `gate_reasons`). */
  #lastGates: readonly GateReasonLine[] = [];

  /** The same reasons with their inputs, for the candidate (not journaled: gate_reasons keeps its shape). */
  #lastNeeds: readonly CandidateReason[] = [];

  #fail(text: string, gates: readonly GateReasonLine[], needs: readonly CandidateReason[] = gates): string {
    this.#lastGates = gates;
    this.#lastNeeds = needs.map((x) => ({ gate: x.gate, code: x.code, ...(x.input === undefined ? {} : { input: x.input }) }));
    return text;
  }

  /** One candidate through regime, hard rejects and risk. Returns the reject reason, or null when it proposed an entry. */
  #evaluate(cand: Candidate, ctx: StrategyContext, gctx: GateContext, out: Decision[]): string | null {
    const c = this.#d.config;
    const session = this.#d.session;
    const policy = session.policy;
    const regime = evaluateRegime(gctx, { session, mode: c.gateMode ?? 'live' });
    if (!regime.on) return this.#fail(`regime off: ${regime.reasons.map((x) => x.detail).join('; ') || 'no reason given'}`, regime.reasons.map((x) => ({ gate: 'regime', code: x.code, detail: x.detail, ...(x.input === undefined ? {} : { input: x.input }) })), regime.reasons.map((x) => ({ gate: 'regime', ...x })));
    const sol = this.#spotSol(ctx);
    if (sol === null) return this.#fail('live SOL price unknown', [{ gate: 'worker', code: 'no-sol-price', detail: 'no live SOL/USD price' }]);
    const m = this.#market(ctx, cand.mint);
    if (typeof m === 'string') return this.#fail(m, [{ gate: 'worker', code: 'no-market', detail: m }]);
    const notional = policy.capital.minNotional;
    const spend = microUsdToLamports(notional, sol.value, 'ceil');
    const quoter = pumpSwapRoundTrip(m.pool, m.ctx);
    const hard = evaluateHardRejects(gctx, { session, mode: c.gateMode ?? 'live', rugLabeller: 'RUG-1' }, { mint: cand.mint, universe: c.universe, notional, spend, roundTrip: quoter(spend) });
    if (!hard.pass) return this.#fail(`hard reject ${hard.failed.join(',')}: ${hard.reasons.map((x) => `${x.gate} ${x.code} ${x.detail}`).join('; ')}`, hard.reasons.map((x) => ({ gate: x.gate, code: x.code, detail: x.detail, ...(x.input === undefined ? {} : { input: x.input }) })), hard.reasons);
    const acct = this.#account(ctx);
    if (acct === null) return this.#fail('account snapshot unknown', [{ gate: 'worker', code: 'no-account', detail: 'account snapshot unknown' }]);
    // Stop: the tighter of the ATR limit and the policy's maximum distance, from the executable price after the buy.
    const rt = quoter(spend);
    if (!rt.ok) return this.#fail(`no round trip: ${rt.reason}`, [{ gate: 'worker', code: 'no-round-trip', detail: rt.reason }]);
    const entryPx = execPrice(rt.trade.proceeds, rt.trade.tokens);
    const ux = exitsFor(policy.exits, c.universe);
    const range = atr(this.#bars.get(cand.mint) ?? [], ux.atrPeriod, ux.atrBarMs, ctx.now.receivedAt);
    if (range === null) return this.#fail('stop: not enough price bars for the ATR', [{ gate: 'stop', code: 'no-atr', detail: 'not enough price bars for the ATR' }]);
    const byAtr = (BigInt(ux.stopAtrTenths) * range) / 10n;
    const byMax = (entryPx * BigInt(policy.loss.stopMaxBps)) / BPS;
    const distance = byAtr < byMax ? byAtr : byMax;
    const stopPrice = entryPx - distance;
    const stop = checkStopDistance(policy, c.universe, entryPx, stopPrice, range);
    if (!stop.ok) return this.#fail(`stop: ${stop.reason} ${stop.detail}`, [{ gate: 'stop', code: stop.reason, detail: stop.detail }]);
    const stopBps = Number(mulDiv(distance, BPS, entryPx, 'ceil'));
    // Numbered from the book (restored at start), so a restart never reuses an intent id or key.
    cand.tries = 1 + Object.values(ctx.book.intents).filter((i) => i.intent.purpose === 'entry' && i.intent.mint === cand.mint).length;
    const id = intentId(`en:${cand.mint}:${cand.tries}`);
    const rid = reservationId(`r:${cand.mint}:${cand.tries}`);
    const reserveLiq = effectiveQuoteReserve(m.pool);
    const r = evaluateEntry(
      { session, mode: 'paper', clock: { now: () => ctx.now }, account: this.#marked(acct.history, ctx, sol), latches: acct.latches, market: { solPrice: sol, solBalance: this.#balance(acct, ctx), regime: 'on' } },
      {
        intentId: id, reservationId: rid, mint: toMint(cand.mint), universe: c.universe, stopBps, edgePpm: c.edgePpm, medianTargetBps: c.medianTargetBps,
        quote: quoter, quoteAtMs: m.atMs, poolLiquidity: lamportsToMicroUsd((reserveLiq * 2n) as Lamports, sol.value, 'floor'), network: c.network, rent: { ...c.rent, oneTime: acct.oneTimeRent },
      },
    );
    const trips = r.trips.map((t) => `${TRIP_PREFIX}${t}`);
    if (!r.allow) {
      return this.#fail(`risk ${r.reasons.map((x) => `${x.control} ${x.code}: ${x.detail}`).join(', ')}${trips.length > 0 ? `; ${trips.join(', ')}` : ''}`, r.reasons.map((x) => ({ gate: x.control, code: x.code, detail: x.detail })));
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
    out.push({ action: { type: 'propose_entry', intent: { id, key: entryKey(tm, `${c.universe}.${c.version}.${cand.tries}`), purpose: 'entry', side: 'buy', mint: tm, venue: 'pumpswap', positionId: pid, spend: spend as Lamports } }, reasons: ['enter', ...base, `notional ${r.notional}`, `stop ${stopBps} bps`] });
    out.push({ action: { type: 'intent', intentId: id, event: { type: 'mark_eligible' } }, reasons: ['gates passed', ...base, `H1-H16 pass (${hard.passed.length} gates)`] });
    out.push({ action: { type: 'intent', intentId: id, event: { type: 'approve_risk' } }, reasons: ['risk approved', ...base, `${RESERVE_PREFIX}${JSON.stringify(request)}`, ...trips] });
    return null;
  }

  /** The account with each open position's mark: its liquidation value now, or null (risk counts it as a total loss). */
  #marked(h: AccountHistory, ctx: StrategyContext, sol: Timed<MicroUsd>): AccountHistory {
    const openPositions = h.openPositions.map((o) => {
      const p = Object.values(ctx.book.positions).find((x) => x.mint === o.mint && x.status !== 'closed');
      const m = this.#market(ctx, o.mint);
      if (p === undefined || typeof m === 'string' || p.quantity <= 0n) return o;
      const q = poolSell(m.pool, p.quantity, m.ctx);
      return q.ok ? { ...o, mark: lamportsToMicroUsd(q.trade.userQuote as Lamports, sol.value, 'floor'), markAtMs: m.atMs } : o;
    });
    return { ...h, openPositions };
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

