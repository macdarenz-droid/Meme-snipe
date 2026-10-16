// The keyless M1 recorder process (card Z10), started by the host's `worker-start` when the release's
// ops/host-config.json says `"worker": "recorder"` (entry: resolve.mjs, which loads this file). Paper only: no key, no
// signer, no send path, no strategy. See compose.ts for what it wires and health.ts for the host contract.
//
// Environment (set by worker-start or worker-smoke; never a secret):
//   ZEROED_MODE           must be `paper`, else exit 2.
//   ZEROED_HEALTH_ADDR    loopback health route (default 127.0.0.1:8787); ZEROED_API_ADDR the tailnet one (8788).
//   ZEROED_STATE_DIR      worker-smoke's scratch folder: every path goes inside it and the database is created there.
//   STATE_DIRECTORY       the unit's state folder (/var/lib/zeroed) for `open_intents` / `open_positions`.
//   CREDENTIALS_DIRECTORY the unit's credentials; only rpc_shyft_url, rpc_chainstack_url, heartbeat_hmac_key and
//                         telegram_chat_id are read.
//   WATCHDOG_URL, ZEROED_HEARTBEAT_MS  the watchdog heartbeat (OPS-1b).
//   ZEROED_GIT_SHA        the release id; else the folder name of /opt/zeroed/current.
// Exit codes: 0 stopped by a signal; 1 a start refused (the update gate then holds or rolls back); 2 a refused setting.
import { existsSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { UnixMs } from '@bot/types';
import { ENGINE_PATHS, STATE_DIR } from '../paths.ts';
import type { FetchLike } from '../m14/types.ts';
import { FileLogSink } from '../m27/logfile.ts';
import { recorderTimers, recorderWallClock } from './clock.ts';
import { createRecorder, type RecorderPaths, type RunningRecorder } from './compose.ts';
import { cgroupMemory, heartbeatBody, memoryWatch, parseLoopback, reconcile, sendHeartbeat, startHealthServers, type HealthBody } from './health.ts';
import { credentialSecrets } from './rpc.ts';

const env = process.env;
const say = (line: string): void => { process.stdout.write(`${line}\n`); };

if (env.ZEROED_MODE !== 'paper') { say('Refused: ZEROED_MODE must be paper.'); process.exit(2); }
const health = parseLoopback(env.ZEROED_HEALTH_ADDR ?? '127.0.0.1:8787');
const api = env.ZEROED_API_ADDR === undefined || env.ZEROED_API_ADDR === '' ? null : parseLoopback(env.ZEROED_API_ADDR);
if (health === null || (env.ZEROED_API_ADDR !== undefined && env.ZEROED_API_ADDR !== '' && api === null)) { say('Refused: the health and API routes must bind loopback only.'); process.exit(2); }

const scratch = env.ZEROED_STATE_DIR !== undefined && env.ZEROED_STATE_DIR !== '' ? env.ZEROED_STATE_DIR : null;
const stateDir = scratch ?? env.STATE_DIRECTORY ?? STATE_DIR;
const releaseId = ((): string => {
  if (env.ZEROED_GIT_SHA !== undefined && /^[0-9a-f]{7,64}$/.test(env.ZEROED_GIT_SHA)) return env.ZEROED_GIT_SHA;
  try { return basename(readlinkSync('/opt/zeroed/current')); } catch { return 'unknown'; }
})();

if (process.argv.includes('--reconcile')) {
  if (scratch !== null) mkdirSync(stateDir, { recursive: true });
  const r = reconcile(stateDir);
  say(r.ok ? 'Reconcile: 0 open intents, 0 open positions (recorder). OK' : `Reconcile refused: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}

/** The scratch layout of worker-smoke's trial: every path inside its one writable folder. */
const scratchPaths = (d: string): RecorderPaths => ({
  db: join(d, 'bot.db'), preMigrationBackup: join(d, 'premigrate/bot.premigrate'), initMarker: join(d, 'init/first-start'), logDir: join(d, 'log'),
  usageDb: join(d, 'usage/rpc-usage.db'), mdDir: join(d, 'md'), receiptsDir: join(d, 'md/receipts'), ceilings: '/etc/bot/ceilings.json', config: '/etc/bot/config.json',
});
const paths: RecorderPaths = scratch !== null ? scratchPaths(join(scratch, 'recorder')) : {
  db: ENGINE_PATHS.db, preMigrationBackup: ENGINE_PATHS.preMigrationBackup, initMarker: ENGINE_PATHS.initMarker, logDir: ENGINE_PATHS.logDir,
  usageDb: ENGINE_PATHS.rpcUsageDb, mdDir: ENGINE_PATHS.mdDir, receiptsDir: ENGINE_PATHS.receiptsDir, ceilings: '/etc/bot/ceilings.json', config: '/etc/bot/config.json',
};
if (scratch !== null) for (const d of ['premigrate', 'init', 'log', 'usage', 'md/receipts']) mkdirSync(join(scratch, 'recorder', d), { recursive: true });
// The database's own folder (paths.ts: never the marker's), the pre-migration backup's and the log folder, inside the
// unit's 0700 state folder; the folders outside it are the installer's.
for (const d of [dirname(paths.db), dirname(paths.preMigrationBackup), paths.logDir]) mkdirSync(d, { recursive: true, mode: 0o700 });

const credDir = env.CREDENTIALS_DIRECTORY;
const cred = (name: string): string | null => {
  if (credDir === undefined || credDir === '') return null;
  const p = join(credDir, name);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
};
const secrets = credentialSecrets(credDir);
const keyed = secrets.get('RPC_SHYFT_URL') !== undefined || secrets.get('RPC_CHAINSTACK_URL') !== undefined;
const boot = `${recorderWallClock.nowMs().toString(36)}-${process.pid}`;
const startedAt = recorderTimers.nowMs();
const critical = new Map<string, string>();
let rec: RunningRecorder | null = null;
let refusal: string | null = null;
let paused = false;
let seq = 0;

const body = (): HealthBody => {
  const s = rec?.status();
  return {
    mode: 'paper', git_sha: releaseId, boot, seq, recorder: true, signing_key: false, recording: rec !== null, refused: refusal,
    anchored: s?.anchored ?? false, sol_usd_check: s?.solUsdCheck ?? null, rpc_mode: s?.mode ?? null, watched: s?.watched ?? 0, halted: s?.halted ?? null, paused,
    critical: [...critical.values()], evidence: [],
  };
};
const servers = await startHealthServers(api === null ? [health] : [health, api], body);

// The log sink: the day files of M27 (m27.log_dir); in the scratch trial its own folder.
const sink = new FileLogSink({ dir: paths.logDir, clock: recorderWallClock, retentionDays: 14, maxBytesPerDay: 256 * 1_048_576, queueBytes: 8 * 1_048_576 });

const started = await createRecorder({
  paths, secrets, fetch: ((url, init) => fetch(url, init)) as FetchLike, clock: recorderWallClock, scheduler: recorderTimers, releaseId,
  euid: process.geteuid?.() ?? -1, createDb: scratch !== null, logSink: sink, readFile: (p) => readFileSync(p, 'utf8'),
});
if (started.ok) {
  rec = started.value;
  say(`Recorder up: release ${releaseId.slice(0, 12)}, providers ${rec.status().providers.join(', ')}.`);
} else if (!keyed && credDir === undefined) {
  // worker-smoke's trial has no credentials: it proves the release loads and answers its health route, nothing more.
  refusal = `${started.error.reason}: ${started.error.message}`.slice(0, 200);
  say(`Recorder not recording (no credentials in this trial): ${refusal}`);
} else {
  // With the unit's credentials but no read provider, a Deploy with RPC_SHYFT_URL and RPC_CHAINSTACK_URL is missing:
  // refuse loudly, so the update gate holds or rolls back instead of keeping a recorder that cannot record.
  if (!keyed) say('Recorder start refused: no read provider credentials (rpc_shyft_url, rpc_chainstack_url); run Deploy with RPC_SHYFT_URL and RPC_CHAINSTACK_URL.');
  say(`Recorder start refused: ${started.error.reason}: ${started.error.message}`.slice(0, 300));
  for (const s of servers) s.close();
  process.exit(1);
}

// The 75% memory alert (health.ts) and the heartbeat.
const mem = memoryWatch({
  read: () => cgroupMemory(),
  alert: (r) => { critical.set('memory', `Recorder memory at ${r.pct}% of its limit.`); rec?.parts.log.event('critical', 'recorder.memory_high', { rss_bytes: r.anonBytes, limit_bytes: r.limitBytes, pct: r.pct }); },
  cleared: () => { critical.delete('memory'); },
});
const memTimer = setInterval(() => { mem.check(); }, 10_000);
const watchdog = env.WATCHDOG_URL ?? '';
const hbKey = cred('heartbeat_hmac_key');
const ownerChat = cred('telegram_chat_id');
const beat = async (): Promise<void> => {
  seq += 1;
  const s = rec?.status();
  if (s?.halted != null) critical.set('halted', `Recording halted: ${s.halted.slice(0, 80)}.`); else critical.delete('halted');
  if (watchdog === '' || hbKey === null) return;
  const text = heartbeatBody({ seq, boot, gitSha: releaseId, lastSlot: null, critical: [...critical.values()], ownerChat, uptimeS: Math.floor((recorderTimers.nowMs() - startedAt) / 1000) }, recorderWallClock.nowMs() as UnixMs, paused);
  const r = await sendHeartbeat({ url: watchdog, key: hbKey, body: text, nowMs: recorderWallClock.nowMs(), fetch });
  if (r.paused !== undefined) paused = r.paused;                    // echoed back so the state and the message agree
};
const hbMs = Number(env.ZEROED_HEARTBEAT_MS ?? 20_000);
void beat();
const hbTimer = setInterval(() => { void beat(); }, Number.isFinite(hbMs) && hbMs >= 1_000 ? hbMs : 20_000);

const stop = async (): Promise<void> => {
  clearInterval(hbTimer);
  clearInterval(memTimer);
  await rec?.stop();
  for (const s of servers) s.close();
  process.exit(0);
};
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
