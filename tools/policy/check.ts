// `pnpm lint` part 2: every offline policy check of B-M30-01 and the B-M19-01 freeze, over one repository.
// `--include-zeroed` also reads Zeroed's own files (config.ts ZEROED_FILES_MANIFEST, ZEROED_WORKFLOWS), to report what the scoped
// checks would find there; CI runs without it.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { lockIds } from './age.ts';
import { checkAllowlist } from './allowlist.ts';
import { DEFAULT_BASE_REF, FROZEN_PACKAGES, LOCKFILE } from './config.ts';
import { formatFindings, type Finding, type Io } from './finding.ts';
import { checkFreeze } from './freeze.ts';
import { gitAt } from './git.ts';
import { checkHosts } from './hosts.ts';
import { checkImports } from './imports.ts';
import { checkLintConfig } from './lintconfig.ts';
import { checkLockfile } from './lockfile.ts';
import { checkManifests } from './manifests.ts';
import { checkNpmrc } from './npmrc.ts';
import { checkPnpmConfig } from './pnpmconfig.ts';
import { readRepo } from './repo.ts';
import { scopeOf } from './scope.ts';
import { readAllowlist, scanFiles } from './secrets.ts';
import { checkSubmodules, checkSymlinks } from './symlinks.ts';
import { checkTyposquats } from './typosquat.ts';
import { checkWorkflows } from './workflows.ts';

/** True when `file` (relative to `root`) is a regular file itself: a symbolic link, directory or FIFO is not read. */
function isPlainFile(root: string, file: string): boolean {
  try {
    return lstatSync(join(root, file)).isFile();
  } catch {
    return false;
  }
}

export function runChecks(root: string, baseRef: string, options: { includeZeroed?: boolean } = {}): Finding[] {
  const scope = scopeOf(options.includeZeroed === true);
  const git = gitAt(root);
  const listed = git.listFiles();
  const special = [...checkSymlinks(root, listed, git.symlinks(), scope), ...checkSubmodules(listed, git.submodules(), scope)];
  if (special.length > 0) return special;                              // fail closed before reading through a link (A1, A7)
  const { snapshot, findings } = readRepo(root);
  // Not a deleted file, a FIFO, a file now a directory, or a symbolic link (one in Zeroed's paths is never followed).
  const files = listed.filter((f) => isPlainFile(root, f));
  // The base lockfile at merge-base(base, HEAD), not at the base tip (round 1 review F5): a newer push to the base
  // cannot change what an older commit's run reads. No merge base means no base, so the release-age exclusions fail closed.
  const mergeBase = git.hasRef(baseRef) ? git.mergeBase(baseRef) : null;
  const baseIds = mergeBase === null ? null : lockIds(git.show(mergeBase, LOCKFILE));
  return [
    ...findings,
    ...checkManifests(snapshot),
    ...checkLockfile(snapshot),
    ...checkAllowlist(snapshot, scope),
    ...checkTyposquats(snapshot),
    ...checkWorkflows(snapshot, scope),
    ...checkNpmrc(snapshot, files),
    ...checkPnpmConfig(snapshot, files.filter(scope), baseIds),
    ...checkLintConfig(snapshot, files),
    ...checkImports(snapshot, files, scope),
    ...checkHosts(root, files, scope),
    ...scanFiles(root, files.filter(scope), readAllowlist(root)),
    ...checkFreeze(root, FROZEN_PACKAGES, git, baseRef),
  ];
}

/**
 * Usage: check.ts [--include-zeroed] [root]. Base ref for the freeze check and the release-age exclusions:
 * POLICY_BASE_REF, default origin/<integration branch>. Exit 0 clean, 1 findings.
 */
export function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: Io): number {
  const includeZeroed = argv[0] === '--include-zeroed';
  const root = (includeZeroed ? argv[1] : argv[0]) ?? process.cwd();
  const findings = runChecks(root, env['POLICY_BASE_REF'] ?? DEFAULT_BASE_REF, { includeZeroed });
  if (findings.length > 0) {
    io.err(`${formatFindings(findings)}\npolicy: ${findings.length} finding(s)${includeZeroed ? ' (Zeroed paths included)' : ''}`);
    return 1;
  }
  io.out(`policy: all checks passed${includeZeroed ? ' (Zeroed paths included)' : ''}`);
  return 0;
}
