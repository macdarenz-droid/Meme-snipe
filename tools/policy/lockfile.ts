// Lockfile checks (B-M30-01 logic 1, 2, 4, 6) and dependency-closure resolution over pnpm-lock.yaml v9 (pnpm 10).
// Ported from C01's package-lock.json v3 checks. Format, as pnpm 10.28.0 writes it in this repository:
// - `importers` maps each workspace directory ('.' is the root) to its dependency fields; each dependency has the
//   `specifier` of its package.json and the resolved `version`: an exact version with the resolved peers appended in
//   parentheses (`8.70.1(eslint@10.11.0)(typescript@6.0.3)`), `link:<relative dir>` for a workspace package, or
//   `<name>@<version>` for an alias (`"x": "npm:y@1.0.0"`);
// - `packages` maps `<name>@<version>` to its `resolution` (registry packages record only `integrity`; a tarball URL,
//   git commit or directory appears only for other sources) and metadata (engines, cpu, os, peers, …);
// - `snapshots` maps `<name>@<version>(<peers>)` to the dependencies that instance resolved to, written the same way
//   as an importer's versions.
// The v9 format records no licence and no install-script flag, so the licences are read from the installed packages
// (installed.ts) and install scripts are stopped by pnpm's strictDepBuilds and the installed-package scan.
import {
  INTERNAL_SCOPE, LOCKFILE, LOCKFILE_VERSION, NO_THIRD_PARTY, OTHER_LOCKFILES, SENTINEL, WEB3, WEB3_BANNED_IN,
} from './config.ts';
import { finding, type Finding } from './finding.ts';
import type { RepoSnapshot } from './repo.ts';
import { parseYaml, type YamlMap, type YamlValue } from './yaml.ts';

const LOCK = LOCKFILE;

export type DepMap = Record<string, string>;
export interface ImporterDep { specifier: string; version: string }
export type ImporterField = 'dependencies' | 'devDependencies' | 'optionalDependencies';
export const IMPORTER_FIELDS: readonly ImporterField[] = ['dependencies', 'devDependencies', 'optionalDependencies'];
export const IMPORTER_PRODUCTION_FIELDS: readonly ImporterField[] = ['dependencies', 'optionalDependencies'];
export type Importer = Partial<Record<ImporterField, Record<string, ImporterDep>>>;
export interface PackageEntry { resolution: Record<string, string>; deprecated?: string }
export interface Snapshot { dependencies?: DepMap; optionalDependencies?: DepMap }
export interface PnpmLock {
  lockfileVersion: string;
  importers: Record<string, Importer>;
  packages: Record<string, PackageEntry>;
  snapshots: Record<string, Snapshot>;
}

/** Top-level keys the policy accepts. Overrides, package extensions, patches and pnpmfile checksums change what gets
 * installed outside the reviewed manifests, so a lockfile that records one is refused (E_LOCK_FIELD). */
const TOP_LEVEL = ['lockfileVersion', 'settings', 'importers', 'packages', 'snapshots'];

const isMap = (v: YamlValue | undefined): v is YamlMap => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringMap = (v: YamlValue | undefined): v is Record<string, string> => isMap(v) && Object.values(v).every((x) => typeof x === 'string');

