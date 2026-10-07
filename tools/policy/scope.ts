// Which paths the scoped checks read. Old Zeroed code is skipped by the checks that would flag it today;
// `check.ts --include-zeroed` reports what they would find there.
//
// The skipped set is a committed manifest of exact files, tools/policy/zeroed-files.txt (config.ts
// ZEROED_FILES_MANIFEST): every file the Zeroed folders held in the integration branch at c045c18a. Round 1 review F4
// and red team RT-01: with folder prefixes, a NEW file under apps/, ops/ or research/ was skipped too, so new
// Blueprint code could carry a banned import, a pump.fun host or an unreviewed dependency tree past every scoped
// check. A file not on the manifest is checked, wherever it sits. The manifest is a guarded file, so changing it needs
// the review label (drift.ts).
import { readFileSync } from 'node:fs';
import { ZEROED_JOBS, ZEROED_WORKFLOWS } from './config.ts';

/** The manifest's files, read once. Each line is a path relative to the repository root, `/`-separated. */
export const ZEROED_FILES: ReadonlySet<string> = new Set(
  readFileSync(new URL('./zeroed-files.txt', import.meta.url), 'utf8').split('\n').filter((l) => l !== ''),
);
/** The manifest's directories, every ancestor of a listed file, each with a trailing `/`. */
export const ZEROED_FILE_DIRS: ReadonlySet<string> = new Set(
  [...ZEROED_FILES].flatMap((f) => f.split('/').slice(0, -1).map((_, i, parts) => `${parts.slice(0, i + 1).join('/')}/`)),
);

/**
 * True when `path` is old Zeroed code: a file on the manifest (or one of Zeroed's workflows), or a directory (a path
 * ending in `/`, as the workspace-importer and submodule checks ask) the manifest has files in. A new directory, a new
 * workspace package included, is not Zeroed.
 */
export function inZeroed(path: string): boolean {
  if (path.endsWith('/')) return ZEROED_FILE_DIRS.has(path);
  return ZEROED_FILES.has(path) || ZEROED_WORKFLOWS.includes(path);
}

/**
 * The manifest's files ESLint would lint (every source extension of eslint.config.mjs SOURCES). The lint
 * configuration ignores exactly these, not the folders they sit in, so a NEW source file under apps/, ops/ or
 * research/ is linted (red team RT-01: a planted file there passed ESLint).
 */
export function zeroedSourceFiles(): string[] {
  return [...ZEROED_FILES].filter((f) => /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/.test(f));
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
