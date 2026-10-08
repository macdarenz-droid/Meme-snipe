// DDL generation from the table descriptors (B-M24-02 logic 1-4). Used to write the frozen text of a new migration
// and, in tests, to build a reference schema that the migrated database must match. Every table is STRICT (SQLite
// enforces the declared storage class), every identifier is quoted.
import { snake, TABLES, type ColumnDef, type TableDef } from './schema.ts';

const q = (name: string): string => `"${name}"`;
const BASE58 = '[^1-9A-HJ-NP-Za-km-z]';
const DAY_S = 86_400;
/** Lowest epoch-millisecond time a `ms` column accepts: 10^12 (2001-09-09); a time in seconds is far below it. */
export const MS_MIN = 1_000_000_000_000;
/**
 * Upper bound (exclusive) of a `ms` column: 10^14 (year 5138); a time in microseconds is far above it and would never
 * pass a retention horizon, so it is refused (red team n3).
 */
export const MS_MAX = 100_000_000_000_000;

/** SQLite storage class of a column kind. */
export function storageOf(kind: ColumnDef['kind']): 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' {
  switch (kind) {
    case 'bool': case 'int': case 'ms': case 'lamports': case 'slamports': case 'i64':
      return 'INTEGER';
    case 'real':
      return 'REAL';
    case 'blob':
      return 'BLOB';
    default:
      return 'TEXT';
  }
}

/** The CHECK expression of a column (null when the kind needs none), for a non-null value. */
export function checkOf(col: string, def: ColumnDef): string | null {
  const x = q(col);
  const unsigned = (d: string): string => `${d} <> '' AND ${d} NOT GLOB '*[^0-9]*' AND (${d} = '0' OR ${d} NOT GLOB '0*')`;
  const digits = `(CASE WHEN ${x} GLOB '-*' THEN substr(${x}, 2) ELSE ${x} END)`;
  switch (def.kind) {
    case 'ulid': return `length(${x}) = 26 AND ${x} NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'`;
    case 'pubkey': return `length(${x}) BETWEEN 32 AND 44 AND ${x} NOT GLOB '*${BASE58}*'`;
    case 'signature': return `length(${x}) BETWEEN 64 AND 88 AND ${x} NOT GLOB '*${BASE58}*'`;
    case 'sha256': return `length(${x}) = 64 AND ${x} NOT GLOB '*[^0-9a-f]*'`;
    case 'json': return `json_valid(${x})`;
    case 'bool': return `${x} IN (0, 1)`;
    case 'ms': return `${x} >= ${MS_MIN} AND ${x} < ${MS_MAX}`;
    case 'lamports': return `${x} >= 0`;
    case 'u64': return `${unsigned(x)} AND (length(${x}) < 20 OR (length(${x}) = 20 AND ${x} <= '18446744073709551615'))`;
    case 'i128': return `${unsigned(digits)} AND length(${digits}) <= 39 AND ${x} <> '-0'`;
    case 'decimal':
      return `length(${x}) <= 100 AND ${digits} GLOB '[0-9]*' AND ${digits} NOT GLOB '*[^0-9.]*' AND ${digits} NOT GLOB '*.*.*' AND ${digits} NOT GLOB '*.'`
        + ` AND ${digits} NOT GLOB '0[0-9]*' AND (instr(${digits}, '.') = 0 OR length(${digits}) - instr(${digits}, '.') <= 30)`;
    case 'enum': return `${x} IN (${(def.values ?? []).map((v) => `'${v}'`).join(', ')})`;
    case 'text': return def.maxBytes === undefined ? null : `length(CAST(${x} AS BLOB)) <= ${def.maxBytes}`;
    default: return null;
  }
}

