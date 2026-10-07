// The BT-2 study strategy (docs/ARCHITECTURE.md §3.2, §7, §8, §9, §14): the same engine code as live, judged at
// each check the feed releases. A candidate is entered only when every hard reject passes (GATE-1, all gates
// evaluated so the reject mix is logged), its universe's pre-registered setup holds, the stop fits §9 and RISK-1
// sizes a trade; exits are EXIT-1's on executable liquidation value with its escalation ladder.
//
// S0 mode is the random control for each universe (§3.2): the same checks, that universe's gates, risk and exits, no
// setup rule. At a candidate's first check it draws one of the window's check slots at random (seeded) and enters at the first
// eligible check from there; the draw reads nothing but the seeded rng, so it cannot depend on outcomes.
//
// The backtest takes every eligible candidate (§14): RISK-1 judges each entry against a fresh account at the trial
// bankroll, so per-trade controls (R2, R4–R6, R12–R14) apply and portfolio controls (R7–R10, R11) do not.
import { createHash } from 'node:crypto';
import { type PoolState, effectiveQuoteReserve } from '../../../core/src/amm/index.ts';
import { encodeBase58 } from '../../../core/src/chain/index.ts';
import type { FillConfig, PolicySession } from '../../../core/src/config/index.ts';
import { exitsFor, PRICE_SCALE } from '../../../core/src/config/index.ts';
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
  CREATE_KEEP_MS, createKeepVerdict, DeployerIndex, evaluateHardRejects, evaluateRegime, type GateContext, holdersKey, parseHolders, parseSolUsd, SOL_USD_KEY, solUsdAt, TX_CREATE_PREFIX, type Universe,
  migrationKey, parseMigration, concentration, mintAccounts, poolKey, parsePool, type HardResult, type HardGate, HARD_GATES, HARD_STAGE_GROUPS, type Staged, stagedHardRejects,
} from '../../../core/src/gates/index.ts';
import { OBSERVED_TIP_KEY } from '../sim/market.ts';
import { canOpenNewEntry, isTerminal, type IntentState } from '../../../core/src/lifecycle/index.ts';
import { economicNav, evaluateEntry, NO_LATCHES, type NavMark, type AccountCost, type AccountHistory, type ClosedTrade, type EntryAllowed, type EntryRecord, type Latches, type OpenPosition, type Trip } from '../../../core/src/risk/index.ts';
import { type Bps, BPS_DENOMINATOR, type Lamports, LAMPORTS_PER_SOL, type MicroUsd, lamportsToMicroUsd, microUsdToLamports, mulDiv } from '../../../core/src/units/index.ts';
import type { PoolView } from '../sim/market.ts';
import { configTag, type FeatureRules, type StudyConfig, type U1Rules, type U2Rules, type UniverseConfig } from './config.ts';
import { featuresKey, LANDED_PREFIX } from '../sim/facts.ts';
import type { ReadLimits } from '../study/reads.ts';
import { oneTimeRent } from '../../../worker/src/run/settings.ts';
import { BAR_MS, PoolTape, spotPrice } from './tape.ts';
import { Funnel, NOT_COVERED_CODES, type Stage, type StopClass } from '../study/funnel.ts';

const NORMAL = { mayhemMode: false, transferFee: false, transferHook: false } as const;
const BPS = BPS_DENOMINATOR;

export interface StudyOptions {
  readonly config: StudyConfig;
  readonly session: PolicySession;
  readonly fills: FillConfig;
  readonly scenario: ScenarioName;
  /**
   * 'strategy': the universes' setups, each entry judged on a fresh trial account (§14 takes every candidate);
   * 's0': the random control for each universe; 'deployment': the setups at the real size against one running
   * account (positions, daily entries, cooldowns, loss triggers and the kill switch), marked at liquidation value.
   */
  /** 'deployment-s0': S0 under the deployment replay's constraints (one account, capacity, timing, costs) for the paired comparison. */
  readonly mode: 'strategy' | 's0' | 'deployment' | 'deployment-s0';
  /** Entries are planned only inside [from, to) (a walk-forward fold or the holdout, embargo applied). */
  readonly entriesFrom: number;
  readonly entriesTo: number;
  /**
   * A paper-only ablation (supervisor ruling after external review): a candidate whose only failing gates are these
   * is entered anyway, tagged `<universe>-no<gates>`, so the outcomes of what the filter blocks are scored with the
   * same size, costs, delays and exits. Never used for a decision: the filters stay on.
   */
  readonly ablate?: readonly HardGate[];
  /**
   * 'evaluate' (default): the regime gate as live. 'assume-on': a labelled diagnostic for runs whose regime inputs are
   * not produced yet (graduate survival and curve volume); every output of such a run says the regime was assumed on.
   */
  readonly regime?: 'evaluate' | 'assume-on';
  /** OOM-MINT: the most a coin's migration may follow its create (`CREATE_KEEP_MS`, as live); later, it is refused. */
  readonly createKeepMs?: number;
  /** The live read caps (READ_LIMITS). */
  readonly readLimits: ReadLimits;
}

const paperSignature = (id: string) =>
  signature(encodeBase58(new Uint8Array([...createHash('sha256').update(`sig1:${id}`).digest(), ...createHash('sha256').update(`sig2:${id}`).digest()])));
const paperBlockhash = (id: string) => blockhash(encodeBase58(createHash('sha256').update(`bh:${id}`).digest()));
const poolState = (v: PoolView): PoolState => ({ baseReserve: v.baseReserve, quoteVault: v.quoteVault, virtualQuoteReserves: v.virtualQuoteReserves });
const market = (v: PoolView): ExitMarket => ({ venue: 'pumpswap', pool: poolState(v), ctx: observedFeeContext(v.fees, v.baseSupply, NORMAL) });

