// Freeze mechanism for shared packages (B-M19-01 logic 2; ARCH 18 "frozen before tickets start").
// FREEZE.json records the package version and a sha256 over package.json, every file under src/, and the package's
// tsconfig.json with every config it extends (red team RT-06). The check fails
// when the files no longer match it. When they differ from the base branch's FREEZE.json, the change must also carry
// a higher semantic version, a CHANGELOG.md section for it and sign-off lines from both group leads.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname as posixDirname, join as posixJoin, relative as posixRelative } from 'node:path/posix';
import { join } from 'node:path';
import { finding, type Finding, type Io } from './finding.ts';
import type { Git } from './git.ts';

export interface FreezeManifest { package: string; version: string; sha256: string; files: string[] }

const SIGN_OFFS = ['Sign-off (group A lead):', 'Sign-off (group B lead):'];

function listSrc(root: string, rel: string): string[] {
  const out: string[] = [];
  for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = `${rel}/${d.name}`;
    if (d.isDirectory()) out.push(...listSrc(root, path));
    else out.push(path);
  }
  return out;
}

/**
 * The tsconfig files a frozen package compiles with, relative to `dir`: `start` and every config it extends, following
 * the chain depth first, an array `extends` entry by entry in its order (red team RT-06, RT2-06). A compiler option
 * decides what the frozen types mean (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and the rest),
 * so a change to one is a change to the frozen surface and needs the version bump, the changelog entry and both
 * sign-offs. Only relative `extends` values are followed; a package name would be a dependency, which a frozen
 * zero-dependency package does not have. Each file is listed once.
 */
export function tsconfigChain(root: string, dir: string, start = 'tsconfig.json'): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    if (out.includes(rel) || !existsSync(join(root, dir, rel))) return;
    out.push(rel);
    let extend: unknown;
    try {
      extend = (JSON.parse(readFileSync(join(root, dir, rel), 'utf8')) as { extends?: unknown }).extends;
    } catch {
      return;                                                           // unreadable: the typecheck fails on it anyway
    }
    for (const e of Array.isArray(extend) ? extend : [extend]) {
      if (typeof e === 'string' && (e.startsWith('./') || e.startsWith('../'))) visit(posixJoin(posixDirname(rel), e));
    }
  };
  visit(start);
  return out;
}

/**
 * The repository's root tsconfig.json, which is what `pnpm typecheck` compiles a frozen package's src/ with (it
 * includes packages/types/src), and every config it extends, relative to `dir` (red team RT2-06; supervisor ruling 3.5).
 * The root file itself is hashed through rootTsconfigProjection (round 4); the configs it extends are hashed whole.
 */
export function rootTsconfigChain(root: string, dir: string): string[] {
  return tsconfigChain(root, dir, posixRelative(dir, 'tsconfig.json'));
}

/**
 * The frozen files of the package in `dir`, relative to `dir`: package.json, everything under src/, the package's
 * tsconfig chain and the root tsconfig chain, each file once.
 */
export function freezeFiles(root: string, dir: string): string[] {
  const src = existsSync(join(root, dir, 'src')) ? listSrc(join(root, dir), 'src') : [];
  const configs = [...tsconfigChain(root, dir), ...rootTsconfigChain(root, dir)];
  return ['package.json', ...src.sort(), ...configs.filter((c, i) => configs.indexOf(c) === i)];
}

/** JSON with every object's keys sorted, at every depth: the same settings always give the same text. */
export function sortedJson(value: unknown): string {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort)
    : typeof v === 'object' && v !== null ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v);
  return JSON.stringify(sort(value));
}

/**
 * What the freeze hashes of the repository's root tsconfig.json (supervisor ruling for round 4): its `compilerOptions`,
 * as sorted JSON, and its `extends` (string or array, each config it names is frozen whole through the chain). Not its
 * `include`, `exclude`, `files` or `references`: the root config lists every Blueprint package, and adding one must
 * not need a @bot/types bump, while any compiler option still does (red team RT2-06). A root config that does not parse
 * is hashed whole, so a change to it is still caught.
 */
export function rootTsconfigProjection(text: string): string {
  try {
    const json = JSON.parse(text) as { compilerOptions?: unknown; extends?: unknown };
    return sortedJson({ compilerOptions: json.compilerOptions ?? null, extends: json.extends ?? null });
  } catch {
    return text;
  }
}

/**
 * sha256 over each file's relative path, byte length and bytes, in the given order. The repository's root
 * tsconfig.json counts only through rootTsconfigProjection; every other file, package tsconfigs included, is whole.
 */
