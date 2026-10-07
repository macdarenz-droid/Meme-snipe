// pnpm-workspace.yaml settings (B-M30-01 logic 2 and 3). pnpm 10 reads its settings from pnpm-workspace.yaml (pnpm
// 10.x docs, settings.md), so the file may hold only the workspace globs and the reviewed dependency settings of
// config.ts WORKSPACE_ALLOWED, with these values:
// - minimumReleaseAge: at least the 14-day policy, in minutes (pnpm applies it whenever it resolves a version);
// - minimumReleaseAgeExclude: only exact `name@version` entries, each either already in the base branch's lockfile
//   (adopted before this rule existed; it only grows older) or listed under "Age exceptions" in DEPENDENCIES.md (a
//   reviewed security fix), so the list can never exempt a package name, a pattern or a future version;
// - strictDepBuilds and blockExoticSubdeps: true.
// Keys that would loosen the install (allowBuilds, onlyBuiltDependencies, dangerouslyAllowAllBuilds, ignoreScripts,
// registries, overrides, packageExtensions, patchedDependencies, pnpmfile, nodeLinker, …) are refused by not being
// allowed. A pnpmfile runs its hooks during every install whatever ignoreScripts says (pnpm 10.x docs, pnpmfile.md),
// and pnpm reads only the root's workspace file, so no pnpmfile and no other pnpm-workspace.yaml may exist.
import { ageExceptions } from './age.ts';
import { DATA_DIRS, MIN_RELEASE_AGE_MINUTES, PNPMFILE_PATTERN, WORKSPACE_ALLOWED, WORKSPACE_FILE, WORKSPACE_REQUIRED } from './config.ts';
import { finding, type Finding } from './finding.ts';
import type { RepoSnapshot } from './repo.ts';

const FILE = WORKSPACE_FILE;
/** One exact version of one package: `name@1.2.3` or `@scope/name@1.2.3`; no pattern, range or `||` list. */
const EXACT_ID = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * `baseIds`: `name@version` of every package in the base branch's lockfile, or null when the base ref is missing
 * (reported by the freeze check as E_BASE_REF; every exclusion then fails, closed).
 */
export function checkPnpmConfig(snapshot: RepoSnapshot, files: readonly string[], baseIds: ReadonlySet<string> | null): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (DATA_DIRS.some((d) => f.startsWith(d))) continue;
    if (PNPMFILE_PATTERN.test(f)) findings.push(finding('E_PNPMFILE', f, 'a pnpmfile runs code during every install, even with ignore-scripts; not allowed'));
    if (f !== FILE && f.endsWith(`/${FILE}`)) findings.push(finding('E_PNPM_CONFIG', f, `only the root ${FILE} is allowed`));
  }
  const ws = snapshot.workspace;
  if (typeof ws !== 'object' || ws === null || Array.isArray(ws)) {
    return [...findings, finding('E_PNPM_CONFIG', FILE, `the root ${FILE} is missing or not a mapping`)];
  }
  for (const key of Object.keys(ws)) {
    if (!WORKSPACE_ALLOWED.includes(key)) findings.push(finding('E_PNPM_CONFIG', FILE, `"${key}" is not allowed; ${FILE} may set only ${WORKSPACE_ALLOWED.join(', ')}`));
  }
  for (const [key, value] of Object.entries(WORKSPACE_REQUIRED)) {
    if (ws[key] !== value) findings.push(finding('E_PNPM_CONFIG', FILE, `${key} must be ${value}`));
  }
  const age = ws['minimumReleaseAge'];
  if (typeof age !== 'string' || !/^\d+$/.test(age) || Number(age) < MIN_RELEASE_AGE_MINUTES) {
    findings.push(finding('E_PNPM_CONFIG', FILE, `minimumReleaseAge must be a whole number of minutes, at least ${MIN_RELEASE_AGE_MINUTES} (14 days)`));
  }
  const exclude = ws['minimumReleaseAgeExclude'];
  if (exclude !== undefined && exclude !== null) {
    if (!Array.isArray(exclude)) {
      findings.push(finding('E_PNPM_CONFIG', FILE, 'minimumReleaseAgeExclude must be a list'));
    } else {
      const exceptions = ageExceptions(snapshot.dependenciesMd ?? '').ids;
      for (const item of exclude) {
        const id = typeof item === 'string' ? item : null;
        if (id === null || !EXACT_ID.test(id)) {
          findings.push(finding('E_AGE_EXCLUDE', FILE, `minimumReleaseAgeExclude entry ${JSON.stringify(item)} must be one exact name@version (no name alone, pattern or || list)`));
        } else if (!(baseIds?.has(id) ?? false) && !exceptions.has(id)) {
          findings.push(finding('E_AGE_EXCLUDE', FILE, `${id} is excluded from the 14-day rule but is neither in the base branch's lockfile nor an "Age exceptions" row of DEPENDENCIES.md`));
        }
      }
    }
  }
  return findings;
}
