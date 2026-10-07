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
  /**
   * The merge base of `ref` and HEAD, or null when there is none (an unrelated or missing ref). Round 1 review F5:
   * the age and audit checks read the base lockfile here, not at the tip of `ref`, so a run that starts after a newer
   * push still compares against the commit the branch forked from and cannot be failed by a version the newer commit
   * removed.
   */
  mergeBase(ref: string): string | null;
  /**
   * The lines each file gained since `ref` (a commit), as 1-based line numbers of the working tree's file: `git diff
   * -U0` against the working tree, so committed and uncommitted changes both count. Files whose content did not change
   * are absent; a file whose hunks only remove lines maps to an empty set. Supervisor ruling 3.1 (round 2 review R2-1,
   * red team RT2-01): the safety checks read only these lines of old Zeroed files, so an edit to one is checked while
   * its old lines stay quiet. `--text` (ruling 5.2, red team RT3-02): no attribute or NUL byte turns a file's diff into
   * "Binary files differ".
   */
  addedLines(ref: string): Map<string, Set<number>>;
  /** Tracked files whose working-tree content or mode differs from `ref`. A changed file absent from addedLines is read whole. */
  changedFiles(ref: string): string[];
}

/** Parses `git diff -U0 --no-prefix` output into the added line numbers of each new-side file. */
export function parseAddedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  let header = false;                                                   // between "diff --git" and the first hunk
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = true;
      file = null;
      continue;
    }
    if (header && line.startsWith('+++ ')) {                           // an added line "++ x" also prints as "+++ x"
      const name = line.slice(4);
      file = name === '/dev/null' ? null : name.replace(/^"(.*)"$/, '$1');
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m === null || file === null) continue;
    header = false;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const lines = out.get(file) ?? new Set<number>();
    for (let i = 0; i < count; i++) lines.add(start + i);
    out.set(file, lines);                                               // a hunk that only removes lines: an empty set
  }
  return out;
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
    mergeBase: (ref) => attempt(['merge-base', ref, 'HEAD'])?.trim() ?? null,
    addedLines: (ref) => parseAddedLines(run(['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--no-prefix', '--text', ref])),
    changedFiles: (ref) => run(['diff', '--name-only', '-z', '--no-renames', ref]).split('\0').filter((f) => f !== ''),
  };
}
