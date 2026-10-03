// The BT-2 study strategy (docs/ARCHITECTURE.md §3.2, §7, §8, §9, §14): the same engine code as live, judged at
// each check the feed releases. A candidate is entered only when every hard reject passes (GATE-1, all gates
// evaluated so the reject mix is logged), its universe's pre-registered setup holds, the stop fits §9 and RISK-1
// sizes a trade; exits are EXIT-1's on executable liquidation value with its escalation ladder.
//
// S0 mode is the random control for each universe (§3.2): the same checks, gates, risk and exits, no setup rule.
// At a candidate's first check it draws one of the window's check slots at random (seeded) and enters at the first
// eligible check from there; the draw reads nothing but the seeded rng, so it cannot depend on outcomes.
//
// The backtest takes every eligible candidate (§14): RISK-1 judges each entry against a fresh account at the trial
// bankroll, so per-trade controls (R2, R4–R6, R12–R14) apply and portfolio controls (R7–R10, R11) do not.
import { createHash } from 'node:crypto';
import { type PoolState, effectiveQuoteReserve } from '../../../core/src/amm/index.ts';
import { encodeBase58 } from '../../../core/src/chain/index.ts';
import type { FillConfig, PolicySession } from '../../../core/src/config/index.ts';
import { PRICE_SCALE } from '../../../core/src/config/index.ts';
import { pumpSwapRoundTrip } from '../../../core/src/costs/index.ts';
import {
  attemptId, blockhash, entryKey, type IntentId, intentId, mint as toMint, positionId, type QuoteContext, reservationId, signature, type TransactionAttempt,
} from '../../../core/src/domain/index.ts';
import type { Decision, MarketEvent, Strategy, StrategyContext } from '../../../core/src/engine/index.ts';
import {
  type EntryPlan, type ExitDecision, type ExitTracker, checkStopDistance, decideExit, exitAttemptsOf, exitBookEvents, exitSettings, execPrice, liquidationValue,
  newTracker, noteAttempt, planAttempt, atr, type ExitMarket, type FlowMinute,
} from '../../../core/src/exits/index.ts';
import { observedFeeContext, type ScenarioName } from '../../../core/src/fills/index.ts';
import {
  DeployerIndex, evaluateHardRejects, type GateContext, holdersKey, parseHolders, parseSolUsd, SOL_USD_KEY, solUsdAt, TX_CREATE_PREFIX, type Universe,
  migrationKey, parseMigration, concentration, mintAccounts, type HardResult,
} from '../../../core/src/gates/index.ts';
import { canOpenNewEntry, isTerminal, type IntentState } from '../../../core/src/lifecycle/index.ts';
import { evaluateEntry, NO_LATCHES, type EntryAllowed } from '../../../core/src/risk/index.ts';
import { type Bps, BPS_DENOMINATOR, type Lamports, LAMPORTS_PER_SOL, type MicroUsd, lamportsToMicroUsd, microUsdToLamports, mulDiv } from '../../../core/src/units/index.ts';
import type { PoolView } from '../sim/market.ts';
import type { StudyConfig, U1Rules, U2Rules, UniverseConfig } from './config.ts';
import { BAR_MS, PoolTape, spotPrice } from './tape.ts';

const NORMAL = { mayhemMode: false, transferFee: false, transferHook: false } as const;
const BPS = BPS_DENOMINATOR;

export interface StudyOptions {
  readonly config: StudyConfig;
  readonly session: PolicySession;
  readonly fills: FillConfig;
  readonly scenario: ScenarioName;
  /** 'strategy': the universes' setups; 's0': the random control for each universe. */
  readonly mode: 'strategy' | 's0';
  /** Entries are planned only inside [from, to) (a walk-forward fold or the holdout, embargo applied). */
  readonly entriesFrom: number;
  readonly entriesTo: number;
}

const paperSignature = (id: string) =>
  signature(encodeBase58(new Uint8Array([...createHash('sha256').update(`sig1:${id}`).digest(), ...createHash('sha256').update(`sig2:${id}`).digest()])));
const paperBlockhash = (id: string) => blockhash(encodeBase58(createHash('sha256').update(`bh:${id}`).digest()));
const poolState = (v: PoolView): PoolState => ({ baseReserve: v.baseReserve, quoteVault: v.quoteVault, virtualQuoteReserves: v.virtualQuoteReserves });
const market = (v: PoolView): ExitMarket => ({ venue: 'pumpswap', pool: poolState(v), ctx: observedFeeContext(v.fees, v.baseSupply, NORMAL) });

