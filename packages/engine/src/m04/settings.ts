// M04 settings (A-M04-01 and A-M04-02 config tables) and their validation. Pure.
import type { Result } from '@bot/types';

export interface M04Settings {
  candidateIntervalMs: number;
  positionIntervalMs: number;
  tailIntervalMs: number;
  maxAccountsPerCall: number;
  supplyRefreshMs: number;
  maxProviderLagSlots: number;
  historyMs: number;
  staleLagSlots: number;
  buildLagSlots: number;
  exitLagAlertSlots: number;
  /** `pool_tracker.subscribe.enabled` (A-M04-03): off until the D03 trigger evidence. */
  subscribeEnabled: boolean;
  /** The staleness monitor's period (A-M04-02 logic 4: 500 ms). */
  staleCheckMs: number;
  /** Per-read timeout passed to M14. */
  readTimeoutMs: number;
  /**
   * A pool is also stale when its newest snapshot is older than this plus its class interval (wall clock; #325 red
   * team MAJOR-1: staleness cannot rest on slots alone).
   */
  staleAgeMs: number;
  /**
   * Hard caps on watched pools per class (#325 red team MINOR-1): rings are preallocated, so M04 refuses a watch past
   * them. Candidates: M05's `max_watched` = `max_accounts_per_call ÷ 3` (A-M05-02); tail: 30 (MIGRATION A-M05-02);
   * positions: 10 (POLICY, above any position count the risk limits allow in Phase 0-2).
   */
  maxCandidates: number;
  maxTail: number;
  maxPositions: number;
}

export const M04_DEFAULTS: Readonly<M04Settings> = Object.freeze({
  candidateIntervalMs: 1_000, positionIntervalMs: 500, tailIntervalMs: 10_000,
  // VERIFY A-06 resolved [VF-11]: Solana's getMultipleAccounts takes up to 100 pubkeys and no provider page read states
  // a lower cap; 90 leaves room (solana.com/docs/rpc/http/getmultipleaccounts).
  maxAccountsPerCall: 90,
  supplyRefreshMs: 60_000, maxProviderLagSlots: 10, historyMs: 7_200_000,
  staleLagSlots: 12, buildLagSlots: 8, exitLagAlertSlots: 40,
  subscribeEnabled: false, staleCheckMs: 500, readTimeoutMs: 2_000,
  staleAgeMs: 5_000, maxCandidates: 30, maxTail: 30, maxPositions: 10,
});

const RANGES: ReadonlyArray<[keyof M04Settings, string, number, number]> = [
  ['candidateIntervalMs', 'pool_tracker.candidate_interval_ms', 500, 5_000],
  ['positionIntervalMs', 'pool_tracker.position_interval_ms', 250, 1_000],
  ['tailIntervalMs', 'pool_tracker.tail_interval_ms', 5_000, 60_000],
  ['maxAccountsPerCall', 'pool_tracker.max_accounts_per_call', 3, 100],
  ['supplyRefreshMs', 'pool_tracker.supply_refresh_ms', 10_000, 600_000],
  ['maxProviderLagSlots', 'pool_tracker.max_provider_lag_slots', 2, 50],
  ['historyMs', 'pool_tracker.history_ms', 600_000, 14_400_000],
  ['staleLagSlots', 'pool_tracker.stale_lag_slots', 4, 50],
  ['buildLagSlots', 'pool_tracker.build_lag_slots', 2, 20],
  ['exitLagAlertSlots', 'pool_tracker.exit_lag_alert_slots', 12, 400],
  ['staleCheckMs', 'pool_tracker.stale_check_ms', 100, 5_000],
  ['readTimeoutMs', 'pool_tracker.read_timeout_ms', 100, 30_000],
  ['staleAgeMs', 'pool_tracker.stale_age_ms', 1_000, 60_000],
  ['maxCandidates', 'pool_tracker.max_candidates', 1, 33],
  ['maxTail', 'pool_tracker.max_tail', 0, 100],
  ['maxPositions', 'pool_tracker.max_positions', 1, 20],
];

/**
 * The config tables' ranges; the position interval must be below the candidate interval. The account cap's floor is 3
 * (one pool's accounts; SPEC-A says 1, which could never fit a pool). Integers only.
 */
export function checkM04Settings(s: M04Settings): Result<M04Settings, { code: 'E_CONFIG'; key: string }> {
  for (const [field, key, lo, hi] of RANGES) {
    const v = s[field] as number;
    if (!Number.isInteger(v) || v < lo || v > hi) return { ok: false, error: { code: 'E_CONFIG', key } };
  }
  if (s.positionIntervalMs >= s.candidateIntervalMs) return { ok: false, error: { code: 'E_CONFIG', key: 'pool_tracker.position_interval_ms' } };
  // M05's max_watched: the candidates fit one call per candidate interval (A-M05-02).
  if (s.maxCandidates * 3 > s.maxAccountsPerCall) return { ok: false, error: { code: 'E_CONFIG', key: 'pool_tracker.max_candidates' } };
  if (typeof s.subscribeEnabled !== 'boolean') return { ok: false, error: { code: 'E_CONFIG', key: 'pool_tracker.subscribe.enabled' } };
  return { ok: true, value: s };
}

/** The interval of a priority class. */
export const intervalOf = (s: M04Settings, cls: 'position' | 'candidate' | 'tail'): number =>
  cls === 'position' ? s.positionIntervalMs : cls === 'candidate' ? s.candidateIntervalMs : s.tailIntervalMs;
/** The watch cap of a class. */
export const capOf = (s: M04Settings, cls: 'position' | 'candidate' | 'tail'): number =>
  cls === 'position' ? s.maxPositions : cls === 'candidate' ? s.maxCandidates : s.maxTail;
/** M14 priority of a class's polls (logic 2, C-07): positions P1, candidates P2, tail P4. */
export const priorityOf = (cls: 'position' | 'candidate' | 'tail'): 1 | 2 | 4 => (cls === 'position' ? 1 : cls === 'candidate' ? 2 : 4);
