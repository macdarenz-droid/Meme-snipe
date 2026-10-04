// The DATA-1 dataset on disk: manifest.json and days/YYYY-MM-DD/<table>-NNN.<csv|jsonl>.zst (schema 3).
// mints.csv.zst is deliberately never read here: it holds whole-life facts (graduation time, tape end, censoring)
// that would tell the engine the future. Lifecycle facts reach the engine only as the events of the day they happen.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { readRaw } from './raw.ts';
import { parseVolumeHoursCsv, type VolumeHour } from '../../../core/src/facts/index.ts';
import { type CoverageRow, type DatasetRow, type MovementRow, compareRows, readAmm, readBlocks, readCoverage, readCurve, readEvents, readMovements } from './rows.ts';

export interface ManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly rows?: number;
}

export interface ManifestDay {
  readonly day: string;
  readonly blocks_expected: number;
  readonly blocks_scanned: number;
  readonly complete: boolean;
  readonly warm_up: boolean;
  readonly rows: Readonly<Record<string, number>>;
  readonly files: readonly ManifestFile[];
}

export interface Manifest {
  readonly schema: number;
  readonly generated_at?: string;
  readonly window: { readonly from: string; readonly to_exclusive: string };
  readonly coverage: { readonly first_slot: number; readonly last_slot: number; readonly first_block_time?: number; readonly last_block_time?: number };
  readonly coverage_gaps?: readonly unknown[];
  readonly days: readonly ManifestDay[];
  readonly [key: string]: unknown;
}

/** Schema 3 only: trade rows carry the user token account and its owner, which holder facts need (DATA-1 #46). */
export const SUPPORTED_SCHEMA = 3;

export const loadManifest = (dir: string): Manifest => {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (!Array.isArray(m.days)) throw new RangeError('manifest has no days');
  if (m.schema !== SUPPORTED_SCHEMA) throw new RangeError(`dataset schema ${String(m.schema)} is not supported (reader is schema ${SUPPORTED_SCHEMA})`);
  return m;
};

/** sha256 of the manifest file: the dataset id recorded in every report. */
export const manifestHash = (dir: string): string => createHash('sha256').update(readFileSync(join(dir, 'manifest.json'))).digest('hex');

const TABLES: Readonly<Record<string, (text: string, out: DatasetRow[]) => void>> = {
  amm_trades: readAmm,
  curve_trades: readCurve,
  blocks: readBlocks,
  events: readEvents,
  raw: readRaw,
};

/** Table name of a day file: `amm_trades-000.csv.zst` → `amm_trades`. Files of other tables are not read. */
export const tableOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/-\d+\.(csv|jsonl)\.zst$/, '').replace(/\.(csv|jsonl)\.zst$/, '');
};

const readVerified = (dir: string, day: string, f: ManifestFile, options: LoadOptions): string => {
  const raw = readFileSync(locate(dir, day, f.path));
  if (options.verify !== false) {
    if (raw.length !== f.bytes) throw new RangeError(`${f.path}: ${raw.length} bytes, manifest says ${f.bytes}`);
    const sum = createHash('sha256').update(raw).digest('hex');
    if (sum !== f.sha256) throw new RangeError(`${f.path}: sha256 ${sum} does not match the manifest`);
  }
  return zstdDecompressSync(raw).toString('utf8');
};

/** One day's token movements (schema 3), in chain order. Only holder rebuilds read them; trading replays never do. */
export const loadMovements = (dir: string, day: ManifestDay, options: LoadOptions = {}): MovementRow[] => {
  const out: MovementRow[] = [];
  for (const f of day.files) if (tableOf(f.path) === 'movements') readMovements(readVerified(dir, day.day, f, options), out);
  return out.sort((a, b) => (a.slot !== b.slot ? (a.slot < b.slot ? -1 : 1) : a.txIdx - b.txIdx || a.outerIx - b.outerIx || (a.innerIx ?? -1) - (b.innerIx ?? -1)));
};

/**
 * One day's regime volume hours (DATA-1c `days/DAY/volume_hours-NNN.csv.zst`), parsed by core's
 * `parseVolumeHoursCsv` (the same parser as the live reader). A malformed file refuses the whole day (no rows: unknown,
 * never zero); a day without the file has no rows.
 */
export const loadVolumeHours = (dir: string, day: ManifestDay, options: LoadOptions = {}): VolumeHour[] => {
  const dayNumber = Date.parse(`${day.day}T00:00:00Z`) / 86_400_000;
  const out: VolumeHour[] = [];
  for (const f of day.files) {
    if (tableOf(f.path) !== 'volume_hours') continue;
    const rows = parseVolumeHoursCsv(readVerified(dir, day.day, f, options), dayNumber);
    if (rows === null) return [];
    out.push(...rows);
  }
  return out;
};

/**
 * The dataset's movement coverage notes (schema 3; listed with the mint files, not by day). Every note is dated, and
 * a consumer applies it only once the replay reaches its slot.
 */
