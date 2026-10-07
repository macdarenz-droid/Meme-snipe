// Read-only git queries used by the policy checks.
import { execFileSync } from 'node:child_process';

export interface Git {
  /** Files tracked or not ignored, relative to the repository root. */
  listFiles(): string[];
  /** Paths the index records as symbolic links (mode 120000), relative to the repository root. */
  symlinks(): string[];
  /** Paths the index records as submodules (gitlinks, mode 160000), relative to the repository root. */
  submodules(): string[];
  /** True when `ref` names a commit. */
  hasRef(ref: string): boolean;
  /** Content of `path` at `ref`, or null when the file does not exist there. */
  show(ref: string, path: string): string | null;
  /** Bytes of `path` at `ref`, or null when the file does not exist there. */
  blob(ref: string, path: string): Buffer | null;
  /** Every file path in the tree of `ref`. */
  files(ref: string): string[];
  /** Paths that differ between the merge base of `ref` and HEAD, and HEAD. Renames count as a deletion and an addition. */
  changedSince(ref: string): string[];
}

export function gitAt(root: string): Git {
  const run = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  const attempt = (args: string[]): string | null => {
    try { return run(args); } catch { return null; }
  };
  const staged = (mode: string): string[] => run(['ls-files', '-z', '--stage']).split('\0').filter((e) => e.startsWith(`${mode} `)).map((e) => e.slice(e.indexOf('\t') + 1));
  return {
    listFiles: () => run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter((f) => f !== ''),
    symlinks: () => staged('120000'),
    submodules: () => staged('160000'),
    hasRef: (ref) => attempt(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null,
    show: (ref, path) => attempt(['show', `${ref}:${path}`]),
    blob: (ref, path) => {
      try {
        return execFileSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
      } catch {
        return null;
      }
    },
    files: (ref) => run(['ls-tree', '-r', '-z', '--name-only', ref]).split('\0').filter((f) => f !== ''),
    changedSince: (ref) => run(['diff', '--no-renames', '--name-only', '-z', `${ref}...HEAD`]).split('\0').filter((f) => f !== ''),
  };
}
