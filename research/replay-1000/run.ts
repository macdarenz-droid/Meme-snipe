// REPLAY-1000: one replay of the bot over recorded chain history. The worker is built exactly as main.ts builds it
// (same Worker, LiveProviders, FactReaders, strategy config, S0 shakedown settings from ops/host-config.json), on
// virtual time, with the network swapped for the as-of world (world/*). Its journal and recorder land in a state folder
// like the server's, so the TEST-1 parity replay can run on it afterwards (replay.ts).
//
//   node research/replay-1000/run.ts <out-dir> <coins.json> <startIso> <endIso> [--mode A|B]
//
// <coins.json>: [{ mint, pool, migrationSig, migrationSlot, migrationTime }] (coins.ts output, filtered).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FILL_CONFIG, RESEARCH_CONFIG, RUG_CONFIG, TRIAL_POLICY, startSession, type Policy, type PolicySession } from '../../packages/core/src/config/index.ts';
import { usd } from '../../packages/core/src/config/amounts.ts';
import { deepFreeze } from '../../packages/core/src/config/freeze.ts';
import { policyHash } from '../../packages/core/src/config/hash.ts';
import { toAddress } from '../../packages/core/src/chain/index.ts';
import { DryRunRpc } from '../../packages/worker/src/dryrun/index.ts';
import type { DryRunRecord } from '../../packages/worker/src/dryrun/index.ts';
import { liveFacts } from '../../packages/worker/src/facts/index.ts';
import { DailyBudget } from '../../packages/worker/src/persist/index.ts';
import { heliusRpcUrl, type HttpClient, type Secrets } from '../../packages/worker/src/providers/index.ts';
import { parseConfig } from '../../packages/worker/src/run/config.ts';
import { provisionalCalibration } from '../../packages/worker/src/run/live-sim.ts';
import type { SimLeg } from '../../packages/worker/src/run/paper-world.ts';
import { FILL_BUDGET_FILE, runSeed } from '../../packages/worker/src/run/seed-start.ts';
import { PAPER_SCENARIO, strategyConfig } from '../../packages/worker/src/run/settings.ts';
import { SIM_READS_PER_HOUR, simReader } from '../../packages/worker/src/run/sim-read.ts';
import { CreditBook, FEED_COMMITMENTS, LiveProviders } from '../../packages/worker/src/run/sources.ts';
import { Worker } from '../../packages/worker/src/run/worker.ts';
import { checkSession } from '../../packages/worker/src/run/parity.ts';
import { replayLedgerFile } from '../../packages/core/src/ledger/replay/index.ts';
import { COINBASE_PUBLIC, GITHUB_DOWNLOADS, GITHUB_RELEASES, GOPLUS_FREE, P2 } from '../../packages/worker/src/scheduler/index.ts';
import { loadIndex } from './coins.ts';
import { loadCandles, loadTrades } from './coinbase.ts';
import { PublicRpc, type RawSig } from './rpc.ts';
import { AccountWorld } from './world/accounts.ts';
import { ChainView } from './world/chain.ts';
import { CoreSimulator } from './world/core-sim.ts';
import { HolderBook } from './world/holders.ts';
import { HttpWorld, RPC_LATENCY_MS } from './world/http-world.ts';
import { RpcWorld } from './world/rpc-world.ts';
import { VirtualClock } from './world/vclock.ts';
import { socketWorld } from './world/ws-world.ts';
import { PUMP_CREATE_AUTHORITY, PUMP_MIGRATION_AUTHORITY } from '../../packages/worker/src/run/sources.ts';

export interface RunCoin {
  readonly mint: string;
  readonly pool: string;
  readonly migrationSig: string;
  readonly migrationSlot: number;
  readonly migrationTime: number;
}

/** The release's S0 shakedown block (ops/host-config.json), as worker-start exports it. */
const shakedown = (): Record<string, string> => (JSON.parse(readFileSync(new URL('../../ops/host-config.json', import.meta.url), 'utf8')) as { shakedown: Record<string, string> }).shakedown;

export interface RunOptions {
  readonly out: string;
  readonly coins: readonly RunCoin[];
  readonly startMs: number;
  readonly endMs: number;
  /** Creates the creates stream carries (the replayed coins' and their creators' others), with their slots. */
  readonly creates: readonly RawSig[];
  /**
   * Coins replayed only up to their migration and 30-minute survival read: their migrations reach the bot (the
   * regime's graduates series is fed by every coin, live), their pools' logs streams are refused.
   */
  readonly others?: readonly RunCoin[];
  readonly log?: (line: string) => void;
  /** Mode B: the risk caps lifted (README "Modes"); A: the bot exactly. */
  readonly mode: 'A' | 'B';
  readonly boot?: string;
  /** The cache folder (default DATA_DIR); with `offline` no network is used (a test fixture). */
  readonly dataDir?: string;
  readonly offline?: boolean;
  /** TEST-1 parity replays of the recording after the run (0: none). */
  readonly parityReplays?: number;
}

