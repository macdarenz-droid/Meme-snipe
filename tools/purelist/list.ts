// The pure-function file list for the 100% branch-coverage gate (B-M30-01, Z01-COV). One line per file:
// `<path>  # <reason>`, or `<path>  min=<percent>  # <reason>` for a file held to a floor below 100 (a ratchet: its
// current branch percentage, rounded down). `vitest.config.ts` reads it; these rules keep it honest:
// - a line without a reason fails;
// - an entry is a path, not a glob, and must be an existing file (Z01-COV-4: a misspelled or moved path would otherwise
//   drop a file from the gate without a sound);
// - a file is listed once, and a floor is a number above 0 and at most 100.
import { statSync } from 'node:fs';
import { join } from 'node:path';

export interface PureEntry { path: string; min: number; reason: string }

const SEPARATOR = '  # ';
const GLOB = /[*?[\]{}!]/;
const FLOOR = /^min=(\d+(?:\.\d+)?)$/;

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Parses the list text; `root` is the repository root the paths are relative to. Throws on any problem. */
export function parsePureList(text: string, root: string): PureEntry[] {
  const out: PureEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const at = line.indexOf(SEPARATOR);
    const head = (at < 0 ? line : line.slice(0, at)).trim().split(/\s+/);
    const reason = at < 0 ? '' : line.slice(at + SEPARATOR.length).trim();
    const path = head[0] ?? '';
    if (path === '' || reason === '' || head.length > 2) throw new Error(`pure-file list: a line needs "<path>  # <reason>" (or "<path>  min=<percent>  # <reason>"): ${line}`);
    if (GLOB.test(path)) throw new Error(`pure-file list: "${path}" must be a path, not a glob`);
    if (!isFile(join(root, path))) throw new Error(`pure-file list: "${path}" matches no file`);
    if (out.some((e) => e.path === path)) throw new Error(`pure-file list: "${path}" is listed twice`);
    let min = 100;
    if (head[1] !== undefined) {
      const m = FLOOR.exec(head[1]);
      min = m === null ? Number.NaN : Number(m[1]);
      if (!(min > 0 && min <= 100)) throw new Error(`pure-file list: "${path}" has a floor that is not above 0 and at most 100: ${head[1]}`);
    }
    out.push({ path, min, reason });
  }
  return out;
}