/** Plans and state of one candidate in one universe. */
interface Candidate {
  readonly tag: string;
  readonly universe: 'U1' | 'U2';
  readonly mint: string;
  /** S0: the check index (1-based) from which it may enter. */
  target: number | null;
  checks: number;
  entered: boolean;
  /** The reasons of the last abstention logged: the same abstention at the next check is not logged again. */
  said: string;
}

/** An entry waiting for its fill, then the open trade with its exit state. */
interface Trade {
  readonly tag: string;
  readonly mint: string;
  readonly pool: string;
  readonly positionId: string;
  readonly notional: MicroUsd;
  readonly stopSpot: bigint;
  readonly entrySpot: bigint;
  readonly stopBps: number;
  readonly fixedCosts: bigint;
  plan: EntryPlan | null;
  tracker: ExitTracker;
  exits: number;
  /** Exit intents with what their ladder was planned from. */
  readonly ladders: Map<string, { triggerValue: bigint; startRung: number; maxAttempts: number }>;
}

export class StudyStrategy implements Strategy {
  readonly #o: StudyOptions;
  readonly #deployers = new DeployerIndex();
  readonly #tapes = new Map<string, PoolTape>();
  readonly #candidates = new Map<string, Candidate>();
  readonly #trades = new Map<string, Trade>();
  readonly #byPool = new Map<string, Set<string>>();
  readonly #live = new Set<IntentId>();
  readonly #settings;
  readonly #universes: ReadonlyMap<string, UniverseConfig>;
  readonly #poolOf = new Map<string, string>();
  #prunedAt = Number.MIN_SAFE_INTEGER;

  constructor(o: StudyOptions) {
    this.#o = o;
    const net = o.fills.network;
    this.#settings = exitSettings(o.session.policy, o.fills.scenarios[o.scenario].takeProfit === 'close' ? 'close' : 'wick', net);
    this.#universes = new Map(o.config.universes.map((u) => [u.universe, u]));
  }

  /** The deployer index the gates read (for tests). */
  get deployers(): DeployerIndex {
    return this.#deployers;
  }

  onMarket(e: MarketEvent, ctx: StrategyContext): readonly Decision[] {
    this.#deployers.observe(e);
    if (e.key === 'slot') this.#prune(ctx.now.receivedAt);
    const out: Decision[] = [];
    if (e.key.startsWith('pool:')) this.#tape(e, ctx);
    this.#lifecycle(e, ctx, out);
    if (e.key.startsWith('pool:') || e.key === 'slot') this.#exits(e, ctx, out);
    // At most one entry per call, and only while nothing else acted on the book in this call (CORE-1).
    if (e.key.startsWith('check:') && !out.some((d) => d.action !== null)) this.#check(e, ctx, out);
    return out;
  }