/**
 * Mode B's policy (README "Modes"): the trial policy with the position and loss caps lifted so every coin that passes
 * the gates on its own is entered, and a bankroll large enough that cash never binds. A research copy built here, never
 * the bot's: the bot's code and config are untouched, and startSession (which refuses any loosening) is not used.
 * Entry size is unchanged: the bot sizes at the policy's minimum ($2) until the owner steps sizes up (risk R2 stage).
 */
export const modeBSession = (): PolicySession => {
  const p = structuredClone(TRIAL_POLICY) as Policy & { -readonly [K in keyof Policy]: Policy[K] };
  const policy: Policy = deepFreeze({
    ...p,
    name: 'replay-mode-b',
    capital: { ...p.capital, bankroll: usd('100000') },
    positions: { ...p.positions, maxOpen: 1000, maxEntriesPerDay: 100_000 },
    loss: { ...p.loss, dailyBps: 10_000, weeklyBps: 10_000, killSwitchFloorBps: 1, cooldownAfterLosses: 100_000, pauseDayAfterLosses: 100_000, reviewWindowTrades: 100_000, reviewLosses: 100_000 },
  });
  const versionHash = policyHash(policy);
  let running = true;
  return {
    policy, versionHash, baselineHash: 'replay-mode-b', changesFromBaseline: [],
    get running() { return running; },
    requestChange: () => ({ ok: false, reason: 'replay: Mode B policy is fixed' }) as ReturnType<PolicySession['requestChange']>,
    end: () => void (running = false),
  };
};

