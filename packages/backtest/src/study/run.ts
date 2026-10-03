// One study run: the real engine over dataset rows with the BT-2 fact projector as part of the feed and the study
// strategy (or its S0 control) deciding. Same harness as BT-1 (runBacktest); only the feed's facts and the strategy
// are BT-2's.
import { RUG_CONFIG, startSession } from '../../../core/src/config/index.ts';
import type { RugConfig } from '../../../core/src/config/index.ts';
import { seriesReleases } from '../dataset/offchain.ts';
import { type RunOptions, type RunResult, runBacktest } from '../run.ts';
import { FactProjector, gapsOf } from '../sim/facts.ts';
import type { StudyConfig } from '../strategy/config.ts';
import { StudyStrategy } from '../strategy/study.ts';

export interface StudyRunOptions extends Omit<RunOptions, 'strategy' | 'facts' | 's0'> {
  readonly study: StudyConfig;
  readonly mode: 'strategy' | 's0';
  /** Entries are planned only inside [entriesFrom, entriesTo). */
  readonly entriesFrom: number;
  readonly entriesTo: number;
  /** The dataset's launch-sample rate (manifest `sampling.launch_rate`); null when not stated. */
  readonly sampleRate: number | null;
  readonly coverageGaps?: readonly unknown[];
  readonly rugs?: RugConfig;
  readonly insiders?: ConstructorParameters<typeof FactProjector>[0]['insiders'];
}

export const studyRunOptions = (o: StudyRunOptions): RunOptions => {
  const sol = o.series.find((s) => s.name === 'SOL/USD');
  return {
    ...o,
    facts: () => new FactProjector({
      sampleRate: o.sampleRate,
      rugs: o.rugs ?? RUG_CONFIG,
      windows: o.study.universes.map((u) => u.window),
      solUsd: sol === undefined ? [] : seriesReleases(sol),
      solUsdPoints: 30,
      candlesHead: 10,
      candlesTail: 360,
      gaps: gapsOf(o.coverageGaps),
      ...(o.insiders === undefined ? {} : { insiders: o.insiders }),
    }),
    // A fresh locked session per run: the policy cannot change while it runs (R15).
    strategy: () => new StudyStrategy({
      config: o.study, session: startSession(o.policy), fills: o.fills, scenario: o.scenario, mode: o.mode, entriesFrom: o.entriesFrom, entriesTo: o.entriesTo,
    }),
  };
};

export const runStudy = (o: StudyRunOptions): RunResult => runBacktest(studyRunOptions(o));