  /** Tapes and candidates past every check window (and not traded) are dropped once an hour: memory stays bounded. */
  #prune(now: number): void {
    if (now < this.#prunedAt + 3_600_000) return;
    this.#prunedAt = now;
    const horizon = Math.max(0, ...this.#o.config.universes.map((u) => u.window.toMs)) + 3_600_000;
    for (const [pool, t] of this.#tapes) if (now - t.startedAtMs > horizon && !this.#byPool.get(pool)?.size) this.#tapes.delete(pool);
    for (const [k, c] of this.#candidates) if (!c.entered && !this.#tapes.has(this.#poolOf.get(c.mint) ?? '')) this.#candidates.delete(k);
  }

  // ---------- tape ----------

  #tape(e: MarketEvent, ctx: StrategyContext): void {
    const v = e.value as PoolView;
    let t = this.#tapes.get(v.pool);
    if (t === undefined) {
      t = new PoolTape(e.moment.receivedAt, this.#o.config.headBars, this.#o.config.tailBars);
      this.#tapes.set(v.pool, t);
      this.#poolOf.set(v.mint, v.pool);
    }
    t.add(v, e.moment.receivedAt, this.#creator(ctx, v.mint));
  }

  /** The deployer of a mint, from its create event as released; null when the create was not seen. */
  #creator(ctx: StrategyContext, mint: string): string | null {
    const r = ctx.lookup(`${TX_CREATE_PREFIX}${mint}`);
    if (!r.ok) return null;
    const d = (r.value as { event?: { data?: { creator?: unknown } } }).event?.data;
    return typeof d?.creator === 'string' ? d.creator : null;
  }

  // ---------- entries ----------

  #check(e: MarketEvent, ctx: StrategyContext, out: Decision[]): void {
    const { mint, universe, blockHeight } = e.value as { mint: string; universe: string; blockHeight: bigint };
    const u = this.#universes.get(universe);
    if (u === undefined) return;
    const now = ctx.now.receivedAt;
    const tag = this.#o.mode === 's0' ? `S0-${u.universe}` : u.universe;
    const key = `${tag}|${mint}`;
    let c = this.#candidates.get(key);
    if (c === undefined) {
      c = { tag, universe: u.universe, mint, target: null, checks: 0, entered: false, said: '' };
      this.#candidates.set(key, c);
      if (this.#o.mode === 's0') {
        const slots = Math.max(1, Math.floor((u.window.toMs - u.window.fromMs) / u.window.everyMs));
        c.target = 1 + ctx.rng.int(slots);
      }
    }
    c.checks++;
    if (c.entered) return;
    // One log line per change: an abstention repeated at every check with the same reasons is one decision.
    const cand = c;
    const say = (...why: string[]) => {
      const k = why.map((w) => w.replace(/-?\d+/g, '#')).join('|');
      if (k === cand.said) return;
      cand.said = k;
      out.push({ action: null, reasons: [why[0]!, tag, mint, ...why.slice(1)] });
    };
    if (now < this.#o.entriesFrom || now >= this.#o.entriesTo) return;
    if (c.target !== null && c.checks < c.target) return;
    if (c.checks === 1 || c.target === c.checks) say('candidate', `check ${c.checks}`);

    const mig = parseMigration(ctx.lookup(migrationKey(mint)).ok ? (ctx.lookup(migrationKey(mint)) as { value: unknown }).value : null);
    const pool = mig?.pool ?? null;
    const pv = pool === null ? null : ctx.lookup(`pool:${pool}`);
    const view = pv !== null && pv.ok ? (pv.value as PoolView) : null;
    const sol = parseSolUsd(ctx.lookup(SOL_USD_KEY).ok ? (ctx.lookup(SOL_USD_KEY) as { value: unknown }).value : null);
    const px = sol === null ? null : solUsdAt(sol, now);
    if (view === null || pool === null) return void say('no entry', 'pool state unknown');
    if (px === null) return void say('no entry', 'SOL/USD unknown');
    const policy = this.#o.session.policy;
    const spend = microUsdToLamports(policy.capital.minNotional, px.price as MicroUsd, 'ceil');
    const quoter = pumpSwapRoundTrip(poolState(view), observedFeeContext(view.fees, view.baseSupply, NORMAL));

    // Hard rejects, every gate evaluated (calibration log): the reject mix by reason is a G3 input.
    const gctx: GateContext = { now: ctx.now, lookup: (k, a) => ctx.lookup(k, a), history: (k, f, t) => ctx.history(k, f, t), deployers: this.#deployers };
    const gates = evaluateHardRejects(gctx, { session: this.#o.session, mode: 'backtest', rugLabeller: 'RUG-1' },
      { mint, universe: (this.#o.mode === 's0' ? 'S0' : u.universe) as Universe, notional: policy.capital.minNotional, spend: spend as Lamports, roundTrip: quoter(spend) },
      { stopAtFirst: false });
    if (!gates.pass) return void say('reject', ...gateCodes(gates));

    const tape = this.#tapes.get(pool);
    if (tape === undefined || tape.last === null) return void say('no entry', 'no trades seen on the pool');
    const spot = spotPrice(view);
    if (spot === null) return void say('no entry', 'pool has an empty side');
    const setup = this.#o.mode === 's0' ? this.#s0Stop(u, tape, spot, now) : this.#setup(u, tape, spot, now, ctx, mint, mig!.price);
    if (!setup.ok) return void say('no setup', setup.why);
    const stopBps = Number(((spot - setup.stopSpot) * BPS) / spot);
    const range = atr(tape.bars(), policy.exits.atrPeriod, policy.exits.atrBarMs, now);
    const stopCheck = checkStopDistance(policy, spot, setup.stopSpot, range);
    if (!stopCheck.ok) return void say('no entry', `stop ${stopCheck.reason}: ${stopCheck.detail}`);
    if (!canOpenNewEntry(ctx.book).ok) return void say('no entry', 'book busy: another entry or an exit is in flight');

    const id = intentId(`en:${tag}:${mint}`);
    const quoteUsd = lamportsToMicroUsd(effectiveQuoteReserve(poolState(view)) as Lamports, px.price as MicroUsd, 'floor');
    const net = this.#o.fills.network;
    const network = { signaturesPerTx: net.signaturesPerTx, baseFeePerSignature: net.baseFeePerSignature, entryPriorityFee: net.entryPriorityFee, exitPriorityFee: policy.exits.ladder.steps[0]!.priorityFeeLamports, tip: net.tip, entryFailurePpm: 0n, exitFailurePpm: 0n };
    // The bot closes the token account with its full exit (§9), so sizing counts the rent as recoverable; the conservative
    // scenario still scores it as lost (BT-1 fill model), so trade P&L carries it.
    const rent = { tokenAccount: net.tokenAccountRent, tokenAccountClosedOnExit: true, oneTime: 0n, transient: 0n };
    const bankrollLamports = microUsdToLamports(policy.capital.bankroll, px.price as MicroUsd, 'floor');
    const risk = evaluateEntry({
      session: this.#o.session, mode: 'backtest', clock: { now: () => ({ receivedAt: now }) },
      account: { openingEquity: policy.capital.bankroll, openedAtMs: now - 1, flows: [], closedTrades: [], openPositions: [], entries: [], unresolvedEntries: [], heldReservations: 0n as Lamports, version: 0n },
      latches: NO_LATCHES,
      market: { solPrice: { value: px.price as MicroUsd, atMs: now }, solBalance: { value: bankrollLamports as Lamports, atMs: now }, regime: 'unknown' },
    }, {
      intentId: id, reservationId: reservationId(`r:${tag}:${mint}`), mint: toMint(mint), universe: u.universe, stopBps, edgePpm: u.edgePpm,
      medianTargetBps: u.medianTargetBps, quote: quoter, quoteAtMs: now, poolLiquidity: quoteUsd as MicroUsd, network, rent,
    });
    if (!risk.allow) return void say('risk refused', ...risk.reasons.map((r) => `${r.control}:${r.code}`));
    this.#enter(c, u, view, pool, risk, spot, setup.stopSpot, stopBps, blockHeight, out);
  }

  /** The universe's setup at the spot price now, with its structure stop. */
  #setup(u: UniverseConfig, tape: PoolTape, spot: bigint, now: number, ctx: StrategyContext, mint: string, migration: { quote: bigint; base: bigint }): { ok: true; stopSpot: bigint } | { ok: false; why: string } {
    return u.rules.kind === 'U2' ? u2Setup(u.rules, tape, spot, now, migration) : u1Setup(u.rules, tape, spot, now, ctx, mint);
  }

  /** S0's stop: the base universe's structure stop when it fits, else the widest stop the policy allows within 3 ATR. */
  #s0Stop(u: UniverseConfig, tape: PoolTape, spot: bigint, now: number): { ok: true; stopSpot: bigint } | { ok: false; why: string } {
    const r = u.rules;
    const lowMs = r.kind === 'U2' ? r.recentMs : r.stopLowMs;
    const bars = tape.between(now - lowMs, now + BAR_MS);
    if (bars.length > 0) {
      const low = bars.reduce((m, b) => (b.low < m ? b.low : m), bars[0]!.low);
      const stop = (low * (BPS - BigInt(r.stopBelowLowBps))) / BPS;
      if (stop > 0n && stop < spot) return { ok: true, stopSpot: stop };
    }
    return { ok: false, why: 'no structure below the price for a stop' };
  }

  #enter(c: Candidate, u: UniverseConfig, view: PoolView, pool: string, risk: EntryAllowed, spot: bigint, stopSpot: bigint, stopBps: number, height: bigint, out: Decision[]): void {
    const q = pumpSwapRoundTrip(poolState(view), observedFeeContext(view.fees, view.baseSupply, NORMAL))(risk.spendLamports);
    if (!q.ok) return void out.push({ action: null, reasons: ['no entry', c.tag, c.mint, `no quote at the chosen size: ${q.reason}`] });
    const spend = risk.spendLamports as Lamports;
    const tokensOut = q.trade.tokens;
    const slip = this.#o.config.entryMinOutBelowBps;
    const quote: QuoteContext = {
      provider: 'pumpswap-local', requestId: null, inAmount: spend, quotedOut: tokensOut,
      minOut: mulDiv(tokensOut, BPS - BigInt(slip), BPS, 'floor'), slippage: slip as Bps, quotedAtSlot: null,
    };
    const id = intentId(`en:${c.tag}:${c.mint}`);
    const pid = `p:${c.tag}:${c.mint}`;
    const tm = toMint(c.mint);
    const net = this.#o.fills.network;
    c.entered = true;
    this.#live.add(id);
    this.#trades.set(pid, {
      tag: c.tag, mint: c.mint, pool, positionId: pid, notional: risk.notional, stopSpot, entrySpot: spot, stopBps,
      fixedCosts: net.signaturesPerTx * net.baseFeePerSignature + net.entryPriorityFee + net.tip + net.tokenAccountRent,
      plan: null, tracker: newTracker(), exits: 0, ladders: new Map(),
    });
    this.#byPool.set(pool, (this.#byPool.get(pool) ?? new Set()).add(pid));
    const intent = { id, key: entryKey(tm, c.tag), purpose: 'entry' as const, side: 'buy' as const, mint: tm, venue: 'pumpswap' as const, positionId: positionId(pid), spend };
    const act = (event: Exclude<Decision['action'], null>, why: string, ...more: string[]) => out.push({ action: event, reasons: [why, c.tag, c.mint, ...more] });
    act({ type: 'propose_entry', intent }, 'enter', `notional ${risk.notional}`, `stop ${stopBps} bps`, `round trip ${risk.roundTripPpm} ppm`);
    act({ type: 'intent', intentId: id, event: { type: 'mark_eligible' } }, 'eligible');
    act({ type: 'intent', intentId: id, event: { type: 'approve_risk' } }, 'risk approved');
    act({ type: 'intent', intentId: id, event: { type: 'reserve_exposure', reservation: { id: reservationId(`r:${c.tag}:${c.mint}`), intentId: id, amount: risk.reservation.amount as Lamports, status: 'held' } } }, 'reserve');
    act({ type: 'intent', intentId: id, event: { type: 'prepare', quote } }, 'prepare');
    act({ type: 'intent', intentId: id, event: { type: 'sign', attempt: this.#attempt(id, 1, quote, height, net.entryPriorityFee) } }, 'sign');
    act({ type: 'intent', intentId: id, event: { type: 'submit' } }, 'submit');
  }

  #attempt(id: IntentId, n: number, quote: QuoteContext, height: bigint, fee: bigint): TransactionAttempt {
    const a = `${id}.a${n}`;
    return {
      id: attemptId(a), intentId: id, signedBytesRef: `paper:${a};fee=${fee}`, signature: paperSignature(a), blockhash: paperBlockhash(a),
      lastValidBlockHeight: height + this.#o.fills.network.blockhashValidBlocks, quote,
    };
  }

  // ---------- exits ----------

  #height(e: MarketEvent): bigint | null {
    const v = e.value as { blockHeight?: unknown } | null;
    return v !== null && typeof v === 'object' && typeof v.blockHeight === 'bigint' ? v.blockHeight : null;
  }

  #exits(e: MarketEvent, ctx: StrategyContext, out: Decision[]): void {
    const ids = e.key === 'slot' ? [...this.#trades.keys()] : [...(this.#byPool.get((e.value as PoolView).pool) ?? [])];
    const height = this.#height(e);
    if (height === null) return;
    const now = ctx.now.receivedAt;
    for (const pid of ids) {
      const t = this.#trades.get(pid)!;
      const p = ctx.book.positions[pid];
      if (p === undefined) continue;
      if (p.status === 'closed') {
        this.#trades.delete(pid);
        this.#byPool.get(t.pool)?.delete(pid);
        continue;
      }
      const pv = ctx.lookup(`pool:${t.pool}`);
      const view = pv.ok ? (pv.value as PoolView) : null;
      if (t.plan === null) {
        if (p.status !== 'open' || view === null) continue;
        // Fixed at the fill: the stop as an executable price, 1R and the reserve at entry.
        const liq = liquidationValue(market(view), p.quantity);
        if (!liq.ok) continue;
        const entryExec = execPrice(liq.value, p.quantity);
        t.plan = {
          openedAtMs: now, notional: t.notional, riskUnit: (p.cost * BigInt(t.stopBps)) / BPS + t.fixedCosts,
          stopPrice: (entryExec * t.stopSpot) / t.entrySpot, entryReserve: effectiveQuoteReserve(poolState(view)),
        };
      }
      const tape = this.#tapes.get(t.pool);
      const bars = tape?.bars() ?? [];
      const supply = view?.baseSupply ?? 0n;
      const dev = bars.filter((b) => b.startMs + BAR_MS > t.plan!.openedAtMs).reduce((s, b) => s + b.deployerSold, 0n);
      const flow: FlowMinute[] = bars.filter((b) => b.startMs >= t.plan!.openedAtMs - BAR_MS).map((b) => ({ startMs: b.startMs, net: b.netIndependent }));
      const exitFills = Object.values(ctx.book.intents).filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === pid);
      const realized = exitFills.reduce((s, i) => s + i.fills.reduce((x, f) => x + f.sol, 0n), 0n);
      const net = this.#o.fills.network;
      const step = decideExit(this.#settings, t.plan, {
        status: p.status, quantity: p.quantity, sold: p.sold, costBasis: p.cost + t.fixedCosts, realized,
        exitCost: net.signaturesPerTx * net.baseFeePerSignature + this.#o.session.policy.exits.ladder.steps[0]!.priorityFeeLamports + net.tip,
        exitSeq: p.exitSeq, exitAttempts: exitAttemptsOf(ctx.book.intents, p.id),
      }, t.tracker, {
        nowMs: now, slotClose: e.key === 'slot',
        market: view === null ? null : { atMs: pv.ok ? pv.moment.receivedAt : now, value: market(view) },
        deployerSoldBps: supply > 0n ? { atMs: now, value: Number((dev * BPS) / supply) } : null,
        sellRoute: null, flow, bars,
      });
      t.tracker = step.tracker;
      // A merge that adds no new reason to the exit owner changes nothing; it is not logged.
      const d = step.decision;
      if (d.kind === 'merge' && d.reasons.every((r) => p.exitOwner?.reasons.includes(r))) continue;
      this.#act(t, p.id, d, height, view, ctx, out);
    }
  }

  #act(t: Trade, pid: string, d: ExitDecision, height: bigint, view: PoolView | null, ctx: StrategyContext, out: Decision[]): void {
    if (d.kind === 'hold') return;
    const id = intentId(`ex:${t.tag}:${t.mint}:${++t.exits}`);
    const why = d.fired.map((f) => f.code).join(',') || d.kind;
    const events = exitBookEvents(positionId(pid), d, id);
    for (const ev of events) out.push({ action: ev, reasons: [ev.type === 'exit_blocked' ? 'exit blocked' : `exit ${why}`, t.tag, t.mint] });
    if (d.kind !== 'exit' || d.blocked !== null || !d.value.ok || view === null) return;
    const plan = planAttempt(this.#o.session.policy.exits.ladder, 1, d.value.value, d.value.value, d.startRung, d.maxAttempts, t.tracker.lastRung);
    if (!plan.ok) {
      out.push({ action: { type: 'exit_blocked', positionId: positionId(pid), reason: `${plan.reason}: ${plan.detail}` }, reasons: ['exit blocked', t.tag, t.mint, plan.reason] });
      return;
    }
    t.ladders.set(id, { triggerValue: d.value.value, startRung: d.startRung, maxAttempts: d.maxAttempts });
    t.tracker = noteAttempt(t.tracker, plan.rung);
    this.#live.add(id);
    this.#sell(id, 1, d.quantity, d.value.value, plan, height, t, out);
    void ctx;
  }

  #sell(id: IntentId, n: number, quantity: bigint, quoted: bigint, plan: { rung: number; priorityFee: bigint; minOut: bigint }, height: bigint, t: Trade, out: Decision[]): void {
    const steps = this.#o.session.policy.exits.ladder.steps;
    const quote: QuoteContext = {
      provider: 'pumpswap-local', requestId: null, inAmount: quantity, quotedOut: quoted, minOut: plan.minOut,
      slippage: steps[plan.rung]!.minOutBelowTriggerBps as Bps, quotedAtSlot: null,
    };
    const attempt = this.#attempt(id, n, quote, height, plan.priorityFee);
    if (n === 1) {
      out.push({ action: { type: 'intent', intentId: id, event: { type: 'prepare', quote } }, reasons: ['prepare exit', t.tag, t.mint, `rung ${plan.rung}`] });
      out.push({ action: { type: 'intent', intentId: id, event: { type: 'sign', attempt } }, reasons: ['sign exit', t.tag, t.mint] });
    } else {
      out.push({ action: { type: 'intent', intentId: id, event: { type: 'sign_replacement', attempt, blockHeight: height } }, reasons: [`exit attempt ${n}`, t.tag, t.mint, `rung ${plan.rung}`] });
    }
    out.push({ action: { type: 'intent', intentId: id, event: { type: 'submit' } }, reasons: ['submit exit', t.tag, t.mint] });
  }

