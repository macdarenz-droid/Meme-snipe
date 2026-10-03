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
  /** The app's read API: loopback only (OPS publishes it to the tailnet with `tailscale serve`). */
  readonly api: { readonly host: string; readonly port: number; readonly addr: string };
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
  /**
   * What decides entries. `none`: the gates and risk only; with no proven edge risk refuses every entry. `S0`: the
   * random-entry control (same gates, risk and exits, entry moment drawn in the window) for the non-qualifying
   * shakedown (supervisor ruling 2026-10-04). A qualifying run takes a strategy BT-2 registers.
   */
  readonly strategy: { readonly name: string; readonly paperEdgePpm: bigint | null; readonly qualifying: boolean };
}

export type Parsed = { readonly ok: true; readonly config: WorkerConfig } | { readonly ok: false; readonly code: number; readonly message: string };

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Strategies BT-2 has registered (their configurations fixed before the holdout): the only entry rules a qualifying
 * run may use. None yet, so no run qualifies.
 */
export const REGISTERED_STRATEGIES: readonly string[] = [];

/** A qualifying-run file that is present but cannot be read. */
export const UNREADABLE = Symbol('unreadable');

export const parseConfig = (
  env: Readonly<Record<string, string | undefined>>, release: () => string | null,
  /** The qualifying run's name (packages/runner/qualifying-run.json): null when none is asked for. */
  qualifyingRun: string | null | typeof UNREADABLE = null,
): Parsed => {
  const refuse = (message: string): Parsed => ({ ok: false, code: EXIT.config, message });
  const stateDir = env['STATE_DIRECTORY'] ?? env['ZEROED_STATE_DIR'];
  if (stateDir === undefined || stateDir === '') return refuse('no state directory (STATE_DIRECTORY or ZEROED_STATE_DIR)');
  // A paper-only edge lets risk size S0's shakedown entries; it never reaches any other mode (supervisor ruling).
  const edgeText = env['ZEROED_PAPER_EDGE_PPM'];
  if (edgeText !== undefined && env['ZEROED_MODE'] !== 'paper') return refuse('refused: ZEROED_PAPER_EDGE_PPM is a paper-only setting');
  // Unset is refused too: the mode is always stated, never assumed.
  if (env['ZEROED_MODE'] !== 'paper') return refuse('refused: ZEROED_MODE must be paper');
  const addr = env['ZEROED_HEALTH_ADDR'] ?? DEFAULT_HEALTH_ADDR;
  if (!isLoopback(addr)) return refuse('refused: the health address must be loopback');
  const hostPort = (a: string) => {
    const cut = a.lastIndexOf(':');
    const port = Number(a.slice(cut + 1));
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? { host: a.slice(0, cut).replace(/^\[|\]$/g, ''), port, addr: a } : null;
  };
  const health = hostPort(addr);
  if (health === null) return refuse('refused: the health port is out of range');
  const apiAddr = env['ZEROED_API_ADDR'] ?? '127.0.0.1:8788';
  if (!isLoopback(apiAddr)) return refuse('refused: the API address must be loopback (OPS publishes it to the tailnet)');
  const api = hostPort(apiAddr);
  if (api === null || apiAddr === addr) return refuse('refused: the API port is out of range or the same as the health port');
  const beat = env['ZEROED_HEARTBEAT_MS'] === undefined ? 20_000 : Number(env['ZEROED_HEARTBEAT_MS']);
  if (!Number.isSafeInteger(beat) || beat < 1_000) return refuse('refused: ZEROED_HEARTBEAT_MS must be a whole number of at least 1000');
  const wallet = env['ZEROED_WALLET'] ?? null;
  if (wallet !== null && !ADDRESS.test(wallet)) return refuse('refused: ZEROED_WALLET is not an address');
  const standIns = (env['ZEROED_STANDINS'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (standIns.some((s) => !ADDRESS.test(s))) return refuse('refused: ZEROED_STANDINS holds something that is not an address');
  const name = env['ZEROED_STRATEGY'] ?? 'none';
  if (name !== 'none' && name !== 'S0' && !REGISTERED_STRATEGIES.includes(name)) return refuse(`refused: ZEROED_STRATEGY must be none, S0 or a registered strategy (${REGISTERED_STRATEGIES.join(', ') || 'none is registered yet'})`);
  // S0 and the paper-only edge never reach the qualifying run (supervisor ruling on the #48 re-review).
  if (qualifyingRun === UNREADABLE) return refuse('refused: packages/runner/qualifying-run.json is unreadable');
  const qualifying = qualifyingRun !== null && env['ZEROED_RUN_ID'] === qualifyingRun;
  if (qualifying && (name === 'S0' || edgeText !== undefined)) return refuse('refused: S0 and ZEROED_PAPER_EDGE_PPM are never used in the qualifying run');
  if (qualifying && !REGISTERED_STRATEGIES.includes(name)) return refuse('refused: the qualifying run needs a registered strategy in ZEROED_STRATEGY');
  let paperEdgePpm: bigint | null = null;
  if (edgeText !== undefined) {
    if (name !== 'S0') return refuse('refused: ZEROED_PAPER_EDGE_PPM is only for the S0 shakedown');
    if (!/^[1-9][0-9]{0,6}$/.test(edgeText) || BigInt(edgeText) > 1_000_000n) return refuse('refused: ZEROED_PAPER_EDGE_PPM must be a whole number from 1 to 1000000');
    paperEdgePpm = BigInt(edgeText);
  }
  const watchdog = env['WATCHDOG_URL'] ?? '';
  if (watchdog !== '' && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(watchdog)) return refuse('refused: WATCHDOG_URL must be an https URL');
  return {
    ok: true,
    config: {
      stateDir, mode: 'paper',
      recorder: env['ZEROED_RECORDER'] === 'on', simulate: env['ZEROED_SIMULATE'] === 'on', drills: env['ZEROED_DRILLS'] === 'on',
      health, api,
      runId: env['ZEROED_RUN_ID'] ?? null, runLabel: env['ZEROED_RUN_LABEL'] ?? null,
      gitSha: env['ZEROED_GIT_SHA'] ?? release() ?? 'unknown',
      watchdogUrl: watchdog === '' ? null : watchdog.replace(/\/$/, ''),
      heartbeatMs: beat, wallet, standIns,
      strategy: { name, paperEdgePpm, qualifying },
    },
  };
};
