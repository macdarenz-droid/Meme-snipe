// RPC gateway: read rate limiting, priorities, pinning and failover (A-M14-02; ARCH M14 rules), with the owner's
// data-source rule (2026-10-06): rates at most half of each documented limit (checked in providers.ts), response bytes
// metered against half of each documented byte limit (a call without room for its answer fails at once with
// `byte_budget`; nothing waits for bytes), one request in flight per provider, Retry-After honoured on 429
// and 403 with exponential back-off, and a provider stopped after three 429/403 answers within ten minutes until an
// operator resumes it (the stop, the counted answers and the pause survive a restart through the StopStore port).
// Nothing retries in a loop: a call tries each eligible provider at most once. Every duration runs on the scheduler's
// monotonic clock (review C03 R5).
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62): review fixes R1, R3-R8, R10, N1-N4 and red team rounds R3-R12
// with the supervisor's byte-budget rulings 1-4 (SPEC-A A-M14-02) included.
import type { Clock, Result } from '@bot/types';
import type { RequestOptions, RpcClient, TooLargeInfo } from './client.ts';
import { methodSpec, type MethodClass } from './methods.ts';
import { floorProblems, type ProviderRegistry } from './providers.ts';
import { DeadlineHeap, FifoList, type QueueEntry } from './queue.ts';
import { MAX_TIMER_MS } from './timers.ts';
import type {
  CallOptions, CallValue, GatewayContext, GatewayMode, LogPort, MetricsPort, Priority, ResolvedProvider, RpcError,
  RpcGateway, Scheduler,
} from './types.ts';

/** `rpc.p0_reserve_bps`: share of every bucket only P0 may use (2,000; range 1,000-5,000). */
export const DEFAULT_P0_RESERVE_BPS = 2_000;
/** `rpc.default_timeout_ms` per priority (A-M14-02 config), for callers choosing `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS: Readonly<Record<Priority, number>> = Object.freeze({ 0: 2_000, 1: 3_000, 2: 5_000, 3: 10_000, 4: 30_000 });
/** 429 back-off: 1 s without Retry-After, doubling with each answer in the window up to 60 s [LD-26]. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/**
 * POLICY (review C03 R6): the longest pause a Retry-After may ask for (10 minutes, the stop window). A provider asking
 * for longer is stopped with the critical log, so an operator decides when to resume it.
 */
export const MAX_PAUSE_MS = 600_000;
/**
 * Owner rule (2026-10-06): a provider is stopped after this many 429 or 403 answers within STOP_WINDOW_MS, whether or
 * not successes came between them (a live capture on 2026-10-07 saw 429s alternate with successes on the public RPC).
 */
export const STOP_AFTER_LIMITED = 3;
/** POLICY: the window over which rate-limit answers are counted (10 minutes). */
export const STOP_WINDOW_MS = 600_000;
/**
 * POLICY (review C03 R1): the most calls one provider holds waiting at one priority. A full queue answers
 * `E_RATE_LIMITED` `queue_full` at once (a P0/P1 read then fails over). Per priority, so a P4 burst never refuses P0.
 * A queue drains at most rps × timeout calls before they expire (public RPC at P4: 5/s × 30 s = 150).
 */
export const DEFAULT_MAX_QUEUED = 10_000;
/**
 * POLICY (red team C03 R5-1, R6-1, R8-1, R8-2, R9-2): the hold. After a request of a method ends `too_large`, the
 * method's calls send nothing and fail at once with `E_RATE_LIMITED` `byte_budget` and `retryAfterMs` until the window
 * has room for its need (`needBytes`) or this long has passed; then one request goes with the room left minus the
 * reserve (`admit`), and the hold starts again unless it succeeds. There is no probe (supervisor directive on R6-1). A
 * method whose answer is known to be above what an unknown-size read may ever use, or above the client's own cap
 * (`rpc.max_response_bytes`, which the client reports; R8-2), never has room, so within one process it sends at most one
 * request per 10 minutes per provider: a read that holds the provider's one in-flight slot while it transfers. An
 * answer above the client's own cap starts the hold on every provider, metered or not (supervisor ruling 3, R9-2). The
 * needs, the holds and the byte meter live in memory: a restart forgets them, so every restart allows one more such
 * read.
 */
export const OVERSIZED_HOLD_MS = 600_000;
/**
 * Supervisor ruling (2), 2026-10-07 (red team C03 R9-1): a read of unknown size, or the one read after a hold, leaves
 * a reserve for other methods in every byte window: the larger of RESERVE_BPS of the window's budget and
 * RESERVE_ANSWERS times the largest answer of any other method in the window. Applied as written (red team C03
 * R11-1): when the reserve is at least the bytes left, the read is refused (`byte_budget`, `retryAfterMs` until the
 * large answer leaves the window, at most its length) rather than taking bytes from the reserve. The reserve covers
 * only methods with an answer in the window (red team R12-1). Accepted cost of ruling (1) (red team R12-2): a reader of
 * known size whose next large answer arrives before its last one leaves keeps one in the window, so a first read of
 * unknown size (after a restart, for instance) may be refused on every call for as long as that reader runs. Each
 * refusal is immediate, counted and sends nothing.
 */
export const RESERVE_BPS = 1_000;
export const RESERVE_ANSWERS = 2;
/**
 * POLICY (red team C03 R9-1): the bytes a read of unknown size may take past its cap, so the reserve still holds after
 * the network chunk that crosses the cap. Node's fetch has no documented chunk size; measured on Node 22.23.2 (undici
 * 6.28.0) on 2026-10-07 with an 8 MB body and a reader pausing 20-300 ms, one chunk held at most 195,584 bytes over
 * HTTP and 114,688 over HTTPS. The gateway raises a provider's allowance to the largest overshoot it sees there.
 */
export const OVERSHOOT_BYTES = 262_144;

/**
 * A provider stopped after rate-limit answers, or because the StopStore could not be read (review C03 red team R3-2), as
 * the StopStore keeps it. `stoppedAtMs` is wall time, for display.
 */