  /** Ends unfilled entries; signs the next ladder attempt of an exit that resolved unfilled, or books it blocked. */
  #lifecycle(e: MarketEvent, ctx: StrategyContext, out: Decision[]): void {
    for (const id of this.#live) {
      const i: IntentState | undefined = ctx.book.intents[id];
      if (i === undefined || isTerminal(i)) {
        this.#live.delete(id);
        continue;
      }
      if (i.status !== 'reconciled' || i.fills.length > 0) continue;
      const mint = i.intent.mint;
      if (i.intent.purpose === 'entry') {
        out.push({ action: { type: 'intent', intentId: id, event: { type: 'abandon' } }, reasons: ['entry not filled', mint] });
        continue;
      }
      const t = this.#trades.get(i.intent.positionId);
      const height = this.#height(e);
      const ladder = t?.ladders.get(id);
      if (t === undefined || ladder === undefined || height === null) continue;
      const pv = ctx.lookup(`pool:${t.pool}`);
      const qty = i.intent.purpose === 'exit' ? i.intent.quantity : 0n;
      const fresh = pv.ok ? liquidationValue(market(pv.value as PoolView), qty) : null;
      const n = i.attempts.length + 1;
      const plan = fresh === null || !fresh.ok
        ? { ok: false as const, reason: 'no-quote', detail: fresh === null ? 'pool state unknown' : fresh.detail }
        : planAttempt(this.#o.session.policy.exits.ladder, n, ladder.triggerValue, fresh.value, ladder.startRung, ladder.maxAttempts, t.tracker.lastRung);
      if (!plan.ok) {
        out.push({ action: { type: 'exit_blocked', positionId: i.intent.positionId, reason: `${plan.reason}: ${plan.detail}` }, reasons: ['exit blocked', t.tag, mint, plan.reason] });
        continue;
      }
      t.tracker = noteAttempt(t.tracker, plan.rung);
      this.#sell(id, n, qty, (fresh as { value: bigint }).value, plan, height, t, out);
    }
  }
}

