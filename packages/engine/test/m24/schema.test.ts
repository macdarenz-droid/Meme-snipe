// B-M24-02: migrations from an empty database and from every previous version, checksum and failure handling, and
// the migrated schema equal to the descriptors.
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'vitest';
import { openDb, OUTBOX_DDL, type Db } from '../../src/m24/db.ts';
import { schemaStatements, tableStatements } from '../../src/m24/ddl.ts';
import { erdMarkdown } from '../../src/m24/erd.ts';
import {
  appliedMigrations, checkMigrationList, M24_MIGRATION_LOG_CODES, migrationSha256, MIGRATIONS, prepareDatabase, type Migration,
} from '../../src/m24/migrate.ts';
import { M0001_INITIAL } from '../../src/m24/migrations/0001_initial.ts';
import { TABLE_NAMES, TABLES } from '../../src/m24/schema.ts';
import { createLogger, M27_LOG_CODES, mergeLogCodes } from '../../src/m27/log.ts';
import { labelsHash } from '../../src/m27/metrics.ts';
import { fakeClock, tempDir, schemaFixture } from '../helpers.ts';
import { pubkey } from './samples.ts';

const dir = tempDir('schema');
let n = 0;
/** The SHA-256 of migration 0001's text. Pinned: the text is frozen once applied anywhere; a change needs a new migration. */
const M0001_SHA256 = '74473e882c2c4eb0b8a1cc679915654092427130f17e2258f2a23ff4c9a2b3af';

function fresh(): { db: Db; path: string; lines: string[]; log: ReturnType<typeof createLogger> } {
  const path = join(dir, `m${n++}.db`);
  const lines: string[] = [];
  const clock = fakeClock();
  const log = createLogger({ clock, codes: mergeLogCodes(M27_LOG_CODES, M24_MIGRATION_LOG_CODES), runId: 'R', mode: 'paper', sink: { write: (l) => { lines.push(l); return 'written'; } } });
  return { db: openDb({ create: true, path, clock }), path, lines, log };
}

type Shape = Record<string, { columns: unknown[]; indexes: unknown[] }>;

/** Tables, columns (name, type, not null, default, key position), indexes (unique, partial, columns) and triggers. */
function shapeOf(raw: DatabaseSync): { tables: Shape; triggers: string[] } {
  const all = <T>(sql: string): T[] => raw.prepare(sql).all().map((r) => ({ ...r }) as T);
  const tables: Shape = {};
  for (const { name } of all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    const columns = all<Record<string, unknown>>(`PRAGMA table_xinfo("${name}")`).map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
    const indexes = all<{ name: string; unique: number; partial: number }>(`PRAGMA index_list("${name}")`)
      .map((ix) => [ix.name.startsWith('sqlite_autoindex') ? 'auto' : ix.name, ix.unique, ix.partial,
        all<{ name: string }>(`PRAGMA index_info("${ix.name}")`).map((c) => c.name).join(',')])
      .sort((a, b) => String(a).localeCompare(String(b)));
    tables[name] = { columns, indexes };
  }
  const triggers = all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").map((t) => t.name);
  return { tables, triggers };
}

/** Each object's CREATE text as SQLite stores it: CHECK constraints and trigger WHEN clauses, which shapeOf does not see. */
function schemaSql(raw: DatabaseSync): string[][] {
  return raw.prepare('SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name').all()
    .map((r) => [String(r.type), String(r.name), String(r.sql)]);
}

describe('migration list', () => {
  it('is numbered from 1 without gaps, and migration 0001 keeps its frozen text', () => {
    checkMigrationList(MIGRATIONS);
    assert.equal(MIGRATIONS[0], M0001_INITIAL);
    assert.equal(migrationSha256(M0001_INITIAL), M0001_SHA256);
    assert.throws(() => checkMigrationList([{ version: 2, name: 'x', statements: ['SELECT 1'] }]), /expected 1/);
    assert.throws(() => checkMigrationList([{ version: 1, name: 'x', statements: [] }]), /no statements/);
  });
});

