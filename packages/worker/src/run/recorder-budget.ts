// RECORD-BUDGET: the recordings under `<state>/recorder/` are kept under a byte cap and above a free-disk floor, whether
// or not they were uploaded (a full disk crash-loops the worker). A pass deletes sealed recording files, oldest first by
// (UTC day, boot start, file number), until the recordings are at or below the cap, or, when the disk's free space is
// under the floor, until it is back to the floor plus FLOOR_HEADROOM. A past boot's folder is removed whole once it holds
// no recording file. A packed saved state in `recorder/saved-state/` that no boot links to any more (link count 1) goes
// too, never while a pack runs.
//
// What a pass never touches: the running boot's plain `.jsonl` files (the regex takes only sealed `.jsonl.zst`), any
// `*.tmp`, its manifest and attachments; symlinks, or anything whose real path leaves the recorder folder; and the rest
// of the state dir (ledger, journal, deployers, every other state file), which is never walked. The walk uses lstat
// only, and a file's bytes count once per inode (the saved-state store is hard-linked into the boot folders).
import { lstatSync, readdirSync, realpathSync, rmSync, statfsSync, unlinkSync, type Stats } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SAVED_STATES } from './recorder.ts';

const GiB = 1024 ** 3;
/** Defaults (config: ZEROED_RECORDER_MAX_BYTES, ZEROED_DISK_PRUNE_FREE_BYTES). */
export const RECORDER_MAX_BYTES = 8 * GiB;
export const DISK_PRUNE_FREE_BYTES = 3 * GiB;
/** The lowest floor the config accepts. */
export const MIN_DISK_PRUNE_FREE_BYTES = 2 * GiB;
/** Under the floor, a pass deletes until free space is the floor plus this (3.5 GiB at the default floor). */
export const FLOOR_HEADROOM = GiB / 2;
/** How often the worker runs a pass. */
export const PRUNE_EVERY_MS = 60_000;

const DATA = /^(frames|raw|releases|pre|delays)-(\d{3})\.jsonl\.zst$/;
const PLAIN = /\.jsonl$/;
const SAVED = /^[0-9a-f]{64}\.zst$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface PruneOptions {
  /** `<state>/recorder`. */
  readonly root: string;
  /** The running boot: its folder is never removed and only its sealed recording files are deleted. */
  readonly current: string;
  readonly maxBytes: number;
  readonly floorBytes: number;
  /** Free bytes on the recorder's disk (default: statfs `bavail * bsize`); a test fakes it. */
  readonly freeBytes?: (root: string) => number;
  /** True while the worker packs its saved-state copy: the saved-state store is left alone. */
  readonly packing: () => boolean;
}

export interface Pruned {
  readonly boot: string;
  /** Relative to the boot's folder (`days/<day>/<file>`), or `saved-state/<sha>.zst` with boot ''. */
  readonly path: string;
  readonly bytes: number;
}

export interface PruneResult {
  /** Why the pass deleted: the cap, the free-disk floor (the floor wins when both), or null when within both. */
  readonly reason: 'cap' | 'floor' | null;
  readonly deleted: readonly Pruned[];
  readonly bytes: number;
  /** Past boot folders removed whole. */
  readonly boots: readonly string[];
  readonly freeBytes: number;
  readonly recorderBytes: number;
  /** Still over the cap or under the floor with nothing left this pass may delete. */
  readonly short: boolean;
  /** Deletions that failed (not counting a file already gone). */
  readonly errors: readonly string[];
}

const statfsFree = (root: string): number => {
  const s = statfsSync(root);
  return Number(s.bavail) * Number(s.bsize);
};

const lstat = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

const list = (p: string): string[] => {
  try {
    return readdirSync(p).sort();
  } catch {
    return [];
  }
};

/** A boot id's start time: `<ms base36>-<pid>`; anything else sorts first. */
export const bootStart = (boot: string): number => {
  const head = boot.split('-')[0] ?? '';
  const ms = /^[0-9a-z]+$/.test(head) ? parseInt(head, 36) : NaN;
  return Number.isSafeInteger(ms) ? ms : 0;
};

interface Inode {
  readonly size: number;
  /** Links on the whole file system, from lstat. */
  nlink: number;
  /** Links under the recorder folder. */
  inside: number;
}

interface Candidate {
  readonly boot: string;
  readonly day: string;
  readonly start: number;
  readonly n: number;
  readonly name: string;
  readonly path: string;
  readonly key: string;
}

const keyOf = (s: Stats): string => `${s.dev}:${s.ino}`;