/** Failed gates with their first reason code, for the log: "H13:not-covered". */
export const gateCodes = (g: HardResult): string[] =>
  g.failed.map((gate) => {
    const r = g.reasons.find((x) => x.gate === gate || ('neededBy' in x && x.neededBy === gate));
    return `${gate}:${r?.code ?? '?'}`;
  });

const lowOf = (bars: readonly { low: bigint }[]): bigint | null => (bars.length === 0 ? null : bars.reduce((m, b) => (b.low < m ? b.low : m), bars[0]!.low));
const highOf = (bars: readonly { high: bigint }[]): bigint | null => (bars.length === 0 ? null : bars.reduce((m, b) => (b.high > m ? b.high : m), bars[0]!.high));

/** U2: flush, higher low, reclaim of the VWAP since migration, positive independent net flow (§3.2). */
export const u2Setup = (r: U2Rules, tape: PoolTape, spot: bigint, now: number, migration: { quote: bigint; base: bigint }): { ok: true; stopSpot: bigint } | { ok: false; why: string } => {
  const migSpot = (migration.quote * PRICE_SCALE) / migration.base;
  const all = tape.between(tape.startedAtMs - BAR_MS, now + BAR_MS);
  const recent = tape.between(now - r.recentMs, now + BAR_MS);
  const before = all.filter((b) => b.startMs < now - r.recentMs);
  const flush = lowOf(before);
  if (flush === null) return { ok: false, why: 'no bars before the recent window' };
  if (flush * BPS > migSpot * (BPS - BigInt(r.flushBps))) return { ok: false, why: `no flush: low ${flush} vs migration ${migSpot}` };
  const recentLow = lowOf(recent);
  if (recentLow === null) return { ok: false, why: 'no recent trades' };
  if (recentLow * BPS < flush * (BPS + BigInt(r.higherLowBps))) return { ok: false, why: `no higher low: ${recentLow} vs flush ${flush}` };
  const vwap = tape.vwap();
  if (vwap === null || spot <= vwap) return { ok: false, why: `below the VWAP since migration (${spot} vs ${vwap})` };
  const flow = recent.reduce((s, b) => s + b.netIndependent, 0n);
  if (flow <= 0n) return { ok: false, why: `independent net flow ${flow} over the recent window` };
  return { ok: true, stopSpot: (recentLow * (BPS - BigInt(r.stopBelowLowBps))) / BPS };
};