/** What the deployment replay reports beyond the trades (§ deployment replay, external review). */
export interface DeploymentStats {
  readonly trips: { readonly trip: Trip; readonly atMs: number }[];
  /** Eligible setups refused by a portfolio control or a busy book, by control and code. */
  readonly rejected: Record<string, number>;
  /** Equity marked at executable liquidation value, micro-dollars, at every entry decision. */
  peakEquityUsd: bigint;
  maxDrawdownUsd: bigint;
  closed: number;
  /**
   * Closes and marks valued in dollars at a SOL/USD close older than SOL_USD_BOOKS_STALE_MS (the series stopped). They are
   * still booked (a loss is never dropped); their lamports are exact, only the dollar conversion may be off.
   */
  staleSolUsdCloses: number;
  staleSolUsdMarks: number;
}

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
  /** The universe whose exits the position uses (S0 uses the universe it controls for). */
  readonly universe: 'U1' | 'U2';
  readonly positionId: string;
  /** Risk's notional q, in lamports (SOL-BOOKS). */
  readonly notional: Lamports;
  /** q in dollars at the opening price, rounded down, for the exit size rule (as the live worker's entry seed). */
  readonly notionalUsd: MicroUsd;
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
  // Deployment replay: the one running account.
  readonly #closed: ClosedTrade[] = [];
  readonly #entries: EntryRecord[] = [];
  readonly #navMarks: NavMark[] = [];
  #setupCost: AccountCost | null = null;
  /** The setup rent in dollars at the start hour's price (the replay's dollar figures only). */
  #setupUsd = 0n;
  /** SOL-BOOKS: the SOL/USD price fixed at the walk-forward start that converts the policy's dollars once (as live). */
  #openingPx: MicroUsd | null = null;
  /** Each close's net in dollars at its own SOL/USD price (the replay's dollar figures only; risk counts lamports). */
  #realizedUsd = 0n;
  /** Candidates past stage 1 whose stage-2 and stage-3 reads have not landed yet, by tag and mint. */
  readonly #pending = new Map<string, { readonly n: number; readonly awaiting: 2 | 3 }>();
  /** Complete holder scans spent per UTC day (the live cap). */
  readonly #scans = new Map<string, number>();
  /** When each mint's reads were last asked: at most one read round per mint per `minReadGapMs`. */
  readonly #lastAsk = new Map<string, number>();
  #latches: Latches = NO_LATCHES;
  readonly #stats: DeploymentStats = { trips: [], rejected: {}, peakEquityUsd: 0n, maxDrawdownUsd: 0n, closed: 0, staleSolUsdCloses: 0, staleSolUsdMarks: 0 };
  #prunedAt = Number.MIN_SAFE_INTEGER;
  /** Every check inside the entry window, counted at the stage where it stopped (funnel first, review consensus). */
  readonly funnel = new Funnel();

  /** S0's selection and stop (research or deployment). */
  readonly #s0: boolean;
  /** One running account with its limits (strategy or S0). */
  readonly #deploy: boolean;

  constructor(o: StudyOptions) {
    this.#o = o;
    this.#s0 = o.mode === 's0' || o.mode === 'deployment-s0';
    this.#deploy = o.mode === 'deployment' || o.mode === 'deployment-s0';
    const net = o.fills.network;
    this.#settings = exitSettings(o.session.policy, o.fills.scenarios[o.scenario].takeProfit === 'close' ? 'close' : 'wick', net);
    // One configuration per universe in a run: checks come per universe (the projector's windows), so several
    // hypotheses of one universe run one at a time, each under its own tag.
    const seen = o.config.universes.map((u) => u.universe);
    if (new Set(seen).size !== seen.length) throw new RangeError(`one configuration per universe in a run (got ${o.config.universes.map(configTag).join(', ')})`);
    this.#universes = new Map(o.config.universes.map((u) => [u.universe, u]));
  }

  /** The deployment replay's figures (empty in the other modes). */
  get deployment(): DeploymentStats {
    return this.#stats;
  }

  /**
   * The running account for RISK-1, in lamports (SOL-BOOKS), marked at executable liquidation value; `wallet` is what
   * the wallet holds, the operations floor included as in opening equity, so economic NAV equals equity. The dollar
   * drawdown figures value marks at `px` and each close at its own price, as before.
   */
  #account(ctx: StrategyContext, px: MicroUsd, now: number): { history: AccountHistory; wallet: Lamports } {
    const policy = this.#o.session.policy;
    const opening = this.#openingPx ?? (0n as MicroUsd);
    const open: OpenPosition[] = [];
    let committed = 0n;
    let openUsd = 0n;
    for (const t of this.#trades.values()) {
      const p = ctx.book.positions[t.positionId];
      if (p === undefined || p.status === 'closed') continue;
      const pv = ctx.lookup(`pool:${t.pool}`);
      const liq = pv.ok && p.quantity > 0n ? liquidationValue(market(pv.value as PoolView), p.quantity) : null;
      const cost = (p.cost + t.fixedCosts) as Lamports;
      const mark = liq !== null && liq.ok ? (liq.value as Lamports) : null;
      committed += cost;
      openUsd += (mark === null ? 0n : lamportsToMicroUsd(mark, px, 'floor')) - lamportsToMicroUsd(cost, px, 'ceil');
      open.push({ mint: p.mint, openedAtMs: t.plan?.openedAtMs ?? now, notional: cost, mark, markAtMs: mark !== null ? now : null });
    }
    const unresolved = Object.values(ctx.book.intents).filter((i) => i.intent.purpose === 'entry' && !isTerminal(i)).map((i) => ({ mint: i.intent.mint }));
    const realized = this.#closed.reduce((a, c) => a + c.netPnl, 0n);
    const setupCost = this.#setupCost?.amount ?? 0n;
    const equityUsd = policy.capital.bankroll - this.#setupUsd + this.#realizedUsd + openUsd;
    if (equityUsd > this.#stats.peakEquityUsd) this.#stats.peakEquityUsd = equityUsd;
    if (this.#stats.peakEquityUsd - equityUsd > this.#stats.maxDrawdownUsd) this.#stats.maxDrawdownUsd = this.#stats.peakEquityUsd - equityUsd;
    const openingEquity = (opening > 0n ? microUsdToLamports(policy.capital.bankroll, opening, 'floor') : 0n) + policy.reserve.opsFloor;
    const wallet = (openingEquity - setupCost + realized - committed) as Lamports;
    // R10's high-water mark comes from recorded NAV observations, in the evaluator's own definition.
    const nav = economicNav(wallet, open);
    if (opening > 0n && nav !== null && nav > 0n && this.#navMarks.at(-1)?.nav !== nav) this.#navMarks.push({ atMs: now, nav });
    return {
      history: {
        openingEquity: openingEquity as Lamports, openingSolPrice: opening, openedAtMs: this.#o.entriesFrom - 1, flows: [], costs: this.#setupCost === null ? [] : [this.#setupCost],
        closedTrades: [...this.#closed], openPositions: open, entries: [...this.#entries], unresolvedEntries: unresolved, heldReservations: ctx.book.reserved,
        // Day and week start marks are reporting only in RISK-1; not recorded here.
        markedAtDayStart: null, markedAtWeekStart: null, navMarks: [...this.#navMarks],
        version: BigInt(this.#entries.length + this.#closed.length + this.#navMarks.length),
      },
      wallet,
    };
  }

  /** Latches a trip the first time it fires; the replay has no owner to re-arm, so it holds to the end. */
  #trip(trips: readonly Trip[], now: number): void {
    for (const trip of trips) {
      if (trip === 'kill_switch' && this.#latches.killTrippedAtMs === null) this.#latches = { ...this.#latches, killTrippedAtMs: now };
      else if (trip === 'weekly_loss' && this.#latches.weeklyTrippedAtMs === null) this.#latches = { ...this.#latches, weeklyTrippedAtMs: now };
      else continue;
      this.#stats.trips.push({ trip, atMs: now });
    }
  }

  /** A deployment position just closed: its net P&L in lamports, fees from its fills plus failed attempts' fees. */
  #close(ctx: StrategyContext, t: Trade, pid: string, now: number): void {
    const p = ctx.book.positions[pid]!;
    const net = this.#o.fills.network;
    const intents = Object.values(ctx.book.intents).filter((i) => i.intent.id === p.entryIntentId || (i.intent.purpose === 'exit' && i.intent.positionId === pid));
    let lamports = 0n;
    for (const i of intents) {
      for (const f of i.fills) lamports += (i.intent.purpose === 'exit' ? f.sol : -f.sol) - f.fees;
      lamports -= BigInt(Math.max(0, i.attempts.length - i.fills.length)) * net.signaturesPerTx * net.baseFeePerSignature;
    }
    // The account is closed by the final sell (fills-2): the rent paid at entry comes back with it. Booked in lamports
    // whatever the SOL/USD series holds (a loss is never dropped); only the dollar figures wait on a price.
    const pt = solUsdForBooks(ctx, now);
    if (pt !== null) {
      if (pt.stale) this.#stats.staleSolUsdCloses++;
      this.#realizedUsd += lamports < 0n ? -lamportsToMicroUsd((-lamports) as Lamports, pt.price as MicroUsd, 'ceil') : lamportsToMicroUsd(lamports as Lamports, pt.price as MicroUsd, 'floor');
    }
    const stopped = Object.values(ctx.book.intents).some((i) => i.intent.purpose === 'exit' && i.intent.positionId === pid) && (p.exitOwner?.reasons ?? []).some((r) => r === 'stop' || r === 'thesis_lost' || r === 'liquidity');
    this.#closed.push({ mint: p.mint, openedAtMs: t.plan?.openedAtMs ?? now, closedAtMs: now, notional: t.notional, netPnl: lamports as Lamports, stoppedOut: stopped });
    this.#stats.closed++;
  }

  /**
   * The wallet's setup rent, booked as live books it (WORKER-1 `wallet_setup`, the worker's own `oneTimeRent`): one
   * account cost at the walk-forward start, in lamports. That hour's SOL price is the opening price that fixes the
   * policy's dollars in SOL (SOL-BOOKS, as live at its first price). Equity starts at bankroll minus the rent, and the
   * rent counts toward day 1's loss, as live.
   */
  #walletSetup(e: MarketEvent): void {
    const sol = parseSolUsd(e.value);
    const px = sol === null ? null : solUsdAt(sol, this.#o.entriesFrom);
    if (px === null) return;
    const rent = oneTimeRent(this.#o.fills) as Lamports;
    this.#openingPx = px.price as MicroUsd;
    this.#setupCost = { atMs: this.#o.entriesFrom, amount: rent, kind: 'wallet_setup' };
    this.#setupUsd = lamportsToMicroUsd(rent, px.price as MicroUsd, 'ceil');
  }

  /** NAV observations recorded for R10 (deployment modes). */
  get navMarks(): readonly NavMark[] {
    return this.#navMarks;
  }

  /** The booked setup cost (deployment modes; null until the start hour's SOL price is known). */
  get walletSetup(): AccountCost | null {
    return this.#setupCost;
  }

  /** The deployer index the gates read (for tests). */
  get deployers(): DeployerIndex {
    return this.#deployers;
  }

  onMarket(e: MarketEvent, ctx: StrategyContext): readonly Decision[] {
    this.#deployers.observe(e);
    if (this.#deploy && this.#setupCost === null && e.key === SOL_USD_KEY) this.#walletSetup(e);
    if (e.key === 'slot') this.#prune(ctx.now.receivedAt);
    const out: Decision[] = [];
    if (e.key.startsWith('pool:')) this.#tape(e, ctx);
    this.#lifecycle(e, ctx, out);
    if (e.key.startsWith('pool:') || e.key === 'slot') this.#exits(e, ctx, out);
    // At most one entry per call, and only while nothing else acted on the book in this call (CORE-1).
    if (e.key.startsWith('check:') && !out.some((d) => d.action !== null)) this.#check(e, ctx, out);
    if (e.key.startsWith(LANDED_PREFIX) && !out.some((d) => d.action !== null)) this.#landed(e, ctx, out);
    return out;
  }

  /** Tapes and candidates past every check window (and not traded) are dropped once an hour: memory stays bounded. */
  #prune(now: number): void {
    if (now < this.#prunedAt + 3_600_000) return;
    this.#prunedAt = now;
    const horizon = Math.max(0, ...this.#o.config.universes.map((u) => u.window.toMs)) + 3_600_000;
    for (const [pool, t] of this.#tapes) if (now - t.startedAtMs > horizon && !this.#byPool.get(pool)?.size) this.#tapes.delete(pool);
    for (const [k, c] of this.#candidates) {
      if (!c.entered && !this.#tapes.has(this.#poolOf.get(c.mint) ?? '')) {
        this.#candidates.delete(k);
        this.#pending.delete(k);
        this.#lastAsk.delete(c.mint);
      }
    }
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

  /** One log line per change: an abstention repeated at every check with the same reasons is one decision. */
  #say(c: Candidate, out: Decision[]): (...why: string[]) => void {
    return (...why: string[]) => {
      const k = why.map((w) => w.replace(/-?\d+/g, '#')).join('|');
      if (k === c.said) return;
      c.said = k;
      out.push({ action: null, reasons: [why[0]!, c.tag, c.mint, ...why.slice(1)] });
    };
  }

  /**
   * The chain tip as observed now: the newest chain slot among the observations released so far (the market's
   * `tip:observed`, with an observation delay). Absent (recorded receipt times), the clock's own slot, as live.
   */
  #tip(ctx: StrategyContext): bigint | undefined {
    const r = ctx.lookup(OBSERVED_TIP_KEY);
    const slot = r.ok ? (r.value as { readonly slot?: unknown }).slot : undefined;
    return typeof slot === 'bigint' ? slot : undefined;
  }

  /**
   * The hard rejects as of now through the first `groups` stage groups (1; 1 and 2; or all three), in one call at one
   * moment (audit B2, FACTS-1f's live staged path): every stage from stage 1 is evaluated again at each step, so a pass
   * is never carried from an earlier moment. S0 runs its universe's gates (audit B1: U2's chase check, U1's liquidity
   * floor); it differs from the universe only in which check it enters at.
   */
  #gates(ctx: StrategyContext, u: UniverseConfig, mint: string, roundTrip: ReturnType<ReturnType<typeof pumpSwapRoundTrip>>, spend: bigint, groups: 1 | 2 | 3): Staged {
    const policy = this.#o.session.policy;
    const gctx: GateContext = { now: ctx.now, lookup: (k, a) => ctx.lookup(k, a), history: (k, f, t) => ctx.history(k, f, t), deployers: this.#deployers, observedTip: this.#tip(ctx) ?? ctx.now.slot };
    return stagedHardRejects(gctx, { session: this.#o.session, mode: 'backtest', rugLabeller: 'RUG-1' },
      { mint, universe: u.universe as Universe, notional: policy.capital.minNotional, spend: spend as Lamports, roundTrip }, groups, this.#o.ablate ?? []);
  }

  #check(e: MarketEvent, ctx: StrategyContext, out: Decision[]): void {
    const { mint, universe, blockHeight } = e.value as { mint: string; universe: string; blockHeight: bigint };
    const u = this.#universes.get(universe);
    if (u === undefined) return;
    const now = ctx.now.receivedAt;
    const tag = this.#s0 ? `S0-${u.universe}` : this.#o.ablate !== undefined ? `${configTag(u)}-no${this.#o.ablate.join('')}` : configTag(u);
    const key = `${tag}|${mint}`;
    let c = this.#candidates.get(key);
    if (c === undefined) {
      c = { tag, universe: u.universe, mint, target: null, checks: 0, entered: false, said: '' };
      this.#candidates.set(key, c);
      if (this.#s0) {
        const slots = Math.max(1, Math.floor((u.window.toMs - u.window.fromMs) / u.window.everyMs));
        c.target = 1 + ctx.rng.int(slots);
      }
    }
    c.checks++;
    if (c.entered) return;
    // Reads asked at an earlier check are still in flight: no second ask until they land (as live).
    if (this.#pending.has(key)) return;
    const say = this.#say(c, out);
    if (now < this.#o.entriesFrom || now >= this.#o.entriesTo) return;
    if (c.target !== null && c.checks < c.target) return;
    if (c.checks === 1 || c.target === c.checks) say('candidate', `check ${c.checks}`);
    const gctxR: GateContext = { now: ctx.now, lookup: (k, a) => ctx.lookup(k, a), history: (k, f, t) => ctx.history(k, f, t), deployers: this.#deployers, observedTip: this.#tip(ctx) ?? ctx.now.slot };
    // OOM-MINT (supervisor ruling on the BT review, B1): a coin that migrated more than CREATE_KEEP_MS after its create
    // is refused before anything is judged, from the facts, as live refuses it.
    const kept = createKeepVerdict(gctxR, mint, this.#o.createKeepMs ?? CREATE_KEEP_MS);
    if (kept?.expired === true) {
      this.funnel.record(tag, mint, 'create expired', 'adverse');
      return void say('reject', 'worker:create-expired');
    }
    // The regime gate first, as live (worker strategy: regime off rejects before any hard reject). Off is its own
    // funnel stage, never skipped: "not covered" when its inputs are unknown, adverse when its conditions fail.
    const regime = this.#o.regime === 'assume-on' ? null : evaluateRegime(gctxR, { session: this.#o.session, mode: 'backtest' });
    if (regime !== null && !regime.on) {
      const unknown = regime.reasons.length > 0 && regime.reasons.every((r) => r.code === 'unknown');
      this.funnel.record(tag, mint, 'regime off', unknown ? 'not covered' : 'adverse');
      return void say('regime off', ...regime.reasons.map((r) => `${r.code}${r.input === undefined ? '' : `:${r.input}`}`));
    }

    const mig = parseMigration(ctx.lookup(migrationKey(mint)).ok ? (ctx.lookup(migrationKey(mint)) as { value: unknown }).value : null);
    const pool = mig?.pool ?? null;
    const pv = pool === null ? null : ctx.lookup(`pool:${pool}`);
    const view = pv !== null && pv.ok ? (pv.value as PoolView) : null;
    const px = solForEntry(ctx, now);
    const stop = (stage: Stage, cls: StopClass, gates?: HardResult) => this.funnel.record(tag, mint, stage, cls, gates);
    if (view === null || pool === null) return void (stop('market data', 'not covered'), say('no entry', 'pool state unknown'));
    if (px === null || px === 'stale') return void (stop('market data', 'not covered'), say('no entry', px === null ? 'SOL/USD unknown' : 'SOL/USD stale'));
    const policy = this.#o.session.policy;
    const spend = microUsdToLamports(policy.capital.minNotional, px.price as MicroUsd, 'ceil');
    const quoter = pumpSwapRoundTrip(poolState(view), observedFeeContext(view.fees, view.baseSupply, NORMAL));

    // Stage 1 (FACTS-1 staging): the stream-derived hard rejects, every one evaluated (calibration log). Only a
    // candidate that passes asks for the reads of stages 2 and 3; their answers land later (`LANDED_PREFIX`).
    const g1 = this.#gates(ctx, u, mint, quoter(spend), spend, 1);
    if (g1.stopped) return void (this.funnel.gates(tag, mint, g1.hard), say('reject', ...gateCodes(g1.hard), `not evaluated: ${g1.notEvaluated.join(',')}`));
    // One read round per mint per minute (live cap): a check inside that gap waits for the next one.
    const last = this.#lastAsk.get(mint);
    if (last !== undefined && now - last < this.#o.readLimits.minReadGapMs) return;
    this.#lastAsk.set(mint, now);
    this.#pending.set(key, { n: (e.value as { n: number }).n, awaiting: 2 });
  }

  /**
   * The reads of stages 2 and 3 landed for a check (after the read latency, as of now): those gates, then the setup,
   * risk and entry at this moment's prices. A spent read budget leaves the candidate "not evaluated", never a pass.
   */
  #landed(e: MarketEvent, ctx: StrategyContext, out: Decision[]): void {
    const { mint, universe, n, stage, blockHeight } = e.value as { mint: string; universe: string; n: number; stage: 2 | 3; blockHeight: bigint };
    const u = this.#universes.get(universe);
    if (u === undefined) return;
    const now = ctx.now.receivedAt;
    const tag = this.#s0 ? `S0-${u.universe}` : this.#o.ablate !== undefined ? `${configTag(u)}-no${this.#o.ablate.join('')}` : configTag(u);
    const key = `${tag}|${mint}`;
    const c = this.#candidates.get(key);
    const p = this.#pending.get(key);
    if (c === undefined || p === undefined || p.n !== n || p.awaiting !== stage || c.entered) return;
    const say = this.#say(c, out);
    const stop = (st: Stage, cls: StopClass, gates?: HardResult) => this.funnel.record(tag, mint, st, cls, gates);
    if (now >= this.#o.entriesTo) return void this.#pending.delete(key);
    const mig = parseMigration(ctx.lookup(migrationKey(mint)).ok ? (ctx.lookup(migrationKey(mint)) as { value: unknown }).value : null);
    const pool = mig?.pool ?? null;
    const pv = pool === null ? null : ctx.lookup(`pool:${pool}`);
    const view = pv !== null && pv.ok ? (pv.value as PoolView) : null;
    const px = solForEntry(ctx, now);
    if (view === null || pool === null) return void (this.#pending.delete(key), stop('market data', 'not covered'), say('no entry', 'pool state unknown'));
    if (px === null || px === 'stale') return void (this.#pending.delete(key), stop('market data', 'not covered'), say('no entry', px === null ? 'SOL/USD unknown' : 'SOL/USD stale'));
    const policy = this.#o.session.policy;
    const spend = microUsdToLamports(policy.capital.minNotional, px.price as MicroUsd, 'ceil');
    const quoter = pumpSwapRoundTrip(poolState(view), observedFeeContext(view.fees, view.baseSupply, NORMAL));
    // Every stage from stage 1 again, at this moment (audit B2): stages 1-2 when the account reads land, all of them
    // when the holder scan lands. The earlier stages' answers only decided which reads to ask for.
    const staged = this.#gates(ctx, u, mint, quoter(spend), spend, stage === 2 ? 2 : 3);
    const gates = staged.hard;
    const ablated = this.#o.ablate !== undefined && !gates.pass && gates.failed.every((g) => this.#o.ablate!.includes(g));
    if (stage === 2) {
      if (staged.stopped) return void (this.#pending.delete(key), this.funnel.gates(tag, mint, gates), say('reject', ...gateCodes(gates), `not evaluated: ${staged.notEvaluated.join(',')}`));
      // The complete holder scan runs only for a candidate past stage 2, within the live daily cap (FACTS-1's
      // HOLDER_SCANS_PER_DAY); reached, H12 and H13 abstain: "not evaluated", never a pass.
      const day = new Date(now).toISOString().slice(0, 10);
      const used = this.#scans.get(day) ?? 0;
      if (used >= this.#o.readLimits.holderScansPerUtcDay) return void (this.#pending.delete(key), stop('not evaluated', 'not covered'), say('not evaluated', 'holder scan budget spent', HARD_STAGE_GROUPS[2]!.join(',')));
      this.#scans.set(day, used + 1);
      this.#pending.set(key, { n, awaiting: 3 });
      return;
    }
    this.#pending.delete(key);
    if (staged.stopped || (!gates.pass && !ablated)) return void (this.funnel.gates(tag, mint, gates), say('reject', ...gateCodes(gates), ...(staged.notEvaluated.length > 0 ? [`not evaluated: ${staged.notEvaluated.join(',')}`] : [])));
    // An entry needs a complete evaluation with no reasons (GATE-2): a gate left out is never a pass.
    if (!gates.complete) return void (stop('not evaluated', 'not covered'), say('not evaluated', `gates not evaluated: ${HARD_GATES.filter((g) => !gates.evaluated.includes(g)).join(',')}`));
    // An ablation run enters only what the filter blocks: everything else is the main run's.
    if (this.#o.ablate !== undefined && gates.pass) return;
    if (ablated) say('ablation', ...gateCodes(gates));

    const tape = this.#tapes.get(pool);
    if (tape === undefined || tape.last === null) return void (stop('market data', 'not covered'), say('no entry', 'no trades seen on the pool'));
    const spot = spotPrice(view);
    if (spot === null) return void (stop('market data', 'not covered'), say('no entry', 'pool has an empty side'));
    const setup = this.#s0 ? this.#s0Stop(u, tape, spot, now) : this.#setup(u, tape, spot, now, ctx, mint, mig!.price);
    if (!setup.ok) return void (stop('setup', 'adverse'), say('no setup', setup.why));
    const stopBps = Number(((spot - setup.stopSpot) * BPS) / spot);
    const ux = exitsFor(policy.exits, u.universe);
    const range = atr(tape.bars(), ux.atrPeriod, ux.atrBarMs, now);
    const stopCheck = checkStopDistance(policy, u.universe, spot, setup.stopSpot, range);
    if (!stopCheck.ok) return void (stop('stop distance', 'adverse'), say('no entry', `stop ${stopCheck.reason}: ${stopCheck.detail}`));
    if (!canOpenNewEntry(ctx.book).ok) {
      if (this.#deploy) this.#stats.rejected['R3:book busy'] = (this.#stats.rejected['R3:book busy'] ?? 0) + 1;
      return void (stop('book busy', 'adverse'), say('no entry', 'book busy: another entry, an exit or the position limit'));
    }

    const id = intentId(`en:${tag}:${mint}`);
    const quoteSide = effectiveQuoteReserve(poolState(view)) as Lamports;
    const net = this.#o.fills.network;
    const network = { signaturesPerTx: net.signaturesPerTx, baseFeePerSignature: net.baseFeePerSignature, entryPriorityFee: net.entryPriorityFee, exitPriorityFee: policy.exits.ladder.steps[0]!.priorityFeeLamports, tip: net.tip, entryFailurePpm: 0n, exitFailurePpm: 0n };
    // The bot closes the token account with its full exit (§9), so sizing counts the rent as recoverable (RISK-1's C
    // still carries it as a worst-case cost); the fill model returns it only when the final sell lands (fills-2).
    const rent = { tokenAccount: net.tokenAccountRent, tokenAccountClosedOnExit: true, oneTime: 0n, transient: 0n };
    const deploy = this.#deploy;
    const account = deploy ? this.#account(ctx, px.price as MicroUsd, now) : null;
    const bankrollLamports = account === null ? microUsdToLamports(policy.capital.bankroll, px.price as MicroUsd, 'floor') + policy.reserve.opsFloor : account.wallet;
    // Outside deployment each check is its own one-trade account, opened at this hour's price.
    const fresh: AccountHistory = {
      openingEquity: bankrollLamports as Lamports, openingSolPrice: px.price as MicroUsd, openedAtMs: now - 1, flows: [], costs: [], closedTrades: [], openPositions: [], entries: [],
      unresolvedEntries: [], heldReservations: 0n as Lamports, markedAtDayStart: null, markedAtWeekStart: null, navMarks: [], version: 0n,
    };
    const risk = evaluateEntry({
      session: this.#o.session, mode: deploy ? 'live' : 'backtest', clock: { now: () => ({ receivedAt: now }) },
      account: account?.history ?? fresh,
      latches: deploy ? this.#latches : NO_LATCHES,
      // R16: the regime gate was evaluated at the check and was on (an off regime never reaches risk).
      market: { solBalance: { value: bankrollLamports as Lamports, atMs: now }, regime: deploy ? 'on' : 'unknown' },
    }, {
      intentId: id, reservationId: reservationId(`r:${tag}:${mint}`), mint: toMint(mint), universe: u.universe, stopBps, edgePpm: u.edgePpm,
      medianTargetBps: u.medianTargetBps, quote: quoter, quoteAtMs: now, poolLiquidity: quoteSide, network, rent,
    });
    if (deploy) this.#trip(risk.trips, now);
    if (!risk.allow) {
      if (deploy) for (const r of risk.reasons) this.#stats.rejected[`${r.control}:${r.code}`] = (this.#stats.rejected[`${r.control}:${r.code}`] ?? 0) + 1;
      stop('risk', risk.reasons.length > 0 && risk.reasons.every((r) => NOT_COVERED_CODES.has(r.code)) ? 'not covered' : 'adverse');
      return void say('risk refused', ...risk.reasons.map((r) => `${r.control}:${r.code}`));
    }
    if (deploy) this.#entries.push({ mint: toMint(mint), atMs: now });
    this.#enter(c, u, view, pool, risk, account?.history.openingSolPrice ?? fresh.openingSolPrice, spot, setup.stopSpot, stopBps, blockHeight, out, this.#creator(ctx, mint));
  }

  /** The universe's setup at the spot price now, with its structure stop. */
  #setup(u: UniverseConfig, tape: PoolTape, spot: bigint, now: number, ctx: StrategyContext, mint: string, migration: { quote: bigint; base: bigint }): { ok: true; stopSpot: bigint } | { ok: false; why: string } {
    if (u.rules.kind === 'features') {
      const f = ctx.lookup(featuresKey(mint));
      return featureSetup(u.rules, f.ok ? f.value : null, spot);
    }
    return u.rules.kind === 'U2' ? u2Setup(u.rules, tape, spot, now, migration) : u1Setup(u.rules, tape, spot, now, ctx, mint);
  }

  /** S0's stop: the base universe's structure stop when it fits, else the widest stop the policy allows within 3 ATR. */
  #s0Stop(u: UniverseConfig, tape: PoolTape, spot: bigint, now: number): { ok: true; stopSpot: bigint } | { ok: false; why: string } {
    const r = u.rules;
    // A feature rule's stop is a fixed distance below the spot: S0 uses the same, so the pair differs only in selection.
    if (r.kind === 'features') return fixedStop(r.stopBelowBps, spot);
    const lowMs = r.kind === 'U2' ? r.recentMs : r.stopLowMs;
    const bars = tape.between(now - lowMs, now + BAR_MS);
    if (bars.length > 0) {
      const low = bars.reduce((m, b) => (b.low < m ? b.low : m), bars[0]!.low);
      const stop = (low * (BPS - BigInt(r.stopBelowLowBps))) / BPS;
      if (stop > 0n && stop < spot) return { ok: true, stopSpot: stop };
    }
    return { ok: false, why: 'no structure below the price for a stop' };
  }

  #enter(c: Candidate, u: UniverseConfig, view: PoolView, pool: string, risk: EntryAllowed, opening: MicroUsd, spot: bigint, stopSpot: bigint, stopBps: number, height: bigint, out: Decision[], creator: string | null): void {
    const q = pumpSwapRoundTrip(poolState(view), observedFeeContext(view.fees, view.baseSupply, NORMAL))(risk.spendLamports);
    if (!q.ok) {
      this.funnel.record(c.tag, c.mint, 'risk', 'adverse');
      return void out.push({ action: null, reasons: ['no entry', c.tag, c.mint, `no quote at the chosen size: ${q.reason}`] });
    }
    this.funnel.record(c.tag, c.mint, 'entered', 'adverse');
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
      tag: c.tag, mint: c.mint, pool, universe: u.universe, positionId: pid, notional: risk.notional, notionalUsd: lamportsToMicroUsd(risk.notional, opening, 'floor'), stopSpot, entrySpot: spot, stopBps,
      fixedCosts: net.signaturesPerTx * net.baseFeePerSignature + net.entryPriorityFee + net.tip + net.tokenAccountRent,
      plan: null, tracker: newTracker(), exits: 0, ladders: new Map(),
    });
    this.#byPool.set(pool, (this.#byPool.get(pool) ?? new Set()).add(pid));
    const intent = { id, key: entryKey(tm, c.tag), purpose: 'entry' as const, side: 'buy' as const, mint: tm, venue: 'pumpswap' as const, positionId: positionId(pid), spend };
    const act = (event: Exclude<Decision['action'], null>, why: string, ...more: string[]) => out.push({ action: event, reasons: [why, c.tag, c.mint, ...more] });
    // The deployer goes in the log line: G2's creator cluster is read from it at scoring (STATS-1b).
    act({ type: 'propose_entry', intent }, 'enter', `notional ${risk.notional}`, `stop ${stopBps} bps`, `round trip ${risk.roundTripPpm} ppm`, `creator ${creator ?? 'unknown'}`);
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
        if (this.#deploy) this.#close(ctx, t, pid, now);
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
          universe: t.universe, openedAtMs: now, notional: t.notionalUsd, riskUnit: (p.cost * BigInt(t.stopBps)) / BPS + t.fixedCosts,
          stopPrice: (entryExec * t.stopSpot) / t.entrySpot, entryReserve: effectiveQuoteReserve(poolState(view)),
        };
      }
      const tape = this.#tapes.get(t.pool);
      const bars = tape?.bars() ?? [];
      const supply = view?.baseSupply ?? 0n;
      const dev = bars.filter((b) => b.startMs + BAR_MS > t.plan!.openedAtMs).reduce((s, b) => s + b.deployerSold, 0n);
      const flow: FlowMinute[] = bars.filter((b) => b.startMs >= t.plan!.openedAtMs - BAR_MS).map((b) => ({ startMs: b.startMs, net: b.netNonCreatorUser }));
      const exitFills = Object.values(ctx.book.intents).filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === pid);
      const realized = exitFills.reduce((s, i) => s + i.fills.reduce((x, f) => x + f.sol, 0n), 0n);
      const net = this.#o.fills.network;
      const step = decideExit(this.#settings, t.plan, {
        status: p.status, quantity: p.quantity, sold: p.sold, costBasis: p.cost + t.fixedCosts, realized,
        exitCost: net.signaturesPerTx * net.baseFeePerSignature + this.#o.session.policy.exits.ladder.steps[0]!.priorityFeeLamports + net.tip,
        exitSeq: p.exitSeq, exitAttempts: exitAttemptsOf(ctx.book.intents, p.id),
        // The simulated token account holds exactly the position (nobody sends us tokens), and the fill model has no
        // separate close failure: a sell-and-close lands or fails whole.
        tokenAccountBalance: p.quantity, closeFailed: false,
      }, t.tracker, {
        nowMs: now, slotClose: e.key === 'slot',
        market: view === null ? null : { atMs: pv.ok ? pv.moment.receivedAt : now, value: market(view) },
        deployerSoldBps: supply > 0n ? { atMs: now, value: Number((dev * BPS) / supply) } : null,
        sellRoute: null, flow, bars,
      });
      t.tracker = step.tracker;
      if (this.#deploy) {
        // Equity marked at executable liquidation value on every update of the open position (drawdown).
        const pt = solUsdForBooks(ctx, now);
        if (pt !== null && pt.stale) this.#stats.staleSolUsdMarks++;
        if (pt !== null) this.#account(ctx, pt.price as MicroUsd, now);
      }
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

/**
 * The SOL/USD price an entry is sized and judged at: the latest hourly close released, no older than the series lets it
 * be. Live refuses a SOL price older than maxQuoteAgeMs (2 s) from its stream; the dataset has hourly closes only, each
 * stamped at its bar's end and usable one bar later (offchain.ts `usableFrom`), so a healthy close is 1 to 2 hours old
 * and the backtest's bound is 2 hours. Older, as when the series stops, the entry is "not covered", never sized at an
 * old price. Exits and the books keep the latest price (refusing it there would drop a loss from the account).
 */
export const SOL_USD_MAX_AGE_MS = 2 * 3_600_000;
/**
 * The age past which the books flag a SOL/USD conversion as stale: the entry bound plus the close's delivery (the
 * feed's release and the observation delay, at most the stress profile's 16 slots, 2 s and a 60 s blackout: under
 * 2 minutes), so a series that never stops flags nothing. It only counts; the entry bound stays 2 hours.
 */
export const SOL_USD_BOOKS_STALE_MS = SOL_USD_MAX_AGE_MS + 2 * 60_000;
/** The SOL/USD price the books use (closes, marks): the latest close however old, flagged stale past SOL_USD_BOOKS_STALE_MS. */
export const solUsdForBooks = (ctx: Pick<StrategyContext, 'lookup'>, now: number): { readonly tMs: number; readonly price: bigint; readonly stale: boolean } | null => {
  const r = ctx.lookup(SOL_USD_KEY);
  const sol = r.ok ? parseSolUsd(r.value) : null;
  const pt = sol === null ? null : solUsdAt(sol, now);
  return pt === null ? null : { ...pt, stale: now - pt.tMs > SOL_USD_BOOKS_STALE_MS };
};
const solForEntry = (ctx: StrategyContext, now: number): { readonly tMs: number; readonly price: bigint } | 'stale' | null => {
  const r = ctx.lookup(SOL_USD_KEY);
  const sol = r.ok ? parseSolUsd(r.value) : null;
  const pt = sol === null ? null : solUsdAt(sol, now);
  if (pt === null) return null;
  return now - pt.tMs > SOL_USD_MAX_AGE_MS ? 'stale' : pt;
};

/** Failed gates with their first reason code, for the log: "H13:not-covered". */
export const gateCodes = (g: HardResult): string[] =>
  g.failed.map((gate) => {
    const r = g.reasons.find((x) => x.gate === gate || ('neededBy' in x && x.neededBy === gate));
    return `${gate}:${r?.code ?? '?'}`;
  });

const lowOf = (bars: readonly { low: bigint }[]): bigint | null => (bars.length === 0 ? null : bars.reduce((m, b) => (b.low < m ? b.low : m), bars[0]!.low));
const highOf = (bars: readonly { high: bigint }[]): bigint | null => (bars.length === 0 ? null : bars.reduce((m, b) => (b.high > m ? b.high : m), bars[0]!.high));

/** U2: flush, higher low, reclaim of the VWAP since migration, positive non-creator-user flow (§3.2, #115 definitions). */
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
  const flow = recent.reduce((s, b) => s + b.netNonCreatorUser, 0n);
  if (flow <= 0n) return { ok: false, why: `non-creator-user flow ${flow} over the recent window` };
  return { ok: true, stopSpot: (recentLow * (BPS - BigInt(r.stopBelowLowBps))) / BPS };
};

/**
 * H3's holder count as of a moment (#115 definitions.holderGrowth, audit B3): distinct wallet owners whose accounts of
 * the mint sum to a positive balance; delegations play no part (BT review D1). The pool vault (of the tape's pool, named by its pool fact), the curve, the
 * mayhem vault, burns, lockers and program-owned accounts are not holders. Only complete coverage counts: a
 * largest-accounts view, a quality flag, accounts that do not sum to the supply, or no pool fact for the tape's pool
 * leave it unknown (null), and the condition then fails.
 */
/** The holder fact's tag when its only gap is delegations not rebuilt from the dataset (`--delegates-complete` absent). */
export const DELEGATES_PARTIAL = 'delegates';

export const walletHolders = (ctx: Pick<StrategyContext, 'lookup'>, mint: string, pool: string, asOf?: Parameters<StrategyContext['lookup']>[1]): number | null => {
  const r = ctx.lookup(holdersKey(mint), asOf);
  const h = r.ok ? parseHolders(r.value) : null;
  // The backtest's delegate-only 'partial' flag (delegations not rebuilt) says nothing about owner balances, so it leaves
  // the count standing (BT review N1, #115 definitions.holderGrowth); every other flag makes it unknown.
  const delegatesOnly = r.ok && (r.value as { partialReason?: unknown }).partialReason === DELEGATES_PARTIAL;
  const flags = h === null ? [] : h.obs.quality.filter((q) => !(delegatesOnly && q === 'partial'));
  if (h === null || flags.length > 0 || h.coverage !== 'all') return null;
  const pr = ctx.lookup(poolKey(mint), asOf);
  const pf = pr.ok ? parsePool(pr.value) : null;
  if (pf === null || pf.address !== pool) return null;
  const c = concentration(h, mintAccounts(mint, { address: pf.address, baseVault: pf.pool.poolBaseTokenAccount }));
  if (c.unaccounted !== 0n) return null;
  // Owners only (#115 definitions.holderGrowth; BT review D1): a delegation neither adds nor merges a holder here.
  // Delegates count as control in H12/H13's concentration, not in this count.
  const byOwner = new Map<string, bigint>();
  for (const x of c.classes) if (x.cls === 'wallet') byOwner.set(x.owner, (byOwner.get(x.owner) ?? 0n) + x.amount);
  return [...byOwner.values()].filter((v) => v > 0n).length;
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
  const nowHolders = walletHolders(ctx, mint, tape.last?.view.pool ?? '');
  const past = ctx.history(holdersKey(mint), { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 });
  const thenEntry = Array.isArray(past) ? [...past].reverse().find((x) => x.moment.receivedAt <= now - r.rangeMs) : undefined;
  const thenHolders = thenEntry === undefined ? null : walletHolders(ctx, mint, tape.last?.view.pool ?? '', thenEntry.moment);
  if (nowHolders === null || thenHolders === null || thenHolders === 0) return { ok: false, why: 'holder growth unknown' };
  if ((nowHolders - thenHolders) * Number(BPS) < thenHolders * r.holderGrowthBps) return { ok: false, why: `holders ${thenHolders} -> ${nowHolders}` };
  const low = lowOf(tape.between(now - r.stopLowMs, now + BAR_MS));
  if (low === null) return { ok: false, why: 'no bars for the stop' };
  return { ok: true, stopSpot: (low * (BPS - BigInt(r.stopBelowLowBps))) / BPS };
};

export { LAMPORTS_PER_SOL };

// The staged hard rejects (audit B2) are core's, the same implementation the live worker calls (FACTS-1f).
export { HARD_STAGE_GROUPS, type Staged, stagedHardRejects } from '../../../core/src/gates/index.ts';

const fixedStop = (stopBelowBps: number, spot: bigint): { ok: true; stopSpot: bigint } | { ok: false; why: string } => {
  // Rounded up, so the stop is never further than `stopBelowBps` below the spot (a barrier at the policy's widest stop
  // stays inside it).
  const stop = (spot * (BPS - BigInt(stopBelowBps)) + BPS - 1n) / BPS;
  return stop > 0n && stop < spot ? { ok: true, stopSpot: stop } : { ok: false, why: 'no room for the stop below the price' };
};

/**
 * A RES-3 feature rule: every condition holds on the features released with this check (as of its moment, feed
 * side), or no setup. An unknown or absent feature fails its condition.
 */
export const featureSetup = (r: FeatureRules, value: unknown, spot: bigint): { ok: true; stopSpot: bigint } | { ok: false; why: string } => {
  const f = value !== null && typeof value === 'object' ? (value as { features?: Readonly<Record<string, number | null>> }).features : undefined;
  if (f === undefined) return { ok: false, why: 'features not known at this check' };
  for (const c of r.conds) {
    const x = f[c.f];
    if (x === null || x === undefined || !Number.isFinite(x)) return { ok: false, why: `${c.f} unknown` };
    const t = Number(c.t);
    if (c.dir === 'ge' ? !(x >= t) : !(x <= t)) return { ok: false, why: `${c.f} ${x} ${c.dir === 'ge' ? '<' : '>'} ${c.t}` };
  }
  return fixedStop(r.stopBelowBps, spot);
};
