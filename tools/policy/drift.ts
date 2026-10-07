// Review label for the lockfile and the policy files (B-M30-01 logic 1; C01 review findings M1, M3, m5, R1 and R3). A
// pull request that changes a guarded path (config.ts GUARDED_*: the installed root pnpm-lock.yaml,
// pnpm-workspace.yaml, package.json, .npmrc, .node-version, DEPENDENCIES.md, vitest.config.ts, the frozen packages'
// FREEZE.json and CHANGELOG.md, eslint.config.* and tsconfig*.json at any depth, tools/** and .github/**) fails until
// a reviewer has read that diff and added the label bound to the exact content of every guarded file:
// `deps-reviewed:<first 32 hex digits of guardedHash>`. Any later change to a guarded file, including one a merge of
// the base branch brings in, changes the hash, so an earlier label no longer counts.
//
// The label counts only when the run that reads it is the `labeled` event that added it (config.ts LABEL_EVENT_ENV,
// supervisor ruling 7 for red team RT-03): a label is then always newer than the head commit the run checks. After a
// push that changes a guarded file the supervisor adds the label again (removing and re-adding it when the hash did not
// change), which is the review the label stands for. A push that leaves the guarded files alone has nothing to review,
// so it needs no label at all.
//
// The label is computed on HEAD, which in CI is the pull request's merge commit (refs/pull/N/merge): compute it after
// merging the base branch into the branch (`node tools/policy/bin/drift.ts --print-label` on an up-to-date branch prints the same
// value), or copy it from the failing step. Who adds the label is not checked: every agent and the owner act through
// the same GitHub account, so the label records a review step, and the supervisor adds it (AGENTS.md).
//
// CI runs this file in the `check` job, on the pull request's own copy. The base branch's copy used to run in
// guard.yml as well; that workflow is not in this repository (config.ts GUARD_WORKFLOW, supervisor ruling 2), because
// a pull_request_target run reports against the base branch's newest commit and a failure there would stop every
// deploy. This file still imports only node: built-ins and the dependency-free modules beside it, so a guard can run
// it without an install once one is tested. CI passes the base ref, the labels and the added label in POLICY_BASE_REF,
// PR_LABELS and PR_LABEL_ADDED.
import { createHash } from 'node:crypto';
import {
  DEFAULT_BASE_REF, GUARDED_DIRS, GUARDED_FILES, GUARDED_PATTERNS, LABEL_EVENT_ENV, LOCK_REVIEW_HASH_HEX, LOCK_REVIEW_LABEL_PREFIX, LOCKFILE,
} from './config.ts';
import { finding, formatFindings, type Finding, type Io } from './finding.ts';
import type { Git } from './git.ts';

export interface GuardedFile { path: string; bytes: Uint8Array }

export function isGuarded(path: string): boolean {
  return GUARDED_FILES.includes(path) || GUARDED_DIRS.some((d) => path.startsWith(d)) || GUARDED_PATTERNS.some((p) => p.test(path));
}

/** sha256 over each guarded file's path, byte length and bytes, in path order (code-unit order). */
export function guardedHash(files: readonly GuardedFile[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    h.update(`${f.path}\n${f.bytes.length}\n`);
    h.update(f.bytes);
  }
  return h.digest('hex');
}

export function reviewLabel(files: readonly GuardedFile[]): string {
  return `${LOCK_REVIEW_LABEL_PREFIX}${guardedHash(files).slice(0, LOCK_REVIEW_HASH_HEX)}`;
}

/** The guarded files in the tree of `ref`. Throws when one cannot be read (a submodule, say): the check fails closed. */
export function guardedFiles(git: Git, ref: string): GuardedFile[] {
  return git.files(ref).filter(isGuarded).map((path) => {
    const bytes = git.blob(ref, path);
    if (bytes === null) throw new Error(`drift: cannot read ${path} at ${ref}`);
    return { path, bytes };
  });
}

/**
 * `changed`: paths changed since the base; `files`: the guarded files at HEAD; `labelAdded`: the label this run's
 * `labeled` event added, or '' on any other event (config.ts LABEL_EVENT_ENV). The label counts only when this run is
 * that event, so it is newer than the head commit it checks (red team RT-03).
 */
export function checkDrift(changed: readonly string[], labels: readonly string[], files: readonly GuardedFile[], labelAdded = ''): Finding[] {
  const touched = changed.filter(isGuarded).sort();
  if (touched.length === 0) return [];
  if (!files.some((f) => f.path === LOCKFILE)) return [finding('E_LOCK_DRIFT', LOCKFILE, 'the lockfile was removed; it must be committed')];
  const label = reviewLabel(files);
  if (labels.includes(label) && labelAdded === label) return [];
  const lock = touched.includes(LOCKFILE);
  const list = touched.length > 5 ? `${touched.slice(0, 5).join(', ')} and ${touched.length - 5} more` : touched.join(', ');
  const stale = labels.includes(label)
    ? `. The label "${label}" is on the pull request but was not added by this run's event, so it is older than this head: remove it and add it again after reading this diff`
    : `. A reviewer must read this diff and add the label "${label}", computed on the merge commit; any later change to the lockfile or a policy file needs a new label`;
  return [finding(lock ? 'E_LOCK_DRIFT' : 'E_POLICY_DRIFT', lock ? LOCKFILE : (touched[0] as string), `changed: ${list}${stale}`)];
}

/** Usage: drift.ts [--print-label]. Exit 0 when no guarded file changed or the label is present; 1 otherwise. */
export function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, git: Git, io: Io): number {
  if (argv[0] === '--print-label') {
    io.out(reviewLabel(guardedFiles(git, 'HEAD')));
    return 0;
  }
  const base = env['POLICY_BASE_REF'] ?? DEFAULT_BASE_REF;
  const labels = (env['PR_LABELS'] ?? '').split(',').map((l) => l.trim()).filter((l) => l !== '');
  const labelAdded = (env[LABEL_EVENT_ENV] ?? '').trim();
  const findings = git.hasRef(base)
    ? checkDrift(git.changedSince(base), labels, guardedFiles(git, 'HEAD'), labelAdded)
    : [finding('E_BASE_REF', base, `base ref "${base}" is not available`)];
  if (findings.length > 0) {
    io.err(formatFindings(findings));
    return 1;
  }
  io.out('policy: review label check passed (lockfile and policy files)');
  return 0;
}
