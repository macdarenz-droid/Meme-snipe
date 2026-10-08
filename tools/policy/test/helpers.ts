// Test helpers: a throw-away git repository made from the good fixture, and "bad commits" applied on a branch.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding, Io } from '../finding.ts';
import { readRepo, type RepoSnapshot } from '../repo.ts';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface TempRepo { dir: string; git(...args: string[]): string; commit(message: string): void; remove(): void }

/** A git repository holding the good fixture on `main`, with branch `pr` checked out. */
export function goodRepo(): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'policy-'));
  cpSync(join(FIXTURES, 'good'), dir, { recursive: true });
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const commit = (message: string): void => { git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', message); };
  commit('good');
  git('checkout', '-q', '-b', 'pr');
  return { dir, git, commit, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Copies the overlay fixture over the repository and commits it on `pr`. */
export function applyBadCommit(repo: TempRepo, overlay: string): void {
  cpSync(join(FIXTURES, overlay), repo.dir, { recursive: true });
  repo.commit(overlay);
}

export function editJson(dir: string, file: string, edit: (v: Record<string, unknown>) => void): void {
  const path = join(dir, file);
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function editText(dir: string, file: string, edit: (s: string) => string): void {
  const path = join(dir, file);
  writeFileSync(path, edit(readFileSync(path, 'utf8')));
}

/** Runs a bin script of tools/policy as CI does and returns its exit code and output. */
export function runBin(bin: string, args: readonly string[], cwd: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'tools/policy/bin', bin), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function capture(): Io & { text(): string } {
  const lines: string[] = [];
  return { out: (s) => lines.push(s), err: (s) => lines.push(s), text: () => lines.join('\n') };
}

export const codes = (findings: readonly Finding[]): string[] => [...new Set(findings.map((f) => f.code))].sort();

/** The good fixture as a snapshot, copied so a test can change it freely. */
export function goodSnapshot(): RepoSnapshot {
  const { snapshot } = readRepo(join(FIXTURES, 'good'));
  return structuredClone(snapshot);
}
