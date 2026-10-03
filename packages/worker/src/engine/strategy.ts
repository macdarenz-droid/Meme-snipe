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
import { PRICE_SCALE } from '../../../core/src/config/index.ts';
import { type NetworkPolicy, type RentInputs, pumpSwapRoundTrip } from '../../../core/src/costs/index.ts';
import {
  type IntentId, type PositionId, type QuoteContext, type TransactionAttempt,
  attemptId, blockhash, entryKey, intentId, mint as toMint, positionId, reservationId, signature,
} from '../../../core/src/domain/index.ts';
import type { Decision, MarketEvent, Strategy, StrategyContext } from '../../../core/src/engine/index.ts';
import {
  type EntryPlan, type ExitDecision, type ExitSettings, type ExitTracker, type Holding, type PriceBar,
  atr, checkStopDistance, decideExit, execPrice, exitAttemptsOf, exitBookEvents, exitSettings, newTracker, noteAttempt,
} from '../../../core/src/exits/index.ts';
import {
  type Coverage, type GateContext, DeployerIndex, RugLabeller, createsCoverage, evaluateHardRejects, evaluateRegime, migrationKey, parseMigration, parsePool, poolKey,
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
 * `{ creates, coverage, fill, rugs, asOf }`: SEED-1's seed of the deployer index (the saved state and the day or RPC
 * seed), released first; the index is seeded from it before it observes any live event.
 */
export const SEED_KEY = 'worker:seed';
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
}

/** Exit state of one position, saved after every step so a restart resumes the same stop and trail. */
export interface SavedExit {
  readonly plan: EntryPlan;
  readonly tracker: ExitTracker;
  readonly bars: readonly PriceBar[];
}

export interface RestoreFact {
  readonly exits: Readonly<Record<string, SavedExit>>;
}

/** Strategy settings that are not owner limits. The trading rules stay provisional until BT-2 registers U2's. */
export interface StrategyConfig {
  readonly version: string;
  readonly universe: 'U2';
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
}

