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
import { CreditBook, LiveProviders } from './run/sources.ts';
import { Worker } from './run/worker.ts';

const log = (line: string): void => console.log(line);
const environment = readEnvironment();
const parsed = parseConfig(environment.env, environment.release);
if (!parsed.ok) {
  console.error(parsed.message);
  process.exit(parsed.code);
}
if (environment.keyMaterial.length > 0) {
  console.error(`refused: environment names that look like key material: ${environment.keyMaterial.join(', ')}`);
  process.exit(EXIT.config);
}
const config = parsed.config;
const timers = systemTimers();
const session = startSession(TRIAL_POLICY);
const credits = new CreditBook(config.stateDir, timers);
const providers = new LiveProviders({ secrets: environment.secrets, http: fetchHttp, factory: globalSocketFactory, credits });
const policy = session.policy;
const rpc = new DryRunRpc({ url: () => heliusRpcUrl(environment.secrets), http: fetchHttp, scheduler: providers.helius, timeoutMs: 10_000 });
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
  console.error(`Worker crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : 'error'}`);
  process.exit(EXIT.crash);
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

try {
  worker = new Worker({
    config, session, rugs: RUG_CONFIG, strategy: strategyConfig(policy, FILL_CONFIG, RESEARCH_CONFIG),
    scenario: FILL_CONFIG.scenarios[PAPER_SCENARIO], network: FILL_CONFIG.network, timers,
    sources: (ctx) => providers.feeds(ctx),
    simulate,
    fetchCreate: (sig) => providers.fetchCreate(sig),
    // SEED-1 supplies the seed (DeployerIndex.seed); until it lands the index starts empty and H14 stays not covered.
    seedDeployers: async () => 'not seeded (SEED-1 not wired yet); H14 not covered until the look-back passes',
    heartbeat: { http: fetchHttp, key: environment.host.heartbeat_hmac_key, ownerChatId: environment.host.telegram_chat_id },
    reconcileTimeoutMs: 60_000, loopMs: 100, staleFeedMs: 10_000, log,
  });
} catch (e) {
  fatal(e);
}
const w = worker!;

if (environment.argv.includes('--reconcile')) {
  const r = await w.reconcileOnly();
  credits.flush();
  if (!r.ok) {
    console.error(r.message);
    process.exit(r.code);
  }
  log(`Reconcile: done, open intents written.`);
  process.exit(EXIT.clean);
}

const started = await w.start();
if (!started.ok) {
  console.error(started.message);
  await w.stop(started.code);
  process.exit(started.code);
}
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
