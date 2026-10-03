// The always-on paper worker (WORKER-1, docs/ARCHITECTURE.md §12.4, §20): the shared engine on the live Feed, with the
// market recorder and the dry-run simulation from its first minute, the ledger, the journal, the loopback health and
// drill endpoint, the signed heartbeat and the watchdog's pause. Paper only: no signing key exists, nothing is sent.
//
// Start order: journal `start` → ledger restore (the stored book events are fed back to the engine as recorded world
// frames, then `restart`) → reconcile every open intent through the paper world → journal `reconcile` and write
// `open_intents` → seed the deployer index (SEED-1's hook) → start the live sources → trade. Nothing enters before the
// reconcile line; a reconcile that cannot settle every intent exits 3.
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { PolicySession, RugConfig } from '../../../core/src/config/index.ts';
import { Engine, type LogRecord, type MarketEvent } from '../../../core/src/engine/index.ts';
import type { DeployerIndex } from '../../../core/src/gates/index.ts';
import { Ledger, openLedger } from '../../../core/src/ledger/index.ts';
import type { Book, BookEvent } from '../../../core/src/lifecycle/index.ts';
import { isTerminal, isUnresolved } from '../../../core/src/lifecycle/index.ts';
import type { FillNetwork, FillScenario } from '../../../core/src/fills/index.ts';
import type { MicroUsd } from '../../../core/src/units/index.ts';
import { EXIT, STATE_FILES, type FeedHealth, type Health, type JournalKind } from '../../../runner/src/contract.ts';
import type { DryRunRecord } from '../dryrun/index.ts';
import { ACCOUNT_KEY, HALT_KEY, LiveStrategy, POOL_PREFIX, RESTORE_KEY, SHORTLIST, SOL_PRICE_KEY, type StrategyConfig, TRIP_PREFIX } from '../engine/strategy.ts';
import { DEFAULT_LIVE_FEED, type Frame, type HttpClient, LiveFeed, type Release, seqId } from '../providers/index.ts';
import type { Timers } from '../scheduler/timers.ts';
import { PaperAccount, accountFile } from './account.ts';
import type { WorkerConfig } from './config.ts';
import { Desk, openIntents } from './desk.ts';
import type { FactContext, FactSource } from './facts.ts';
import { startHealthServer } from './health.ts';
import { type HeartbeatPosition, heartbeatBody, sendHeartbeat } from './heartbeat.ts';
import { jsonText } from './json.ts';
import { Journal } from './journal.ts';
import { type PaperMarket, type PaperState, PaperWorld, type SimLeg } from './paper-world.ts';
import { Recorder, sealLeftovers } from './recorder.ts';
import { type Control, NO_CONTROL, StateFile, controlFile, exitsFile } from './state.ts';
import { parsePool } from '../../../core/src/gates/index.ts';
import type { PoolFeeContext } from '../../../core/src/amm/index.ts';

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
}

export interface WorkerDeps {
  readonly config: WorkerConfig;
  readonly session: PolicySession;
  readonly rugs: RugConfig;
  readonly strategy: StrategyConfig;
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
  readonly fetchTx: (signature: string, why: 'create' | 'cut-log') => Promise<boolean>;
  /** SEED-1's start-up hook: seeds the deployer index before the live streams are trusted. */
  readonly seedDeployers: (index: DeployerIndex) => Promise<string>;
  readonly heartbeat: { readonly http: HttpClient; readonly key: string | null; readonly ownerChatId: string | null };
  /** How long the start reconcile may take before it exits 3. */
  readonly reconcileTimeoutMs: number;
  /** Engine loop period. */
  readonly loopMs: number;
  /** A critical feed with no frame for this long is stale (entries halt). */
  readonly staleFeedMs: number;
  /** Plain status lines for the process log (never a key or a URL). */
  readonly log: (line: string) => void;
}

export type StartResult = { readonly ok: true } | { readonly ok: false; readonly code: number; readonly message: string };

