// Installed-package scan (B-M30-01 edge case "a new install script appears in a dependency → CI fails"), run by CI
// right after `pnpm install --frozen-lockfile`. Defence in depth: the root .npmrc sets ignore-scripts and
// pnpm-workspace.yaml sets strictDepBuilds, so pnpm runs no dependency script and fails an install that has one nobody
// reviewed; this scan reads every installed package from disk and fails on any `preinstall`, `install` or
// `postinstall` script, and on a binding.gyp (npm runs `node-gyp rebuild` for a package that has one and no install
// script: npm/cli v10.9.4 docs/lib/content/using-npm/scripts.md, as C01 read it; whether pnpm does the same was not
// checked here, so the file is refused either way), even with `gypfile: false`.
//
// pnpm 10's default layout keeps each installed package once, as a real directory at
// node_modules/.pnpm/<id>/node_modules/<name>; every other node_modules entry is a symbolic link to one of them or to
// a workspace package. The scan reads those real directories.
//
// The lockfile v9 format records no licence, so the allowlist's licence cells (DEPENDENCIES.md) are compared here
// with the `license` field of each installed package the allowlist covers. A package for another platform (an
// optional binary pnpm did not install here) cannot be read, and is counted as not verified.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowlistLicences, allowlistScope, NO_LICENCE } from './allowlist.ts';
import { finding, formatFindings, type Finding, type Io } from './finding.ts';
import { readRepo, type RepoSnapshot } from './repo.ts';
import { scopeOf } from './scope.ts';

/** Scripts a package manager runs for an installed registry dependency (`prepare` runs only for git dependencies). */
export const DEPENDENCY_INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
/** pnpm's virtual store, relative to the repository root. */
export const VIRTUAL_STORE = 'node_modules/.pnpm';

export interface InstalledPackage { dir: string; name: string | null; version: string | null; license: string | null; scripts: Record<string, unknown>; invalid: boolean }

const isDirectory = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();                               // a symbolic link is not followed
  } catch {
    return false;
  }
};

/** The licence a manifest declares: the SPDX string, the legacy `{ type }` object, or the legacy `licenses` list. */
export function declaredLicence(json: Record<string, unknown>): string | null {
  const l = json['license'];
  if (typeof l === 'string' && l !== '') return l;
  if (typeof l === 'object' && l !== null && typeof (l as { type?: unknown }).type === 'string') return (l as { type: string }).type;
  const list = json['licenses'];
  if (Array.isArray(list)) {
    const types = list.map((x) => (typeof x === 'object' && x !== null ? (x as { type?: unknown }).type : null)).filter((t): t is string => typeof t === 'string');
    if (types.length > 0) return types.length === 1 ? (types[0] as string) : `(${types.join(' OR ')})`;
  }
  return null;
}