export const loadCoverage = (dir: string, manifest: Manifest, options: LoadOptions = {}): CoverageRow[] => {
  if (manifest.schema !== SUPPORTED_SCHEMA) throw new RangeError(`movement coverage needs schema ${SUPPORTED_SCHEMA}`);
  const files = (manifest['mints_files'] ?? []) as readonly ManifestFile[];
  const out: CoverageRow[] = [];
  for (const f of files) if (tableOf(f.path) === 'movement_coverage') readCoverage(readVerified(dir, '', f, options), out);
  return out;
};

export interface LoadOptions {
  /** Check every file's size and sha256 against the manifest (default true). */
  readonly verify?: boolean;
}

/** Every row of one day the backtest reads, in chain order. Throws on a missing, altered or unreadable file. */
export const loadDay = (dir: string, day: ManifestDay, options: LoadOptions = {}): DatasetRow[] => {
  const out: DatasetRow[] = [];
  for (const f of day.files) {
    const reader = TABLES[tableOf(f.path)];
    if (reader === undefined) continue;
    reader(readVerified(dir, day.day, f, options), out);
  }
  // Array.prototype.sort is stable, so equal keys keep file order.
  return out.sort(compareRows);
};

/** The files of one day that loadDay reads (the trading tables; movements and other tables are not read). */
export const dayFilesRead = (day: ManifestDay): readonly ManifestFile[] => day.files.filter((f) => TABLES[tableOf(f.path)] !== undefined);

/** The files SHA256SUMS lists, as resolved paths (empty without the file). Call after verifySums. */
export const sumsListed = (dir: string): ReadonlySet<string> => {
  const sums = join(dir, 'SHA256SUMS');
  if (!existsSync(sums)) return new Set();
  const root = resolve(dir);
  return new Set(readFileSync(sums, 'utf8').split('\n').flatMap((line) => {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    return m === null ? [] : [resolve(root, m[2]!)];
  }));
};

/**
 * A day file on disk: `days/<day>/<file>` as the scanner writes it, or `<day>__<file>` as the release assets publish
 * it (DATA-1's workflow flattens the day folders). Missing in both places is an error.
 */
export const locate = (dir: string, day: string, path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  // Dataset-level files (day ''): at the top, by their own name.
  const where = day === '' ? [join(dir, path)] : [join(dir, path.startsWith('days/') ? path : join('days', day, path)), join(dir, `${day}__${base}`)];
  for (const p of where) if (existsSync(p)) return p;
  throw new RangeError(`${path} is in neither days/${day}/ nor ${day}__${base}`);
};

/**
 * When the directory holds a SHA256SUMS file (release assets), every file it lists must be present and match, the
 * manifest included. Returns how many files were checked (0 without the file).
 */
export const verifySums = (dir: string): number => {
  const sums = join(dir, 'SHA256SUMS');
  if (!existsSync(sums)) return 0;
  let n = 0;
  for (const line of readFileSync(sums, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m === null) continue;
    const name = m[2]!;
    // Only plain names inside the directory: never "..", an absolute path, or anything that resolves outside it.
    const root = resolve(dir);
    const file = resolve(root, name);
    if (isAbsolute(name) || name.split(/[\\/]/).includes('..') || !file.startsWith(root + sep)) throw new RangeError(`SHA256SUMS names ${name}, outside the dataset directory`);
    if (!existsSync(file)) throw new RangeError(`SHA256SUMS lists ${m[2]}, which is missing`);
    const got = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (got !== m[1]) throw new RangeError(`${m[2]}: sha256 ${got} does not match SHA256SUMS`);
    n++;
  }
  if (n === 0) throw new RangeError('SHA256SUMS lists no files');
  return n;
};

interface UpgradeMark { readonly slot?: number }

/**
 * Regime boundaries from the manifest: every `program_upgrade_<date>` entry (DATA-1). Its exact `slot` when the
 * manifest gives one; otherwise the earliest slot where its effects were seen (extra event bytes on curve or PumpSwap
 * trades, or a new event type), which is an upper bound on the upgrade slot: the upgrade happened at or before it.
 */
export const regimeBoundariesOf = (m: Manifest): { readonly slot: bigint; readonly label: string }[] =>
  Object.entries(m)
    .filter(([k, v]) => /^program_upgrade_/.test(k) && typeof v === 'object' && v !== null)
    .flatMap(([k, v]) => {
      const exact = (v as UpgradeMark).slot;
      if (Number.isSafeInteger(exact)) return [{ slot: BigInt(exact!), label: k }];
      const marks = ['first_extra_hex_curve', 'first_extra_hex_amm', 'first_unknown_event']
        .map((f) => (v as Record<string, UpgradeMark | null | undefined>)[f]?.slot)
        .filter((x): x is number => Number.isSafeInteger(x));
      return marks.length === 0 ? [] : [{ slot: BigInt(Math.min(...marks)), label: k }];
    })
    .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
