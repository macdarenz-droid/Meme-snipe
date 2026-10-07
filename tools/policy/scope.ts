// Which paths the scoped checks read (config.ts ZEROED_PATHS, ZEROED_WORKFLOWS). Old Zeroed code is skipped by the
// checks that would flag it today; `check.ts --include-zeroed` reports what they would find there.
import { ZEROED_JOBS, ZEROED_PATHS, ZEROED_WORKFLOWS } from './config.ts';

/** True when `path` (relative to the repository root, `/`-separated) is old Zeroed code. */
export function inZeroed(path: string): boolean {
  return ZEROED_PATHS.some((p) => path.startsWith(p)) || ZEROED_WORKFLOWS.includes(path);
}

/** True when `job` of the workflow `file` is one of Zeroed's (config.ts ZEROED_JOBS). */
export function zeroedJob(file: string, job: string): boolean {
  return ZEROED_JOBS[file]?.includes(job) ?? false;
}

/** The scope predicate of one run: every path, or every path outside Zeroed's; `job` asks about a workflow job. */
export interface Scope { (path: string): boolean; job(file: string, job: string): boolean }
export function scopeOf(includeZeroed: boolean): Scope {
  const scope = (path: string): boolean => includeZeroed || !inZeroed(path);
  return Object.assign(scope, { job: (file: string, job: string): boolean => includeZeroed || !zeroedJob(file, job) });
}
