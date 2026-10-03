// The holdout registry kept on the remote (BT-1c D2): every session is a fresh clone, so the registry lives on a
// dedicated branch of the remote, not in the working tree. Every holdout command first fetches that branch and refuses
// unless the local copy equals it (a fresh clone takes the remote copy); every write is committed onto that branch and
// pushed (plain push, never force) before the command goes on, so a failed push or a remote that moved ahead (a race)
// stops it. The local copy is a symlink-free file at a fixed path, ignored by the code branch.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RegistryVcs } from './holdout.ts';

export interface GitRegistryOptions {
  /** The repository the registry belongs to (the code's own repository). */
  readonly root: string;
  /** The local copy, relative to `root`. */
  readonly relPath: string;
  readonly remote: string;
  readonly branch: string;
  /** The file's name on the registry branch. */
  readonly fileName: string;
}

/** Refuses a registry path that is a symbolic link (D3). */
export const refuseSymlink = (path: string): void => {
  let link = false;
  try {
    link = lstatSync(path).isSymbolicLink();
  } catch {
    return;
  }
  if (link) throw new Error(`the holdout registry ${path} is a symbolic link`);
};

export const gitRegistryVcs = (o: GitRegistryOptions): RegistryVcs => {
  const path = join(o.root, o.relPath);
  const git = (args: readonly string[], input?: string): string =>
    execFileSync('git', args, { cwd: o.root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) });
  /** The registry branch's head on the remote and its file, or null when the branch does not exist yet. */
  let base: string | null = null;
  const fetchRemote = (): string | null => {
    const heads = git(['ls-remote', '--heads', o.remote, o.branch]).trim();
    if (heads === '') {
      base = null;
      return null;
    }
    git(['fetch', '-q', o.remote, `refs/heads/${o.branch}`]);
    base = git(['rev-parse', 'FETCH_HEAD']).trim();
    return git(['show', `${base}:${o.fileName}`]);
  };
  const check = (): void => {
    refuseSymlink(path);
    const remote = fetchRemote();
    const local = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (local === null) {
      if (remote !== null) {
        // A fresh clone: take the remote registry, so every registered or started window is seen.
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, remote);
      }
      return;
    }
    if (remote === null) throw new Error(`the local holdout registry ${o.relPath} was never pushed to ${o.remote}/${o.branch}`);
    if (local !== remote) throw new Error(`the local holdout registry ${o.relPath} differs from ${o.remote}/${o.branch}`);
  };
  return {
    check,
    commit: (message) => {
      refuseSymlink(path);
      const blob = git(['hash-object', '-w', '--', path]).trim();
      const tree = git(['mktree'], `100644 blob ${blob}\t${o.fileName}\n`).trim();
      const commit = git(['commit-tree', tree, ...(base === null ? [] : ['-p', base]), '-m', message]).trim();
      // A plain push: refused when the remote moved ahead, so a race stops the command.
      git(['push', '-q', o.remote, `${commit}:refs/heads/${o.branch}`]);
      base = commit;
      check();
    },
  };
};
