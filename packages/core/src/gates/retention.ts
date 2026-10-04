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
 * A mint's raw create event (`TX_CREATE_PREFIX`, `LOG_CREATE_PREFIX`). Read by lookup long after it happened: the exits'
 * deployer-sell trigger (`#deployerOf`) and the gates' create alias, for a coin that migrates days after its create. Its
 * newest entry is kept like any key read by lookup, never dropped, until a compact create record replaces those reads
 * (WORKER-GROW G4b).
 */
const RAW_CREATE = /^(logs:)?pump:CreateEvent:/;
/** Keys of one object: a mint's gate facts, a chain event of one mint or pool, an account. Read only near their time. */
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
 * - raw create events: the newest entry kept (see `RAW_CREATE`);
 * - per-object keys: a day, or the candidate window plus the longest hold plus an hour if longer, then gone (a coin
 *   that migrates later has its create fetched again at its shortlist; a missing fact rejects, never passes);
 * - everything else: the newest entry plus an hour of history (read by lookup only).
 */
export const engineRetention = (i: RetentionInputs): Retention => {
  for (const [k, v] of Object.entries(i)) if (!(Number.isSafeInteger(v) && v > 0)) throw new RangeError(`retention: ${k} must be a positive whole number`);
  const trade: RetentionRule = { horizonMs: (i.lookbackDays + 1) * DAY, dropStale: true };
  const perObject: RetentionRule = { horizonMs: Math.max(DAY, i.candidateWindowMs + i.maxHoldMs + HOUR), dropStale: true };
  const rest: RetentionRule = { horizonMs: HOUR, dropStale: false };
  return {
    everyMs: HOUR,
    rule: (key) => (key.startsWith('coverage:') ? 'all' : TRADE.test(key) ? trade : RAW_CREATE.test(key) ? rest : PER_OBJECT.test(key) ? perObject : rest),
  };
};

/** The rule set from the policy (look-back, the longest hold over every exit universe) and the strategy's window. */
export const retentionFor = (policy: Policy, candidateWindowMs: number): Retention => engineRetention({
  lookbackDays: policy.gates.deployerRugLookbackDays,
  candidateWindowMs,
  maxHoldMs: Math.max(...EXIT_UNIVERSES.map((u) => policy.exits.universes[u].tMaxMs)),
});
