// Symbolic links (C01 red-team round 3, finding A1). Node loads a module by its real path and resolves the module's own
// imports from there (nodejs.org ESM_RESOLVE step 7.4), while the import check, tsc and ESLint resolve them from the
// link's path: a link inside a package can load code from anywhere. Every other check also reads files by path, so a
// link could point it out of the repository, at a device that never ends, or at a directory it cannot read. The
// repository therefore holds no links: each path git lists that is a link in the working tree (lstat) or in the index
// (mode 120000, also when core.symlinks=false checks it out as a plain file) is refused, and runChecks stops before
// reading anything else. Submodules are refused in the same pass (C01 red-team round 5, A7): a gitlink (index mode
// 160000) and a nested repository that git lists as `dir/` are directories whose files belong to another repository,
// so no check can read them, and reading one as a file crashed the scan with EISDIR. Zeroed's paths (config.ts
// ZEROED_FILES_MANIFEST) hold symbolic links (research/historical/rpcscan shares the scanner's Go sources): those
// listed links are skipped
// unless the run includes them, and no check follows them (check.ts reads only plain files).
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { finding, type Finding } from './finding.ts';
import { scopeOf, type Scope } from './scope.ts';

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;                                                       // listed by git but gone from the working tree
  }
}

/** One E_SYMLINK finding per link among `files` (relative to `root`) or in `indexLinks`, sorted by path. */
export function checkSymlinks(root: string, files: readonly string[], indexLinks: readonly string[], scope: Scope = scopeOf(false)): Finding[] {
  const links = new Set([...indexLinks, ...files.filter((f) => isLink(join(root, f)))].filter(scope));
  return [...links].sort().map((f) => finding('E_SYMLINK', f, 'symbolic links are not allowed: Node loads a linked module from its target, '
    + 'which the import check, tsc and ESLint do not see, and the checks would read through the link; commit the file itself. '
    + 'The other checks did not run'));
}

/**
 * One E_SUBMODULE finding per gitlink in `indexSubmodules` and per nested repository among `files` (git lists an
 * untracked one as `dir/`), sorted by path.
 */
export function checkSubmodules(files: readonly string[], indexSubmodules: readonly string[], scope: Scope = scopeOf(false)): Finding[] {
  const found = new Set([...indexSubmodules, ...files.filter((f) => f.endsWith('/')).map((f) => f.slice(0, -1))].filter((f) => scope(`${f}/`)));
  return [...found].sort().map((f) => finding('E_SUBMODULE', f, 'submodules and nested git repositories are not allowed: their files belong to '
    + 'another repository, so the checks cannot read them; commit the files themselves. The other checks did not run'));
}
