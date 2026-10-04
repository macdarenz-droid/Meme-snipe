// The worker's settings from its environment (docs/ARCHITECTURE.md §12.4). Pure: the entry passes the environment in
// (boot/environment.ts is the one place that reads it). Anything refused exits 2; live is never set from here.
import { DEFAULT_HEALTH_ADDR, EXIT, REGISTERED_STRATEGIES, isLoopback } from '../../../runner/src/contract.ts';

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
  /**
   * WATCH-1: how often the position watch looks, and how old a held position's market may get before a snapshot is read
   * through the second path (ZEROED_WATCH_EVERY_MS, ZEROED_WATCH_STALE_MS).
   */
  readonly watch: { readonly everyMs: number; readonly staleMs: number; readonly latencyMs: number };
  /** The bot wallet's public address, when the signer has made one: the dry-run builds use it. */
  readonly wallet: string | null;
  /** Funded public wallets that stand in for the unfunded bot wallet in simulations (TEST-2). */
  readonly standIns: readonly string[];
  /**
   * What decides entries. `none`: the gates and risk only; with no proven edge risk refuses every entry. `S0`: the
   * random-entry control (same gates, risk and exits, entry moment drawn in the window) for the non-qualifying
   * shakedown (supervisor ruling 2026-10-04). A qualifying run takes a strategy BT-2 registers.
   */
  readonly strategy: { readonly name: string; readonly paperEdgePpm: bigint | null; readonly qualifying: boolean; readonly s0Diagnostic: boolean };
}

/**
 * WATCH-1 keeps a held position's market younger than the policy's quote age: a market is read again once it is
 * `staleMs` old, seen at most one period late, its answer used only within `latencyMs`, and released by the feed within
 * `releaseMs` (its horizon while slots arrive). So the oldest a market can be when an exit is judged is
 * staleMs + everyMs + latencyMs + releaseMs, which must stay below `maxQuoteAgeMs` (exits treat an older market as no
 * quote). Null when the timing holds; else why not (the entry exits 2, the worker refuses to build).
 */
export const watchTimingProblem = (w: WorkerConfig['watch'], maxQuoteAgeMs: number, releaseMs: number): string | null =>
  w.staleMs + w.everyMs + w.latencyMs + releaseMs < maxQuoteAgeMs ? null
    : `refused: ZEROED_WATCH_STALE_MS + ZEROED_WATCH_EVERY_MS + ZEROED_WATCH_LATENCY_MS + the feed's release (${w.staleMs} + ${w.everyMs} + ${w.latencyMs} + ${releaseMs}) must stay below the policy's quote age of ${maxQuoteAgeMs} ms`;

/** Solana's target slot time; the feed releases an off-chain fact once its horizon of slots has passed. */
export const SLOT_MS = 400;

export type Parsed = { readonly ok: true; readonly config: WorkerConfig } | { readonly ok: false; readonly code: number; readonly message: string };

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The registered strategies live with the run contract (the runner checks the same list). */
export { REGISTERED_STRATEGIES };

/** A qualifying-run file that is present but cannot be read. */
export const UNREADABLE = Symbol('unreadable');

