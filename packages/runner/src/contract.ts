// The worker process contract (docs/ARCHITECTURE.md §12.4). WORKER-1 implements it; the stub in
// ../stub/worker.ts implements it for RUN-1's tests and rehearsals. Pure types and pure checks only.

/** Entry the runner starts by default; WORKER-1 creates it. Run from the release root with `node`. */
export const WORKER_ENTRY = 'packages/worker/src/main.ts';
export const STUB_ENTRY = 'packages/runner/stub/worker.ts';

export const EXIT = { clean: 0, crash: 1, config: 2, reconcileFailed: 3 } as const;

/** Runner exit codes. `refused` and `aborted` are in the host unit's RestartPreventExitStatus: never retried. */
export const RUNNER_EXIT = { ok: 0, crash: 1, refused: 2, aborted: 4 } as const;

/** The only worker entries the runner starts (it runs with the API keys in its environment). */
export const ENTRIES: readonly string[] = ['packages/worker/src/main.ts', 'packages/runner/stub/worker.ts'];

export const WORKER_UNIT = 'zeroed-worker.service';
/** Host run names (qualifying-run.json, the zeroed-dryrun@<name> instance). */
export const RUN_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Fallback chain limits: a run is at most 72 h, and a chain stops 2 jobs past what the run needs. */
export const MAX_HOURS = 72;
export const SEGMENT_MINUTES = 335;
export const segmentAllowed = (segment: number, hours: number): boolean =>
  Number.isInteger(segment) && segment >= 1 && hours > 0 && hours <= MAX_HOURS && segment <= Math.ceil((hours * 60) / SEGMENT_MINUTES) + 2;

/** Credential names: files under CREDENTIALS_DIRECTORY (VPS) or the upper-case env variables (GitHub Actions). */
export const SECRET_NAMES = ['HELIUS_API_KEY', 'ALCHEMY_API_KEY', 'JUPITER_API_KEY', 'TELEGRAM_BOT_TOKEN'] as const;

/** Environment names that would mean key material is present. No signing key exists in a dry run. */
export const KEY_ENV = /PRIVATE_KEY|SECRET_KEY|KEYPAIR|SEED|MNEMONIC|WALLET_KEY/i;

/** Why the worker went down in a restart drill (DECISIONS "Follow-up rulings", Standby). */
export type RestartCause = 'crash' | 'reboot' | 'host-loss' | 'chain-rebuild';
export const RESTART_CAUSES: readonly RestartCause[] = ['crash', 'reboot', 'host-loss', 'chain-rebuild'];

/**
 * Evidence in the state dir: kept through a host-loss or chain-rebuild drill (the runner copies them aside and back),
 * because they are the run's record, not the bot's state. Everything else in the state dir is bot state.
 */
export const EVIDENCE_FILES: readonly string[] = ['journal.jsonl', 'recorder'];

export const STATE_FILES = {
  journal: 'journal.jsonl',
  recorder: 'recorder',
  openIntents: 'open_intents',
  drillToken: 'drill.token',
  cleanStop: 'clean_stop',
} as const;

export const DEFAULT_HEALTH_ADDR = '127.0.0.1:8787';

export interface FeedHealth {
  readonly connected: boolean;
  /** Age of the newest message, ms; null before the first one. */
  readonly age_ms: number | null;
  /** True when losing this feed must halt entries (§18 "data freezes"). */
  readonly critical: boolean;
  readonly dropped_by_drill: boolean;
}

/** One provider's scheduler (FEED-1's SchedulerStatus plus credits by class and the plan's monthly budget). Counters start at 0 each boot. */
export interface QuotaStatus {
  readonly provider: string;
  readonly credits_used: number;
  /** Credits by class P0..P3; they sum to credits_used. */
  readonly credits_by_class: readonly [number, number, number, number];
  /** The free plan's monthly credits (Helius credits, Alchemy compute units); null for rate-only providers. */
  readonly monthly_credits: number | null;
  readonly granted: readonly [number, number, number, number];
  readonly shed: readonly [number, number, number, number];
  readonly halted: boolean;
}

/** Bucket upper bounds (ms) of the historical-lookup latency histogram; the last bucket is everything slower. */
export const LOOKUP_BOUNDS_MS = [25, 50, 100, 200, 400, 800, 1600, 3200, 6400] as const;

/** A mark older than this when read is not a price: the exposure move it would give is unmeasured. */
export const MARK_MAX_AGE_MS = 30_000;

export interface OpenPositionHealth {
  readonly trade: string; readonly mint: string; readonly qty: string; readonly entry: string; readonly stop: string;
  readonly mark: string; readonly mark_slot: number; readonly mark_ts: number;
  /** The universe the position was entered under (CFG-2: its exit parameters come from it). */
  readonly universe: string;
}

