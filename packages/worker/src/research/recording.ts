// Reads a worker's recording (run/recorder.ts): every frame of every boot, in arrival order, from the sealed
// `.jsonl.zst` files and any plain `.jsonl` a crash left unsealed. Read only: nothing in the state directory changes.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import type { Frame } from '../providers/index.ts';
import { parseTyped } from '../run/json.ts';

export interface RecordedBoot {
  readonly boot: string;
  readonly frames: readonly Frame[];
}

const lines = (path: string): string[] => {
  const text = path.endsWith('.zst') ? zstdDecompressSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8');
  return text.split('\n').filter((l) => l !== '');
};

/** The frames of one table file name pattern under `<boot>/days/<day>/`, in file order. */
const tableOf = (dir: string, table: string): string[] => {
  const days = join(dir, 'days');
  if (!existsSync(days)) return [];
  const re = new RegExp(`^${table}-(\\d{3})\\.jsonl(\\.zst)?$`);
  return readdirSync(days).sort().flatMap((d) => {
    const files = readdirSync(join(days, d)).filter((f) => re.test(f));
    // A file both sealed and plain cannot exist (sealing removes the plain one); sorted by number either way.
    files.sort((a, b) => Number(re.exec(a)![1]) - Number(re.exec(b)![1]));
    return files.flatMap((f) => lines(join(days, d, f)));
  });
};

/** Every boot under `<state>/recorder`, oldest first (by its first frame's receipt time), with its frames by `seq`. */
export const readRecording = (stateDir: string): RecordedBoot[] => {
  const root = join(stateDir, 'recorder');
  if (!existsSync(root)) return [];
  const boots = readdirSync(root).filter((b) => statSync(join(root, b)).isDirectory()).map((boot) => ({
    boot,
    frames: tableOf(join(root, boot), 'frames').map((l) => parseTyped(l) as Frame).sort((a, b) => a.seq - b.seq),
  })).filter((b) => b.frames.length > 0);
  return boots.sort((a, b) => a.frames[0]!.receivedAt - b.frames[0]!.receivedAt);
};