export interface StoppedProvider { label: string; stoppedAtMs: number; reason: StopReason }
export type StopReason = 'rate_limited' | 'retry_after_too_long' | 'stop_store_invalid';
const STOP_REASONS: ReadonlySet<unknown> = new Set<StopReason>(['rate_limited', 'retry_after_too_long', 'stop_store_invalid']);
/**
 * A provider's 429/403 answers within the stop window and the end of its pause, in wall time (`pausedUntilMs` 0: no
 * pause), as the StopStore keeps them (review C03 N4).
 */
export interface RecentLimited { label: string; limitedAtMs: readonly number[]; pausedUntilMs: number }
export interface StopState { stopped: readonly StoppedProvider[]; recent: readonly RecentLimited[] }
/**
 * Durable record of stopped providers and of recent 429/403 answers (review C03 R8, N4): the gateway loads it at
 * start, saves it again when it held entries (so stored times ahead of a stepped-back wall clock are re-based once;
 * red team R3-3) and on every rate-limit answer, stop and resume. So a restart never gives a provider that stopped us
 * three more 429/403 answers, a crash loop that restarts after each 429 still reaches the stop at the third, and a
 * Retry-After pause still holds after a restart (no longer than it was set, at most MAX_PAUSE_MS). A store that cannot
 * be loaded or has another shape stops every configured provider (`stop_store_invalid`) with the critical log
 * `m14.stop_store_invalid`, and is not written until an operator resumes a provider (red team R3-2). The composition
 * root (M26) wires it to durable storage. Operator resume path: `resumeProvider(label)` (M26's operator command), which
 * clears the stop and the counted answers; with the process down, removing the label from the store has the same
 * effect.
 */
export interface StopStore { load(): StopState; save(state: StopState): void }

export interface GatewayDeps {
  registry: ProviderRegistry;
  context: GatewayContext;
  client: RpcClient;
  /** Wall clock: only for `StoppedProvider.stoppedAtMs`. */
  clock: Clock;
  /** Timers and the monotonic clock every pacing, pause, deadline and window uses. */
  scheduler: Scheduler;
  log: LogPort;
  metrics: MetricsPort;
  stopStore: StopStore;
  p0ReserveBps?: number;
  /** Calls one provider holds waiting per priority (DEFAULT_MAX_QUEUED). */
  maxQueued?: number;
  /** A-M14-05 burn-rate projection. Without it every metered provider counts as projected above 80% (fail closed). */
  usage?: { projectedOver80(label: string): boolean };
  /** A-M14-05 degraded mode; `normal` without it. */
  mode?: () => GatewayMode;
  /**
   * `rpc.send_enabled` (default false). Calls with `role = 'send'` are refused before any request (`E_RPC`,
   * `send_disabled`) until M4 wires the send path (A-M14-04, card limit "no sending code" before M4; review C03-R1-6).
   */
  sendEnabled?: boolean;
  /**
   * The starting overshoot allowance of every provider with a byte limit (OVERSHOOT_BYTES). A RangeError when it leaves
   * an empty window of any of them less than 1 byte (red team R11-2).
   */
  overshootBytes?: number;
}

/** `pausedUntilMs` is on the scheduler's monotonic clock. */
export interface ProviderStatus { label: string; inFlight: boolean; queued: number; pausedUntilMs: number; recentLimited: number; stopped: boolean }

export interface Gateway extends RpcGateway {
  /** Clears a stopped provider (operator action after three 429/403 answers in the window). */
  resumeProvider(label: string): boolean;
  status(): ProviderStatus[];
}

/**
 * Spacing limiter with one token and no burst (GCRA): a request may start at `tat` or later and moves `tat` on by
 * 1/rate. In any half-open window of W ms at most ceil(W × rate / 1000) requests start.
 */
class Pacer {
  private tat = Number.NEGATIVE_INFINITY;
  private readonly intervalMs: number;
  constructor(rps: number) { this.intervalMs = 1000 / rps; }
  readyAt(): number { return this.tat; }
  take(now: number): void { this.tat = Math.max(now, this.tat) + this.intervalMs; }
}

/** A bucket with the P0 reserve: every request takes `all`; requests below P0 also take `others` (the 80% share). */
class Bucket {
  private readonly all: Pacer;
  private readonly others: Pacer;
  constructor(rps: number, reserveBps: number) {
    this.all = new Pacer(rps);
    this.others = new Pacer((rps * (10_000 - reserveBps)) / 10_000);
  }
  readyAt(p0: boolean): number { return p0 ? this.all.readyAt() : Math.max(this.all.readyAt(), this.others.readyAt()); }
  take(now: number, p0: boolean): void {
    this.all.take(now);
    if (!p0) this.others.take(now);
  }
}

/**
 * Response bytes over a sliding window against half of a documented byte limit (owner rule; review C03 R3). A request
 * may read at most the budget left in the window (the client aborts a larger answer as `too_large`, after the network
 * chunk that crossed it), so with one request in flight any window of the documented length holds at most the budget
 * plus one chunk. The budget never makes a call wait or hold another (supervisor directive, red team C03 R6-1): a call
 * goes only when the window has room for its method's need, else it fails at once (`admit`). Each answer keeps its
 * method, for the reserve a read of unknown size leaves to the others (supervisor ruling 2, R9-1).
 */
