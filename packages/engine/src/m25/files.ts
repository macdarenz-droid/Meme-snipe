// Start-up ownership checks of the root-owned files (B-M25-01 logic 3-4, security notes): /etc/bot/ceilings.json and
// /etc/bot/config.json must be regular files owned by root that neither the engine's user nor its group nor others
// can write, in a directory with the same property (otherwise the file could be replaced). The engine must not run as
// root, since root can write every file.
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FileStat { uid: number; mode: number; isFile: boolean; isSymbolicLink: boolean; isDirectory: boolean }
/** Stat without following a final symbolic link; null when the path does not exist. */
export type StatFn = (path: string) => FileStat | null;

export type TrustCode = 'E_RUN_AS_ROOT' | 'E_MISSING' | 'E_NOT_REGULAR' | 'E_NOT_ROOT_OWNED' | 'E_WRITABLE';

export function lstatOrNull(path: string): FileStat | null {
  try {
    const s = lstatSync(path);
    return { uid: s.uid, mode: s.mode, isFile: s.isFile(), isSymbolicLink: s.isSymbolicLink(), isDirectory: s.isDirectory() };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Null when `path` is a root-owned regular file, not writable by group or others, in such a directory. */
export function trustProblem(path: string, euid: number, stat: StatFn = lstatOrNull): { code: TrustCode; message: string } | null {
  if (euid === 0) return { code: 'E_RUN_AS_ROOT', message: 'the engine runs as root and could write every file; run it as its own user' };
  for (const [p, kind] of [[path, 'file'], [dirname(path), 'directory']] as const) {
    const s = stat(p);
    if (s === null) return { code: 'E_MISSING', message: `${p} does not exist` };
    if (s.isSymbolicLink || (kind === 'file' ? !s.isFile : !s.isDirectory)) return { code: 'E_NOT_REGULAR', message: `${p} is not a plain ${kind}` };
    if (s.uid !== 0) return { code: 'E_NOT_ROOT_OWNED', message: `${p} is not owned by root` };
    if ((s.mode & 0o022) !== 0) return { code: 'E_WRITABLE', message: `${p} is writable by its group or others (mode ${(s.mode & 0o777).toString(8)})` };
  }
  return null;
}
