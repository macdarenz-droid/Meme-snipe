// One backtest run: the real engine (ENG-1) driven through a simulated clock by the DATA-1 dataset, with the S0
// control as its strategy and the §11 fill model as its outside world. Live and backtest share the engine; only the
// feed, clock and effect runner here are backtest parts (docs/ARCHITECTURE.md §16.1, §16.2).
import { exitsFor, type Policy } from '../../core/src/config/index.ts';
import { retentionFor } from '../../core/src/gates/retention.ts';
import type { FillConfig, ResearchConfig } from '../../core/src/config/index.ts';
import { createRng, Engine, type FeedEvent, type LogRecord, type MarketEvent, type Strategy } from '../../core/src/engine/index.ts';
import { blockedExitValue, type DelayProfileName, drawDiscoverySlots, type PoolDelta, type ScenarioName } from '../../core/src/fills/index.ts';
import { openLedger, type Ledger } from '../../core/src/ledger/index.ts';
import { isTerminal, type Book } from '../../core/src/lifecycle/index.ts';
import { type DatasetRow } from './dataset/rows.ts';
import { type OffchainSeries, seriesReleases } from './dataset/offchain.ts';
import { type Discovery, Market, rowMoment } from './sim/market.ts';
import { type StreamSource, StreamReplay } from './sim/replay.ts';
import { LedgerSink } from './sim/sink.ts';
import { type AttemptRecord, World } from './sim/world.ts';
import { S0, type S0Config } from './strategy/s0.ts';

export interface RunOptions {
  /** Rows in chain order, produced lazily (dataset days) or from memory (tests). */
  readonly rows: () => Iterator<DatasetRow>;
  readonly series: readonly OffchainSeries[];
  readonly seed: string;
  readonly scenario: ScenarioName;
  readonly policy: Policy;
  readonly fills: FillConfig;
  readonly research: ResearchConfig;
  /** End of the data window (ms): S0 plans no entry that could not finish inside it. */
  readonly windowEnd: number;
  /** Open a ledger file with purpose 'backtest' at this path. */
  readonly ledgerPath?: string;
  /** A replacement strategy (the leak test wraps S0). Default: S0 with `s0` overrides. */
  readonly strategy?: (config: S0Config) => Strategy;
  readonly s0?: Partial<S0Config>;
  /** Extra events (a planted leak marker), merged into the replay. */
  readonly extraEvents?: readonly FeedEvent[];
  /** No entry starts at or after this time (ms): the holdout's entry cutoff; the run still observes to its end. */
  readonly entryCutoff?: number;
  /** Deterministic failure bursts (stress): every attempt sent inside one never reaches a block. */
  readonly failureBursts?: { readonly perDay: number; readonly durationMs: number };
  /** Observation delay profile instead of the scenario's (a stress run). */
  readonly delay?: DelayProfileName;
  /** 'recorded': the rows carry recorded receipt times (recorder data), so no delay is added. Default 'chain-time'. */
  readonly observation?: 'chain-time' | 'recorded';
  /** Program-change slots from the dataset manifest (regime boundaries). */
  readonly regimeBoundaries?: readonly { readonly slot: bigint; readonly label: string }[];
}

export interface RunStats {
  readonly rows: number;
  readonly events: number;
  readonly crashes: number;
  readonly crash: string | null;
  /** Illegal transitions and refused events in the log, plus records the mirror reducer refused. */
  readonly illegalStates: number;
  /** Intents not finished when the data ended. */
  readonly unreconciledIntents: number;
  readonly mirrorMatches: boolean;
  readonly skippedSwaps: number;
  readonly unquotableSwaps: number;
  readonly alerts: Readonly<Record<string, number>>;
  readonly elapsedMs: number;
}

