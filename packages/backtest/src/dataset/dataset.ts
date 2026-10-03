// The DATA-1 dataset on disk: manifest.json and days/YYYY-MM-DD/<table>-NNN.<csv|jsonl>.zst (schema 1).
// mints.csv.zst is deliberately never read here: it holds whole-life facts (graduation time, tape end, censoring)
// that would tell the engine the future. Lifecycle facts reach the engine only as the events of the day they happen.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { type DatasetRow, compareRows, readAmm, readBlocks, readCurve, readEvents } from './rows.ts';
import { readRaw } from './raw.ts';

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

/** Schema 2 adds raw transaction records, `outer_ix`/`inner_ix` and `jito_tip`; columns are read by name, so both read. */
export const SUPPORTED_SCHEMAS: readonly number[] = [1, 2];

export const loadManifest = (dir: string): Manifest => {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (!SUPPORTED_SCHEMAS.includes(m.schema)) throw new RangeError(`dataset schema ${String(m.schema)} is not supported (reader reads schemas ${SUPPORTED_SCHEMAS.join(', ')})`);
  if (!Array.isArray(m.days)) throw new RangeError('manifest has no days');
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
    const full = locate(dir, day.day, f.path);
    const raw = readFileSync(full);
    if (options.verify !== false) {
      if (raw.length !== f.bytes) throw new RangeError(`${f.path}: ${raw.length} bytes, manifest says ${f.bytes}`);
      const sum = createHash('sha256').update(raw).digest('hex');
      if (sum !== f.sha256) throw new RangeError(`${f.path}: sha256 ${sum} does not match the manifest`);
    }
    reader(zstdDecompressSync(raw).toString('utf8'), out);
  }
  // Array.prototype.sort is stable, so equal keys keep file order.
  return out.sort(compareRows);
};

/**
 * A day file on disk: `days/<day>/<file>` as the scanner writes it, or `<day>__<file>` as the release assets publish
 * it (DATA-1's workflow flattens the day folders). Missing in both places is an error.
 */
export const locate = (dir: string, day: string, path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  for (const p of [join(dir, path.startsWith('days/') ? path : join('days', day, path)), join(dir, `${day}__${base}`)]) if (existsSync(p)) return p;
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
