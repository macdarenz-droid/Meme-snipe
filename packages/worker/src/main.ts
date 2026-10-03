// The worker entry (docs/ARCHITECTURE.md §12.4): `node packages/worker/src/main.ts` from the release root, Node 22.
// `--reconcile` settles every open intent, writes `open_intents` and exits (the host unit's ExecStartPre); the normal
// start reconciles again, then trades on paper. Exit codes: 0 clean stop, 1 crash, 2 config refused, 3 reconcile failed.
// Paper only: there is no signing key and no path that sends a transaction.
import { readEnvironment } from '../boot/environment.ts';
import { FILL_CONFIG, RESEARCH_CONFIG, RUG_CONFIG, TRIAL_POLICY, startSession } from '../../core/src/config/index.ts';
import { EXIT } from '../../runner/src/contract.ts';
import { DryRunRpc } from './dryrun/index.ts';
import { fetchHttp, globalSocketFactory, heliusRpcUrl } from './providers/index.ts';
import { systemTimers } from './scheduler/index.ts';
import { parseConfig } from './run/config.ts';
import { liveSimulator, provisionalCalibration } from './run/live-sim.ts';
import { PAPER_SCENARIO, strategyConfig } from './run/settings.ts';
import { CreditBook, FEED_COMMITMENTS, LiveProviders, PUMP_CREATE_AUTHORITY } from './run/sources.ts';
import { redact, setSecretValues } from './run/redact.ts';
import { RpcCut } from './run/rpc-cut.ts';
import { runSeed } from './run/seed-start.ts';
import { Worker } from './run/worker.ts';

const environment = readEnvironment();
setSecretValues(environment.secretValues());
const log = (line: string): void => console.log(redact(line));
const fail = (line: string): void => console.error(redact(line));
const observeOnly = environment.argv.includes('--reconcile-only');
const parsed = parseConfig(environment.env, environment.release, environment.qualifyingRun(), { reconcileOnly: observeOnly });
if (!parsed.ok) {
  fail(parsed.message);
  process.exit(parsed.code);
}
if (environment.keyMaterial.length > 0) {
  fail(`refused: environment names that look like key material: ${environment.keyMaterial.join(', ')}`);
  process.exit(EXIT.config);
}
const config = parsed.config;
const timers = systemTimers();
const session = startSession(TRIAL_POLICY);
const credits = new CreditBook(config.stateDir, timers);
const rpcCut = new RpcCut(timers);
const providerHttp = rpcCut.http(fetchHttp);
const providers = new LiveProviders({ tradeStreams: false, secrets: environment.secrets, http: providerHttp, factory: globalSocketFactory, credits });
const policy = session.policy;
const rpc = new DryRunRpc({ url: () => heliusRpcUrl(environment.secrets), http: providerHttp, scheduler: providers.helius, timeoutMs: 10_000 });
let worker: Worker | null = null;
const simulate = liveSimulator({
  rpc, wallet: config.wallet, standIns: config.standIns,
  calibration: provisionalCalibration(new URL('../../core/test/tx/fixtures/golden.json', import.meta.url).pathname),
  poolOf: (mint) => worker?.poolOf(mint) ?? null,
  maxSlippageBps: Math.max(RESEARCH_CONFIG.s0.entryMinOutBelowBps, ...policy.exits.ladder.steps.map((s) => s.minOutBelowTriggerBps)),
  maxPriorityFee: policy.exits.ladder.maxFeePerAttempt, tip: FILL_CONFIG.network.tip, maxTip: FILL_CONFIG.network.tip * 2n,
  lamportsPerSignature: FILL_CONFIG.network.baseFeePerSignature,
});
log(`Credentials present: ${environment.present.length} of 3 provider keys; heartbeat key ${environment.host.heartbeat_hmac_key === null ? 'absent' : 'present'}.`);

const fatal = (e: unknown): never => {
  fail(`Worker crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : 'error'}`);
  process.exit(EXIT.crash);
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

try {
  worker = new Worker({
    config, session, rugs: RUG_CONFIG, strategy: strategyConfig(policy, FILL_CONFIG, RESEARCH_CONFIG, config.strategy.paperEdgePpm ?? 0n, config.strategy.name === 'S0' ? { timing: 'random', salt: config.runId ?? 'S0' } : { timing: 'gates', salt: '' }),
    scenario: FILL_CONFIG.scenarios[PAPER_SCENARIO], network: FILL_CONFIG.network, timers,
    sources: (ctx) => providers.feeds(ctx),
    simulate,
    fetchTx: (sig) => providers.fetchTx(sig),
    seed: (r) => runSeed(r, { rpc: providers.seedRpc(), timers }),
    seedWaitMs: 30_000,
    seedMaxMs: 90_000,
    ops: () => providers.ops(),
    cutRpc: (ms) => rpcCut.cut(ms),
    exposureRpc: providers.seedRpc(),
    delayProbe: { confirmed: (sig) => providers.confirmed(sig), via: `logs:${PUMP_CREATE_AUTHORITY}`, everyMs: 60_000 },
    commitments: FEED_COMMITMENTS,
    heartbeat: { http: fetchHttp, key: environment.host.heartbeat_hmac_key, ownerChatId: environment.host.telegram_chat_id },
    reconcileTimeoutMs: 60_000, loopMs: 100, staleFeedMs: 10_000, log,
  });
} catch (e) {
  fatal(e);
}
const w = worker!;
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  // The unit gives 30 s (TimeoutStopSec); finish within 25 s whatever happens.
  setTimeout(() => process.exit(EXIT.crash), 25_000).unref();
  void w.stop(EXIT.clean).then((code) => {
    credits.flush();
    process.exit(code);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

if (environment.argv.includes('--reconcile')) {
  const r = await w.reconcileOnly();
  credits.flush();
  if (!r.ok) {
    fail(r.message);
    process.exit(r.code);
  }
  log('Reconcile: done, open intents written.');
  process.exit(EXIT.clean);
}

// `--reconcile-only` (RUN-1d's host-loss tabletop): reconcile, journal `recovered`, serve /health, send nothing; it
// runs until SIGTERM. Otherwise the full start.
const started = observeOnly ? await w.observeOnly() : await w.start();
if (!started.ok && !stopping) {
  fail(started.message);
  await w.stop(started.code);
  process.exit(started.code);
}
