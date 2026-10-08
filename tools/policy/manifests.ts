// package.json checks (B-M30-01 logic 1, 2, 4, 6): exact pins, no install lifecycle scripts, zero-dependency
// packages, the sentinel's allowed dependencies and the @solana/web3.js ban. Every manifest of the workspace is
// checked, Zeroed's included. Internal @bot/* packages are referenced only through pnpm's workspace protocol
// (`workspace:*`), which never falls back to the registry; pnpm 10 links a plain version only when
// linkWorkspacePackages is on, which it is not by default (pnpm 10.x docs, workspaces.md).
import {
  INSTALL_LIFECYCLE_SCRIPTS, INTERNAL_SCOPE, INTERNAL_SPEC, NEW_PACKAGE_DIRS, NO_THIRD_PARTY, SENTINEL, WEB3, WEB3_BANNED_IN,
} from './config.ts';
import { finding, type Finding } from './finding.ts';
import { aliasTarget, EXACT_VERSION } from './lockfile.ts';
import { DEPENDENCY_FIELDS, PRODUCTION_FIELDS, type Manifest, type RepoSnapshot } from './repo.ts';
import { inZeroed } from './scope.ts';

function checkManifest(m: Manifest, findings: Finding[]): void {
  const name = m.json.name ?? m.file;
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dep, spec] of Object.entries(m.json[field] ?? {})) {
      if (dep.startsWith(INTERNAL_SCOPE)) {
        if (spec !== INTERNAL_SPEC) findings.push(finding('E_INTERNAL_NOT_LINKED', m.file, `${field}.${dep} is "${spec}"; ${INTERNAL_SCOPE}* packages are referenced only as "${INTERNAL_SPEC}"`));
      } else if (!EXACT_VERSION.test(spec)) {
        findings.push(finding('E_PIN', m.file, `${field}.${dep} is "${spec}"; pin an exact version`));
      }
    }
  }
  for (const script of Object.keys(m.json.scripts ?? {})) {
    if (INSTALL_LIFECYCLE_SCRIPTS.includes(script)) findings.push(finding('E_LIFECYCLE_SCRIPT', m.file, `script "${script}" runs during install; not allowed`));
  }
  const production = PRODUCTION_FIELDS.flatMap((field) => Object.keys(m.json[field] ?? {}));
  if (m.json.bundleDependencies !== undefined || m.json.bundledDependencies !== undefined) {
    findings.push(finding('E_BUNDLED', m.file, 'bundled dependencies bypass the lockfile; not allowed'));
  }
  if (name === '@bot/types' && production.length > 0) {
    findings.push(finding('E_THIRD_PARTY_RUNTIME', m.file, `@bot/types must have no runtime dependencies; found ${production.join(', ')}`));
  }
  if (NO_THIRD_PARTY.includes(name) && name !== '@bot/types') {
    for (const dep of production.filter((d) => !d.startsWith(INTERNAL_SCOPE))) {
      findings.push(finding('E_THIRD_PARTY_RUNTIME', m.file, `${name} must have no third-party runtime dependency; found ${dep}`));
    }
  }
  if (name === SENTINEL.name) {
    for (const dep of production.filter((d) => !d.startsWith(INTERNAL_SCOPE) && !SENTINEL.allowedThirdParty.includes(d))) {
      findings.push(finding('E_SENTINEL_DEP', m.file, `${name} may depend only on internal packages and ${SENTINEL.allowedThirdParty.join(', ')}; found ${dep}`));
    }
  }
  if (WEB3_BANNED_IN.includes(name)) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dep, spec] of Object.entries(m.json[field] ?? {})) {
        if (dep === WEB3 || aliasTarget(spec) === WEB3) findings.push(finding('E_WEB3_BANNED', m.file, `${WEB3} is banned in ${name} (${field}.${dep})`));
      }
    }
  }
}

/**
 * New workspace packages under Zeroed's workspace folders (config.ts NEW_PACKAGE_DIRS; red team RT-01 test 2). A
 * package there would be new Blueprint code in a folder the scoped checks pass over, and its whole dependency tree
 * would miss the allowlist and the audit. Zeroed's own packages are the ones the Zeroed manifest knows.
 */
function checkNewPackageDirs(snapshot: RepoSnapshot, findings: Finding[]): void {
  const dirs = new Set([
    ...snapshot.manifests.map((m) => m.dir).filter((d) => d !== ''),
    ...Object.keys(snapshot.lock?.importers ?? {}).filter((d) => d !== '.'),
  ]);
  for (const dir of [...dirs].sort()) {
    if (!NEW_PACKAGE_DIRS.some((d) => dir.startsWith(d)) || inZeroed(`${dir}/`)) continue;
    findings.push(finding('E_NEW_PACKAGE_DIR', `${dir}/package.json`, `${NEW_PACKAGE_DIRS.join(', ')} hold Zeroed's packages, which the scoped checks skip; `
      + 'a new workspace package goes under packages/, where every check reads it'));
  }
}

export function checkManifests(snapshot: RepoSnapshot): Finding[] {
  const findings: Finding[] = [];
  for (const m of snapshot.manifests) checkManifest(m, findings);
  checkNewPackageDirs(snapshot, findings);
  return findings;
}