/** GET /health. The heartbeat fields of docs/research/security.md §5.2 plus what the runner measures. */
export interface Health {
  readonly seq: number;
  readonly ts: number;
  readonly git_sha: string;
  readonly policy_version: string;
  readonly last_processed_slot: number | null;
  readonly feed_ages_ms: Readonly<Record<string, number | null>>;
  /**
   * `mark`: the latest price the position is valued at, a plain decimal string in the unit of `entry`; `mark_slot` and
   * `mark_ts` (ms) say when it was seen. `trade`: the trade id used in the journal.
   */
  readonly open_position: OpenPositionHealth | null;
  /** Every open position, oldest first (WORKER-1c); `open_position` is its first entry, kept for older readers. */
  readonly open_positions: readonly OpenPositionHealth[];
  /** Trade ids with an exit planned or signed and not yet final: what a restart must not lose. */
  readonly pending_exits: readonly string[];
  /** `trades`: the trade ids of the unresolved intents (an entry in flight has an intent and no position yet). */
  readonly unresolved_intents: { readonly count: number; readonly oldest_age_s: number | null; readonly trades: readonly string[] };
  readonly signer: string;
  readonly lease_epoch: number | null;
  readonly sol_reserve: string | null;
  readonly paused: boolean;
  readonly boot: string;
  readonly pid: number;
  readonly uptime_s: number;
  readonly rss_bytes: number;
  readonly mode: 'paper';
  readonly recorder: 'on' | 'off';
  readonly simulation: 'on' | 'off';
  readonly reconciled: boolean;
  /** Reconciled, an exit quote source and a landing path are up: an exit could be sent now (paper: simulated). */
  readonly exit_capable: boolean;
  readonly quota: readonly QuotaStatus[];
  /** Historical lookups since boot: counts per LOOKUP_BOUNDS_MS bucket (length bounds + 1). */
  readonly lookups: { readonly counts: readonly number[] };
  readonly entries_halted: boolean;
  readonly halt_reasons: readonly string[];
  /**
   * Critical alerts up now, one line each; empty when none: WATCH-1's held position with no fresh price, ALERT-EXIT's
   * position whose exit is booked blocked, and the book's other critical alerts this boot (`<code> <subject> (at <time>)`). The part before " (" names the alert; the watchdog pushes each name once.
   */
  readonly critical: readonly string[];
  readonly feeds: Readonly<Record<string, FeedHealth>>;
  readonly journal_seq: number;
  /** Always false in a dry run: no signing key exists. */
  readonly signing_key: false;
  readonly stub?: true;
  /** WORKER-1e: S0's diagnostic set (its parts) when the shakedown runs with it; absent otherwise. */
  readonly s0_diagnostic?: readonly string[];
  /** PRACTICE-ON: what decides entries (`ZEROED_STRATEGY`: none, S0 or a registered strategy), as the start line's `entry_rule`. */
  readonly entry_rule?: string;
}

export type JournalKind =
  | 'start' | 'reconcile' | 'decision' | 'entry' | 'exit' | 'simulation' | 'feed' | 'halt' | 'resume' | 'stop' | 'journal_repair'
  /** A coverage gap of a discovery stream: journaled when it opens (to_ts null) and again when it closes, same gap_id. */
  | 'coverage_gap'
  /** After a restart with an open position: the worst price move over the down window, rebuilt from chain history. */
  | 'exposure'
  /** A critical alert raised or cleared (WATCH-1: `level` critical or cleared, `code`, `mint`). */
  | 'alert'
  /**
   * Written once per boot right after the start reconcile: what the worker found and kept. `source`: 'state' (its
   * own files) or 'chain' (no state: rebuilt from wallet balances and pending signatures by address);
   * `pending_exits` (trade ids); `positions` ([{trade, universe}]).
   */
  | 'recovered'
  /**
   * The first moment in a boot the worker is able to exit: times a host reboot from the worker's own journal. Written
   * before /health first reports `exit_capable: true` in that boot.
   */
  | 'exit_capable'
  /** H15's round-trip simulation of a candidate (WORKER-1e: SIM-1's `SimRecord`, or `not-run` with its reason). Not item 4's `simulation`. */
  | 'h15_sim';

/**
 * The fields of a `recovered` line, typed so the worker writes what the runner reads (no cast can hide drift). A
 * first boot on an empty state dir (the tabletop's chain rebuild, or a genuinely new host) reports source 'chain'.
 */
export interface RecoveredFields {
  readonly source: 'state' | 'chain';
  readonly pending_exits: readonly string[];
  readonly positions: readonly { readonly trade: string; readonly universe: string }[];
}

/** One line of journal.jsonl. Written with a synchronous append per line, so a crash can tear only the last line. */
export interface JournalLine {
  readonly seq: number;
  readonly ts: string;
  readonly boot: string;
  readonly kind: JournalKind;
  readonly reasons?: readonly string[];
  readonly trade?: string;
  readonly ok?: boolean;
  readonly [k: string]: unknown;
}

/** Kinds that must carry at least one reason ("every decision logged with its reasons", §15 item 3). */
export const NEEDS_REASONS: ReadonlySet<JournalKind> = new Set(['decision', 'entry', 'exit', 'halt', 'resume']);

/**
 * Strategies BT-2 has registered (configurations fixed before the holdout): the only entry rules the qualifying run
 * may use (worker refuses anything else; the report fails a named host run whose start lines differ). None yet.
 */
export const REGISTERED_STRATEGIES: readonly string[] = [];

export const isLoopback = (addr: string): boolean => /^(127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(addr);

export interface HealthCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** What the runner refuses to run with, from the first health reply. */
export const checkStartHealth = (h: Health): HealthCheck => {
  const problems: string[] = [];
  if (h.mode !== 'paper') problems.push(`mode ${String(h.mode)}`);
  if (h.recorder !== 'on') problems.push('recorder off');
  if (h.simulation !== 'on') problems.push('simulation off');
  if (h.signing_key !== false) problems.push('a signing key is loaded');
  if (Object.keys(h.feeds).length === 0) problems.push('no feeds reported');
  return { ok: problems.length === 0, problems };
};
