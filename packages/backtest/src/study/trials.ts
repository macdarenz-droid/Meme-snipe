// The study's experiment registry (docs/ARCHITECTURE.md §13.2): every trial evaluated, kept across runs so PBO and the
// deflated Sharpe count every configuration ever tried. Holdouts live in the one holdout registry (src/holdout.ts).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { TrialRecord } from '../../../core/src/stats/index.ts';

export type StudyTrial = TrialRecord & { readonly configId: string; readonly evaluatedOn: string };

export interface TrialLog {
  readonly version: 1;
  readonly trials: readonly StudyTrial[];
}

export const readTrialLog = (path: string): TrialLog => {
  const r = JSON.parse(readFileSync(path, 'utf8')) as TrialLog;
  if (r.version !== 1 || !Array.isArray(r.trials)) throw new RangeError(`${path} is not a trial log`);
  return r;
};

export const loadTrialLog = (path: string): TrialLog => (existsSync(path) ? readTrialLog(path) : { version: 1, trials: [] });

/** Written to a temporary file and renamed, so a crash never leaves a half-written log. */
export const writeTrialLog = (path: string, r: TrialLog): void => {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(r, null, 1)}\n`);
  renameSync(`${path}.tmp`, path);
};

/** Adds a trial unless one with the same id is there (the same configuration evaluated on the same data). */
export const recordTrial = (r: TrialLog, t: StudyTrial): TrialLog => (r.trials.some((x) => x.trialId === t.trialId) ? r : { ...r, trials: [...r.trials, t] });