/** What an entry needs once it fills: fixed at the decision, completed with the fill. */
interface EntrySeed {
  readonly mint: string;
  readonly notional: MicroUsd;
  readonly stopPrice: bigint;
  readonly entryReserve: bigint;
}

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
    for (const [pid, s] of this.#exits) out[pid] = { ...s, bars: this.#bars.get(pid) ?? s.bars };
    return out;
  }

  /** Mints that need live facts: candidates in their window and every position not closed. */
  watched(): Set<string> {
    const out = new Set(this.#cands.keys());
    for (const pid of this.#exits.keys()) out.add(this.#mintOf(pid));
    return out;
  }

  #coverage: Coverage | null = null;

  /** H14's creates coverage as of the last slot, coverage fact or seed released; null before any. */
  get coverage(): Coverage | null {
    return this.#coverage;
  }

  get deployers(): DeployerIndex {
    return this.#deployers;
  }

  onMarket(e: MarketEvent, ctx: StrategyContext): readonly Decision[] {
    const out: Decision[] = [];
    this.#observe(e);
    if (e.key === RESTORE_KEY) this.#restore(unwrap(e.value), out);
    if (e.key === SEED_KEY) this.#seed(e.value, out);
    if (e.key === 'chain:slot') {
      const s = unwrap(e.value);
      if (isObj(s) && typeof s['slot'] === 'bigint' && (this.#height === null || s['slot'] > this.#height)) this.#height = s['slot'];
    }
    this.#discover(e, ctx, out);
    if (e.key === SEED_KEY || e.key === 'chain:slot' || e.key.startsWith('coverage:creates:')) {
      // H14's creates coverage over its look-back as of each slot and coverage change, for health and the restart drill.
      this.#coverage = createsCoverage((k, f, t) => ctx.history(k, f, t), ctx.now, ctx.now.receivedAt - this.#d.session.policy.gates.deployerRugLookbackDays * 86_400_000);
    }
    const gctx: GateContext = { now: ctx.now, lookup: (k, a) => ctx.lookup(k, a), history: (k, f, t) => ctx.history(k, f, t), deployers: this.#deployers };
    this.#track(e, ctx);
    this.#lifecycle(ctx, out);
    this.#manage(ctx, out);
    // At most one entry step per call, and only while nothing else acted: ctx.book is the book before these decisions.
    if (!out.some((d) => d.action !== null)) this.#entries(ctx, gctx, out);
    return out;
  }

  /** Every released event feeds the deployer index and the rug labeller; labels go to the index as they are made. */
  #observe(e: MarketEvent): void {
    // The worker's own facts are not chain events: the index's start is the first chain event it sees (or the seed's).
    if (e.key.startsWith('worker:')) return;
    this.#deployers.observe(e);
    for (const label of this.#labeller.observe(e)) this.#deployers.observe(label);
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
      n++;
    }
    out.push({ action: null, reasons: ['restore', `${n} exit plans and trackers restored`] });
  }

  /** Seeds the index (SEED-1): saved and seeded creates and coverage, then the downtime fill, then saved rug labels. */
  #seed(v: unknown, out: Decision[]): void {
    if (!isObj(v) || !Array.isArray(v['creates']) || !Array.isArray(v['coverage']) || !Array.isArray(v['fill']) || !Array.isArray(v['rugs']) || !isObj(v['asOf'])) {
      out.push({ action: null, reasons: ['seed refused', 'malformed seed'] });
      return;
    }
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
      if (f !== null && !this.#cands.has(mint)) {
        this.#cands.set(mint, { mint, migratedAtMs: f.migratedAtMs, lastEvalMs: null, lastReason: null, tries: 0 });
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
    if (mint === null || this.#cands.has(mint)) return;
    // Block time of the migration when the event states it, else when it was received.
    const migratedAtMs = ts ?? ctx.now.receivedAt;
    this.#cands.set(mint, { mint, migratedAtMs, lastEvalMs: null, lastReason: null, tries: 0 });
    out.push({ action: null, reasons: [SHORTLIST, this.#d.config.universe, mint, `migrated at ${migratedAtMs}`] });
  }

  /** The pool market of a mint as of now: the gate pool fact and the fee context. */
  #market(ctx: StrategyContext, mint: string): Market | string {
    const p = ctx.lookup(poolKey(mint));
    if (!p.ok) return 'pool state unknown';
    const pool = parsePool(p.value);
    if (pool === null) return 'pool state malformed';
    const f = ctx.lookup(feesKey(mint));
    if (!f.ok) return 'fee context unknown';
    const fees = unwrap(f.value) as PoolFeeContext;
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
    for (const pid of held) add(pid);
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
    return isObj(v) && isObj(v['history']) && isObj(v['latches']) ? (v as unknown as AccountFact) : null;
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
        this.#exits.delete(p.id);
        this.#bars.delete(p.id);
        continue;
      }
      if (p.status === 'opening') continue;
      let saved = this.#exits.get(p.id) ?? this.#planFromFill(p.id, p.entryIntentId, ctx, out);
      if (saved === null) continue;
      const exitIntents = Object.values(ctx.book.intents).filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === p.id);
      const realized = exitIntents.reduce((t, i) => t + i.fills.reduce((s, f) => s + f.sol, 0n), 0n);
      const entry = ctx.book.intents[p.entryIntentId];
      const entryFees = entry === undefined ? 0n : entry.fills.reduce((t, f) => t + f.fees, 0n);
      const exitFees = exitIntents.reduce((t, i) => t + i.fills.reduce((s, f) => s + f.fees, 0n), 0n);
      const n = this.#d.config.network;
      const holding: Holding = {
        status: p.status, quantity: p.quantity, sold: p.sold, costBasis: p.cost + entryFees + exitFees, realized,
        exitCost: n.signaturesPerTx * n.baseFeePerSignature + this.#d.session.policy.exits.ladder.steps[0]!.priorityFeeLamports + n.tip,
        exitSeq: p.exitSeq, exitAttempts: exitAttemptsOf(ctx.book.intents, p.id),
      };
      const m = this.#market(ctx, p.mint);
      const step = decideExit(this.#settings, saved.plan, holding, saved.tracker, {
        nowMs: ctx.now.receivedAt, slotClose: true,
        market: typeof m === 'string' ? null : { atMs: m.atMs, value: { venue: 'pumpswap', pool: m.pool, ctx: m.ctx } },
        deployerSoldBps: null, sellRoute: null, flow: [], bars: this.#bars.get(p.id) ?? saved.bars,
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
    const plan: EntryPlan = { openedAtMs: fillAt, notional: seed?.notional ?? this.#d.session.policy.capital.minNotional, riskUnit, stopPrice, entryReserve: seed?.entryReserve ?? 0n };
    const saved: SavedExit = { plan, tracker: newTracker(), bars: this.#bars.get(p.mint) ?? [] };
    this.#bars.set(pid, [...saved.bars]);
    this.#exits.set(pid, saved);
    this.#seeds.delete(entryId);
    out.push({ action: null, reasons: ['entry plan', p.mint, `stop ${stopPrice}`, `1R ${riskUnit} lamports`] });
    return saved;
  }

  #entries(ctx: StrategyContext, gctx: GateContext, out: Decision[]): void {
    const now = ctx.now.receivedAt;
    const c = this.#d.config;
    // Fails closed: entries only on a readable halt fact that says not halted.
    const halt = ctx.lookup(HALT_KEY);
    const h = halt.ok ? unwrap(halt.value) : null;
    if (!isObj(h) || h['halted'] !== false) return;
    for (const cand of this.#cands.values()) {
      const from = cand.migratedAtMs + c.windowFromMs;
      const to = cand.migratedAtMs + c.windowToMs;
      if (now >= to) {
        this.#cands.delete(cand.mint);
        this.#bars.delete(cand.mint);
        out.push({ action: null, reasons: ['no entry', c.universe, cand.mint, cand.lastReason === null ? 'window ended' : `window ended; last reason: ${cand.lastReason}`] });
        continue;
      }
      if (now < from || (cand.lastEvalMs !== null && now - cand.lastEvalMs < c.evaluateEveryMs)) continue;
      if (Object.values(ctx.book.positions).some((p) => p.mint === cand.mint && p.status !== 'closed')) continue;
      if (Object.values(ctx.book.intents).some((i) => i.intent.mint === cand.mint && !isTerminal(i))) continue;
      cand.lastEvalMs = now;
      const r = this.#evaluate(cand, ctx, gctx, out);
      // A reject is logged when its reason changes (numbers aside), so a long wait does not fill the journal.
      const key = (x: string | null) => (x === null ? null : x.replace(/\d+/g, '#'));
      if (r !== null && key(r) !== key(cand.lastReason)) out.push({ action: null, reasons: ['reject', c.universe, cand.mint, r] });
      if (r !== null) cand.lastReason = r;
      if (out.some((d) => d.action !== null)) return;
    }
  }

  /** One candidate through regime, hard rejects and risk. Returns the reject reason, or null when it proposed an entry. */
  #evaluate(cand: Candidate, ctx: StrategyContext, gctx: GateContext, out: Decision[]): string | null {
    const c = this.#d.config;
    const session = this.#d.session;
    const policy = session.policy;
    const regime = evaluateRegime(gctx, { session, mode: 'live' });
    if (!regime.on) return `regime off: ${regime.reasons.map((x) => x.detail).join('; ') || 'no reason given'}`;
    const sol = this.#spotSol(ctx);
    if (sol === null) return 'live SOL price unknown';
    const m = this.#market(ctx, cand.mint);
    if (typeof m === 'string') return m;
    const notional = policy.capital.minNotional;
    const spend = microUsdToLamports(notional, sol.value, 'ceil');
    const quoter = pumpSwapRoundTrip(m.pool, m.ctx);
    const hard = evaluateHardRejects(gctx, { session, mode: 'live', rugLabeller: 'RUG-1' }, { mint: cand.mint, universe: c.universe, notional, spend, roundTrip: quoter(spend) });
    if (!hard.pass) return `hard reject ${hard.failed.join(',')}: ${hard.reasons.map((x) => `${x.gate} ${x.code} ${x.detail}`).join('; ')}`;
    const acct = this.#account(ctx);
    if (acct === null) return 'account snapshot unknown';
    // Stop: the tighter of the ATR limit and the policy's maximum distance, from the executable price after the buy.
    const rt = quoter(spend);
    if (!rt.ok) return `no round trip: ${rt.reason}`;
    const entryPx = execPrice(rt.trade.proceeds, rt.trade.tokens);
    const range = atr(this.#bars.get(cand.mint) ?? [], policy.exits.atrPeriod, policy.exits.atrBarMs, ctx.now.receivedAt);
    if (range === null) return 'stop: not enough price bars for the ATR';
    const byAtr = (BigInt(policy.exits.stopAtrTenths) * range) / 10n;
    const byMax = (entryPx * BigInt(policy.loss.stopMaxBps)) / BPS;
    const distance = byAtr < byMax ? byAtr : byMax;
    const stopPrice = entryPx - distance;
    const stop = checkStopDistance(policy, entryPx, stopPrice, range);
    if (!stop.ok) return `stop: ${stop.reason} ${stop.detail}`;
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
        quote: quoter, quoteAtMs: m.atMs, poolLiquidity: lamportsToMicroUsd((reserveLiq * 2n) as Lamports, sol.value, 'floor'), network: c.network, rent: c.rent,
      },
    );
    const trips = r.trips.map((t) => `${TRIP_PREFIX}${t}`);
    if (!r.allow) {
      return `risk ${r.reasons.map((x) => `${x.control} ${x.code}: ${x.detail}`).join(', ')}${trips.length > 0 ? `; ${trips.join(', ')}` : ''}`;
    }
    if (r.spendLamports !== spend) {
      return `risk sized ${r.spendLamports} lamports, gates judged ${spend}`;
    }
    const pid = positionId(`p:${cand.mint}:${cand.tries}`);
    const tm = toMint(cand.mint);
    this.#seeds.set(id, { mint: cand.mint, notional: r.notional, stopPrice, entryReserve: reserveLiq });
    const q = r.reservation;
    const request = { reservationId: q.reservationId, intentId: q.intentId, amount: String(q.amount), maxHeld: String(q.limits.maxHeld), maxCount: q.limits.maxCount, accountVersion: String(q.accountVersion) };
    const base = [c.universe, cand.mint];
    out.push({ action: { type: 'propose_entry', intent: { id, key: entryKey(tm, `${c.version}.${cand.tries}`), purpose: 'entry', side: 'buy', mint: tm, venue: 'pumpswap', positionId: pid, spend: spend as Lamports } }, reasons: ['enter', ...base, `notional ${r.notional}`, `stop ${stopBps} bps`] });
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

