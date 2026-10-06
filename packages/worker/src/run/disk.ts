// DISK-GUARD: free space on the state directory's filesystem, the recorder's bytes, and what the worker does as space
// runs low. First the recorder stops writing frames (the gap is marked in its manifest and the journal) while state,
// ledger, journal and account writes go on; then, at a lower floor, entries are refused ('disk low'). Exits are never
// stopped. Each step comes back only once free space is a margin above where it started (no flapping at the line).
import { existsSync, readdirSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export interface DiskSample {
  readonly atMs: number;
  /** Bytes an unprivileged writer may still use (statfs bavail × bsize): what the worker can write. */
  readonly freeBytes: number;
  readonly totalBytes: number;
  /** Every recorder file: the sealed files its manifests list, plus the plain files still being written. */
  readonly recorderBytes: number;
}

export interface DiskPolicy {
  /** Below this the recorder stops writing frames. */
  readonly recorderPauseBytes: number;
  /** The recorder writes again once free space is back at or above this. */
  readonly recorderResumeBytes: number;
  /** Below this new entries are refused ('disk low'); exits continue. */
  readonly entryFloorBytes: number;
  /** Entries are allowed again once free space is back at or above this. */
  readonly entryResumeBytes: number;
}

/** How often the worker reads the disk. */
export const DISK_EVERY_MS = 60_000;
/** The hourly readings kept for the slope, in the state directory. */
export const DISK_HISTORY_FILE = 'disk-history.json';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * Defaults (WORKER-HARDEN's estimate, supervisor 2026-10-05): the recorder holds up to 5 open plain tables × 64 MiB
 * plus 64 MiB while sealing (384 MiB), and a worst-case day writes about 1 GiB; it pauses while that much is still free
 * (rounded up to 1.5 GiB). Entries stop at 512 MiB: room for state, ledger, journal and account writes (each a few MB a
 * day; deployers.jsonl grows by appends) while every open position is exited. Each resumes 512 MiB higher.
 */
export const DEFAULT_DISK_POLICY: DiskPolicy = {
  recorderPauseBytes: 1.5 * GiB,
  recorderResumeBytes: 2 * GiB,
  entryFloorBytes: 512 * MiB,
  entryResumeBytes: 1 * GiB,
};

/** A policy whose steps keep their order: entries stop below the recorder's pause, and each resumes above its own line. */
export const validDiskPolicy = (p: DiskPolicy): boolean =>
  [p.entryFloorBytes, p.entryResumeBytes, p.recorderPauseBytes, p.recorderResumeBytes].every((n) => Number.isSafeInteger(n) && n > 0) &&
  p.entryFloorBytes < p.entryResumeBytes && p.recorderPauseBytes < p.recorderResumeBytes && p.entryFloorBytes < p.recorderPauseBytes;

export interface DiskState {
  readonly recorderPaused: boolean;
  readonly entriesRefused: boolean;
}

export const DISK_OK: DiskState = { recorderPaused: false, entriesRefused: false };

/**
 * The next state from the last one and a sample. No sample (statfs failed): entries are refused, since nothing proves
 * there is room to record what an entry writes; the recorder keeps its state (pausing it would lose data on a guess).
 */
export const nextDiskState = (prev: DiskState, s: DiskSample | null, p: DiskPolicy): DiskState => {
  if (s === null) return { recorderPaused: prev.recorderPaused, entriesRefused: true };
  const free = s.freeBytes;
  const recorderPaused = prev.recorderPaused ? free < p.recorderResumeBytes : free < p.recorderPauseBytes;
  const entriesRefused = prev.entriesRefused ? free < p.entryResumeBytes : free < p.entryFloorBytes;
  return { recorderPaused, entriesRefused };
};

/** The halt reason entries carry while refused (api.ts haltOf names it 'disk-low'). */
export const DISK_LOW = 'disk low';

/** Readings kept for the slope: one an hour at most, for the last 7 days. */
const HISTORY_MS = 7 * 86_400_000;
const HISTORY_STEP_MS = 3_600_000;
/** The slope needs readings at least this far apart. */
const SLOPE_MIN_SPAN_MS = 6 * 3_600_000;

export interface DiskPoint {
  readonly atMs: number;
  readonly freeBytes: number;
}

/** Adds a reading to the history: at most one an hour, none older than 7 days. */
export const addPoint = (h: readonly DiskPoint[], s: DiskSample): DiskPoint[] => {
  const kept = h.filter((x) => s.atMs - x.atMs <= HISTORY_MS && x.atMs <= s.atMs);
  const last = kept[kept.length - 1];
  if (last !== undefined && s.atMs - last.atMs < HISTORY_STEP_MS) return kept;
  return [...kept, { atMs: s.atMs, freeBytes: s.freeBytes }];
};

/**
 * Days until the disk is full at the slope from the oldest kept reading (at least 6 hours old) to now. Null when there
 * is not that much history yet, or free space is not falling.
 */
export const daysToFull = (h: readonly DiskPoint[], s: DiskSample): number | null => {
  const first = h.find((x) => s.atMs - x.atMs >= SLOPE_MIN_SPAN_MS && s.atMs - x.atMs <= HISTORY_MS);
  if (first === undefined) return null;
  const perDay = ((first.freeBytes - s.freeBytes) / (s.atMs - first.atMs)) * 86_400_000;
  if (!(perDay > 0)) return null;
  return Math.floor((s.freeBytes / perDay) * 10) / 10;
};

/** Reads the history file (a list of points); anything else reads as none. */
export const parseHistory = (text: string): DiskPoint[] => {
  try {
    const v = JSON.parse(text) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is DiskPoint => typeof x === 'object' && x !== null && Number.isSafeInteger((x as DiskPoint).atMs) && Number.isSafeInteger((x as DiskPoint).freeBytes));
  } catch {
    return [];
  }
};

/** The recorder's bytes: each boot folder's manifest `days[].files[].bytes`, plus plain `.jsonl` files under `days/`. */
export const recorderBytes = (root: string): number => {
  if (!existsSync(root)) return 0;
  let total = 0;
  for (const boot of readdirSync(root)) {
    const dir = join(root, boot);
    try {
      const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { days?: { files?: { bytes?: unknown }[] }[] };
      for (const d of m.days ?? []) for (const f of d.files ?? []) if (typeof f.bytes === 'number') total += f.bytes;
    } catch {
      // no manifest yet: its sealed files are counted when it is written
    }
    const days = join(dir, 'days');
    if (!existsSync(days)) continue;
    for (const day of readdirSync(days)) {
      const dd = join(days, day);
      let names: string[];
      try {
        names = readdirSync(dd);
      } catch {
        continue;
      }
      for (const f of names) if (f.endsWith('.jsonl')) total += statSync(join(dd, f), { throwIfNoEntry: false })?.size ?? 0;
    }
  }
  return total;
};

/** One reading of the filesystem holding `stateDir`; null when statfs fails. */
export const readDisk = (stateDir: string, recorderRoot: string, atMs: number): DiskSample | null => {
  try {
    const f = statfsSync(stateDir);
    return { atMs, freeBytes: Number(f.bavail) * Number(f.bsize), totalBytes: Number(f.blocks) * Number(f.bsize), recorderBytes: recorderBytes(recorderRoot) };
  } catch {
    return null;
  }
};
