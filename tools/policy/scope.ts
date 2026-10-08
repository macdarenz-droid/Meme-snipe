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
import { ZEROED_JOBS, ZEROED_PACKAGE_PREFIXES, ZEROED_WORKFLOWS } from './config.ts';

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

/** True when `path` (a file, or a directory ending in `/`) lies in a Zeroed-only package folder, new files included. */
export function inZeroedPackage(path: string): boolean {
  return ZEROED_PACKAGE_PREFIXES.some((p) => path.startsWith(p) || `${path}/` === p || path === p);
}

/**
 * The structure rules' scope (supervisor ruling 3.1): every path but Zeroed's own files and anything under the
 * Zeroed-only package folders. The other scoped checks (secrets, symbolic links, the allowlist, the workflows) keep the
 * manifest scope of scopeOf, so nothing they read before is skipped now.
 */
export function structureScopeOf(includeZeroed: boolean): Scope {
  const scope = (path: string): boolean => includeZeroed || !(inZeroed(path) || inZeroedPackage(path));
  return Object.assign(scope, { job: (file: string, job: string): boolean => includeZeroed || !zeroedJob(file, job) });
}

/** Which lines of a file the safety checks read: all of it, or a set of 1-based line numbers. */
export type SafetyLines = (file: string) => 'all' | ReadonlySet<number>;

/**
 * The safety checks' lines (supervisor ruling 3.1, red team RT2-01): every line of a file that is not old Zeroed code
 * (a new file anywhere, the Zeroed-only package folders included), and only the added lines (git diff -U0 against
 * merge-base(base, HEAD)) of an old Zeroed file, so an edit to one is checked while its old lines stay quiet. `added`
 * null means the merge base is unknown: old Zeroed files are then read in full, which fails closed. An old file in
 * `changed` with no hunk in `added` (a mode change, or a diff git would not print) is read in full too (ruling 5.2).
 */
export function safetyLinesOf(includeZeroed: boolean, added: ReadonlyMap<string, ReadonlySet<number>> | null,
  changed: ReadonlySet<string> = new Set()): SafetyLines {
  const none: ReadonlySet<number> = new Set();
  return (file) => {
    if (includeZeroed || !inZeroed(file) || added === null) return 'all';
    const lines = added.get(file);
    // Ruling 5.2 (red team RT3-02): a changed old file whose diff has no hunk git would print is read whole.
    if (lines === undefined) return changed.has(file) ? 'all' : none;
    return lines;
  };
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