function columnSql(name: string, def: ColumnDef, table: TableDef): string {
  const col = snake(name);
  const parts = [q(col), storageOf(def.kind)];
  const rowid = table.autoincrement === true && table.key[0] === name;
  if (rowid) parts.push('PRIMARY KEY AUTOINCREMENT');                 // an alias of the rowid: never null
  else if (def.nullable !== true) parts.push('NOT NULL');
  if (def.default !== undefined) parts.push(`DEFAULT ${def.default}`);
  const check = checkOf(col, def);
  if (check !== null) parts.push(`CHECK (${def.nullable === true ? `${q(col)} IS NULL OR (${check})` : check})`);
  return parts.join(' ');
}

/** Seconds of the retention horizon of a row, as SQL over OLD (null for `forever`). */
function horizonSql(def: TableDef): string | null {
  const r = def.retention;
  if (r === 'forever') return null;
  if (!('byColumn' in r)) return `${r.days * DAY_S}`;
  const cases = Object.entries(r.days).map(([g, days]) => `WHEN '${g}' THEN ${days * DAY_S}`).join(' ');
  return `(CASE OLD.${q(snake(r.byColumn))} ${cases} END)`;
}

/** The retention job's time for its own transaction; 0 (every DELETE refused) when unset (ruling 10). */
export const RETENTION_NOW_SQL = `coalesce((SELECT ${q('now_ms')} FROM ${q('retention_clock')} WHERE ${q('id')} = 1), 0)`;

/** The statements that create one table with its indexes and triggers. */
export function tableStatements(name: string, def: TableDef): string[] {
  const cols = Object.entries(def.columns).map(([n, c]) => `  ${columnSql(n, c, def)}`);
  if (def.autoincrement !== true) cols.push(`  PRIMARY KEY (${def.key.map((k) => q(snake(k))).join(', ')})`);
  for (const u of def.unique ?? []) cols.push(`  UNIQUE (${u.map((k) => q(snake(k))).join(', ')})`);
  for (const check of def.checks ?? []) cols.push(`  CHECK (${check})`);
  const out = [`CREATE TABLE ${q(name)} (\n${cols.join(',\n')}\n) STRICT${def.withoutRowid === true ? ', WITHOUT ROWID' : ''}`];
  for (const ix of def.indexes ?? []) {
    out.push(`CREATE ${ix.unique === true ? 'UNIQUE ' : ''}INDEX ${q(ix.name)} ON ${q(name)} (${ix.columns.map((k) => q(snake(k))).join(', ')})${ix.where === undefined ? '' : ` WHERE ${ix.where}`}`);
  }
  if (def.appendOnly) {
    out.push(`CREATE TRIGGER ${q(`${name}_no_update`)} BEFORE UPDATE ON ${q(name)} BEGIN SELECT RAISE(ABORT, 'append_only'); END`);
    const horizon = horizonSql(def);
    // Old by both clocks, or refused (ruling 14): the retention job's time and SQLite's wall clock.
    const when = horizon === null ? ''
      : ` WHEN OLD.${q('created_at')} > ${RETENTION_NOW_SQL} - ${horizon} * 1000 OR OLD.${q('created_at')} > (unixepoch('now') - ${horizon}) * 1000`;
    out.push(`CREATE TRIGGER ${q(`${name}_no_delete`)} BEFORE DELETE ON ${q(name)}${when} BEGIN SELECT RAISE(ABORT, 'append_only'); END`);
  }
  if (def.updateOnce !== undefined) {
    const fixed = Object.keys(def.columns).filter((k) => !(def.updateOnce as { columns: readonly string[] }).columns.includes(k));
    const changed = fixed.map((k) => `NEW.${q(snake(k))} IS NOT OLD.${q(snake(k))}`).join(' OR ');
    out.push(`CREATE TRIGGER ${q(`${name}_update_once`)} BEFORE UPDATE ON ${q(name)} WHEN OLD.${q(snake(def.updateOnce.whileNull))} IS NOT NULL OR ${changed} BEGIN SELECT RAISE(ABORT, 'append_only'); END`);
  }
  return out;
}

/** Every statement of a fresh schema, tables in descriptor order. */
export function schemaStatements(tables: Readonly<Record<string, TableDef>> = TABLES): string[] {
  return Object.entries(tables).flatMap(([name, def]) => tableStatements(name, def));
}
