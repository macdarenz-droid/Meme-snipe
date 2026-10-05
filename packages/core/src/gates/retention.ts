// What the engine's as-of store keeps over a long run (WORKER-GROW). The store used to keep every released event for
// the whole process: about 140 MB a day live, past the worker's MemoryMax in a few days. One rule set, built from the
// policy and the strategy's windows, is passed by live, the parity replay and the backtest alike, so they prune the same.
//
// Who reads the store, and how far back (checked by reading every `lookup` and `history` call, WORKER-GROW):
// - `history` is read only by the coverage readers (`createsCoverage`: every `coverage:*` entry from the start) and the
//   trade-tail checks (GATE-1c: a candidate pool's trades since migration, its curve trades with no start).
// - Everything else is read by `lookup` as of now: the newest entry. Keeping each key's newest entry keeps every answer.
import { DAY_MS, EXIT_UNIVERSES, HOUR_MS, type Policy } from '../config/index.ts';
import type { Retention, RetentionRule } from '../engine/index.ts';

const HOUR = HOUR_MS;
const DAY = DAY_MS;

/** Trade-event keys the tail checks read (`poolTradeKeys`, `curveTradeKeys`), in their decoded and log forms. */
const TRADE = /^(logs:)?(pump_amm:(BuyEvent|SellEvent)|pump:TradeEvent):/;
/**
 * Keys of one object: a mint's gate facts, a chain event of one mint or pool, an account. Read only near their time.
 * Raw create events (`pump:CreateEvent`) are among them: the gates' create alias and the exits' `#deployerOf` read them
 * only for a shortlisted or held mint, so the worker fetches a create again at the shortlist when the store no longer
 * holds it and keeps a held position's deployer from its entry (WORKER-GROW: kept for the whole process, they grew the
 * store by about 87 MB a day).
 */
const PER_OBJECT = /^(gates\/(mint|pool|lp|curve|create|migration|candles|holders|insiders|deployer|sim|xcheck|soft):|(logs:)?(pump|pump_amm):|account:)/;

export interface RetentionInputs {
  /** The deployer and rug look-back (policy.gates.deployerRugLookbackDays). */
  readonly lookbackDays: number;
  /** The latest a candidate is judged after its migration (the strategy's windowToMs). */
  readonly candidateWindowMs: number;
  /** The longest a position is held (the largest exit universe's tMaxMs). */
  readonly maxHoldMs: number;
}

/**
 * The rule set:
 * - `coverage:*`: every entry (its readers replay the stream from the start; the stream is a few lines a day);
 * - trade-event keys: the look-back plus a day, then gone (a candidate's tape since migration is hours old; a curve
 *   tape older than that is the same as one never seen, which the curve check already accepts);
 * - per-object keys, raw create events among them: a day, or the candidate window plus the longest hold plus an hour if longer, then gone (a coin
 *   that migrates later has its create fetched again at its shortlist; a missing fact rejects, never passes);
 * - everything else: the newest entry plus an hour of history (read by lookup only);
 * - `oneShot` keys (a caller's facts that are only observed as they are released, never looked up, such as the
 *   worker's seed with the whole saved deployer index): an hour, then gone.
 */
export const engineRetention = (i: RetentionInputs, oneShot: readonly string[] = []): Retention => {
  for (const [k, v] of Object.entries(i)) if (!(Number.isSafeInteger(v) && v > 0)) throw new RangeError(`retention: ${k} must be a positive whole number`);
  const once = new Set(oneShot);
  const trade: RetentionRule = { horizonMs: (i.lookbackDays + 1) * DAY, dropStale: true };
  const perObject: RetentionRule = { horizonMs: Math.max(DAY, i.candidateWindowMs + i.maxHoldMs + HOUR), dropStale: true };
  const oneHour: RetentionRule = { horizonMs: HOUR, dropStale: true };
  const rule = (key: string): RetentionRule => (key.startsWith('coverage:') ? null : once.has(key) ? oneHour : TRADE.test(key) ? trade : PER_OBJECT.test(key) ? perObject : HOUR);
  return Object.assign(rule, { sweep: true as const });
};

/** The rule set from the policy (look-back, the longest hold over every exit universe) and the strategy's window. */
export const retentionFor = (policy: Policy, candidateWindowMs: number, oneShot: readonly string[] = []): Retention => engineRetention({
  lookbackDays: policy.gates.deployerRugLookbackDays,
  candidateWindowMs,
  maxHoldMs: Math.max(...EXIT_UNIVERSES.map((u) => policy.exits.universes[u].tMaxMs)),
}, oneShot);

/**
 * How old a held raw create may be at a shortlist and still outlive the candidate window and the longest hold under the
 * per-object horizon (one hour more for the hourly prune). An older one, or none, is fetched again by the worker.
 */
export const createRefreshAgeMs = (policy: Policy, candidateWindowMs: number): number => {
  const maxHoldMs = Math.max(...EXIT_UNIVERSES.map((u) => policy.exits.universes[u].tMaxMs));
  const horizon = Math.max(DAY, candidateWindowMs + maxHoldMs + HOUR);
  return Math.max(0, horizon - (candidateWindowMs + maxHoldMs + 2 * HOUR));
};

/** The worker's facts that are only observed as released (its seed, carrying the saved deployer index). */
export const LIVE_ONE_SHOT: readonly string[] = ['worker:seed'];

const live = new WeakMap<Policy, Map<number, Retention>>();

/**
 * The one rule object of everything that claims live parity: the live worker, the parity replay and the backtest's
 * default (not BT-2's study, which keeps its own `STUDY_RETENTION`). The same policy and window give the same object.
 */
export const liveRetention = (policy: Policy, candidateWindowMs: number): Retention => {
  let byWindow = live.get(policy);
  if (byWindow === undefined) live.set(policy, (byWindow = new Map()));
  let r = byWindow.get(candidateWindowMs);
  if (r === undefined) byWindow.set(candidateWindowMs, (r = retentionFor(policy, candidateWindowMs, LIVE_ONE_SHOT)));
  return r;
};
