// Strategy health in the worker (STRATEGY-HEALTH-OBS step 3), observation only: after each account publication the
// episodes that became final are fed to core's reducer, the same one the backtest uses, and each observation is
// journaled as a `strategy_health` line beside the decisions. Nothing reads it: entries, exits and risk are unchanged.
// The state is saved in health.json so a restart neither repeats nor loses an observation.
import { feeParts } from '../../../core/src/fills/index.ts';
import type { Book, IntentState } from '../../../core/src/lifecycle/index.ts';
import {
  type HealthConfig, type HealthObservation, type HealthState, type StrategyIdentity, compactHealthState, finalEpisodes, initialHealthState,
  newEpisodeEvents, reduceHealth,
} from '../../../core/src/strategy-health/index.ts';
import type { PaperLegs, PaperTrade } from './account.ts';
import { StateFile } from './state.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const strategyHealthFile = (dir: string) =>
  new StateFile<HealthState>(dir, 'health.json', (v) => (isObj(v) && typeof v['lastSeq'] === 'number' && isObj(v['lineages']) && isObj(v['open']) && isObj(v['finished']) && isObj(v['seen']) ? (v as unknown as HealthState) : null));

/**
 * The line a screen or report shows for a state: always marked as observed, never as a halt or stop (risk review
 * condition), and never on a halt code or the daily-loss chip.
 */
export const healthDisplay = (status: HealthObservation['to']): string => `health: ${status} (observed; entries not stopped)`;

/** The universe and strategy version of an entry, from its key `entry:<mint>:<universe>.<version>.<n>`. */
export const entryOrigin = (i: IntentState): { readonly universe: string; readonly version: string } => {
  const local = String(i.intent.key).split(':').slice(2).join(':');
  const parts = local.split('.');
  return parts.length >= 3 ? { universe: parts[0]!, version: parts.slice(1, -1).join('.') } : { universe: local, version: local };
};

/**
 * A closed trade's whole SOL result: its net at the close plus every settlement booked after it (PAPER-2, #198, keeps
 * those in `late` and exports the same sum as `tradeSol`). Before PAPER-2 a trade has no `late` and this is its net.
 */
export const tradeSolNet = (t: PaperTrade & { readonly late?: readonly { readonly lamports: bigint }[] }): bigint =>
  (t.netLamports ?? 0n) + (t.late ?? []).reduce((sum, l) => sum + l.lamports, 0n);

export class HealthMonitor {
  readonly #file: StateFile<HealthState>;
  readonly #config: HealthConfig;
  readonly #identity: (i: IntentState) => StrategyIdentity;
  #state: HealthState;

  constructor(file: StateFile<HealthState>, config: HealthConfig, identity: (i: IntentState) => StrategyIdentity) {
    this.#file = file;
    this.#config = config;
    this.#identity = identity;
    this.#state = file.read(initialHealthState());
  }

  get state(): HealthState {
    return this.#state;
  }

  /**
   * Observes every episode that is final now: all its positions closed in the paper account with no attempt of its
   * intents still in flight (so its net cannot change after `final`), or an entry that ended with no fill.
   */
  update(book: Book, legs: PaperLegs, trades: readonly PaperTrade[]): HealthObservation[] {
    const inFlight = (intentIds: ReadonlySet<string>) => [...legs.attempts.values()].some((a) => intentIds.has(a.intentId) && a.outcome === 'in_flight');
    const episodes = finalEpisodes(book, {
      identityOf: this.#identity,
      positionNet: (id) => {
        const t = trades.find((x) => x.positionId === id);
        const p = book.positions[id];
        if (t === undefined || p === undefined || p.status !== 'closed' || t.closedAtMs === null || t.netLamports === null) return null;
        const ids = new Set([p.entryIntentId as string, ...Object.values(book.intents).filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === id).map((i) => i.intent.id as string)]);
        return inFlight(ids) ? null : { net: tradeSolNet(t), atMs: t.closedAtMs };
      },
      strayFees: (id) => {
        let lamports = 0n;
        let atMs = 0;
        for (const att of book.intents[id]?.attempts ?? []) {
          const a = legs.attempts.get(att.signature);
          if (a === undefined) continue;
          const f = feeParts(legs.network, a.priorityFee, a.outcome);
          lamports += f.base + f.priority + f.tip;
          atMs = Math.max(atMs, a.sentAtMs ?? 0);
        }
        return { lamports, atMs };
      },
    });
    const events = newEpisodeEvents(this.#state, episodes);
    if (events.length === 0) return [];
    const out: HealthObservation[] = [];
    let s = this.#state;
    for (const e of events) {
      const step = reduceHealth(s, e, this.#config);
      s = step.state;
      if (step.observation) out.push(step.observation);
    }
    this.#state = compactHealthState(s);
    this.#file.write(this.#state);
    return out;
  }
}
