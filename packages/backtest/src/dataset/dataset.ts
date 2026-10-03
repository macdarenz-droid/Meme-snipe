// The DATA-1 dataset on disk: manifest.json and days/YYYY-MM-DD/<table>-NNN.<csv|jsonl>.zst (schema 1).
// mints.csv.zst is deliberately never read here: it holds whole-life facts (graduation time, tape end, censoring)
// that would tell the engine the future. Lifecycle facts reach the engine only as the events of the day they happen.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { type DatasetRow, compareRows, readAmm, readBlocks, readCurve, readEvents } from './rows.ts';

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
  /** Slots where an event layout changed (e.g. the 2 Oct pump upgrade). Name agreed with DATA-1; absent in older manifests. */
  readonly regime_boundaries?: readonly { readonly slot: number; readonly label: string }[];
  readonly [key: string]: unknown;
}

export const SUPPORTED_SCHEMA = 1;

export const loadManifest = (dir: string): Manifest => {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (m.schema !== SUPPORTED_SCHEMA) throw new RangeError(`dataset schema ${String(m.schema)} is not supported (reader is schema ${SUPPORTED_SCHEMA})`);
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
    const full = join(dir, f.path.startsWith('days/') ? f.path : join('days', day.day, f.path));
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