export function freezeHash(root: string, dir: string, files: readonly string[]): string {
  const h = createHash('sha256');
  const rootConfig = dir === '' ? null : posixRelative(dir, 'tsconfig.json');
  for (const f of files) {
    const raw = readFileSync(join(root, dir, f));
    const bytes = f === rootConfig ? Buffer.from(rootTsconfigProjection(raw.toString('utf8'))) : raw;
    h.update(`${f}\n${bytes.length}\n`);
    h.update(bytes);
  }
  return h.digest('hex');
}

export function buildFreeze(root: string, dir: string): FreezeManifest {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
  const files = freezeFiles(root, dir);
  return { package: String(pkg.name), version: String(pkg.version), sha256: freezeHash(root, dir, files), files };
}

export function writeFreeze(root: string, dir: string): FreezeManifest {
  const manifest = buildFreeze(root, dir);
  writeFileSync(join(root, dir, 'FREEZE.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Text of the `## <version>` section of a changelog, or null. */
export function changelogSection(md: string, version: string): string | null {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** a > b for plain x.y.z versions; false when either is not x.y.z. */
export function semverGreater(a: string, b: string): boolean {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d > 0;
  }
  return false;
}

function hasSignOff(section: string, prefix: string): boolean {
  return section.split('\n').some((l) => {
    const who = l.startsWith(prefix) ? l.slice(prefix.length).trim() : '';
    return who !== '' && !/^pending\b/i.test(who);
  });
}

function parseFreeze(text: string): FreezeManifest | null {
  try {
    const v = JSON.parse(text) as Partial<FreezeManifest>;
    return typeof v.version === 'string' && typeof v.sha256 === 'string' ? (v as FreezeManifest) : null;
  } catch {
    return null;
  }
}

export function checkFreeze(root: string, dirs: readonly string[], git: Git, baseRef: string): Finding[] {
  const findings: Finding[] = [];
  const baseOk = git.hasRef(baseRef);
  if (!baseOk) findings.push(finding('E_BASE_REF', baseRef, `base ref "${baseRef}" is not available; fetch it (git fetch origin <base branch>) or set POLICY_BASE_REF`));
  for (const dir of dirs) {
    const file = `${dir}/FREEZE.json`;
    const recorded = existsSync(join(root, file)) ? parseFreeze(readFileSync(join(root, file), 'utf8')) : null;
    if (recorded === null) {
      findings.push(finding('E_FREEZE_MISSING', file, 'a frozen package needs a valid FREEZE.json'));
      continue;
    }
    const current = buildFreeze(root, dir);
    if (current.sha256 !== recorded.sha256) {
      findings.push(finding('E_FROZEN_CHANGED', file, `${current.package} is frozen and its files changed; bump the version, add a CHANGELOG.md entry with both sign-offs, then run "node tools/policy/bin/freeze.ts ${dir}"`));
    }
    if (current.version !== recorded.version) {
      findings.push(finding('E_FREEZE_VERSION', file, `FREEZE.json records ${recorded.version} but package.json is ${current.version}`));
    }
    const changelog = existsSync(join(root, dir, 'CHANGELOG.md')) ? readFileSync(join(root, dir, 'CHANGELOG.md'), 'utf8') : '';
    const section = changelogSection(changelog, current.version);
    if (section === null) findings.push(finding('E_CHANGELOG', `${dir}/CHANGELOG.md`, `no "## ${current.version}" section`));
    if (!baseOk) continue;
    const baseText = git.show(baseRef, file);
    const base = baseText === null ? null : parseFreeze(baseText);
    if (base === null || base.sha256 === current.sha256) continue;      // first freeze, or unchanged against the base
    if (!semverGreater(current.version, base.version)) {
      findings.push(finding('E_FREEZE_BUMP', file, `${current.package} changed against ${baseRef}; its version must be higher than ${base.version}`));
    }
    for (const prefix of SIGN_OFFS) {
      if (section === null || !hasSignOff(section, prefix)) {
        findings.push(finding('E_FREEZE_SIGNOFF', `${dir}/CHANGELOG.md`, `the ${current.version} entry needs a "${prefix} <name>" line`));
      }
    }
  }
  return findings;
}

/** Usage: freeze.ts <package dir>. Records FREEZE.json for the package's current files and version. */
export function freezeMain(argv: readonly string[], root: string, io: Io): number {
  const dir = argv[0];
  if (dir === undefined) {
    io.err('usage: node tools/policy/bin/freeze.ts <package dir>');
    return 2;
  }
  const m = writeFreeze(root, dir);
  io.out(`${m.package} ${m.version} ${m.sha256}`);
  return 0;
}
