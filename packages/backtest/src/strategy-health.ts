// Strategy health of a finished run (STRATEGY-HEALTH-OBS step 3), observation only: the run's episodes in the order
// they became final, through the same core reducer the worker uses. Built after the run from the scoring side's trades
// (the engine never reads it). A position still held or blocked when the data ends is valued as `tradesOf` values it
// and counts as final at the end; the worker keeps such a position open until it closes.
import {
  type HealthConfig, type HealthObservation, type HealthState, type StrategyIdentity, HEALTH_DEFAULTS, finalEpisodes, initialHealthState,
  newEpisodeEvents, replayHealth,
} from '../../core/src/strategy-health/index.ts';
import type { RunResult } from './run.ts';
import type { StrayCost, TradeRecord } from './trades.ts';

export interface RunHealth {
  readonly observations: readonly HealthObservation[];
  readonly lineages: HealthState['lineages'];
  /** Episodes still open at the end (none in a backtest: every held position is valued at the end). */
  readonly open: number;
}

/** No strategy is registered yet (BT-2): every lineage reports "unregistered", its S still computed. */
export const healthConfig = (registered: readonly StrategyIdentity[] = []): HealthConfig => ({ ...HEALTH_DEFAULTS, registered });

export const runHealth = (
  r: Pick<RunResult, 'book' | 'endedAt'>, scored: { readonly trades: readonly TradeRecord[]; readonly stray: readonly StrayCost[] },
  identity: Omit<StrategyIdentity, 'venue' | 'mode'>, config: HealthConfig = healthConfig(),
): RunHealth => {
  const byId = new Map(scored.trades.map((t) => [t.id, t]));
  const stray = new Map<string, { lamports: bigint; atMs: number }>();
  for (const s of scored.stray) {
    if (s.intentId === undefined) throw new RangeError('a stray cost without its entry intent cannot be grouped into an episode');
    const was = stray.get(s.intentId);
    stray.set(s.intentId, { lamports: (was?.lamports ?? 0n) + s.lamports, atMs: Math.max(was?.atMs ?? 0, s.at) });
  }
  const episodes = finalEpisodes(r.book, {
    identityOf: (i) => ({ ...identity, venue: i.intent.venue, mode: 'backtest' }),
    positionNet: (id) => {
      const t = byId.get(id);
      return t === undefined ? null : { net: t.net, atMs: t.closedAt };
    },
    strayFees: (id) => stray.get(id) ?? { lamports: 0n, atMs: r.endedAt },
  });
  const { state, observations } = replayHealth(newEpisodeEvents(initialHealthState(), episodes), config);
  return { observations, lineages: state.lineages, open: Object.keys(state.open).length };
};
