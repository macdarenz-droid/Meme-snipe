// Reads the files the policy checks need from a repository checkout.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCKFILE, OTHER_LOCKFILES, WORKSPACE_FILE } from './config.ts';
import { finding, type Finding } from './finding.ts';
import { readLock, type PnpmLock } from './lockfile.ts';
import { parseYaml, type YamlValue } from './yaml.ts';

export type DependencyField = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';
export const DEPENDENCY_FIELDS: readonly DependencyField[] = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
export const PRODUCTION_FIELDS: readonly DependencyField[] = ['dependencies', 'optionalDependencies', 'peerDependencies'];

export interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bundleDependencies?: unknown;
  bundledDependencies?: unknown;
}

export interface Manifest { file: string; dir: string; json: PackageJson }

export interface RepoSnapshot {
  root: string;
  /** Root manifest first, then one per workspace package. */
  manifests: Manifest[];
  /** The parsed pnpm-lock.yaml, or null when it is missing or cannot be read (a finding says which). */
  lock: PnpmLock | null;
  /** Lockfiles of other package managers found at the root (an install with them would bypass these checks). */
  otherLockfiles: string[];
  /** The parsed pnpm-workspace.yaml (null when missing or unreadable; a finding says which). */
  workspace: YamlValue;
  dependenciesMd: string | null;
  workflows: Array<{ file: string; text: string }>;
  /** The root .npmrc, or null. */
  npmrc: string | null;
  /** The trimmed content of .node-version (the Node version CI pins), or null. */
  nodeVersion: string | null;
}

function readJson(root: string, file: string, findings: Finding[]): unknown {
  try {
    return JSON.parse(readFileSync(join(root, file), 'utf8'));
  } catch {
    findings.push(finding('E_JSON', file, 'missing or not valid JSON'));
    return null;
  }
}

function readText(root: string, file: string): string | null {
  const path = join(root, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Workspace directories named by pnpm-workspace.yaml `packages`. Only `dir` and `dir/*` patterns are supported. */
function workspaceDirs(root: string, patterns: readonly string[], findings: Finding[]): string[] {
  const dirs: string[] = [];
  for (const p of patterns) {
    if (p.endsWith('/*') && !p.slice(0, -2).includes('*')) {
      const parent = p.slice(0, -2);
      if (!existsSync(join(root, parent))) continue;
      for (const d of readdirSync(join(root, parent), { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(join(root, parent, d.name, 'package.json'))) dirs.push(`${parent}/${d.name}`);
      }
    } else if (!p.includes('*')) {
      dirs.push(p);
    } else {
      findings.push(finding('E_WORKSPACE_PATTERN', WORKSPACE_FILE, `unsupported workspace pattern "${p}"`));
    }
  }
  return dirs.sort();
}

function readYaml(root: string, file: string, findings: Finding[], flowMappings: boolean): YamlValue {
  const text = readText(root, file);
  if (text === null) return null;
  try {
    return parseYaml(text, { flowMappings });
  } catch (e) {
    findings.push(finding('E_YAML', file, `${(e as Error).message}; the policy cannot tell what pnpm would read`));
    return null;
  }
}

/** The `packages` globs of pnpm-workspace.yaml (an empty list when the file or the key is missing). */
export function workspacePatterns(workspace: YamlValue): string[] {
  const packages = typeof workspace === 'object' && workspace !== null && !Array.isArray(workspace) ? workspace['packages'] : undefined;
  return Array.isArray(packages) ? packages.filter((p): p is string => typeof p === 'string') : [];
}

export function readRepo(root: string): { snapshot: RepoSnapshot; findings: Finding[] } {
  const findings: Finding[] = [];
  const manifests: Manifest[] = [];
  const workspace = readYaml(root, WORKSPACE_FILE, findings, false);
  const rootJson = readJson(root, 'package.json', findings) as PackageJson | null;
  if (rootJson) {
    manifests.push({ file: 'package.json', dir: '', json: rootJson });
    for (const dir of workspaceDirs(root, workspacePatterns(workspace), findings)) {
      const json = readJson(root, `${dir}/package.json`, findings) as PackageJson | null;
      if (json) manifests.push({ file: `${dir}/package.json`, dir, json });
    }
  }
  let lock: PnpmLock | null = null;
  const lockText = readText(root, LOCKFILE);
  if (lockText !== null) {
    const read = readLock(lockText);
    if ('error' in read) findings.push(finding('E_LOCK_PARSE', LOCKFILE, `${read.error}; the policy cannot tell what pnpm installs`));
    else lock = read.lock;
  }
  const workflowDir = join(root, '.github', 'workflows');
  const workflows = existsSync(workflowDir)
    ? readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f)).sort()
      .map((f) => ({ file: `.github/workflows/${f}`, text: readFileSync(join(workflowDir, f), 'utf8') }))
    : [];
  const otherLockfiles = OTHER_LOCKFILES.filter((f) => existsSync(join(root, f)));
  const npmrc = readText(root, '.npmrc');
  const nodeVersion = readText(root, '.node-version')?.trim() ?? null;
  return {
    snapshot: { root, manifests, lock, otherLockfiles, workspace, dependenciesMd: readText(root, 'DEPENDENCIES.md'), workflows, npmrc, nodeVersion },
    findings,
  };
}