export const parseConfig = (
  env: Readonly<Record<string, string | undefined>>, release: () => string | null,
  /** The qualifying run's name (packages/runner/qualifying-run.json): null when none is asked for. */
  qualifyingRun: string | null | typeof UNREADABLE = null,
  /** `--reconcile-only`: no API is served, so its address is not checked against the health port. */
  o: { readonly reconcileOnly?: boolean } = {},
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
  if (api === null || (apiAddr === addr && o.reconcileOnly !== true)) return refuse('refused: the API port is out of range or the same as the health port');
  const beat = env['ZEROED_HEARTBEAT_MS'] === undefined ? 20_000 : Number(env['ZEROED_HEARTBEAT_MS']);
  if (!Number.isSafeInteger(beat) || beat < 1_000) return refuse('refused: ZEROED_HEARTBEAT_MS must be a whole number of at least 1000');
  const watchEvery = env['ZEROED_WATCH_EVERY_MS'] === undefined ? 200 : Number(env['ZEROED_WATCH_EVERY_MS']);
  if (!Number.isSafeInteger(watchEvery) || watchEvery < 100) return refuse('refused: ZEROED_WATCH_EVERY_MS must be a whole number of at least 100');
  const watchStale = env['ZEROED_WATCH_STALE_MS'] === undefined ? 500 : Number(env['ZEROED_WATCH_STALE_MS']);
  if (!Number.isSafeInteger(watchStale) || watchStale < watchEvery) return refuse('refused: ZEROED_WATCH_STALE_MS must be a whole number of at least ZEROED_WATCH_EVERY_MS');
  const watchLatency = env['ZEROED_WATCH_LATENCY_MS'] === undefined ? 400 : Number(env['ZEROED_WATCH_LATENCY_MS']);
  if (!Number.isSafeInteger(watchLatency) || watchLatency < 50) return refuse('refused: ZEROED_WATCH_LATENCY_MS must be a whole number of at least 50');
  const wallet = env['ZEROED_WALLET'] ?? null;
  if (wallet !== null && !ADDRESS.test(wallet)) return refuse('refused: ZEROED_WALLET is not an address');
  const standIns = (env['ZEROED_STANDINS'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (standIns.some((s) => !ADDRESS.test(s))) return refuse('refused: ZEROED_STANDINS holds something that is not an address');
  const name = env['ZEROED_STRATEGY'] ?? 'none';
  if (name !== 'none' && name !== 'S0' && !REGISTERED_STRATEGIES.includes(name)) return refuse(`refused: ZEROED_STRATEGY must be none, S0 or a registered strategy (${REGISTERED_STRATEGIES.join(', ') || 'none is registered yet'})`);
  // S0 and the paper-only edge never reach the qualifying run (supervisor ruling on the #48 re-review).
  if (qualifyingRun === UNREADABLE) return refuse('refused: packages/runner/qualifying-run.json is unreadable');
  // Fails closed (re-review of f55538f): on the host the worker unit sets no run id, so a release that asks for the
  // qualifying run makes every worker without a run id qualifying. Rehearsals and the shakedown set theirs.
  const runId = env['ZEROED_RUN_ID'];
  const qualifying = qualifyingRun !== null && (runId === undefined || runId === '' || runId === qualifyingRun);
  if (qualifying && (name === 'S0' || edgeText !== undefined)) return refuse('refused: S0 and ZEROED_PAPER_EDGE_PPM are never used in the qualifying run');
  if (qualifying && !REGISTERED_STRATEGIES.includes(name)) return refuse('refused: the qualifying run needs a registered strategy in ZEROED_STRATEGY');
  let paperEdgePpm: bigint | null = null;
  if (edgeText !== undefined) {
    if (name !== 'S0') return refuse('refused: ZEROED_PAPER_EDGE_PPM is only for the S0 shakedown');
    if (!/^[1-9][0-9]{0,6}$/.test(edgeText) || BigInt(edgeText) > 1_000_000n) return refuse('refused: ZEROED_PAPER_EDGE_PPM must be a whole number from 1 to 1000000');
    paperEdgePpm = BigInt(edgeText);
  }
  // WORKER-1e: S0's diagnostic set (core regime.ts `S0DiagnosticPart`), only for the shakedown and never in a release
  // that names a qualifying run, whatever the run id.
  const diagText = env['ZEROED_S0_DIAGNOSTIC'];
  if (diagText !== undefined && diagText !== 'on') return refuse('refused: ZEROED_S0_DIAGNOSTIC must be on or unset');
  const s0Diagnostic = diagText === 'on';
  if (s0Diagnostic && name !== 'S0') return refuse('refused: ZEROED_S0_DIAGNOSTIC is only for the S0 shakedown');
  if (s0Diagnostic && (qualifying || qualifyingRun !== null)) return refuse('refused: ZEROED_S0_DIAGNOSTIC is never used in a release with a qualifying run');
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
      heartbeatMs: beat, watch: { everyMs: watchEvery, staleMs: watchStale, latencyMs: watchLatency }, wallet, standIns,
      strategy: { name, paperEdgePpm, qualifying, s0Diagnostic },
    },
  };
};