class ByteMeter {
  private readonly log: Array<{ at: number; bytes: number; method: string }> = [];
  private head = 0;
  private sum = 0;
  readonly budget: number;
  readonly windowMs: number;
  constructor(budget: number, windowMs: number) {
    this.budget = budget;
    this.windowMs = windowMs;
  }
  private evict(now: number): void {
    for (let e = this.log[this.head]; e !== undefined && e.at <= now - this.windowMs; e = this.log[this.head]) {
      this.sum -= e.bytes;
      this.head += 1;
    }
    if (this.head > 64 && this.head * 2 > this.log.length) { this.log.splice(0, this.head); this.head = 0; }
  }
  record(now: number, bytes: number, method: string): void {
    this.evict(now);
    this.log.push({ at: now, bytes, method });
    this.sum += bytes;
  }
  /** Bytes a request may read now (≤ 0: none). */
  remaining(now: number): number {
    this.evict(now);
    return this.budget - this.sum;
  }
  /**
   * When at least `need` bytes of budget are free: `now` if they are, else when enough of the oldest answers leave
   * the window. `need` is at most the budget, so the loop ends by the last entry.
   */
  freeAt(now: number, need: number): number {
    this.evict(now);
    let sum = this.sum;
    let i = this.head;
    while (this.budget - sum < need) {
      sum -= (this.log[i] as { bytes: number }).bytes;
      i += 1;
    }
    return i === this.head ? now : (this.log[i - 1] as { at: number }).at + this.windowMs;
  }
  /**
   * Bytes a read of unknown size may use with `left` bytes left and `largest` the largest answer of another method in
   * the window: `left` minus the reserve (supervisor ruling 2, as written; red team R11-1).
   */
  private roomOf(left: number, largest: number): number {
    return left - Math.max((this.budget * RESERVE_BPS) / 10_000, RESERVE_ANSWERS * largest);
  }
  /** Bytes a read of unknown size of `method` may use now (≤ 0: none). */
  room(now: number, method: string): number {
    this.evict(now);
    let largest = 0;
    for (let i = this.head; i < this.log.length; i += 1) {
      const e = this.log[i] as { bytes: number; method: string };
      if (e.method !== method && e.bytes > largest) largest = e.bytes;
    }
    return this.roomOf(this.budget - this.sum, largest);
  }
  /**
   * When `room(method)` is at least `need` if nothing else is read: `now`, when enough of the oldest answers leave the
   * window, or +∞ when even an empty window has too little (it keeps RESERVE_BPS of the budget).
   */
  roomAt(now: number, method: string, need: number): number {
    this.evict(now);
    // largestFrom[k]: the largest answer of another method from entry head + k on.
    const n = this.log.length - this.head;
    const largestFrom = new Array<number>(n + 1).fill(0);
    for (let k = n - 1; k >= 0; k -= 1) {
      const e = this.log[this.head + k] as { bytes: number; method: string };
      largestFrom[k] = Math.max(largestFrom[k + 1] as number, e.method === method ? 0 : e.bytes);
    }
    let sum = this.sum;
    for (let k = 0; k <= n; k += 1) {
      if (this.roomOf(this.budget - sum, largestFrom[k] as number) >= need) return k === 0 ? now : (this.log[this.head + k - 1] as { at: number }).at + this.windowMs;
      if (k < n) sum -= (this.log[this.head + k] as { bytes: number }).bytes;
    }
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * A provider's byte windows: half of each documented byte limit (owner rule), times this process's share of it (Z03
 * ruling 15; `ProviderConfig.budgetShareBps`, the whole budget when absent).
 */
const byteLimits = (p: ResolvedProvider): Array<{ budget: number; windowMs: number }> =>
  p.config.documentedLimits.filter((d) => d.scope === 'bytes')
    .map((d) => ({ budget: Math.floor((d.count * 0.5 * (p.config.budgetShareBps ?? 10_000)) / 10_000), windowMs: d.windowMs }));
/** The most a read of unknown size may use in empty windows of these budgets: the least budget less its reserve, less the overshoot. */
const emptyRoom = (budgets: readonly number[], overshoot: number): number =>
  Math.floor(Math.min(...budgets.map((b) => b - (b * RESERVE_BPS) / 10_000))) - overshoot;

interface Waiter extends QueueEntry {
  method: string; params: readonly unknown[]; o: CallOptions; enqueuedAt: number; methodClass: MethodClass;
  resolve: (r: Result<CallValue<unknown>, RpcError>) => void;
}

interface ProviderState {
  p: ResolvedProvider; label: string; total: Bucket; classes: Map<MethodClass, Bucket>; methods: Map<string, Bucket>;
  bytes: ByteMeter[]; inFlight: boolean;
  /**
   * Per method, the room a request needs (`admit`): the bytes of its last complete answer. A `too_large` sets it to the
   * answer's declared length (above a whole budget: infinity); for an answer cut at its cap (no Content-Length, size
   * unknown) to twice the bytes read, at most the room of an empty window (`maxRoom`; red team R6-1, R8-1, R9-1), or to
   * infinity when more than that was read; and for an answer above the client's own cap (R8-2) to infinity. A
   * `too_large` never lowers it: only a complete answer does (red team R5-1).
   */
  needBytes: Map<string, number>;
  /** Methods whose need is a size (a complete answer or a declared length); the others read with the reserve kept. */
  sized: Set<string>;
  /** The bytes a read of unknown size may take past its cap (OVERSHOOT_BYTES, raised to the largest seen). */
  overshoot: number;
  /**
   * Per method, when (monotonic) its hold started (OVERSIZED_HOLD_MS): when a request ended `too_large` (on any provider
   * when the answer was above the client's own cap), or when the one request after a hold was sent. A complete answer
   * removes it.
   */
  heldAt: Map<string, number>;
  /** Waiting calls: per priority, a FIFO per method (calls of one method share every bucket, so only heads matter). */
  queues: Array<Map<string, FifoList<Waiter>>>; counts: number[]; deadlines: DeadlineHeap<Waiter>;
  pausedUntil: number; limitedAt: number[]; stopped: StoppedProvider | null;
  timer: { at: number; cancel: () => void } | null;
}

/**
 * Solana's JSON-RPC NodeUnhealthy error, "Node is behind by N slots" or "Node is unhealthy" (Z03 ruling 13; VERIFY:
 * anza-xyz/agave rpc-client-api/src/custom_error.rs at 4cd046d7fea12e330bbab0af9f0b019650e8afbe, read 2026-10-08:
 * `JSON_RPC_SERVER_ERROR_NODE_UNHEALTHY: i64 = -32005`). The node is lagging, not limiting us: a P0/P1 read fails over
 * to the next provider, and the answer never counts toward the stop rule.
 */
export const JSON_RPC_NODE_UNHEALTHY = -32005;

const PRIORITIES: readonly Priority[] = [0, 1, 2, 3, 4];
const failoverable = (e: RpcError): boolean => e.code === 'E_RATE_LIMITED' || e.code === 'E_TIMEOUT'
  || (e.code === 'E_HTTP' && (e.httpStatus === undefined || e.httpStatus === 403 || e.httpStatus >= 500))
  || (e.code === 'E_RPC' && e.rpcCode === JSON_RPC_NODE_UNHEALTHY);
const isLimited = (e: RpcError): boolean => e.code === 'E_RATE_LIMITED' || (e.code === 'E_HTTP' && e.httpStatus === 403);
const err = (code: RpcError['code'], message: string, retryAfterMs?: number): { ok: false; error: RpcError } =>
  ({ ok: false, error: { code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } });
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNumber = (x: unknown): x is number => typeof x === 'number';
/** The StopState shape (numbers may be NaN or infinite: restoring handles those). */
function isStopState(x: unknown): x is StopState {
  return isRecord(x) && Array.isArray(x.stopped) && Array.isArray(x.recent)
    && x.stopped.every((s) => isRecord(s) && typeof s.label === 'string' && isNumber(s.stoppedAtMs) && STOP_REASONS.has(s.reason))
    && x.recent.every((r) => isRecord(r) && typeof r.label === 'string' && Array.isArray(r.limitedAtMs) && r.limitedAtMs.every(isNumber)
      && isNumber(r.pausedUntilMs));
}

export function createRpcGateway(deps: GatewayDeps): Gateway {
  const reserveBps = deps.p0ReserveBps ?? DEFAULT_P0_RESERVE_BPS;
  if (!Number.isInteger(reserveBps) || reserveBps < 1_000 || reserveBps > 5_000) throw new RangeError('rpc.p0_reserve_bps must be 1,000-5,000');
  const maxQueued = deps.maxQueued ?? DEFAULT_MAX_QUEUED;
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 1) throw new RangeError('maxQueued must be a positive integer');
  const overshoot0 = deps.overshootBytes ?? OVERSHOOT_BYTES;
  if (!Number.isSafeInteger(overshoot0) || overshoot0 < 0) throw new RangeError('overshootBytes must be a non-negative integer');
  // An allowance that leaves an empty window less than 1 byte would refuse every read of unknown size for good (R11-2).
  for (const p of deps.registry.providers) {
    const budgets = byteLimits(p).map((b) => b.budget);
    if (budgets.length > 0 && emptyRoom(budgets, overshoot0) < 1) {
      throw new RangeError(`overshootBytes leaves no room in an empty byte window of provider ${p.config.label}`);
    }
  }
  // Z03 ruling 31: a provider loaded under an allocation share keeps one request a minute below this gateway's own P0
  // reserve, which may differ from the reserve the registry was checked with.
  for (const p of deps.registry.providers) {
    if (p.config.budgetShareBps === undefined) continue;
    const problems = floorProblems(p.config.limits, reserveBps);
    if (problems.length > 0) throw new RangeError(`provider ${p.config.label}: with rpc.p0_reserve_bps ${reserveBps} its share leaves ${problems.join('; ')}`);
  }
  const modeOf = deps.mode ?? ((): GatewayMode => 'normal');
  const over80 = (c: ResolvedProvider['config']): boolean => c.metering !== null && (deps.usage?.projectedOver80(c.label) ?? true);
  const mono = (): number => deps.scheduler.nowMs();
  let seq = 0;

  let loaded: unknown;
  let problem: 'load_failed' | 'bad_shape' | null = null;
  try {
    loaded = deps.stopStore.load();
  } catch {
    problem = 'load_failed';
  }
  if (problem === null && !isStopState(loaded)) problem = 'bad_shape';
  const valid: StopState = problem === null ? loaded as StopState : { stopped: [], recent: [] };
  const restored = new Map(valid.stopped.map((x) => [x.label, x]));
  const recentLoaded = new Map(valid.recent.map((x) => [x.label, x]));
  /**
   * Stored wall times on this process's monotonic clock; a time ahead of the wall clock (stepped back) counts as now.
   * The pause was set at the latest answer, so it restores no longer than it was set (red team R3-3; without a stored
   * answer, at most MAX_PAUSE_MS).
   */
  const restoreRecent = (label: string): { limitedAt: number[]; pausedUntil: number } => {
    const r = recentLoaded.get(label);
    if (r === undefined) return { limitedAt: [], pausedUntil: Number.NEGATIVE_INFINITY };
    const mono0 = mono();
    const wall0 = deps.clock.nowMs();
    // A NaN time drops out at the filter, and a NaN pause end is no pause (both comparisons are false).
    const limitedAt = r.limitedAtMs.map((at) => mono0 - Math.max(0, wall0 - at)).filter((t) => t > mono0 - STOP_WINDOW_MS).sort((a, b) => a - b);
    const latest = r.limitedAtMs.reduce((a, b) => (Number.isFinite(b) ? Math.max(a, b) : a), Number.NEGATIVE_INFINITY);
    const left = Math.min(r.pausedUntilMs - wall0, r.pausedUntilMs - latest, MAX_PAUSE_MS);
    return { limitedAt, pausedUntil: left > 0 ? mono0 + left : Number.NEGATIVE_INFINITY };
  };
  const stoppedAt0 = problem === null ? 0 : deps.clock.nowMs();
  const states: ProviderState[] = deps.registry.providers.map((p) => {
    const l = p.config.limits;
    const classes = new Map<MethodClass, Bucket>();
    if (l.heavyRps !== undefined) classes.set('heavy', new Bucket(l.heavyRps, reserveBps));
    if (l.sendRps !== undefined) classes.set('send', new Bucket(l.sendRps, reserveBps));
    const bytes = byteLimits(p).map((b) => new ByteMeter(b.budget, b.windowMs));
    return {
      p, label: p.config.label, total: new Bucket(l.rps, reserveBps), classes, methods: new Map(), bytes, inFlight: false, needBytes: new Map(),
      sized: new Set(), overshoot: overshoot0, heldAt: new Map(),
      queues: PRIORITIES.map(() => new Map<string, FifoList<Waiter>>()), counts: PRIORITIES.map(() => 0), deadlines: new DeadlineHeap<Waiter>(),
      ...restoreRecent(p.config.label), timer: null,
      stopped: problem === null ? restored.get(p.config.label) ?? null : { label: p.config.label, stoppedAtMs: stoppedAt0, reason: 'stop_store_invalid' },
    };
  });
  const byLabel = new Map(states.map((s) => [s.label, s]));
  if (problem === null) {
    for (const st of states) {
      if (st.stopped !== null) deps.log.event('critical', 'm14.provider_stopped', { provider: st.label, restored: true, reason: st.stopped.reason });
    }
  } else {
    deps.log.event('critical', 'm14.stop_store_invalid', { problem });
    for (const st of states) deps.log.event('critical', 'm14.provider_stopped', { provider: st.label, reason: 'stop_store_invalid' });
  }

  /**
   * Saves every stopped provider and every provider's answers within the stop window and pause, in wall time, keeping
   * entries for labels this process does not configure.
   */
  const saveStops = (): void => {
    const now = mono();
    const wall = deps.clock.nowMs();
    const toWall = (t: number): number => wall - (now - t);
    const stopped = states.flatMap((st) => (st.stopped === null ? [] : [st.stopped]));
    const recent = states.flatMap((st): RecentLimited[] => {
      const at = st.limitedAt.filter((t) => t > now - STOP_WINDOW_MS);
      const paused = st.pausedUntil > now;
      return at.length === 0 && !paused ? [] : [{ label: st.label, limitedAtMs: at.map(toWall), pausedUntilMs: paused ? toWall(st.pausedUntil) : 0 }];
    });
    try {
      deps.stopStore.save({
        stopped: [...[...restored.values()].filter((x) => !byLabel.has(x.label)), ...stopped],
        recent: [...[...recentLoaded.values()].filter((x) => !byLabel.has(x.label)), ...recent],
      });
    } catch {
      deps.log.event('error', 'm14.stop_store_failed', {});        // the stop and the count still hold in memory
    }
  };
  // Re-bases stored times ahead of the wall clock once (red team R3-3); an empty store needs no write.
  if (problem === null && (valid.stopped.length > 0 || valid.recent.length > 0)) saveStops();

  const bucketsFor = (st: ProviderState, w: Waiter): Bucket[] => {
    const out = [st.total];
    const cls = st.classes.get(w.methodClass);
    if (cls !== undefined) out.push(cls);
    const perMethod = st.p.config.limits.perMethodRps;
    if (perMethod !== undefined) {
      let b = st.methods.get(w.method);
      if (b === undefined) { b = new Bucket(perMethod, reserveBps); st.methods.set(w.method, b); }
      out.push(b);
    }
    return out;
  };

  const queueGauge = (st: ProviderState, pr: Priority): void => {
    deps.metrics.gauge('rpc_queue_depth', { provider: st.label, priority: `P${pr}` }).set(st.counts[pr] as number);
  };

  /** Takes a waiter out of both structures (it was dispatched, expired or failed). */
  const unlink = (st: ProviderState, w: Waiter): void => {
    w.list?.remove(w);
    st.deadlines.remove(w);
    st.counts[w.o.priority] = (st.counts[w.o.priority] as number) - 1;
  };

  const setTimer = (st: ProviderState, at: number): void => {
    if (st.timer !== null) {
      if (st.timer.at === at) return;
      st.timer.cancel();
    }
    const cancel = deps.scheduler.set(() => { st.timer = null; pump(st); }, Math.max(1, Math.ceil(at - mono())));
    st.timer = { at, cancel };
  };

  const failQueue = (st: ProviderState, message: string): void => {
    st.timer?.cancel();
    st.timer = null;
    for (let w = st.deadlines.peek(); w !== undefined; w = st.deadlines.peek()) {
      unlink(st, w);
      w.resolve(err('E_RATE_LIMITED', message));
    }
    for (const pr of PRIORITIES) queueGauge(st, pr);
  };

  /**
   * A `byte_budget` refusal; `retryAfterMs` is always finite (red team R11-2). `at` is +∞ only when the overshoot
   * allowance, raised at run time by a chunk seen past a cap, leaves an empty window no room: no read of unknown size
   * can then go on this provider in this process, and the caller is told to ask again after a hold, never at once.
   */
  const refuse = (st: ProviderState, method: string, now: number, at: number): { ok: false; error: RpcError } => {
    deps.metrics.counter('rpc_byte_budget_refused_total', { provider: st.label, method }).inc();
    return err('E_RATE_LIMITED', 'byte_budget', Number.isFinite(at) ? Math.max(1, Math.ceil(at - now)) : OVERSIZED_HOLD_MS);
  };
  /** Bytes a read of unknown size of `method` may use now: the least room over every byte window, minus the overshoot. */
  const roomFor = (st: ProviderState, method: string, now: number): number =>
    Math.floor(Math.min(...st.bytes.map((m) => m.room(now, method)))) - st.overshoot;
  /** The most a read of unknown size may ever use on a provider: an empty window's room. */
  const maxRoom = (st: ProviderState): number => emptyRoom(st.bytes.map((m) => m.budget), st.overshoot);

  /**
   * Byte admission (supervisor rulings 2026-10-07 on red team C03 R6-1 and R9-1; R8-1): the byte budget never makes a
   * call wait or hold another, and a call that cannot succeed sends nothing. When a call is queued and again when its
   * turn comes:
   * - a method whose answer size is known (`sized`) goes with all the room left (the least over every byte budget) if
   *   that room holds its `needBytes`;
   * - a method of unknown size goes with the room left minus the reserve for other methods and minus the overshoot
   *   (`roomFor`) if that holds its need (at least 1 byte), so a method with an answer in the current window is not
   *   refused because of its read (ruling 2, as written: with a large answer of another method in the window it is
   *   refused until that answer leaves; red team R11-1). A method with no answer in the window (a first read, or one
   *   whose last answer has left) is not protected: the read may take the room that method needs (red team R12-1);
   * - once the method's hold has passed, one request goes with `roomFor` if it is at least 1 byte (`dispatch` starts
   *   the next hold).
   * Otherwise it fails at once with `E_RATE_LIMITED` `byte_budget` and `retryAfterMs`: when room for its need frees if
   * nothing else is read, or when its hold ends, whichever is first. A P0/P1 read then fails over. A provider without a
   * byte limit refuses only a method in its hold (ruling 3, R9-2).
   */
  const admit = (st: ProviderState, method: string, now: number):
    { ok: true; cap: number | undefined; afterHold: boolean } | { ok: false; error: RpcError } => {
    const holdEnd = (st.heldAt.get(method) ?? Number.POSITIVE_INFINITY) + OVERSIZED_HOLD_MS;
    if (st.bytes.length === 0) {
      if (!st.heldAt.has(method)) return { ok: true, cap: undefined, afterHold: false };
      return now >= holdEnd ? { ok: true, cap: undefined, afterHold: true } : refuse(st, method, now, holdEnd);
    }
    const need = Math.max(1, st.needBytes.get(method) ?? 1);
    const sized = st.sized.has(method);
    if (sized) {
      const left = Math.floor(Math.min(...st.bytes.map((m) => m.remaining(now))));
      if (left >= need) return { ok: true, cap: left, afterHold: false };
    }
    const room = roomFor(st, method, now);
    if (!sized && room >= need) return { ok: true, cap: room, afterHold: false };
    if (now >= holdEnd && room >= 1) return { ok: true, cap: room, afterHold: true };
    const freeAt = (n: number): number => (st.bytes.every((m) => n <= m.budget)
      ? Math.max(...st.bytes.map((m) => m.freeAt(now, n))) : Number.POSITIVE_INFINITY);
    const roomAt = (n: number): number => Math.max(...st.bytes.map((m) => m.roomAt(now, method, n + st.overshoot)));
    // A need that never fits always comes with a hold (`startHold`), so `at` is finite unless an empty window has no
    // room at all (`refuse` then answers with a hold's length).
    const at = Math.min(sized ? freeAt(need) : roomAt(need), Math.max(holdEnd, roomAt(1)));
    return refuse(st, method, now, at);
  };

  /**
   * A request of `method` ended `too_large`: raises its need (never lowers it; red team R5-1) and starts its hold, with
   * the log `m14.byte_hold_started` (R8-3). An answer above the client's own cap (R8-2) never fits; one refused on its
   * declared length needs that length (above a whole budget it never fits); one cut at its cap needs twice what was
   * read, at most an empty window's room, so a read cut by a busy window waits for an emptier one, not for the hold
   * (R8-1); one cut past an empty window's room never fits.
   */
  const startHold = (st: ProviderState, method: string, t: TooLargeInfo): void => {
    let size = Number.POSITIVE_INFINITY;
    if (!t.overOwnCap && st.bytes.length > 0) {
      const budget = Math.min(...st.bytes.map((m) => m.budget));
      const most = maxRoom(st);
      if (t.declared) size = t.atLeastBytes > budget ? Number.POSITIVE_INFINITY : t.atLeastBytes;
      else size = t.atLeastBytes > most ? Number.POSITIVE_INFINITY : Math.min(2 * t.atLeastBytes, most);
    }
    const need = Math.max(st.needBytes.get(method) ?? 0, size);
    st.needBytes.set(method, need);
    if (t.declared) st.sized.add(method);
    else st.sized.delete(method);
    st.heldAt.set(method, mono());
    deps.log.event('warn', 'm14.byte_hold_started', {
      provider: st.label, method, need_bytes: Number.isFinite(need) ? need : null, at_least_bytes: t.atLeastBytes, declared: t.declared,
      over_own_cap: t.overOwnCap, hold_ms: OVERSIZED_HOLD_MS,
    });
  };

  /** The oldest call, highest priority first, whose buckets all have a token now; `wake` is told when the others do. */
  const nextReady = (st: ProviderState, now: number, wake: (at: number) => void): Waiter | null => {
    for (const pr of PRIORITIES) {
      if (st.counts[pr] === 0) continue;
      let best: Waiter | null = null;
      for (const q of (st.queues[pr] as Map<string, FifoList<Waiter>>).values()) {
        const w = q.head;
        if (w === null) continue;
        const tokenAt = Math.max(...bucketsFor(st, w).map((b) => b.readyAt(pr === 0)));
        if (tokenAt > now) { wake(tokenAt); continue; }
        if (best === null || w.seq < best.seq) best = w;
      }
      if (best !== null) return best;
    }
    return null;
  };

  function pump(st: ProviderState): void {
    if (st.stopped !== null) { failQueue(st, 'provider_stopped'); return; }
    const now = mono();
    for (let w = st.deadlines.peek(); w !== undefined && w.deadline <= now; w = st.deadlines.peek()) {
      unlink(st, w);
      queueGauge(st, w.o.priority);
      w.resolve(err('E_RATE_LIMITED', 'no_token_before_timeout'));
    }
    // A call refused for bytes takes no token, so the next call may go in the same pass.
    for (let first = st.deadlines.peek(); first !== undefined; first = st.deadlines.peek()) {
      let wakeAt = first.deadline;
      // While a request is in flight (one per provider), wake at the next deadline so a waiting call can fail over in time.
      if (st.inFlight) { setTimer(st, wakeAt); return; }
      if (now < st.pausedUntil) { setTimer(st, Math.min(wakeAt, st.pausedUntil)); return; }
      const w = nextReady(st, now, (at) => { wakeAt = Math.min(wakeAt, at); });
      if (w === null) { setTimer(st, wakeAt); return; }
      unlink(st, w);
      queueGauge(st, w.o.priority);
      const a = admit(st, w.method, now);
      if (!a.ok) { w.resolve(a); continue; }
      for (const b of bucketsFor(st, w)) b.take(now, w.o.priority === 0);
      dispatch(st, w, now, a.cap, a.afterHold);
      return;
    }
    st.timer?.cancel();
    st.timer = null;
  }

  function dispatch(st: ProviderState, w: Waiter, now: number, cap: number | undefined, afterHold: boolean): void {
    st.inFlight = true;
    deps.metrics.histogram('rpc_wait_ms', { priority: `P${w.o.priority}` }).observe(now - w.enqueuedAt);
    const o: RequestOptions = { role: w.o.role, timeoutMs: w.deadline - now, ...(w.o.commitment === undefined ? {} : { commitment: w.o.commitment }) };
    // The one request after a hold starts the next hold, so one that ends without an answer (a timeout, a network error)
    // is not repeated on the next call either; a complete answer ends it, a too_large restarts it.
    if (afterHold) st.heldAt.set(w.method, now);
    let read = 0;
    let tooLarge: TooLargeInfo | null = null;
    if (cap !== undefined) o.byteBudget = cap;
    o.onBytes = (n) => {
      read = n;
      for (const m of st.bytes) m.record(mono(), n, w.method);
    };
    o.onTooLarge = (t) => { tooLarge = t; };
    const settle = (answer: Result<CallValue<unknown>, RpcError>): void => {
      st.inFlight = false;
      // Z03 rulings 4 and 13: a JSON-RPC error (HTTP 200) is a rate limit only when the provider documents that exact code
      // and message as one.
      const rateLimited = !answer.ok && answer.error.code === 'E_RPC'
        && st.p.config.rateLimitRpcErrors.some((e) => e.code === answer.error.rpcCode && e.message === answer.error.message);
      const r: Result<CallValue<unknown>, RpcError> = rateLimited && !answer.ok
        ? { ok: false, error: { code: 'E_RATE_LIMITED', message: 'rpc_rate_limited', ...(answer.error.rpcCode === undefined ? {} : { rpcCode: answer.error.rpcCode }) } }
        : answer;
      if (r.ok) {
        if (cap !== undefined) {
          st.needBytes.set(w.method, read);
          st.sized.add(w.method);
        }
        st.heldAt.delete(w.method);
      } else if (r.error.message === 'too_large') {
        // Without a byte budget the only cap is the client's own.
        const t: TooLargeInfo = tooLarge ?? { atLeastBytes: read, declared: false, overOwnCap: cap === undefined };
        if (cap !== undefined && !t.declared) st.overshoot = Math.max(st.overshoot, t.atLeastBytes - cap);
        // Above the client's own cap the answer fits no provider: the hold starts on every one (ruling 3, R9-2).
        for (const s of t.overOwnCap ? states : [st]) startHold(s, w.method, t);
      }
      if (!r.ok && isLimited(r.error)) onLimited(st, r.error);
      else if (!r.ok && r.error.code === 'E_HTTP' && r.error.httpStatus === 503 && r.error.retryAfterMs !== undefined) onUnavailable(st, r.error.retryAfterMs);
      w.resolve(r);
      pump(st);
    };
    // The client returns errors as values; a throw (a bug, or a failing bus subscriber) still frees the provider.
    deps.client.request<unknown>(st.p, w.method, w.params, o).then(settle, () => settle(err('E_HTTP', 'internal_error')));
  }

  function stop(st: ProviderState, reason: StoppedProvider['reason'], fields: Record<string, unknown>): void {
    st.stopped = { label: st.label, stoppedAtMs: deps.clock.nowMs(), reason };
    deps.log.event('critical', 'm14.provider_stopped', { provider: st.label, reason, ...fields });
  }

  function onLimited(st: ProviderState, e: RpcError): void {
    const now = mono();
    st.limitedAt = [...st.limitedAt.filter((t) => t > now - STOP_WINDOW_MS), now];
    const n = st.limitedAt.length;
    if (e.httpStatus === 429) deps.metrics.counter('rpc_429_total', { provider: st.label }).inc();
    // Z03 ruling 1: max(Retry-After, BASE × 2^(n−1)), so a Retry-After of 0, a past date or junk (read as absent by the
    // client) never gives a zero pause; the back-off is capped at BACKOFF_MAX_MS and Retry-After at MAX_PAUSE_MS below.
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
    const pauseMs = Math.max(e.retryAfterMs ?? 0, backoff);
    const status = e.httpStatus ?? 0;
    // The pause also holds after a stop, so an operator's early resume still waits it out (at most MAX_PAUSE_MS).
    st.pausedUntil = now + Math.min(pauseMs, MAX_PAUSE_MS);
    if (pauseMs > MAX_PAUSE_MS) {
      stop(st, 'retry_after_too_long', { limited_in_window: n, http_status: status, retry_after_ms: pauseMs });
    } else if (n >= STOP_AFTER_LIMITED) {
      stop(st, 'rate_limited', { limited_in_window: n, http_status: status });
    } else {
      deps.log.event('warn', 'm14.provider_paused', { provider: st.label, pause_ms: pauseMs, http_status: status });
    }
    saveStops();                                                // every answer, so a restart still counts it (N4)
  }

  /**
   * Z03 ruling m9: a 503 with Retry-After pauses the provider for that long (at most MAX_PAUSE_MS). It is not a rate
   * limit, so it does not count toward the stop rule.
   */
  function onUnavailable(st: ProviderState, retryAfterMs: number): void {
    const pauseMs = Math.min(retryAfterMs, MAX_PAUSE_MS);
    st.pausedUntil = Math.max(st.pausedUntil, mono() + pauseMs);
    deps.log.event('warn', 'm14.provider_paused', { provider: st.label, pause_ms: pauseMs, http_status: 503 });
    saveStops();
  }

  function enqueue(st: ProviderState, method: string, params: readonly unknown[], o: CallOptions, deadline: number, methodClass: MethodClass):
    Promise<Result<CallValue<unknown>, RpcError>> {
    if ((st.counts[o.priority] as number) >= maxQueued) return Promise.resolve(err('E_RATE_LIMITED', 'queue_full'));
    const a = admit(st, method, mono());                           // no room for its bytes now: fail at once, never queue
    if (!a.ok) return Promise.resolve(a);
    return new Promise((resolve) => {
      const w: Waiter = { method, params, o, seq: seq++, enqueuedAt: mono(), deadline, methodClass, resolve, list: null, prev: null, next: null, heapAt: -1 };
      const byMethod = st.queues[o.priority] as Map<string, FifoList<Waiter>>;
      let q = byMethod.get(method);
      if (q === undefined) { q = new FifoList<Waiter>(); byMethod.set(method, q); }
      q.push(w);
      st.deadlines.push(w);
      st.counts[o.priority] = (st.counts[o.priority] as number) + 1;
      queueGauge(st, o.priority);
      pump(st);
    });
  }

  /** Eligible providers in the order a call tries them (A-M14-02 logic 3, 4, 6, 7). */
  function candidates(method: string, o: CallOptions, mode: GatewayMode): ProviderState[] | RpcError {
    if (o.provider !== undefined && !byLabel.has(o.provider)) return { code: 'E_RPC', message: 'unknown_provider' };
    // Z03 ruling 4: a method is sent only to a provider that serves it; with none, the call fails with a named error.
    const serving = states.filter((st) => st.p.config.methods.includes(method) && (o.provider === undefined || st.label === o.provider));
    if (serving.length === 0) return { code: 'E_RPC', message: 'method_not_served' };
    const eligible = serving.filter((st) => {
      const c = st.p.config;
      if (st.stopped !== null || !c.roles.includes(o.role)) return false;
      if (deps.context === 'engine' && !c.allowInLivePaths) return false;
      if (o.provider !== undefined && c.label !== o.provider) return false;
      if (o.priority >= 2 && !c.unmeteredPrimary) return false;
      if (o.priority >= 1 && over80(c) && !(mode === 'degraded_reads' && o.priority === 1)) return false;
      return true;
    });
    const now = mono();
    const ordered = eligible.sort((a, b) => Number(b.p.config.unmeteredPrimary) - Number(a.p.config.unmeteredPrimary)
      || a.p.config.failoverOrder - b.p.config.failoverOrder);
    if (o.role === 'send') return ordered.slice(0, 1);
    // A paused provider goes last, so a failover call tries a provider that can answer now first.
    return [...ordered.filter((st) => st.pausedUntil <= now), ...ordered.filter((st) => st.pausedUntil > now)];
  }

  return {
    async call<T>(method: string, params: unknown[], o: CallOptions): Promise<Result<CallValue<T>, RpcError>> {
      if (!PRIORITIES.includes(o.priority) || !(Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 && o.timeoutMs <= MAX_TIMER_MS)) return err('E_RPC', 'bad_options');
      if (o.role === 'send' && deps.sendEnabled !== true) return err('E_RPC', 'send_disabled');
      const spec = methodSpec(method);
      if (spec === null) return err('E_RPC', 'unknown_method');
      const mode = modeOf();
      if (mode === 'degraded_reads' && o.priority >= 2) return err('E_RATE_LIMITED', 'degraded');
      const list = candidates(method, o, mode);
      if (!Array.isArray(list)) return { ok: false, error: list };
      if (list.length === 0) return err('E_ALL_PROVIDERS_DOWN', 'no_eligible_provider');
      const deadline = mono() + o.timeoutMs;
      const mayFailover = o.provider === undefined && o.role === 'read' && o.priority <= 1;
      let lastLabel = '';
      let last: RpcError = { code: 'E_TIMEOUT', message: 'timeout' };
      let tried = 0;
      for (const [i, st] of list.entries()) {
        const now = mono();
        if (tried > 0) {
          if (now >= deadline) break;
          deps.metrics.counter('rpc_failover_total', { from: lastLabel, to: st.label }).inc();
        }
        // A call that may fail over gives each provider but the last half of its remaining time, so a timeout or a
        // busy provider still leaves time for the next one (logic 4: "retry on the next eligible provider while time
        // remains").
        const attemptDeadline = mayFailover && i < list.length - 1 ? now + (deadline - now) / 2 : deadline;
        const r = await enqueue(st, method, params, o, attemptDeadline, spec.methodClass);
        if (r.ok) return r as Result<CallValue<T>, RpcError>;
        tried += 1;
        lastLabel = st.label;
        last = r.error;
        if (!mayFailover || !failoverable(r.error)) return { ok: false, error: r.error };
      }
      if (tried < list.length) return { ok: false, error: last };          // time ran out before every provider was tried
      return { ok: false, error: { code: 'E_ALL_PROVIDERS_DOWN', message: `all_failed:${last.code}`, ...(last.retryAfterMs === undefined ? {} : { retryAfterMs: last.retryAfterMs }) } };
    },
    mode: modeOf,
    resumeProvider(label: string): boolean {
      const st = byLabel.get(label);
      if (st === undefined || st.stopped === null) return false;
      st.stopped = null;
      st.limitedAt = [];
      deps.log.event('info', 'm14.provider_resumed', { provider: label });
      saveStops();
      return true;
    },
    status(): ProviderStatus[] {
      return states.map((st) => ({
        label: st.label, inFlight: st.inFlight, queued: st.counts.reduce((a, b) => a + b, 0), pausedUntilMs: st.pausedUntil,
        recentLimited: st.limitedAt.filter((t) => t > mono() - STOP_WINDOW_MS).length, stopped: st.stopped !== null,
      }));
    },
  };
}