describe('schema comparison', () => {
  it('sees a drifted CHECK constraint or retention horizon that the column and index shape does not', () => {
    const build = (edit: (sql: string) => string): DatabaseSync => {
      const raw = new DatabaseSync(':memory:');
      for (const statement of schemaStatements()) raw.exec(edit(statement));
      return raw;
    };
    const reference = build((sql) => sql);
    const check = schemaStatements().find((sql) => sql.includes('CHECK (')) as string;
    const horizon = schemaStatements().find((sql) => sql.includes('retention_clock') && sql.includes('_no_delete')) as string;
    const drifts = [
      build((sql) => (sql === check ? sql.replace(/CHECK \(/, 'CHECK (1 = 1 OR ') : sql)),
      build((sql) => (sql === horizon ? sql.replace(/ - (\d+) \* 1000/, (_m, d: string) => ` - ${Number(d) + 1} * 1000`) : sql)),
    ];
    for (const drifted of drifts) {
      assert.deepEqual(shapeOf(drifted), shapeOf(reference));
      assert.notDeepEqual(schemaSql(drifted), schemaSql(reference));
      drifted.close();
    }
    reference.close();
  });
});

describe('prepareDatabase (B-M24-02 logic 5; CL-52)', () => {
  it('from an empty database: backup first, then every migration; the schema equals the descriptors', async () => {
    const { db, path, lines, log } = fresh();
    const r = await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.start.bak`, log });
    assert.deepEqual(r, { ok: true, value: { from: 0, to: 1, applied: [1] } });
    assert.ok(existsSync(`${path}.start.bak`));
    assert.deepEqual(lines.map((l) => JSON.parse(l).code), ['m24.migration_applied']);
    assert.deepEqual(appliedMigrations(db).map((m) => m.version), [1]);
    db.close();
    const migrated = new DatabaseSync(path, { readOnly: true });
    const reference = new DatabaseSync(':memory:');
    for (const s of schemaStatements()) reference.exec(s);
    assert.deepEqual(shapeOf(migrated), shapeOf(reference));
    assert.deepEqual(schemaSql(migrated), schemaSql(reference));
    assert.deepEqual(Object.keys(shapeOf(migrated).tables).sort(), [...TABLE_NAMES].sort());
    migrated.close();
    reference.close();
  });

  it('a second start applies nothing; the B-M24-01 outbox DDL has the migrated outbox columns', async () => {
    const { db, path } = fresh();
    await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` });
    assert.deepEqual(await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` }), { ok: true, value: { from: 1, to: 1, applied: [] } });
    const raw = new DatabaseSync(':memory:');
    raw.exec(OUTBOX_DDL);
    const cols = (d: DatabaseSync | Db, sql: string): unknown => (d instanceof DatabaseSync ? d.prepare(sql).all() : schemaFixture(d, (tx) => tx.all(sql)))
      .map((c) => { const r = c as Record<string, unknown>; return [r.name, r.type, Number(r.notnull), Number(r.pk)]; });
    assert.deepEqual(cols(raw, 'PRAGMA table_info(outbox)'), cols(db, 'PRAGMA table_info(outbox)'));
    raw.close();
    db.close();
  });

  it('from every previous version: a later migration applies on top of version 1', async () => {
    const m2: Migration = { version: 2, name: 'add', statements: ['ALTER TABLE "kv_state" ADD COLUMN "note" TEXT', 'CREATE TABLE "later" ("x" INTEGER) STRICT'] };
    const { db, path } = fresh();
    assert.deepEqual(await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` }), { ok: true, value: { from: 0, to: 1, applied: [1] } });
    assert.deepEqual(await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak`, migrations: [M0001_INITIAL, m2] }), { ok: true, value: { from: 1, to: 2, applied: [2] } });
    assert.deepEqual(appliedMigrations(db).map((m) => [m.version, m.sha256]), [[1, M0001_SHA256], [2, migrationSha256(m2)]]);
    db.close();
    const empty = fresh();
    assert.deepEqual(await prepareDatabase(empty.db, { clock: fakeClock(), backupPath: `${empty.path}.bak`, migrations: [M0001_INITIAL, m2] }), { ok: true, value: { from: 0, to: 2, applied: [1, 2] } });
    empty.db.close();
  });

  it('acceptance: a migration failure leaves the database at the previous version (one transaction)', async () => {
    const bad: Migration = { version: 2, name: 'bad', statements: ['CREATE TABLE "half" ("x" INTEGER) STRICT', 'CREATE TABLE "fill" ("y" INTEGER)'] };
    const { db, path, lines, log } = fresh();
    await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` });
    const r = await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak`, migrations: [M0001_INITIAL, bad], log });
    assert.equal(r.ok, false);
    assert.deepEqual(r.ok ? null : [r.error.code, r.error.version], ['E_MIGRATION_FAILED', 2]);
    assert.deepEqual(appliedMigrations(db).map((m) => m.version), [1]);
    assert.equal(schemaFixture(db, (tx) => tx.get("SELECT 1 AS x FROM sqlite_schema WHERE name = 'half'")), undefined);
    assert.equal(JSON.parse(lines.at(-1) as string).code, 'm24.migration_failed');
    assert.equal(JSON.parse(lines.at(-1) as string).level, 'critical');
    db.close();
    const empty = fresh();
    const r2 = await prepareDatabase(empty.db, { clock: fakeClock(), backupPath: `${empty.path}.bak`, migrations: [M0001_INITIAL, bad] });
    assert.deepEqual(r2.ok ? null : [r2.error.code, r2.error.version], ['E_MIGRATION_FAILED', 2]);
    assert.deepEqual(appliedMigrations(empty.db), []);
    assert.equal(schemaFixture(empty.db, (tx) => tx.get("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'"))?.n, 0n);
    empty.db.close();
  });

  it('edge case: a checksum mismatch with an applied migration refuses the start (exits_only), and so does a newer schema', async () => {
    const { db, path } = fresh();
    await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` });
    db.withTx((tx) => tx.run("UPDATE schema_migrations SET sha256 = ? WHERE version = 1", '0'.repeat(64)));
    const r = await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` });
    assert.deepEqual(r.ok ? null : [r.error.code, r.error.version], ['E_MIGRATION_CHECKSUM', 1]);
    db.withTx((tx) => {
      tx.run('UPDATE schema_migrations SET sha256 = ? WHERE version = 1', M0001_SHA256);
      tx.run('INSERT INTO schema_migrations (version, sha256, applied_at) VALUES (2, ?, ?)', '1'.repeat(64), Date.UTC(2026, 9, 7));
    });
    const newer = await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` });
    assert.deepEqual(newer.ok ? null : [newer.error.code, newer.error.version], ['E_SCHEMA_NEWER', 2]);
    db.close();
  });

  it('takes the start backup only when migrations are pending (review m7)', async () => {
    const { db, path } = fresh();
    const backup = `${path}.start.bak`;
    await prepareDatabase(db, { clock: fakeClock(), backupPath: backup });
    assert.ok(existsSync(backup));
    rmSync(backup);
    assert.deepEqual(await prepareDatabase(db, { clock: fakeClock(), backupPath: backup }), { ok: true, value: { from: 1, to: 1, applied: [] } });
    assert.equal(existsSync(backup), false);
    db.close();
  });

  it('a failed start backup blocks pending migrations but not a start with nothing to apply', async () => {
    const { db, path, lines, log } = fresh();
    const nowhere = join(dir, 'missing-dir', 'x.bak');
    const r = await prepareDatabase(db, { clock: fakeClock(), backupPath: nowhere, log });
    assert.deepEqual(r.ok ? null : [r.error.code, r.error.version], ['E_BACKUP_FAILED', null]);
    assert.deepEqual(appliedMigrations(db), []);
    assert.equal(JSON.parse(lines[0] as string).code, 'm24.start_backup_failed');
    await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` });
    assert.deepEqual(await prepareDatabase(db, { clock: fakeClock(), backupPath: nowhere }), { ok: true, value: { from: 1, to: 1, applied: [] } });
    db.close();
  });
});

describe('metric_rollup_1m disk use (review R2)', () => {
  it('stores a rollup row in at most 100 bytes (measured 87; 259 with a hex hash in a rowid table)', () => {
    const raw = new DatabaseSync(':memory:');
    for (const statement of tableStatements('metric_rollup_1m', TABLES.metric_rollup_1m)) raw.exec(statement);
    const insert = raw.prepare("INSERT INTO metric_rollup_1m (metric, labels_hash, minute, scope, count, sum, p50, p95, p99, created_at) VALUES (?, ?, ?, 'pool', ?, ?, ?, ?, ?, ?)");
    // 200 watched pools with their three per-pool series, 120 minutes, written in the registry's order (one
    // transaction a minute): 72,000 rows.
    const series = Array.from({ length: 200 }, (_, p) => pubkey(p + 1)).flatMap((pool) => [
      ['pool_snapshot_age_ms', labelsHash({ pool })], ['bar_missing_ratio', labelsHash({ pool })], ['observation_lag_slots', labelsHash({ pool, provider: 'shyft' })],
    ] as const);
    const t0 = Date.UTC(2026, 9, 7);
    let rows = 0;
    for (let m = 0; m < 120; m++) {
      raw.exec('BEGIN');
      series.forEach(([metric, hash], i) => {
        const v = (i * 7_919 + m * 104_729) % 2_000;
        insert.run(metric, hash, t0 + m * 60_000, 60, v * 60.25, v, v + 0.5, v * 1.01, t0 + m * 60_000 + 60_001);
        rows += 1;
      });
      raw.exec('COMMIT');
    }
    const pragma = (name: string): number => Number(Object.values(raw.prepare(`PRAGMA ${name}`).get() as object)[0]);
    const bytesPerRow = ((pragma('page_count') - pragma('freelist_count')) * pragma('page_size')) / rows;
    raw.close();
    assert.ok(bytesPerRow <= 100, `${bytesPerRow.toFixed(1)} bytes a row`);
  });
});

describe('ERD (B-M24-02 definition of done)', () => {
  it('docs/ERD.md is the generated diagram of the current schema', () => {
    const file = readFileSync(new URL('../../../../docs/ERD.md', import.meta.url), 'utf8');
    assert.equal(file, erdMarkdown());
    for (const name of Object.keys(TABLES)) assert.match(file, new RegExp(`^  ${name} \\{$`, 'm'));
  });
});