/** Wallet holders now (the gates' exclusions applied), from the holders fact. */
const walletHolders = (ctx: StrategyContext, mint: string, asOf?: Parameters<StrategyContext['lookup']>[1]): number | null => {
  const r = ctx.lookup(holdersKey(mint), asOf);
  const h = r.ok ? parseHolders(r.value) : null;
  if (h === null || h.obs.quality.length > 0) return null;
  const c = concentration(h, mintAccounts(mint, null));
  return c.classes.filter((x) => x.cls === 'wallet' || x.cls === 'unknown-program' || x.cls === 'locker').length;
};

/** U1: range breakout with volume and holder growth, on pools with a market cap of size (§3.2). */
export const u1Setup = (r: U1Rules, tape: PoolTape, spot: bigint, now: number, ctx: StrategyContext, mint: string): { ok: true; stopSpot: bigint } | { ok: false; why: string } => {
  const supply = tape.last?.view.baseSupply ?? 0n;
  const cap = (spot * supply) / PRICE_SCALE;
  if (cap < r.minMarketCapLamports) return { ok: false, why: `market cap ${cap} lamports below ${r.minMarketCapLamports}` };
  const range = tape.between(now - r.rangeMs, now - r.recentMs);
  const recent = tape.between(now - r.recentMs, now + BAR_MS);
  const top = highOf(range);
  if (top === null || range.length * BAR_MS < r.rangeMs / 2) return { ok: false, why: 'not enough range history' };
  if (spot <= top) return { ok: false, why: `no breakout: ${spot} vs range high ${top}` };
  const vol = (bs: readonly { buyQuote: bigint; sellQuote: bigint }[]) => bs.reduce((s, b) => s + b.buyQuote + b.sellQuote, 0n);
  const per = (vol(range) * BigInt(r.recentMs)) / BigInt(r.rangeMs - r.recentMs);
  if (vol(recent) * 10n < per * BigInt(r.volumeTenths)) return { ok: false, why: `volume ${vol(recent)} below ${r.volumeTenths}/10 of ${per}` };
  const nowHolders = walletHolders(ctx, mint);
  const past = ctx.history(holdersKey(mint), { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 });
  const thenEntry = Array.isArray(past) ? [...past].reverse().find((x) => x.moment.receivedAt <= now - r.rangeMs) : undefined;
  const thenHolders = thenEntry === undefined ? null : walletHolders(ctx, mint, thenEntry.moment);
  if (nowHolders === null || thenHolders === null || thenHolders === 0) return { ok: false, why: 'holder growth unknown' };
  if ((nowHolders - thenHolders) * Number(BPS) < thenHolders * r.holderGrowthBps) return { ok: false, why: `holders ${thenHolders} -> ${nowHolders}` };
  const low = lowOf(tape.between(now - r.stopLowMs, now + BAR_MS));
  if (low === null) return { ok: false, why: 'no bars for the stop' };
  return { ok: true, stopSpot: (low * (BPS - BigInt(r.stopBelowLowBps))) / BPS };
};

export { LAMPORTS_PER_SOL };