/** One pass. Never throws for one file: a failed deletion is listed in `errors` and the pass goes on. */
export const pruneRecordings = (o: PruneOptions): PruneResult => {
  const free0 = (o.freeBytes ?? statfsFree)(o.root);
  const rootReal = realpathSync(o.root);
  const inodes = new Map<string, Inode>();
  const note = (s: Stats): void => {
    const k = keyOf(s);
    const i = inodes.get(k);
    if (i === undefined) inodes.set(k, { size: s.size, nlink: s.nlink, inside: 1 });
    else i.inside++;
  };
  // Every regular file under the recorder folder, counted once per inode; directories followed, symlinks never.
  const walk = (dir: string): void => {
    for (const name of list(dir)) {
      const s = lstat(join(dir, name));
      if (s === null) continue;
      if (s.isDirectory()) walk(join(dir, name));
      else if (s.isFile()) note(s);
    }
  };
  walk(o.root);
  let recorderBytes = 0;
  for (const i of inodes.values()) recorderBytes += i.size;
  let freed = 0;
  const free = (): number => free0 + freed;
  const target = o.floorBytes + FLOOR_HEADROOM;
  const reason = free0 < o.floorBytes ? 'floor' : recorderBytes > o.maxBytes ? 'cap' : null;
  const over = (): boolean => (reason === 'floor' ? free() < target : recorderBytes > o.maxBytes);
  const deleted: Pruned[] = [];
  const boots: string[] = [];
  const errors: string[] = [];
  if (reason === null) return { reason, deleted, bytes: 0, boots, freeBytes: free(), recorderBytes, short: false, errors };

  /** Inside the recorder folder by real path (a symlinked parent never lets a deletion leave it). */
  const within = (p: string): boolean => {
    try {
      const r = realpathSync(p);
      return r.startsWith(rootReal + sep);
    } catch {
      return false;
    }
  };
  const forget = (s: Stats): number => {
    const i = inodes.get(keyOf(s));
    if (i === undefined) return 0;
    i.nlink--;
    i.inside--;
    if (i.inside === 0) recorderBytes -= i.size;
    if (i.nlink === 0) {
      freed += i.size;
      return i.size;
    }
    return 0;
  };
  /** Deletes one regular file (lstat again just before); returns false if it was not deleted. */
  const remove = (p: string, boot: string, rel: string): boolean => {
    const s = lstat(p);
    if (s === null || !s.isFile() || !within(p)) return false;
    try {
      unlinkSync(p);
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') errors.push(`${relative(o.root, p)}: ${e instanceof Error ? e.message : 'error'}`);
      return false;
    }
    forget(s);
    deleted.push({ boot, path: rel, bytes: s.size });
    return true;
  };

  /** A past boot's folder with no recording file and no symlink anywhere in it is removed whole. */
  const holdsData = (dir: string): boolean => {
    const s = lstat(dir);
    if (s === null || !s.isDirectory()) return true;
    for (const name of list(dir)) {
      const p = join(dir, name);
      const e = lstat(p);
      if (e === null) continue;
      if (e.isSymbolicLink()) return true;
      if (e.isDirectory()) {
        if (holdsData(p)) return true;
      } else if (name.endsWith('.jsonl.zst') || PLAIN.test(name)) return true;
    }
    return false;
  };
  const removeBoot = (boot: string): void => {
    if (boot === o.current || boot === SAVED_STATES) return;
    const dir = join(o.root, boot);
    const s = lstat(dir);
    if (s === null || !s.isDirectory() || !within(dir) || holdsData(dir)) return;
    const files: Stats[] = [];
    const collect = (d: string): void => {
      for (const name of list(d)) {
        const e = lstat(join(d, name));
        if (e === null) continue;
        if (e.isDirectory()) collect(join(d, name));
        else if (e.isFile()) files.push(e);
      }
    };
    collect(dir);
    try {
      rmSync(dir, { recursive: true });
    } catch (e) {
      errors.push(`${boot}: ${e instanceof Error ? e.message : 'error'}`);
      return;
    }
    for (const f of files) forget(f);
    boots.push(boot);
  };
  /** Packed saved states no boot links to any more; never while a pack runs (it may be linking one). */
  const dropOrphans = (): void => {
    if (o.packing()) return;
    const dir = join(o.root, SAVED_STATES);
    const s = lstat(dir);
    if (s === null || !s.isDirectory()) return;
    for (const name of list(dir)) {
      if (!over()) return;
      if (!SAVED.test(name)) continue;
      const p = join(dir, name);
      const e = lstat(p);
      if (e === null || !e.isFile() || e.nlink !== 1) continue;
      if (o.packing()) return;
      remove(p, '', `${SAVED_STATES}/${name}`);
    }
  };

  const bootNames = list(o.root).filter((b) => b !== SAVED_STATES && lstat(join(o.root, b))?.isDirectory() === true);
  // Past boot folders that hold no recording (a reconcile pre-step's) go first, then unlinked saved states.
  for (const b of bootNames) {
    if (!over()) break;
    removeBoot(b);
  }
  dropOrphans();

  const candidates: Candidate[] = [];
  for (const boot of bootNames) {
    const daysDir = join(o.root, boot, 'days');
    if (lstat(daysDir)?.isDirectory() !== true) continue;
    for (const day of list(daysDir)) {
      if (!DAY.test(day) || lstat(join(daysDir, day))?.isDirectory() !== true) continue;
      for (const name of list(join(daysDir, day))) {
        const m = DATA.exec(name);
        if (m === null) continue;
        const p = join(daysDir, day, name);
        const s = lstat(p);
        if (s === null || !s.isFile()) continue;
        candidates.push({ boot, day, start: bootStart(boot), n: Number(m[2]), name, path: p, key: keyOf(s) });
      }
    }
  }
  candidates.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.start - b.start || a.n - b.n || (a.boot < b.boot ? -1 : a.boot > b.boot ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  const left = new Map<string, number>();
  for (const c of candidates) left.set(c.boot, (left.get(c.boot) ?? 0) + 1);
  for (const c of candidates) {
    if (!over()) break;
    remove(c.path, c.boot, `days/${c.day}/${c.name}`);
    const n = (left.get(c.boot) ?? 1) - 1;
    left.set(c.boot, n);
    if (n === 0 && c.boot !== o.current) {
      removeBoot(c.boot);
      dropOrphans();
    }
  }
  return { reason, deleted, bytes: deleted.reduce((a, d) => a + d.bytes, 0), boots, freeBytes: free(), recorderBytes, short: over(), errors };
};