export interface RunResult {
  readonly logHash: string;
  readonly records: readonly LogRecord[];
  readonly stats: RunStats;
  readonly attempts: readonly AttemptRecord[];
  readonly book: Book;
  readonly discoveries: ReadonlyMap<string, Discovery>;
  readonly seed: string;
  readonly scenario: ScenarioName;
  readonly symbols: ReadonlyMap<string, string>;
  /** What the last ladder rung would get for `tokens` of `mint` on the pool as the data ended (blocked exits, §11). */
  readonly endValue: (mint: string, tokens: bigint) => bigint;
  /** Our trades' remaining effect on a pool's reserves when the data ended. */
  readonly poolDelta: (pool: string) => PoolDelta;
  /** Regime boundaries the data passed, each with the block time of the first block at or after it. */
  readonly regimes: readonly { readonly slot: bigint; readonly label: string; readonly at: number }[];
  /** Block time (ms) of the last block released. */
  readonly endedAt: number;
  /** Feed blackouts of the run's delay profile, ms [from, to). */
  readonly blackouts: readonly { readonly from: number; readonly to: number }[];
}

/** S0 settings from the policy (size, hold, ladder), the fill config and the research config; no code constants. */
export const s0Config = (o: RunOptions): S0Config => {
  const r = o.research.s0;
  // S0 controls for U2, so it holds for U2's T_max (CFG-2: selected by universe, never a default block).
  const universe = 'U2';
  const { tMaxMs } = exitsFor(o.policy.exits, universe);
  return {
    universe,
    windowFromMs: r.u2WindowFromMs,
    windowToMs: r.u2WindowToMs,
    holdMs: tMaxMs,
    notional: o.policy.capital.minNotional,
    entryMinOutBelowBps: r.entryMinOutBelowBps,
    ladder: { steps: o.policy.exits.ladder.steps, maxAttempts: o.policy.exits.ladder.maxAttempts },
    blockhashValidBlocks: o.fills.network.blockhashValidBlocks,
    stopEntriesAt: Math.min(o.windowEnd - tMaxMs - r.endMarginMs, o.entryCutoff ?? Number.POSITIVE_INFINITY),
    blockedRetryMs: r.blockedRetryMs,
    blockedRetries: r.blockedRetries,
    ...o.s0,
  };
};

/** Process-wide: performance.now is read only here, outside the engine, for the throughput figure. */
const clockMs = (): number => performance.now();