interface FeedState {
  readonly src: FeedSource;
  connected: boolean;
  last: number | null;
  droppedUntil: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class Worker {
  readonly #d: WorkerDeps;
  readonly #boot: string;
  readonly #started: number;
  readonly #journal: Journal;
  readonly #recorder: Recorder | null;
  readonly #ledger: Ledger;
  readonly #control: StateFile<Control>;
  readonly #exitsFile: ReturnType<typeof exitsFile>;
  readonly #account: PaperAccount;
  readonly #feed: LiveFeed;
  readonly #strategy: LiveStrategy;
  readonly #engine: Engine;
  readonly #world: PaperWorld;
  readonly #desk: Desk;
  readonly #feeds = new Map<string, FeedState>();
  readonly #drillToken: string;
  #ctl: Control;
  #reconciled = false;
  #lastSlot: bigint | null = null;
  #ticked: bigint | null = null;
  #solPrice: MicroUsd | null = null;
  #pools = new Map<string, unknown>();
  #fees = new Map<string, PoolFeeContext>();
  #createSig = new Map<string, string>();
  /** Watches that carry rug coverage (`coverage:rugs:start` vias): a cut log on one is a gap until its transaction is read. */
  #rugVias = new Set<string>();
  #intentAt = new Map<string, number>();
  #halted: readonly string[] = [];
  #savedExits = '';
  #beatSeq = 0;
  #loop: ReturnType<Timers['setTimeout']> | null = null;
  #beat: ReturnType<Timers['setTimeout']> | null = null;
  #server: Server | null = null;
  #stopping = false;
  #sources: readonly FeedSource[] = [];

  constructor(d: WorkerDeps) {
    this.#d = d;
    const c = d.config;
    const now = d.timers.now();
    this.#started = now;
    this.#boot = `${now.toString(36)}-${process.pid}`;
    mkdirSync(c.stateDir, { recursive: true });
    this.#journal = new Journal(join(c.stateDir, STATE_FILES.journal), this.#boot, () => d.timers.now());
    rmSync(join(c.stateDir, STATE_FILES.cleanStop), { force: true });
    const seed = `paper:${this.#boot}`;
    this.#journal.write('start', {
      git_sha: c.gitSha, run_id: c.runId, label: c.runLabel, recorder: c.recorder, simulation: c.simulate, mode: c.mode,
      policy_version: d.session.versionHash, strategy: d.strategy.version, seed, pid: process.pid,
    });
    if (this.#journal.repaired) this.#journal.write('journal_repair', { detail: 'torn last line removed' });

    const recRoot = join(c.stateDir, STATE_FILES.recorder);
    mkdirSync(recRoot, { recursive: true });
    for (const b of sealLeftovers(recRoot, this.#boot)) d.log(`Recorder: sealed files of boot ${b} left by a stop without a clean stop.`);
    this.#recorder = c.recorder ? new Recorder({ root: recRoot, boot: this.#boot, gitSha: c.gitSha, rotateBytes: 64 * 1024 * 1024 }) : null;

    this.#ledger = openLedger(join(c.stateDir, Ledger.FILE), 'paper');
    this.#control = controlFile(c.stateDir);
    this.#ctl = this.#control.read(NO_CONTROL);
    this.#exitsFile = exitsFile(c.stateDir);
    this.#account = new PaperAccount(accountFile(c.stateDir), d.session.policy.capital.bankroll, now);

    this.#feed = new LiveFeed({
      ...DEFAULT_LIVE_FEED,
      onFrame: (f) => this.#onFrame(f),
      onRelease: (e, r) => this.#onRelease(e, r),
    });
    this.#strategy = new LiveStrategy({ session: d.session, rugs: d.rugs, config: d.strategy });
    const bookConfig = { maxOpenPositions: d.session.policy.positions.maxOpen };
    const stored = this.#ledger.storedBookEvents(bookConfig);
    this.#world = new PaperWorld({
      report: (event) => void this.#report(event),
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
      file: new StateFile<PaperState>(c.stateDir, 'paper.json', (v) => (isObj(v) && isObj(v['attempts']) ? (v as unknown as PaperState) : null)),
      changed: () => this.#writeOpenIntents(),
    });
    this.#engine = new Engine({ clock: this.#feed.clock, feed: this.#feed, strategy: this.#strategy, runner: this.#world, seed, book: bookConfig });
    this.#desk = new Desk({
      ledger: this.#ledger, config: bookConfig, restored: stored.book,
      journal: (kind, fields) => this.#journal.write(kind, fields),
      report: (event) => this.#report(event),
      accountChanged: () => this.#publishAccount(),
      intentsChanged: () => this.#writeOpenIntents(),
      reserved: (r) => this.#account.reserved(r.mint, r.atMs),
      filled: (r) => this.#account.filled(r, this.#solPrice),
    });
    // The stored book goes back to the engine as world frames (recorded, so a replay rebuilds the same book).
    for (const e of stored.events) this.#desk.written(this.#report(e));
    this.#fact(RESTORE_KEY, { exits: this.#exitsFile.read({}) });
    if (stored.events.length > 0) this.#report({ type: 'restart' });
    if (this.#ctl.paused) this.#report({ type: 'pause_entries', reason: 'owner' });
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
  #report(event: BookEvent): string {
    const f = this.#feed.ingest('worker', { type: 'world', event }, { receivedAt: this.#d.timers.now() });
    return `world#${seqId(f.seq)}`;
  }

  #fact(key: string, value: unknown): void {
    this.#feed.ingest('worker', { type: 'fact', key, value }, { receivedAt: this.#d.timers.now() });
  }

  #onFrame(f: Frame): void {
    this.#recorder?.frame(f);
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
    if ((b.type === 'offchain' || b.type === 'fact') && /^coverage:[a-z]+:gap$/.test(b.key)) this.#recorder?.gap({ key: b.key, value: isObj(b.value) ? b.value : null, receivedAt: f.receivedAt });
  }

  #onRelease(e: { readonly kind: string; readonly key?: string; readonly value?: unknown; readonly moment: { readonly receivedAt: number } }, r: Release): void {
    this.#recorder?.release(r, e.moment.receivedAt);
    if (e.kind !== 'market') return;
    const m = e as unknown as MarketEvent;
    // A late slot notice is refused by the engine (out of order): the paper height follows only accepted ones.
    if (m.key === 'chain:slot' && !r.late && isObj(m.value) && typeof m.value['slot'] === 'bigint' && (this.#lastSlot === null || m.value['slot'] > this.#lastSlot)) this.#lastSlot = m.value['slot'];
    else if (m.key.startsWith(POOL_PREFIX)) this.#pools.set(m.key.slice(POOL_PREFIX.length), m.value);
    else if (m.key.startsWith('worker:fees:')) this.#fees.set(m.key.slice('worker:fees:'.length), m.value as PoolFeeContext);
    else if (m.key === SOL_PRICE_KEY) {
      const p = isObj(m.value) && typeof m.value['value'] === 'bigint' && m.value['value'] > 0n ? { price: m.value['value'] } : null;
      if (p !== null) {
        const first = this.#account.state.walletLamports === null;
        this.#solPrice = p.price as MicroUsd;
        this.#account.price(this.#solPrice);
        // The paper wallet exists from the first price on: risk needs its balance (R4).
        if (first && this.#account.state.walletLamports !== null && this.#reconciled) this.#publishAccount();
      }
    } else if (m.key === 'coverage:rugs:start') {
      const v = isObj(m.value) && isObj(m.value['value']) ? m.value['value'] : m.value;
      if (isObj(v) && typeof v['via'] === 'string') this.#rugVias.add(v['via']);
    }
    this.#cutTradeLog(m);
    if (m.key.startsWith('logs:pump:CreateEvent:') && isObj(m.value) && typeof m.value['signature'] === 'string') {
      this.#createSig.set(m.key.slice('logs:pump:CreateEvent:'.length), m.value['signature']);
      if (this.#createSig.size > 200_000) this.#createSig.delete(this.#createSig.keys().next().value!);
    }
  }

  /** The latest pool fact of a mint, with its fee context: what the paper fill and the dry-run build use. */
  poolOf(mint: string): { readonly address: string; readonly state: PaperMarket['pool']; readonly ctx: PoolFeeContext } | null {
    const p = parsePool(this.#pools.get(mint));
    const ctx = this.#fees.get(mint);
    if (p === null || ctx === undefined) return null;
    return { address: p.address, state: { baseReserve: p.baseVault, quoteVault: p.quoteVault, virtualQuoteReserves: p.pool.virtualQuoteReserves ?? 0n }, ctx };
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
    const p = parsePool(this.#pools.get(mint));
    const ctx = this.#fees.get(mint);
    if (p === null || ctx === undefined) return null;
    return { pool: { baseReserve: p.baseVault, quoteVault: p.quoteVault, virtualQuoteReserves: p.pool.virtualQuoteReserves ?? 0n }, ctx };
  }

  #publishAccount(): void {
    this.#fact(ACCOUNT_KEY, this.#account.fact(this.#ledger, this.#desk.book, this.#ctl.latches, this.#solPrice, this.#d.timers.now()));
  }

  #writeOpenIntents(): void {
    const n = Math.max(openIntents(this.#desk.book), this.#reconciled ? 0 : openIntents(this.#engine.book));
    writeFileSync(join(this.#d.config.stateDir, STATE_FILES.openIntents), `${n}\n`);
  }

  /** One engine step: release what is due, decide, record, write. */
  step(): void {
    const now = this.#d.timers.now();
    this.#recorder?.flush();
    this.#feed.advance(now);
    this.#engine.drain();
    this.#recorder?.flush();
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
    const saved = this.#strategy.saved();
    const text = jsonText(saved);
    if (text !== this.#savedExits) {
      this.#exitsFile.write(saved);
      this.#savedExits = text;
    }
    this.#checkHalt(now);
  }

  #afterRecord(r: LogRecord): void {
    if (r.type !== 'decision') return;
    if (r.reasons[0] === SHORTLIST) {
      const mint = r.reasons[2];
      const sig = mint === undefined ? undefined : this.#createSig.get(mint);
      if (sig !== undefined) void this.#d.fetchTx(sig, 'create');
      else this.#d.log(`Shortlisted ${mint ?? '?'}: its create was not seen by this process; H9 and H12-H14 wait for it.`);
    }
    const trips = r.reasons.filter((x) => x.startsWith(TRIP_PREFIX)).map((x) => x.slice(TRIP_PREFIX.length));
    if (trips.length > 0) {
      const at = r.at.receivedAt;
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
    if (r.action?.type === 'propose_entry') this.#intentAt.set(r.action.intent.id, r.at.receivedAt);
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
      if (this.#stopping) return { ok: false, code: EXIT.clean, message: 'stopped during the start reconcile' };
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
    this.#writeOpenIntents();
    this.#publishAccount();
    const positions = Object.values(this.#engine.book.positions).filter((p) => p.status !== 'closed').map((p) => p.id);
    this.#journal.write('reconcile', { ok: true, restored_events: this.#ledgerEvents(), cancelled: asked.size, open_positions: positions });
    return { ok: true };
  }

  #ledgerEvents(): number {
    return this.#ledger.intentEvents().length;
  }

  /** Seeds the deployer index, starts the sources, the health server, the heartbeat and the loop. */
  async start(): Promise<StartResult> {
    const d = this.#d;
    const r = await this.reconcile();
    if (!r.ok) return r;
    try {
      d.log(`Deployer index: ${await d.seedDeployers(this.#strategy.deployers)}`);
    } catch (e) {
      d.log(`Deployer index seed failed (${e instanceof Error ? e.name : 'error'}); H14 stays uncovered until the look-back passes.`);
    }
    if (d.facts !== undefined && d.facts.length > 0) {
      if (d.schedulers === undefined) return { ok: false, code: EXIT.config, message: 'fact producers need the provider schedulers' };
      const ctx: FactContext = {
        sink: { fact: (key, value) => this.#fact(key, value), now: () => d.timers.now() },
        timers: d.timers, schedulers: d.schedulers, watched: () => this.#strategy.watched(),
      };
      for (const f of d.facts) f.start(ctx);
    }
    this.#sources = d.sources({ feed: this.#feed, timers: d.timers });
    for (const s of this.#sources) this.#feeds.set(s.name, { src: s, connected: false, last: null, droppedUntil: 0 });
    try {
      this.#server = await startHealthServer(d.config.health.host, d.config.health.port, {
        health: () => this.health(),
        drill: d.config.drills ? { token: this.#drillToken, dropFeed: (feed, ms) => this.dropFeed(feed, ms) } : null,
      });
    } catch (e) {
      return { ok: false, code: EXIT.crash, message: `health server: ${e instanceof Error ? e.message : 'error'}` };
    }
    for (const s of this.#sources) s.start();
    const loop = (): void => {
      if (this.#stopping) return;
      try {
        this.step();
      } catch (e) {
        d.log(`Engine step failed: ${e instanceof Error ? `${e.name}: ${e.message}` : 'error'}`);
        process.exitCode = EXIT.crash;
        void this.stop(EXIT.crash);
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
    d.log(`Worker up: boot ${this.#boot}, release ${d.config.gitSha.slice(0, 12)}, recorder ${d.config.recorder ? 'on' : 'off'}, simulation ${d.config.simulate ? 'on' : 'off'}, ${this.#sources.length} feeds.`);
    return { ok: true };
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
    const p = Object.values(this.#engine.book.positions).find((x) => x.status !== 'closed' && x.status !== 'opening');
    const saved = p === undefined ? undefined : this.#strategy.saved()[p.id];
    return {
      seq: this.#beatSeq, ts: now, git_sha: this.#d.config.gitSha, policy_version: this.#d.session.versionHash,
      last_processed_slot: this.#lastSlot === null ? null : Number(this.#lastSlot), feed_ages_ms: ages,
      open_position: p === undefined ? null : { mint: p.mint, qty: String(p.quantity), entry: String(p.cost), stop: saved === undefined ? 'unknown' : String(saved.plan.stopPrice) },
      unresolved_intents: this.#desk.unresolved(now, (id) => this.#intentAt.get(id) ?? null),
      signer: 'none', lease_epoch: null,
      sol_reserve: this.#account.state.walletLamports === null ? null : String(this.#account.state.walletLamports),
      paused: this.#ctl.paused, boot: this.#boot, pid: process.pid, uptime_s: Math.round((now - this.#started) / 1000),
      rss_bytes: process.memoryUsage().rss, mode: 'paper', recorder: this.#d.config.recorder ? 'on' : 'off', simulation: this.#d.config.simulate ? 'on' : 'off',
      reconciled: this.#reconciled, entries_halted: this.#halted.length > 0, halt_reasons: [...this.#halted], feeds, journal_seq: this.#journal.seq, signing_key: false,
    };
  }

  /** One signed heartbeat; the reply's pause is applied both ways. */
  async heartbeat(): Promise<void> {
    const hb = this.#d.heartbeat;
    const url = this.#d.config.watchdogUrl;
    this.#beatSeq++;
    if (url === null || hb.key === null) return;
    const h = this.health();
    const p = Object.values(this.#engine.book.positions).find((x) => x.status !== 'closed' && x.status !== 'opening');
    const saved = p === undefined ? undefined : this.#strategy.saved()[p.id];
    const lastExit = p === undefined ? null : Math.max(...Object.values(this.#engine.book.intents).filter((i) => i.intent.positionId === p.id && i.intent.purpose === 'exit').map((i) => this.#intentAt.get(i.intent.id) ?? 0), 0);
    const position: HeartbeatPosition | null = p === undefined ? null : {
      mint: p.mint, qty: Number(p.quantity), entry: Number(p.cost), stop: saved === undefined ? 0 : Number(saved.plan.stopPrice), mark: null,
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
  async stop(code: number = EXIT.clean): Promise<number> {
    if (this.#stopping) return code;
    this.#stopping = true;
    const d = this.#d;
    if (this.#loop !== null) d.timers.clearTimeout(this.#loop);
    if (this.#beat !== null) d.timers.clearTimeout(this.#beat);
    for (const s of this.#sources) s.stop();
    for (const f of d.facts ?? []) f.stop();
    const pending = [...this.#world.pending.values()];
    if (pending.length > 0) {
      await Promise.race([Promise.allSettled(pending), new Promise<void>((r) => d.timers.setTimeout(r, 10_000))]);
    }
    try {
      this.step();
    } catch {}
    const open = Object.values(this.#engine.book.positions).filter((p) => p.status !== 'closed').map((p) => p.id);
    this.#journal.write('stop', { open_positions: open, open_intents: openIntents(this.#desk.book), reasons: [code === EXIT.clean ? 'signal' : 'crash'] });
    this.#recorder?.close();
    this.#ledger.close();
    if (code === EXIT.clean) writeFileSync(join(d.config.stateDir, STATE_FILES.cleanStop), new Date(d.timers.now()).toISOString());
    await new Promise<void>((r) => (this.#server === null ? r() : this.#server.close(() => r())));
    return code;
  }

  /**
   * What SIGKILL leaves behind, for restart drills in tests: timers, sources and the server stop, the ledger's
   * connection closes (the kernel drops its lock when a killed process dies), and nothing else runs: no final step, no
   * `stop` line, no recorder seal, no `clean_stop`.
   */
  async kill(): Promise<void> {
    this.#stopping = true;
    if (this.#loop !== null) this.#d.timers.clearTimeout(this.#loop);
    if (this.#beat !== null) this.#d.timers.clearTimeout(this.#beat);
    for (const s of this.#sources) s.stop();
    this.#ledger.close();
    await new Promise<void>((r) => (this.#server === null ? r() : this.#server.close(() => r())));
  }

  /** For the `--reconcile` entry: settle, report, close without starting anything. */
  async reconcileOnly(): Promise<StartResult> {
    const r = await this.reconcile();
    // A signal during the reconcile runs the clean stop, which closes both.
    if (!this.#stopping) {
      this.#recorder?.close();
      this.#ledger.close();
    }
    return r;
  }
}
