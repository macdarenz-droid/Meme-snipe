// One study run: the real engine over dataset rows with the BT-2 fact projector as part of the feed and the study
// strategy (or its S0 control) deciding. Same harness as BT-1 (runBacktest); only the feed's facts and the strategy
// are BT-2's.
import { RUG_CONFIG, startSession } from '../../../core/src/config/index.ts';
import type { RugConfig } from '../../../core/src/config/index.ts';
import type { Retention } from '../../../core/src/engine/index.ts';
import { TX_CREATE_PREFIX } from '../../../core/src/gates/index.ts';
import { seriesReleases } from '../dataset/offchain.ts';
import { type RunOptions, type RunResult, runBacktest } from '../run.ts';
import { FactProjector, gapsOf } from '../sim/facts.ts';
import type { StudyConfig } from '../strategy/config.ts';
import { StudyStrategy } from '../strategy/study.ts';

export interface StudyRunOptions extends Omit<RunOptions, 'strategy' | 'facts' | 's0'> {
  readonly study: StudyConfig;
  readonly mode: 'strategy' | 's0' | 'deployment' | 'deployment-s0';
  /** A paper-only ablation of these gates (StudyOptions.ablate). */
  readonly ablate?: readonly import('../../../core/src/gates/index.ts').HardGate[];
  /** Receives the run's strategy (to read the deployment replay's figures after the run). */
  readonly onStrategy?: (s: StudyStrategy) => void;
  /** Entries are planned only inside [entriesFrom, entriesTo). */
  readonly entriesFrom: number;
  readonly entriesTo: number;
  /** The dataset's launch-sample rate (manifest `sampling.launch_rate`); null when not stated. */
  readonly sampleRate: number | null;
  readonly coverageGaps?: readonly unknown[];
  readonly rugs?: RugConfig;
  readonly insiders?: ConstructorParameters<typeof FactProjector>[0]['insiders'];
  readonly poolAccounts?: ConstructorParameters<typeof FactProjector>[0]['poolAccounts'];
  readonly delegatesComplete?: boolean;
  /** When trade rows begin (an assembled window's first day); see FactOptions.tradesFromMs. */
  readonly tradesFromMs?: number;
}

/**
 * What the study reads from the past (and so keeps): every coverage fact (H14 reads their whole history), every
 * create and rug label (one per mint), 7 h of holder facts (U1's 6 h holder growth) and the trade-event tails H5
 * reads. Every other key is read as of now only, so its latest value is enough. Bounds the store over a 74-day run.
 */
export const STUDY_RETENTION: Retention = (key) =>
  key.startsWith('coverage:') || key.startsWith('rug:') || key.startsWith('rug-unjudged:') || key.startsWith(TX_CREATE_PREFIX) ? null
    : key.startsWith('gates/holders:') ? 7 * 3_600_000
    // H5 (GATE-1c) reads every trade event of the pool since migration and of the curve before it: kept past the
    // longest check window (14 days after migration) with room for the curve phase.
    : key.startsWith('pump_amm:') ? 15 * 86_400_000
    : key.startsWith('pump:TradeEvent:') ? 22 * 86_400_000
    : 0;

export const studyRunOptions = (o: StudyRunOptions): RunOptions => {
  const sol = o.series.find((s) => s.name === 'SOL/USD');
  return {
    ...o,
    retention: STUDY_RETENTION,
    facts: () => new FactProjector({
      sampleRate: o.sampleRate,
      rugs: o.rugs ?? RUG_CONFIG,
      windows: o.study.universes.map((u) => u.window),
      tieSalt: o.study.tieSalt,
      features: o.study.universes.some((u) => u.rules.kind === 'features'),
      solUsd: sol === undefined ? [] : seriesReleases(sol),
      solUsdPoints: 30,
      candlesHead: 10,
      candlesTail: 360,
      gaps: gapsOf(o.coverageGaps),
      ...(o.insiders === undefined ? {} : { insiders: o.insiders }),
      ...(o.poolAccounts === undefined ? {} : { poolAccounts: o.poolAccounts }),
      ...(o.delegatesComplete === undefined ? {} : { delegatesComplete: o.delegatesComplete }),
      ...(o.tradesFromMs === undefined ? {} : { tradesFromMs: o.tradesFromMs }),
    }),
    // A fresh locked session per run: the policy cannot change while it runs (R15).
    // The deployment replay trades the real book: the policy's open-position limit (R3).
    ...(o.mode === 'deployment' || o.mode === 'deployment-s0' ? { maxOpenPositions: o.policy.positions.maxOpen } : {}),
    strategy: () => {
      const s = new StudyStrategy({
        config: o.study, session: startSession(o.policy), fills: o.fills, scenario: o.scenario, mode: o.mode, entriesFrom: o.entriesFrom, entriesTo: o.entriesTo,
        ...(o.ablate === undefined ? {} : { ablate: o.ablate }),
      });
      o.onStrategy?.(s);
      return s;
    },
  };
};

export const runStudy = (o: StudyRunOptions): RunResult => runBacktest(studyRunOptions(o));