/** Parses and shape-checks pnpm-lock.yaml. Anything the policy does not understand is an error: it fails closed. */
export function readLock(text: string): { lock: PnpmLock } | { error: string } {
  let doc: YamlValue;
  try {
    doc = parseYaml(text, { flowMappings: true });
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!isMap(doc)) return { error: 'not a YAML mapping' };
  const importers = doc['importers'] ?? {};
  const packages = doc['packages'] ?? {};
  const snapshots = doc['snapshots'] ?? {};
  if (!isMap(importers) || !isMap(packages) || !isMap(snapshots)) return { error: 'importers, packages and snapshots must be mappings' };
  const outImporters: Record<string, Importer> = {};
  for (const [dir, imp] of Object.entries(importers)) {
    if (!isMap(imp)) return { error: `importer "${dir}" is not a mapping` };
    const out: Importer = {};
    for (const [field, deps] of Object.entries(imp)) {
      if (!(IMPORTER_FIELDS as readonly string[]).includes(field)) continue;     // dependenciesMeta, …: not dependencies
      if (!isMap(deps)) return { error: `importer "${dir}" ${field} is not a mapping` };
      const map: Record<string, ImporterDep> = {};
      for (const [name, dep] of Object.entries(deps)) {
        if (!isMap(dep) || typeof dep['specifier'] !== 'string' || typeof dep['version'] !== 'string') {
          return { error: `importer "${dir}" ${field}.${name} needs a specifier and a version` };
        }
        map[name] = { specifier: dep['specifier'], version: dep['version'] };
      }
      out[field as ImporterField] = map;
    }
    outImporters[dir] = out;
  }
  const outPackages: Record<string, PackageEntry> = {};
  for (const [id, entry] of Object.entries(packages)) {
    if (!isMap(entry) || !isStringMap(entry['resolution'])) return { error: `package "${id}" has no resolution` };
    outPackages[id] = { resolution: { ...entry['resolution'] }, ...(typeof entry['deprecated'] === 'string' ? { deprecated: entry['deprecated'] } : {}) };
  }
  const outSnapshots: Record<string, Snapshot> = {};
  for (const [id, snap] of Object.entries(snapshots)) {
    if (!isMap(snap)) return { error: `snapshot "${id}" is not a mapping` };
    const out: Snapshot = {};
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
      const deps = snap[field];
      if (deps === undefined) continue;
      if (!isStringMap(deps)) return { error: `snapshot "${id}" ${field} is not a mapping of versions` };
      out[field] = deps;
    }
    outSnapshots[id] = out;
  }
  const extra = Object.keys(doc).filter((k) => !TOP_LEVEL.includes(k));
  if (extra.length > 0) return { error: `unexpected top-level field(s) ${extra.join(', ')} (overrides, patches and pnpmfiles are not allowed)` };
  return { lock: { lockfileVersion: String(doc['lockfileVersion']), importers: outImporters, packages: outPackages, snapshots: outSnapshots } };
}

/** An exact semver version: no range, tag, URL, path or git reference. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** `name@version` → [name, version]; the name may be scoped. Null when there is no `@` after the name. */
export function splitId(id: string): [string, string] | null {
  const at = id.indexOf('@', 1);
  return at < 0 ? null : [id.slice(0, at), id.slice(at + 1)];
}

/** The version text without the resolved peers: `8.70.1(eslint@10.11.0)` → `8.70.1`. */
export function withoutPeers(version: string): string {
  const paren = version.indexOf('(');
  return paren < 0 ? version : version.slice(0, paren);
}

/** What a dependency version in an importer or snapshot points at. */
export type DepTarget =
  | { kind: 'package'; name: string; version: string; snapshot: string; pkg: string }
  | { kind: 'link'; path: string }
  | { kind: 'other'; text: string };

/**
 * Resolves the dependency `name` written as `version`: a registry package (also through an alias), a workspace link,
 * or anything else (a file, git or URL source), which the policy refuses.
 */
export function depTarget(name: string, version: string): DepTarget {
  if (version.startsWith('link:')) return { kind: 'link', path: version.slice('link:'.length) };
  const base = withoutPeers(version);
  if (EXACT_VERSION.test(base)) return { kind: 'package', name, version: base, snapshot: `${name}@${version}`, pkg: `${name}@${base}` };
  const alias = splitId(base);
  if (alias !== null && EXACT_VERSION.test(alias[1]) && !alias[0].includes(':')) {
    return { kind: 'package', name: alias[0], version: alias[1], snapshot: version, pkg: base };
  }
  return { kind: 'other', text: version };
}