export const runBacktest = (o: RunOptions): RunResult => {
  const started = clockMs();
  const scenario = o.fills.scenarios[o.scenario];
  const profile = o.fills.delays[o.delay ?? scenario.delay];
  const it = o.rows();
  let rows = 0;
  const extra = [...(o.extraEvents ?? [])];
  const source: StreamSource<DatasetRow> = {
    next: () => {
      const r = it.next();
      if (r.done) return null;
      rows++;
      return { moment: rowMoment(r.value), item: r.value };
    },
  };
  let engine: Engine | null = null;
  const book = (): Book => engine!.book;
  let sink: LedgerSink | null = null;
  // Activity as of the last drain: blocks are released in their own drain, so this is the state at the block.
  const live = (): boolean => sink?.inFlight ?? false;
  let replay: StreamReplay<DatasetRow> | null = null;
  const market: Market = new Market({
    heartbeatBlocks: o.research.heartbeatBlocks,
    discoveryLag: (mint) => Math.max(1, drawDiscoverySlots(createRng(`${o.seed}:discovery:${mint}`), scenario)),
    active: live,
    observe: o.observation === 'recorded' ? null : {
      slots: profile.eventToProcessedSlots + (o.research.decisionCommitment === 'confirmed' ? profile.processedToConfirmedSlots : 0),
      providerMs: profile.providerMs, blackouts: profile.blackouts, seed: `${o.seed}:feed`,
    },
    volumeWindowSlots: scenario.congestion.windowSlots,
    hook: (h) => replay!.hook(h),
    hasRows: () => replay!.hasRows(),
    schedule: (e) => replay!.schedule(e),
    ...(o.regimeBoundaries === undefined ? {} : { regimeBoundaries: [...o.regimeBoundaries].sort((a, b) => (a.slot < b.slot ? -1 : 1)) }),
    series: o.series.map((s) => ({ key: s.name === 'SOL/USD' ? 'sol-usd' : s.name, releases: seriesReleases(s) })),
  });
  const discoveries = new Map<string, Discovery>();
  replay = new StreamReplay<DatasetRow>(source, (row) => market.release(row), (e) => {
    if (e.kind === 'market' && e.key.startsWith('disc:')) {
      const d = market.discovery(e.value as { mint: string; pool: string; graduatedAt: number });
      discoveries.set(d.mint, d);
      return { ...e, value: d } as MarketEvent;
    }
    return e;
  });
  for (const e of extra) replay.schedule(e);

  const maxOpen = Number.MAX_SAFE_INTEGER;
  let ledger: Ledger | null = null;
  if (o.ledgerPath !== undefined) ledger = openLedger(o.ledgerPath, 'backtest');
  sink = new LedgerSink(ledger, { maxOpenPositions: maxOpen }, { maxHeld: 2n ** 62n as never, maxCount: maxOpen });
  const net = o.fills.network;
  const world = new World({
    replay: replay as StreamReplay<unknown>, market, book, rng: createRng(`${o.seed}:world`), congestionSeed: `${o.seed}:world`, failureBursts: o.failureBursts, scenario, network: net,
    ladder: o.policy.exits.ladder.steps,
    poolOf: (mint) => discoveries.get(mint)?.pool,
    onSettled: (a) => sink!.fees(a, net.signaturesPerTx * net.baseFeePerSignature, net.tip, replay!.clock.now().receivedAt),
  });
  const config = s0Config(o);
  const strategy = o.strategy?.(config) ?? new S0(config);
  // The backtest takes every eligible candidate: no open-position cap beyond one entry in flight at a time (§14).
  // The same retention as live (WORKER-GROW), so a long backtest keeps the same as-of store as the live worker.
  engine = new Engine({ clock: replay.clock, feed: replay.feed, strategy, runner: world, seed: o.seed, book: { maxOpenPositions: maxOpen }, retention: retentionFor(o.policy, config.windowToMs) });

  let crash: string | null = null;
  try {
    for (;;) {
      const step = replay.advance();
      if (step === 'done') break;
      if (step === 'events') engine.drain();
      sink.consume(engine.records);
    }
  } catch (err) {
    crash = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } finally {
    ledger?.close();
  }
  const records = engine.records;
  let illegal = sink.divergences;
  for (const r of records) if (r.type === 'fault' || ((r.type === 'decision' || r.type === 'world') && r.result === 'illegal')) illegal++;
  const final = engine.book;
  const unreconciled = Object.values(final.intents).filter((i) => !isTerminal(i)).length;
  const mirrorMatches = sink.matches(final);
  return {
    logHash: engine.logHash(),
    records,
    book: final,
    attempts: [...world.attempts.values()],
    discoveries,
    seed: o.seed,
    scenario: o.scenario,
    symbols: market.symbols,
    endedAt: market.blockTime * 1000,
    regimes: market.regimesPassed,
    blackouts: market.blackouts,
    poolDelta: (pool) => market.track(pool)?.shifted.delta ?? { base: 0n, vault: 0n, virtual: 0n },
    endValue: (mint, tokens) => {
      const pool = discoveries.get(mint)?.pool;
      const t = pool === undefined ? undefined : market.track(pool);
      const steps = o.policy.exits.ladder.steps;
      const last = steps[steps.length - 1];
      if (t === undefined || last === undefined) return 0n;
      return blockedExitValue(t.shifted.state, tokens, t.fees, t.baseSupply, { mayhemMode: false, transferFee: false, transferHook: false }, last.minOutBelowTriggerBps);
    },
    stats: {
      rows, events: replay.released, crashes: crash === null ? 0 : 1, crash,
      illegalStates: illegal + (mirrorMatches ? 0 : 1), unreconciledIntents: unreconciled, mirrorMatches,
      skippedSwaps: market.skippedSwaps, unquotableSwaps: market.unquotableSwaps,
      alerts: Object.fromEntries(world.alerts), elapsedMs: Math.round(clockMs() - started),
    },
  };
};