export const runReplay = async (o: RunOptions) => {
  const log = o.log ?? ((l: string) => console.error(l));
  rmSync(o.out, { recursive: true, force: true });
  const stateDir = join(o.out, 'state');
  mkdirSync(stateDir, { recursive: true });
  const clock = new VirtualClock(o.startMs);
  const net = o.offline === true ? new PublicRpc([], o.dataDir) : new PublicRpc(undefined, o.dataDir);
  const chain = new ChainView(net, loadIndex(o.dataDir));
  const accounts = new AccountWorld(chain, net);
  accounts.holders = new HolderBook(chain, net, accounts, new Set(o.coins.map((c) => c.mint)));
  const others = o.others ?? [];
  for (const c of o.coins) await accounts.addCoin(c);
  // 35 minutes of slots past the migration (the survival read is due at +30 min plus a few seconds).
  for (const c of others) await accounts.addCoin({ ...c, servedUntilSlot: chain.clock.slotAt((c.migrationTime + 35 * 60) * 1000) });
  const rpcWorld = new RpcWorld(chain, accounts);
  const candles = loadCandles(o.dataDir);
  const thirdParty = async (name: string, url: string) => net.cached(`3p-${createHash('sha256').update(name).digest('hex').slice(0, 32)}`, async () => {
    if (o.offline === true) return { status: 503, text: 'replay: offline' };
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    return { status: r.status, text: await r.text() };
  });
  const http = new HttpWorld({
    clock, rpc: rpcWorld, net, fetchJson: thirdParty,
    coinbaseCandles: async (startIso, endIso, granularity, nowMs) => {
      if (granularity !== 3600) return { status: 400, text: '{"message":"replay: only hourly candles"}' };
      const s = Date.parse(startIso) / 1000;
      const e = Date.parse(endIso) / 1000;
      // Only bars closed by now (an open bar's values are not known as of now).
      const rows = candles.filter((r) => r[0]! >= s && r[0]! <= e && (r[0]! + 3600) * 1000 <= nowMs).sort((a, b) => b[0]! - a[0]!);
      return { status: 200, text: JSON.stringify(rows) };
    },
    github: async () => ({ status: 403, text: '{"message":"replay: GitHub releases are not served"}' }),
  });
  const wsStats = new Map<string, number>();
  const fixed = new Map<string, RawSig[]>([
    [PUMP_MIGRATION_AUTHORITY, [...o.coins, ...others].map((c) => ({ signature: c.migrationSig, slot: c.migrationSlot, err: null, blockTime: c.migrationTime }))],
    [PUMP_CREATE_AUTHORITY, [...o.creates]],
  ]);
  const logsOf = async (sig: string): Promise<string[] | null> => {
    const t = (await net.tx(sig)) as { meta: { logMessages?: string[] } } | null;
    return t?.meta.logMessages ?? null;
  };
  const sockets = socketWorld({ clock, chain, fixed, logsOf, stats: wsStats, coinbase: loadTrades(o.dataDir), refuseLogs: new Set(others.map((c) => c.pool)) });

  const env: Record<string, string> = {
    ZEROED_STATE_DIR: stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_DRILLS: 'on',
    ZEROED_HEALTH_ADDR: `127.0.0.1:${30_000 + (process.pid % 15_000) * 2}`, ZEROED_API_ADDR: `127.0.0.1:${30_001 + (process.pid % 15_000) * 2}`, ZEROED_GIT_SHA: 'replay-1000',
    ...shakedown(),
  };
  const parsed = parseConfig(env, () => null);
  if (!parsed.ok) throw new Error(parsed.message);
  const config = parsed.config;
  const session = o.mode === 'B' ? modeBSession() : startSession(TRIAL_POLICY);
  const policy = session.policy;
  const secrets: Secrets = { get: () => 'replay-no-key' };
  const credits = new CreditBook(stateDir, clock);
  const fillBudget = DailyBudget.load(join(stateDir, FILL_BUDGET_FILE), config.fillCreditsPerDay, clock.now());
  const providers = new LiveProviders({ tradeStreams: false, secrets, http: http.client, factory: sockets, credits, fillBudget });
  const dry = new DryRunRpc({ url: () => heliusRpcUrl(secrets), http: http.client, scheduler: providers.helius, timeoutMs: 10_000 });
  let worker: Worker | null = null;
  const calibration = provisionalCalibration(new URL('../../packages/core/test/tx/fixtures/golden.json', import.meta.url).pathname);
  // TEST-2's per-leg dry run against mainnet is not rebuilt (it never decides a fill); each leg answers after the two
  // calls it makes live, so landing waits as long as live.
  const simulate = (leg: SimLeg): Promise<DryRunRecord> => {
    const slot = clock.reserve(clock.now() + 2 * RPC_LATENCY_MS);
    return new Promise((resolveLeg) => slot.fill(() => resolveLeg({
      id: `${leg.trade}|${leg.leg}`, side: leg.side, finalExit: leg.side === 'sell' && leg.closes, venue: 'pool', mint: leg.mint as DryRunRecord['mint'], outcome: 'not-simulable', success: false,
      error: 'replay: the dry-run simulation against past state is not rebuilt', standIn: null, policy: null, quotedOut: leg.quotedOut, simulatedOut: null, amountErrorE4: null,
      readSlot: null, quoteAgeSlots: null, rentDeclared: null, rentPaid: null, balancesFrom: null, simulatedSlot: null, unitsConsumed: null, logsTail: [],
    })));
  };
  const maxSlippageBps = Math.max(RESEARCH_CONFIG.s0.entryMinOutBelowBps, ...policy.exits.ladder.steps.map((s) => s.minOutBelowTriggerBps));
  const standIn = config.standIns[0] ?? null;
  const core = standIn === null ? null : new CoreSimulator({ standIn: toAddress(standIn), accounts, chain, now: () => clock.now(), ctxOf: (mint) => worker?.poolOf(mint)?.ctx ?? null });
  const h15 = core === null ? undefined : (ctx: { readonly tip: () => bigint | null }) => simReader({
    rpc: dry, simulator: core, wallet: standIn, calibration,
    poolOf: (mint) => worker?.poolOf(mint) ?? null, head: ctx.tip, maxSlippageBps,
    priorityFee: policy.exits.ladder.steps[0]!.priorityFeeLamports, maxPriorityFee: policy.exits.ladder.maxFeePerAttempt,
    tip: FILL_CONFIG.network.tip, maxTip: FILL_CONFIG.network.tip * 2n, lamportsPerSignature: FILL_CONFIG.network.baseFeePerSignature,
    now: () => clock.now(), perHour: SIM_READS_PER_HOUR,
    record: (r) => worker?.journal.write('h15_sim', { ...r }),
  });
  const quietHttp: HttpClient = async () => ({ status: 200, text: '{}', header: () => null });
  const strategy = strategyConfig(policy, FILL_CONFIG, RESEARCH_CONFIG, config.strategy.paperEdgePpm ?? 0n, config.strategy.name === 'S0' ? { timing: 'random', salt: config.runId ?? 'S0', s0Diagnostic: config.strategy.s0Diagnostic } : { timing: 'gates', salt: '' });
  worker = new Worker({
    boot: o.boot ?? `replay-${o.mode}`,
    config, session, rugs: RUG_CONFIG, strategy,
    scenario: FILL_CONFIG.scenarios[PAPER_SCENARIO], network: FILL_CONFIG.network, timers: clock,
    sources: (ctx) => providers.feeds(ctx),
    simulate,
    fetchTx: (sig) => providers.fetchTx(sig),
    findCreate: (mint) => providers.findCreate(mint, clock),
    seed: (r) => runSeed(r, { rpc: providers.seedRpc(), timers: clock, budget: fillBudget }),
    restartReads: { rpc: providers.seedRpc(), budget: fillBudget },
    seedWaitMs: 30_000,
    seedMaxMs: 90_000,
    ops: () => providers.ops(),
    heliusExhaustion: () => {
      const s = providers.helius.status();
      return { exhausted: s.exhausted, count: s.exhaustedCount, firstAtMs: s.exhaustedFirstAtMs };
    },
    streamHeld: () => providers.heldNotices(),
    facts: [liveFacts({ policy, secrets, http: http.client, goplus: credits.scheduler(GOPLUS_FREE), coinbase: credits.scheduler(COINBASE_PUBLIC), github: { api: credits.scheduler(GITHUB_RELEASES), downloads: credits.scheduler(GITHUB_DOWNLOADS), stateDir: config.stateDir }, stateDir: config.stateDir, log, ...(h15 === undefined ? {} : { sim: h15 }), ...(config.strategy.s0Diagnostic ? { execStats: () => worker?.execStats() ?? null } : {}) })],
    schedulers: { helius: providers.helius, alchemy: providers.alchemy, jupiter: providers.jupiter, rugcheck: providers.rugcheck },
    exposureRpc: providers.seedRpc(),
    watchRead: providers.watchRead(),
    watchHalted: () => providers.alchemy.halted,
    commitments: FEED_COMMITMENTS,
    heartbeat: { http: quietHttp, key: null, ownerChatId: null },
    reconcileTimeoutMs: 60_000, loopMs: 100, staleFeedMs: 10_000, log,
    loopClock: () => clock.now(),
  });
  void P2;
  const w = worker;
  const started = w.start();
  let startResult: unknown = null;
  void started.then((r) => (startResult = r), (e) => (clock.failure = e));
  const wallT0 = Date.now();
  let lastLog = Date.now();
  await clock.run(o.endMs, () => {
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      log(`replay: virtual ${new Date(clock.now()).toISOString()}, timers ${clock.fired}, wall ${((Date.now() - wallT0) / 1000).toFixed(0)}s, rpc ${JSON.stringify(Object.fromEntries(rpcWorld.calls))}`);
    }
    return false;
  });
  await w.stop(0);
  await clock.run(clock.now() + 60_000);
  // TEST-1: the recording replayed through the Engine `parityReplays` times; every replay must equal the journal.
  let parity: unknown = null;
  if ((o.parityReplays ?? 10) > 0) {
    const t0 = Date.now();
    const r = checkSession(stateDir, { session, rugs: RUG_CONFIG, strategy: w.strategyConfig }, replayLedgerFile, o.parityReplays ?? 10);
    parity = { ok: r.ok, replays: o.parityReplays ?? 10, seconds: (Date.now() - t0) / 1000, boots: r.boots.map((b) => ({ boot: b.boot, decisions: b.decisions, deterministic: b.deterministic, divergence: b.divergence, missing: b.missing, redactions: b.redactions, excluded: b.excluded })), ledgerOk: r.ledger?.ok ?? null };
    log(`parity: ${JSON.stringify(parity).slice(0, 400)}`);
  }
  const summary = {
    startResult, virtualEnd: new Date(clock.now()).toISOString(), wallSeconds: (Date.now() - wallT0) / 1000, parity,
    rpcCalls: Object.fromEntries(rpcWorld.calls), refusals: Object.fromEntries(rpcWorld.refusals), recentRefusals: rpcWorld.recent.slice(-50),
    http: Object.fromEntries(http.counts), ws: Object.fromEntries(wsStats), accounts: Object.fromEntries(accounts.stats), holders: Object.fromEntries(accounts.holders.stats), net: net.stats,
  };
  writeFileSync(join(o.out, 'world.json'), JSON.stringify(summary, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
  return summary;
};

const main = async () => {
  const [out, coinsFile, startIso, endIso] = process.argv.slice(2);
  const mode = process.argv.includes('--mode') ? (process.argv[process.argv.indexOf('--mode') + 1] as 'A' | 'B') : 'A';
  const coins = JSON.parse(readFileSync(coinsFile!, 'utf8')) as RunCoin[];
  const othersFile = process.argv.includes('--others') ? process.argv[process.argv.indexOf('--others') + 1]! : null;
  const others = othersFile === null ? [] : (JSON.parse(readFileSync(othersFile, 'utf8')) as RunCoin[]);
  const createsFile = process.argv.includes('--creates') ? process.argv[process.argv.indexOf('--creates') + 1]! : null;
  const creates = createsFile === null ? [] : (JSON.parse(readFileSync(createsFile, 'utf8')) as RawSig[]);
  const s = await runReplay({ out: resolve(out!), coins, others, startMs: Date.parse(startIso!), endMs: Date.parse(endIso!), creates, mode });
  console.log(JSON.stringify({ end: s.virtualEnd, wall: s.wallSeconds, refusals: s.refusals }, null, 1));
  process.exit(0);
};

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