/** The directory a link from importer `fromDir` reaches, as a lockfile importer key ('.' for the root). */
export function linkDir(fromDir: string, path: string): string {
  const parts = fromDir === '.' ? [] : fromDir.split('/');
  for (const seg of path.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

/** Every third-party package of the lockfile: `name@version`, with the alias names it is installed under. */
export interface ThirdParty { key: string; name: string; version: string; aliases: Set<string> }

function addAliasUses(lock: PnpmLock, out: Map<string, ThirdParty>): void {
  const note = (depName: string, version: string): void => {
    const t = depTarget(depName, version);
    if (t.kind === 'package' && t.name !== depName) out.get(t.pkg)?.aliases.add(depName);
  };
  for (const imp of Object.values(lock.importers)) {
    for (const field of IMPORTER_FIELDS) for (const [n, d] of Object.entries(imp[field] ?? {})) note(n, d.version);
  }
  for (const snap of Object.values(lock.snapshots)) {
    for (const deps of [snap.dependencies, snap.optionalDependencies]) for (const [n, v] of Object.entries(deps ?? {})) note(n, v);
  }
}

export function thirdPartyEntries(lock: PnpmLock): ThirdParty[] {
  const out = new Map<string, ThirdParty>();
  for (const key of Object.keys(lock.packages)) {
    const id = splitId(key);
    out.set(key, { key, name: id?.[0] ?? key, version: id?.[1] ?? '', aliases: new Set() });
  }
  addAliasUses(lock, out);
  return [...out.values()];
}

/** "name" or, for an alias, "name (installed as alias)". */
export function describeEntry(t: { name: string; aliases: ReadonlySet<string> }): string {
  return t.aliases.size === 0 ? t.name : `${t.name} (installed as ${[...t.aliases].sort().join(', ')})`;
}

/** The registry package an alias dependency spec installs: `npm:@s/p@1.0.0` → "@s/p"; any other spec → null. */
export function aliasTarget(spec: string): string | null {
  const m = /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)(?:@.*)?$/.exec(spec);
  return m ? (m[1] as string) : null;
}

/** The result of walking dependencies from a set of importers. */
export interface Closure {
  /** `name@version` keys of the third-party packages reached. */
  packages: Set<string>;
  /** Every name a reached package was depended on under (real names and aliases). */
  names: Map<string, Set<string>>;
  /** Importer directories reached through workspace links (the start importers included). */
  importers: Set<string>;
  unresolved: string[];
}

/**
 * Packages reached from the importers in `start` through `fields` of each importer (links to other importers are
 * followed with the production fields) and every dependency and optional dependency of each snapshot reached. An
 * optional dependency without a packages entry is skipped, as C01 skipped one npm had not installed.
 */
export function closure(lock: PnpmLock, start: readonly string[], fields: readonly ImporterField[]): Closure {
  const result: Closure = { packages: new Set(), names: new Map(), importers: new Set(), unresolved: [] };
  const snapshots: string[] = [];
  const seenSnapshots = new Set<string>();
  const reach = (from: string, depName: string, version: string, optional = false): void => {
    const t = depTarget(depName, version);
    if (t.kind === 'other') {
      result.unresolved.push(`${from} → ${depName} is "${t.text}", not a registry package or workspace link`);
    } else if (t.kind === 'package') {
      if (lock.packages[t.pkg] === undefined) {
        if (optional) return;                                           // an optional dependency pnpm will not install (C01)
        result.unresolved.push(`${from} → ${t.pkg} has no packages entry`);
      }
      result.packages.add(t.pkg);
      (result.names.get(t.pkg) ?? result.names.set(t.pkg, new Set()).get(t.pkg) as Set<string>).add(depName).add(t.name);
      if (!seenSnapshots.has(t.snapshot)) { seenSnapshots.add(t.snapshot); snapshots.push(t.snapshot); }
    }
  };
  const importerQueue = [...start];
  const importerFields = new Map(start.map((d) => [d, fields]));
  for (let dir = importerQueue.shift(); dir !== undefined; dir = importerQueue.shift()) {
    if (result.importers.has(dir)) continue;
    result.importers.add(dir);
    const imp = lock.importers[dir];
    if (imp === undefined) { result.unresolved.push(`importer ${dir} is not in the lockfile`); continue; }
    for (const field of importerFields.get(dir) ?? IMPORTER_PRODUCTION_FIELDS) {
      for (const [name, dep] of Object.entries(imp[field] ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
        const t = depTarget(name, dep.version);
        if (t.kind === 'link') {
          const target = linkDir(dir, t.path);
          if (!importerFields.has(target)) importerFields.set(target, IMPORTER_PRODUCTION_FIELDS);
          importerQueue.push(target);
        } else {
          reach(dir === '.' ? '(root)' : dir, name, dep.version, field === 'optionalDependencies');
        }
      }
    }
  }
  for (let id = snapshots.shift(); id !== undefined; id = snapshots.shift()) {
    const snap = lock.snapshots[id];
    if (snap === undefined) { result.unresolved.push(`${id} has no snapshots entry`); continue; }
    for (const [deps, optional] of [[snap.dependencies, false], [snap.optionalDependencies, true]] as const) {
      for (const [name, version] of Object.entries(deps ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) reach(id, name, version, optional);
    }
  }
  return result;
}

const workspaceDirOf = (snapshot: RepoSnapshot, name: string): string | undefined => {
  const m = snapshot.manifests.find((x) => x.dir !== '' && x.json.name === name);
  return m?.dir;
};

/** Each package entry comes from the registry: its resolution is an sha512 integrity hash and nothing else. */
function checkEntries(lock: PnpmLock, findings: Finding[]): void {
  for (const [key, entry] of Object.entries(lock.packages)) {
    const id = splitId(key);
    if (id === null || !EXACT_VERSION.test(id[1])) {
      findings.push(finding('E_LOCK_SOURCE', LOCK, `"${key}" is not name@exact-version (git, URL, file and directory sources are not allowed)`));
      continue;
    }
    if (id[0].startsWith(INTERNAL_SCOPE)) {
      findings.push(finding('E_INTERNAL_NOT_LINKED', LOCK, `"${key}" is a registry package; ${INTERNAL_SCOPE}* must always be a workspace link`));
    }
    const keys = Object.keys(entry.resolution);
    if (keys.some((k) => k !== 'integrity')) {
      findings.push(finding('E_LOCK_SOURCE', LOCK, `"${key}" resolves through ${keys.filter((k) => k !== 'integrity').join(', ')}; every package must come from the npm registry with only an integrity hash`));
    }
    if (typeof entry.resolution['integrity'] !== 'string' || !entry.resolution['integrity'].startsWith('sha512-')) {
      findings.push(finding('E_LOCK_INTEGRITY', LOCK, `"${key}" has no sha512 integrity hash`));
    }
  }
}

/** Importer dependencies: links only to @bot/* workspace packages; @bot/* only through links; nothing else exotic. */
function checkImporters(snapshot: RepoSnapshot, lock: PnpmLock, findings: Finding[]): void {
  const dirs = new Map(snapshot.manifests.map((m) => [m.dir === '' ? '.' : m.dir, m.json.name]));
  for (const [dir, imp] of Object.entries(lock.importers)) {
    if (!dirs.has(dir)) findings.push(finding('E_LOCK_IMPORTER', LOCK, `importer "${dir}" is not a workspace package of ${'pnpm-workspace.yaml'}`));
    for (const field of IMPORTER_FIELDS) {
      for (const [name, dep] of Object.entries(imp[field] ?? {})) {
        const t = depTarget(name, dep.version);
        const where = `importer "${dir}" ${field}.${name}`;
        if (t.kind === 'link') {
          const target = dirs.get(linkDir(dir, t.path));
          if (!name.startsWith(INTERNAL_SCOPE) || target !== name) {
            findings.push(finding('E_LOCK_SOURCE', LOCK, `${where} links to "${t.path}"; only ${INTERNAL_SCOPE}* workspace packages may be linked, under their own name`));
          }
        } else if (name.startsWith(INTERNAL_SCOPE)) {
          findings.push(finding('E_INTERNAL_NOT_LINKED', LOCK, `${where} is "${dep.version}"; ${INTERNAL_SCOPE}* must never come from a registry`));
        } else if (t.kind === 'other') {
          findings.push(finding('E_LOCK_SOURCE', LOCK, `${where} is "${dep.version}"; only registry packages and ${INTERNAL_SCOPE}* workspace links are allowed`));
        }
      }
    }
  }
}

function checkClosures(snapshot: RepoSnapshot, lock: PnpmLock, findings: Finding[]): void {
  const closureOf = (name: string): Closure | null => {
    const dir = workspaceDirOf(snapshot, name);
    if (dir === undefined) {
      findings.push(finding('E_PACKAGE_MISSING', 'package.json', `workspace package ${name} is missing`));
      return null;
    }
    const c = closure(lock, [dir], IMPORTER_PRODUCTION_FIELDS);
    for (const u of c.unresolved) findings.push(finding('E_LOCK_UNRESOLVED', LOCK, `production dependency ${u}`));
    return c;
  };
  for (const name of NO_THIRD_PARTY) {
    const c = closureOf(name);
    for (const key of [...(c?.packages ?? [])].sort()) {
      findings.push(finding('E_THIRD_PARTY_RUNTIME', LOCK, `${name} must have no third-party runtime dependency; its production closure includes ${key}`));
    }
  }
  for (const name of WEB3_BANNED_IN) {
    const c = closureOf(name);
    for (const [key, names] of [...(c?.names ?? new Map<string, Set<string>>())].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (names.has(WEB3)) findings.push(finding('E_WEB3_BANNED', LOCK, `${WEB3} is banned in ${name} (B-M30-01); its production closure includes ${key}`));
    }
  }
  // The sentinel: every internal package it reaches may depend directly only on internal packages and the allowed ones.
  const sentinel = closureOf(SENTINEL.name);
  for (const dir of [...(sentinel?.importers ?? [])].sort()) {
    for (const field of IMPORTER_PRODUCTION_FIELDS) {
      for (const [dep, d] of Object.entries(lock.importers[dir]?.[field] ?? {})) {
        const t = depTarget(dep, d.version);
        if (t.kind === 'package' && ![dep, t.name].every((n) => SENTINEL.allowedThirdParty.includes(n))) {
          findings.push(finding('E_SENTINEL_DEP', LOCK, `${SENTINEL.name} may depend only on internal packages and ${SENTINEL.allowedThirdParty.join(', ')}; ${dir} depends on ${t.name === dep ? dep : `${t.name} (installed as ${dep})`}`));
        }
      }
    }
  }
}

export function checkLockfile(snapshot: RepoSnapshot): Finding[] {
  const findings: Finding[] = [];
  for (const f of snapshot.otherLockfiles) {
    findings.push(finding('E_OTHER_LOCKFILE', f, `${f} belongs to another package manager; an install from it would bypass these checks (${OTHER_LOCKFILES.join(', ')} are refused); remove it`));
  }
  const lock = snapshot.lock;
  if (lock === null) return [...findings, finding('E_LOCK_MISSING', LOCK, 'the committed lockfile is missing or unreadable')];
  if (lock.lockfileVersion !== LOCKFILE_VERSION) findings.push(finding('E_LOCK_VERSION', LOCK, `lockfileVersion must be ${LOCKFILE_VERSION}, found ${lock.lockfileVersion}`));
  checkEntries(lock, findings);
  checkImporters(snapshot, lock, findings);
  checkClosures(snapshot, lock, findings);
  return findings;
}
