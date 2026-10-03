// The worker's settings from its environment (docs/ARCHITECTURE.md §12.4). Pure: the entry passes the environment in
// (boot/environment.ts is the one place that reads it). Anything refused exits 2; live is never set from here.
import { DEFAULT_HEALTH_ADDR, EXIT, isLoopback } from '../../../runner/src/contract.ts';

export interface WorkerConfig {
  readonly stateDir: string;
  readonly mode: 'paper';
  readonly recorder: boolean;
  readonly simulate: boolean;
  readonly drills: boolean;
  readonly health: { readonly host: string; readonly port: number; readonly addr: string };
  readonly runId: string | null;
  readonly runLabel: string | null;
  /** The release commit: ZEROED_GIT_SHA when set, else the release folder's name, else "unknown". */
  readonly gitSha: string;
  readonly watchdogUrl: string | null;
  readonly heartbeatMs: number;
  /** The bot wallet's public address, when the signer has made one: the dry-run builds use it. */
  readonly wallet: string | null;
  /** Funded public wallets that stand in for the unfunded bot wallet in simulations (TEST-2). */
  readonly standIns: readonly string[];
}

export type Parsed = { readonly ok: true; readonly config: WorkerConfig } | { readonly ok: false; readonly code: number; readonly message: string };

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const parseConfig = (env: Readonly<Record<string, string | undefined>>, release: () => string | null): Parsed => {
  const refuse = (message: string): Parsed => ({ ok: false, code: EXIT.config, message });
  const stateDir = env['STATE_DIRECTORY'] ?? env['ZEROED_STATE_DIR'];
  if (stateDir === undefined || stateDir === '') return refuse('no state directory (STATE_DIRECTORY or ZEROED_STATE_DIR)');
  // Unset is refused too: the mode is always stated, never assumed.
  if (env['ZEROED_MODE'] !== 'paper') return refuse('refused: ZEROED_MODE must be paper');
  const addr = env['ZEROED_HEALTH_ADDR'] ?? DEFAULT_HEALTH_ADDR;
  if (!isLoopback(addr)) return refuse('refused: the health address must be loopback');
  const cut = addr.lastIndexOf(':');
  const port = Number(addr.slice(cut + 1));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return refuse('refused: the health port is out of range');
  const beat = env['ZEROED_HEARTBEAT_MS'] === undefined ? 20_000 : Number(env['ZEROED_HEARTBEAT_MS']);
  if (!Number.isSafeInteger(beat) || beat < 1_000) return refuse('refused: ZEROED_HEARTBEAT_MS must be a whole number of at least 1000');
  const wallet = env['ZEROED_WALLET'] ?? null;
  if (wallet !== null && !ADDRESS.test(wallet)) return refuse('refused: ZEROED_WALLET is not an address');
  const standIns = (env['ZEROED_STANDINS'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (standIns.some((s) => !ADDRESS.test(s))) return refuse('refused: ZEROED_STANDINS holds something that is not an address');
  const watchdog = env['WATCHDOG_URL'] ?? '';
  if (watchdog !== '' && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(watchdog)) return refuse('refused: WATCHDOG_URL must be an https URL');
  return {
    ok: true,
    config: {
      stateDir, mode: 'paper',
      recorder: env['ZEROED_RECORDER'] === 'on', simulate: env['ZEROED_SIMULATE'] === 'on', drills: env['ZEROED_DRILLS'] === 'on',
      health: { host: addr.slice(0, cut).replace(/^\[|\]$/g, ''), port, addr },
      runId: env['ZEROED_RUN_ID'] ?? null, runLabel: env['ZEROED_RUN_LABEL'] ?? null,
      gitSha: env['ZEROED_GIT_SHA'] ?? release() ?? 'unknown',
      watchdogUrl: watchdog === '' ? null : watchdog.replace(/\/$/, ''),
      heartbeatMs: beat, wallet, standIns,
    },
  };
};