/** Every real package directory in the virtual store (scoped names included), sorted. */
export function installedPackages(root: string): InstalledPackage[] {
  const out: InstalledPackage[] = [];
  const read = (dir: string): void => {
    const manifest = join(root, dir, 'package.json');
    let json: Record<string, unknown> = {};
    let invalid = false;
    if (existsSync(manifest)) {
      try {
        const v = JSON.parse(readFileSync(manifest, 'utf8')) as unknown;   // valid JSON that is not an object has no scripts
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) json = v as Record<string, unknown>;
      } catch {
        invalid = true;
      }
    }
    const scripts = typeof json['scripts'] === 'object' && json['scripts'] !== null ? json['scripts'] as Record<string, unknown> : {};
    out.push({
      dir, name: typeof json['name'] === 'string' ? json['name'] : null, version: typeof json['version'] === 'string' ? json['version'] : null,
      license: declaredLicence(json), scripts, invalid,
    });
  };
  for (const entry of readdirSync(join(root, VIRTUAL_STORE), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;          // lock.yaml, the hoisted links
    const nm = `${VIRTUAL_STORE}/${entry.name}/node_modules`;
    if (!isDirectory(join(root, nm))) continue;
    for (const d of readdirSync(join(root, nm), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (d.name.startsWith('.')) continue;
      const path = `${nm}/${d.name}`;
      if (d.name.startsWith('@') && d.isDirectory()) {
        for (const s of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (!s.name.startsWith('.') && s.isDirectory()) read(`${path}/${s.name}`);   // links are other packages' entries
        }
      } else if (d.isDirectory()) {
        read(path);
      }
    }
  }
  return out;
}

function checkPackage(root: string, p: InstalledPackage, findings: Finding[]): void {
  if (p.invalid) findings.push(finding('E_INSTALLED_MANIFEST', `${p.dir}/package.json`, 'not valid JSON; cannot tell whether it has install scripts'));
  for (const s of DEPENDENCY_INSTALL_SCRIPTS) {
    if (Object.hasOwn(p.scripts, s)) findings.push(finding('E_INSTALL_SCRIPT', `${p.dir}/package.json`, `installed package has a "${s}" script; install scripts are not allowed`));
  }
  if (existsSync(join(root, p.dir, 'binding.gyp'))) {
    findings.push(finding('E_INSTALL_SCRIPT', `${p.dir}/binding.gyp`, 'installed package has a binding.gyp, so the package manager would run node-gyp rebuild on install; not allowed'));
  }
}

/** Compares the allowlist's licence cells with the installed packages the allowlist covers. */
export function checkLicences(snapshot: RepoSnapshot, installed: readonly InstalledPackage[]): { findings: Finding[]; verified: number; unverified: number } {
  const findings: Finding[] = [];
  const licences = allowlistLicences(snapshot.dependenciesMd ?? '');
  const byId = new Map(installed.filter((p) => p.name !== null && p.version !== null).map((p) => [`${p.name as string}@${p.version as string}`, p]));
  let verified = 0;
  let unverified = 0;
  for (const [key, names] of allowlistScope(snapshot, scopeOf(false))) {
    const p = byId.get(key);
    if (p === undefined) { unverified++; continue; }
    verified++;
    const actual = p.license ?? NO_LICENCE;
    for (const n of [...names].sort()) {
      const listed = licences.get(n);
      if (listed !== undefined && listed !== actual) {
        findings.push(finding('E_LICENCE_MISMATCH', 'DEPENDENCIES.md', `${n}: the allowlist says "${listed}", the installed ${key} declares "${actual}"`));
      }
    }
  }
  return { findings, verified, unverified };
}

/** Scans the virtual store. Fails closed when nothing is installed. */
export function checkInstalled(root: string, snapshot: RepoSnapshot): { findings: Finding[]; packages: number; verified: number; unverified: number } {
  if (!isDirectory(join(root, VIRTUAL_STORE))) {
    return { findings: [finding('E_NOT_INSTALLED', VIRTUAL_STORE, 'nothing is installed; run pnpm install --frozen-lockfile first')], packages: 0, verified: 0, unverified: 0 };
  }
  const installed = installedPackages(root);
  const findings: Finding[] = [];
  for (const p of installed) checkPackage(root, p, findings);
  const lic = checkLicences(snapshot, installed);
  return { findings: [...findings, ...lic.findings], packages: installed.length, verified: lic.verified, unverified: lic.unverified };
}

/** Usage: installed.ts [root]. Exit 0 when no installed package has an install script and every licence matches. */
export function main(argv: readonly string[], io: Io): number {
  const root = argv[0] ?? process.cwd();
  const { snapshot, findings: readFindings } = readRepo(root);
  const { findings, packages, verified, unverified } = checkInstalled(root, snapshot);
  const all = [...readFindings, ...findings];
  if (all.length > 0) {
    io.err(`${formatFindings(all)}\npolicy: ${all.length} finding(s)`);
    return 1;
  }
  io.out(`policy: ${packages} installed packages scanned, no install scripts; licences match for ${verified} allowlisted packages (${unverified} not installed on this platform, not verified)`);
  return 0;
}
