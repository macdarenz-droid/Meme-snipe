// Z02 round 2 rulings (docs/reviews/Z02.md on claude/supervisor-docs-2): each test fails on the round 1 head and
// passes here. Rulings 3 and 4 are in m25/bootstrap.test.ts, 5 in packages/contract, 6 in tools/policy and
// packages/core/test/ledger/labels.test.ts.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import { DbOpenError, isDdl, M24_LOG_CODES, openDb, type Db } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { createRepos, metricRollupSink, M24_ROLLUP_LOG_CODES, ROLLUP_ROW_BYTES } from '../../src/m24/repos.ts';
import { deleteExpired } from '../../src/m24/retention.ts';
import { createLogger, M27_LOG_CODES, mergeLogCodes } from '../../src/m27/log.ts';
import { FileLogSink } from '../../src/m27/logfile.ts';
import { MetricsRegistry, type RollupRow } from '../../src/m27/metrics.ts';
import { fakeClock, tempDir, schemaFixture } from '../helpers.ts';
import { sampleRow } from './samples.ts';

const dir = tempDir('round2');
let n = 0;
const fresh = (): string => join(dir, `r${n++}.db`);
const repos = createRepos();
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

function logger() {
  const lines: string[] = [];
  const log = createLogger({ clock: fakeClock(T0), codes: mergeLogCodes(M27_LOG_CODES, M24_LOG_CODES, M24_ROLLUP_LOG_CODES), runId: 'R', mode: 'paper',
    sink: { write: (l) => { lines.push(l); return 'written'; } } });
  return { log, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

async function migrated(path = fresh()): Promise<Db> {
  const db = openDb({ create: true, path, clock: fakeClock(T0) });
  assert.equal((await prepareDatabase(db, { clock: fakeClock(T0), backupPath: `${path}.bak` })).ok, true);
  return db;
}

const tables = (db: Db): string[] => db.reader().all("SELECT name FROM sqlite_schema WHERE type = 'table'").map((r) => r.name as string);

describe('ruling 1: no login credentials are stored without the owner\'s approval', () => {
  it('migration 0001 creates no operator, webauthn_credential, session or operator_preferences table', async () => {
    const db = await migrated();
    for (const t of ['operator', 'webauthn_credential', 'session', 'operator_preferences']) assert.equal(tables(db).includes(t), false, t);
    db.close();
  });
});

describe('ruling 2: a database is created only by an explicit init', () => {
  it('a missing file refuses the start with a critical log; botctl init (create) and a first-start marker outside the directory create it', () => {
    const { log, parsed } = logger();
    const dbDir = join(dir, `db${n++}`);
    mkdirSync(dbDir);
    const path = join(dbDir, 'bot.db');
    assert.throws(() => openDb({ path, clock: fakeClock(T0), log }), (e: unknown) => e instanceof DbOpenError && e.code === 'E_DATABASE_MISSING');
    assert.deepEqual(parsed().map((l) => [l.level, l.code, l.error_code]), [['critical', 'm24.open_refused', 'E_DATABASE_MISSING']]);
    assert.equal(existsSync(path), false);
    const etc = join(dir, `etc${n++}`);
    mkdirSync(etc);
    const marker = join(etc, 'first-start');
    assert.throws(() => openDb({ path, clock: fakeClock(T0), initMarker: marker }), /E_DATABASE_MISSING|does not exist/);  // no marker yet
    writeFileSync(marker, '');
    openDb({ path, clock: fakeClock(T0), initMarker: marker }).close();
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(marker), false);                                               // spent
    openDb({ path, clock: fakeClock(T0) }).close();                                         // exists now: no init needed
    const other = join(dbDir, 'other.db');
    assert.throws(() => openDb({ path: other, clock: fakeClock(T0), initMarker: join(dbDir, 'm') }), /outside the database directory/);
    assert.throws(() => openDb({ path: other, clock: fakeClock(T0), initMarker: join(dbDir, 'sub', 'm') }), /outside the database directory/);
    openDb({ path: other, clock: fakeClock(T0), create: true }).close();
  });
});

describe('ruling 15: a first-start marker that cannot be removed refuses the start and leaks nothing', () => {
  it('E_INIT_MARKER_STUCK with a critical log, the writer closed and the lock released; the marker never sits silently beside a database', () => {
    const dbDir = join(dir, `db${n++}`);
    const etc = join(dir, `etc${n++}`);
    mkdirSync(dbDir);
    const marker = join(etc, 'first-start');
    mkdirSync(join(marker, 'x'), { recursive: true });                                     // cannot be removed (a non-empty directory)
    const path = join(dbDir, 'bot.db');
    const { log, parsed } = logger();
    assert.throws(() => openDb({ path, clock: fakeClock(T0), initMarker: marker, log }), (e: unknown) => e instanceof DbOpenError && e.code === 'E_INIT_MARKER_STUCK');
    assert.equal(parsed().at(-1)?.error_code, 'E_INIT_MARKER_STUCK');
    openDb({ path, clock: fakeClock(T0) }).close();                                         // lock released, writer closed
    assert.throws(() => openDb({ path, clock: fakeClock(T0), initMarker: marker }), /E_INIT_MARKER_STUCK|cannot be removed/);  // still beside it
    rmSync(marker, { recursive: true });
    writeFileSync(marker, '');                                                              // a removable leftover beside the database
    openDb({ path, clock: fakeClock(T0), initMarker: marker }).close();
    assert.equal(existsSync(marker), false);
  });
});

describe('ruling 7: per-pool rollups keep 7 days, aggregate 1 year, under a byte cap that logs', () => {
  it('a series labelled by pool or mint is scoped pool; the retention job removes pool rows after 7 days and keeps aggregate rows', async () => {
    const rows: RollupRow[] = [];
    const clock = fakeClock(T0);
    const reg = new MetricsRegistry({ clock, seriesCap: 100, ringBudgetBytes: 0, sink: { append: (r) => { rows.push(...r); } } });
    reg.counter('send_429_total', { path: 'rpc' }).inc();
    reg.gauge('pool_snapshot_age_ms', { pool: 'P1' }).set(5);
    reg.tick();
    clock.advance(60_000);
    reg.tick();
    assert.deepEqual(rows.filter((r) => !r.metric.startsWith('metrics_')).map((r) => [r.metric, r.scope]).sort(),
      [['pool_snapshot_age_ms', 'pool'], ['send_429_total', 'aggregate']]);

    const db = await migrated();
    const at = T0 - 8 * DAY;
    db.withTx((tx) => {
      repos.metric_rollup_1m.insert(tx, { ...sampleRow('metric_rollup_1m', 1), scope: 'pool', createdAt: at });
      repos.metric_rollup_1m.insert(tx, { ...sampleRow('metric_rollup_1m', 2), scope: 'aggregate', createdAt: at });
      repos.metric_rollup_1m.insert(tx, { ...sampleRow('metric_rollup_1m', 3), scope: 'pool', createdAt: T0 - 6 * DAY });
    });
    assert.equal(deleteExpired(db, 'metric_rollup_1m', fakeClock(T0)), 1);
    assert.deepEqual(repos.metric_rollup_1m.find(db.reader()).map((r) => [r.scope, r.createdAt]).sort(), [['aggregate', at], ['pool', T0 - 6 * DAY]]);
    db.close();
  });

  it('at the cap the sink drops pool rows first, then aggregate rows, never writes past it, and logs an error each time', async () => {
    const db = await migrated();
    const { log, parsed } = logger();
    const sink = metricRollupSink(db, repos.metric_rollup_1m, fakeClock(T0), { maxBytes: 3 * ROLLUP_ROW_BYTES, log });
    const row = (i: number, scope: 'pool' | 'aggregate'): RollupRow => ({ metric: `m${i}`, labelsHash: BigInt(i), minute: T0 as never, scope, count: 1, sum: 1, p50: null, p95: null, p99: null });
    sink.append([row(1, 'pool'), row(2, 'aggregate'), row(3, 'pool'), row(4, 'pool')]);
    assert.deepEqual(repos.metric_rollup_1m.find(db.reader(), {}, { orderBy: 'metric' }).map((r) => [r.metric, r.scope]), [['m1', 'pool'], ['m2', 'aggregate'], ['m3', 'pool']]);
    sink.append([row(5, 'aggregate')]);
    assert.equal(sink.storedRows(), 3);
    assert.equal(repos.metric_rollup_1m.find(db.reader()).length, 3);
    assert.deepEqual(parsed().map((l) => [l.level, l.code, l.dropped_rows]), [['error', 'm24.rollup_cap_reached', 1], ['error', 'm24.rollup_cap_reached', 1]]);
    sink.expired(2);
    sink.append([row(6, 'pool'), row(7, 'aggregate')]);
    assert.deepEqual(repos.metric_rollup_1m.find(db.reader()).map((r) => r.metric).sort(), ['m1', 'm2', 'm3', 'm6', 'm7']);
    db.close();
  });
});

describe('ruling 8: a clock step neither deletes the log history nor overwrites a compressed day', () => {
  const errors: string[] = [];
  const sinkAt = (logDir: string, clock: ReturnType<typeof fakeClock>) =>
    new FileLogSink({ dir: logDir, clock, retentionDays: 14, maxBytesPerDay: 1_000_000, queueBytes: 1_000_000, onError: (e) => errors.push(`${e.op}: ${e.message}`) });

  it('a clock 30 days ahead deletes at most the one oldest day, and the history is still there when it comes back', async () => {
    const logDir = join(dir, `log${n++}`);
    mkdirSync(logDir);
    const days = Array.from({ length: 14 }, (_, i) => new Date(T0 - (13 - i) * DAY).toISOString().slice(0, 10));
    for (const d of days.slice(0, -1)) writeFileSync(join(logDir, `engine-${d}.ndjson.gz`), 'x');
    const clock = fakeClock(T0);
    const s = sinkAt(logDir, clock);
    s.write('{"a":1}', 'info');
    clock.advance(30 * DAY);
    s.write('{"b":1}', 'info');
    clock.set(T0 + 60_000);
    s.write('{"c":1}', 'info');
    await s.close();
    const left = readdirSync(logDir).map((f) => f.slice(7, 17));
    for (const d of days.slice(1)) assert.ok(left.includes(d), `${d} kept`);
    assert.equal(left.includes(days[0] as string), false);
  });

  it('a clock back across midnight appends to the day already compressed; both writes read back from the .gz', async () => {
    const logDir = join(dir, `log${n++}`);
    const clock = fakeClock(Date.UTC(2026, 9, 7, 23, 59, 0));
    const s = sinkAt(logDir, clock);
    s.write('{"first":1}', 'info');
    clock.set(Date.UTC(2026, 9, 8, 0, 1, 0));
    s.write('{"next":1}', 'info');                                                       // 10-07 is compressed
    clock.set(Date.UTC(2026, 9, 7, 23, 59, 30));                                         // back across midnight
    s.write('{"again":1}', 'info');
    clock.set(Date.UTC(2026, 9, 8, 0, 2, 0));
    s.write('{"later":1}', 'info');                                                      // 10-07 compressed again
    await s.close();
    assert.deepEqual([errors, readdirSync(logDir).sort()], [[], ['engine-2026-10-07.ndjson.gz', 'engine-2026-10-08.ndjson']]);
    const gz = readFileSync(join(logDir, 'engine-2026-10-07.ndjson.gz'));
    assert.equal(gunzipSync(gz).toString(), '{"first":1}\n{"again":1}\n');
  });
});

describe('ruling 9: a damaged database or backup is named, not thrown raw or trusted', () => {
  it('a torn header refuses the open with E_DATABASE_CORRUPT and a critical log', async () => {
    const path = fresh();
    (await migrated(path)).close();
    const bytes = readFileSync(path);
    bytes.fill(0x41, 0, 100);                                                             // the 100-byte header
    writeFileSync(path, bytes);
    const { log, parsed } = logger();
    assert.throws(() => openDb({ path, clock: fakeClock(T0), log }), (e: unknown) => e instanceof DbOpenError && e.code === 'E_DATABASE_CORRUPT');
    assert.equal(parsed()[0]?.error_code, 'E_DATABASE_CORRUPT');
  });

  it('quick_check runs before the start backup: a damaged table page refuses the migration with E_DATABASE_CORRUPT and takes no backup', async () => {
    const path = fresh();
    const db0 = openDb({ create: true, path, clock: fakeClock(T0) });
    schemaFixture(db0, (tx) => { tx.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'); for (let i = 0; i < 200; i++) tx.run('INSERT INTO t VALUES (?, ?)', i, 'x'.repeat(100)); });
    db0.close();                                                                          // checkpointed into the file
    const raw = new DatabaseSync(path, { readOnly: true });
    const root = (raw.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 't'").get() as { rootpage: number }).rootpage;
    const pageSize = (raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    raw.close();
    const bytes = readFileSync(path);
    bytes.fill(0xff, (root - 1) * pageSize + 8, (root - 1) * pageSize + 40);             // the root page's cell pointers
    writeFileSync(path, bytes);
    const { log, parsed } = logger();
    let r: Awaited<ReturnType<typeof prepareDatabase>> | null = null;
    try {
      const db = openDb({ path, clock: fakeClock(T0), log });
      r = await prepareDatabase(db, { clock: fakeClock(T0), backupPath: `${path}.bak` });
      db.close();
      assert.equal(r.ok ? null : r.error.code, 'E_DATABASE_CORRUPT');
    } catch (e) {
      assert.ok(e instanceof DbOpenError && e.code === 'E_DATABASE_CORRUPT', String(e));     // or refused at open
      assert.equal(parsed()[0]?.error_code, 'E_DATABASE_CORRUPT');
    }
    assert.equal(existsSync(`${path}.bak`), false);
  });

  it('a start backup with a different page count (or failing quick_check) is not trusted: E_BACKUP_FAILED, nothing applied', async () => {
    const path = fresh();
    const db = openDb({ create: true, path, clock: fakeClock(T0) });
    db.backupTo = async (p: string): Promise<number> => {                                  // a backup that copies the wrong thing
      const other = new DatabaseSync(p);
      other.exec('PRAGMA page_size=512; CREATE TABLE x (a); CREATE TABLE y (b); CREATE TABLE z (c)');
      other.close();
      return 1;
    };
    const r = await prepareDatabase(db, { clock: fakeClock(T0), backupPath: `${path}.bak` });
    assert.deepEqual(r.ok ? null : [r.error.code, /pages/.test(r.error.message)], ['E_BACKUP_FAILED', true]);
    assert.equal(tables(db).includes('fill'), false);
    db.close();
  });
});

describe('rulings 10 and 14: a delete needs a row old by both the retention job\'s clock and SQLite\'s wall clock', () => {
  it('old by the wall clock only, or by the engine clock only: refused; old by both: deleted; a plain DELETE: refused', async () => {
    const db = await migrated();
    const wall = Number(db.reader().get("SELECT unixepoch('now') * 1000 AS now")?.now);  // SQLite's wall clock
    const ins = (i: number, createdAt: number): void => db.withTx((tx) => repos.wallet_snapshot.insert(tx, { ...sampleRow('wallet_snapshot', i), granularity: '30s', createdAt }));
    ins(1, wall - 40 * DAY);                                                              // 40 days old by the wall clock
    assert.throws(() => db.withTx((tx) => tx.run('DELETE FROM wallet_snapshot')), /append_only/);   // no job, no delete
    assert.equal(deleteExpired(db, 'wallet_snapshot', fakeClock(wall - 39 * DAY)), 0);   // the engine clock says 1 day old
    ins(2, wall - DAY);                                                                   // 1 day old by the wall clock
    assert.equal(deleteExpired(db, 'wallet_snapshot', fakeClock(wall + 400 * DAY)), 1);  // an engine clock far ahead: only row 1 goes
    assert.deepEqual(repos.wallet_snapshot.find(db.reader()).map((w) => w.createdAt), [wall - DAY]);
    db.close();
  });
});

describe('ruling 14: only the retention job writes retention_clock', () => {
  it('any other statement naming it is refused before it runs, in any spelling; a forged clock still cannot delete a young row', async () => {
    const path = fresh();
    const db = await migrated(path);
    for (const sql of ['UPDATE retention_clock SET now_ms = 99999999999999', 'INSERT OR REPLACE INTO "retention_clock" VALUES (1, 5)',
      'DELETE FROM Retention_Clock', '/* x */ UPDATE [retention_clock] SET now_ms = 1', 'SELECT now_ms FROM retention_clock', 'DROP TABLE retention_clock']) {
      assert.throws(() => db.withTx((tx) => tx.run(sql)), /retention job's alone|migration runner's alone/, sql);
    }
    const wall = Number(db.reader().get("SELECT unixepoch('now') * 1000 AS now")?.now);
    db.withTx((tx) => repos.fill.insert(tx, { ...sampleRow('fill', 1), createdAt: wall - DAY }));
    const forge = 'CREATE TRIGGER forge AFTER INSERT ON trade BEGIN UPDATE retention_clock SET now_ms = 99999999999999; END';
    assert.throws(() => db.withTx((tx) => tx.run(forge)), /migration runner's alone/);    // ruling 22: no DDL outside the runner
    assert.throws(() => schemaFixture(db, (tx) => tx.run(forge)), /retention job's alone/); // ruling 24: not even in a schema transaction
    const raw = new DatabaseSync(path);                                                   // a writer outside the engine adds it anyway
    raw.exec(forge);
    raw.close();
    db.withTx((tx) => repos.trade.insert(tx, sampleRow('trade', 1)));                     // the trigger forges a far-future clock
    assert.throws(() => db.withTx((tx) => tx.run('DELETE FROM fill')), /append_only/);    // the wall clock still says 1 day old
    assert.equal(repos.fill.find(db.reader()).length, 1);
    db.close();
  });

  it('no source file but db.ts and retention.ts calls withRetentionClock or names retention_clock', () => {
    const src = fileURLToPath(new URL('../../../', import.meta.url));
    const found: string[] = [];
    for (const pkg of readdirSync(src)) {
      const dirPath = join(src, pkg, 'src');
      if (!existsSync(dirPath)) continue;
      for (const f of readdirSync(dirPath, { recursive: true, encoding: 'utf8' })) {
        if (!f.endsWith('.ts')) continue;
        const rel = `${pkg}/src/${f}`;
        if (['engine/src/m24/db.ts', 'engine/src/m24/retention.ts', 'engine/src/m24/schema-tx.ts', 'engine/src/m24/schema.ts', 'engine/src/m24/ddl.ts', 'engine/src/m24/migrations/0001_initial.ts'].includes(rel)) continue;
        if (/withRetentionClock|retention_clock/.test(readFileSync(join(dirPath, f), 'utf8'))) found.push(rel);
      }
    }
    assert.deepEqual(found, []);
  });
});

describe('round 3 rulings 17-19', () => {
  it('ruling 19: the retention job tells the rollup sink how many rows went, so its byte count frees room', async () => {
    const db = await migrated();
    const sink = metricRollupSink(db, repos.metric_rollup_1m, fakeClock(T0), { maxBytes: 2 * ROLLUP_ROW_BYTES });
    const wall = Number(db.reader().get("SELECT unixepoch('now') * 1000 AS now")?.now);
    const row = (i: number): RollupRow => ({ metric: `m${i}`, labelsHash: BigInt(i), minute: (wall - 9 * DAY) as never, scope: 'pool', count: 1, sum: 1, p50: null, p95: null, p99: null });
    const old = metricRollupSink(db, repos.metric_rollup_1m, fakeClock(wall - 9 * DAY), { maxBytes: 10 * ROLLUP_ROW_BYTES });
    old.append([row(1), row(2)]);                                                        // 9 days old by both clocks
    const fresh2 = metricRollupSink(db, repos.metric_rollup_1m, fakeClock(T0), { maxBytes: 2 * ROLLUP_ROW_BYTES });
    assert.equal(fresh2.storedRows(), 2);
    assert.equal(sink.storedRows(), 0);                                                  // counted before the rows existed
    assert.equal(deleteExpired(db, 'metric_rollup_1m', fakeClock(wall), [fresh2]), 2);
    assert.equal(fresh2.storedRows(), 0);
    fresh2.append([{ ...row(3), minute: wall as never }, { ...row(4), minute: wall as never }]);
    assert.equal(repos.metric_rollup_1m.find(db.reader()).length, 2);                    // room again
    db.close();
  });

  it('ruling 18: a start backup that fails its check leaves the previous backup as it was and no temp file', async () => {
    const path = fresh();
    writeFileSync(`${path}.bak`, 'previous backup');
    const db = openDb({ create: true, path, clock: fakeClock(T0) });
    const realBackup = db.backupTo;
    db.backupTo = async (p: string): Promise<number> => {
      const other = new DatabaseSync(p);
      other.exec('CREATE TABLE x (a)');
      other.close();
      return 1;
    };
    const r = await prepareDatabase(db, { clock: fakeClock(T0), backupPath: `${path}.bak` });
    db.backupTo = realBackup;
    assert.equal(r.ok ? null : r.error.code, 'E_BACKUP_FAILED');
    assert.equal(readFileSync(`${path}.bak`, 'utf8'), 'previous backup');
    assert.equal(existsSync(`${path}.bak.tmp`), false);
    const good = await prepareDatabase(db, { clock: fakeClock(T0), backupPath: `${path}.bak` });
    assert.equal(good.ok, true);
    assert.notEqual(readFileSync(`${path}.bak`).subarray(0, 15).toString(), 'previous backup');   // replaced by the checked copy
    db.close();
  });

  it('ruling 17: a half-written append (.gz.part) left by a crash is cleared and the .gz it was replacing is intact', async () => {
    const logDir = join(dir, `log${n++}`);
    mkdirSync(logDir);
    const old = join(logDir, 'engine-2026-10-07.ndjson');
    writeFileSync(`${old}.gz`, gzipSync('{"kept":1}\n'));
    writeFileSync(`${old}.gz.part`, 'half');
    const clock = fakeClock(Date.UTC(2026, 9, 8, 12, 0, 0));
    const s = new FileLogSink({ dir: logDir, clock, retentionDays: 14, maxBytesPerDay: 1_000_000, queueBytes: 1_000_000 });
    await s.close();
    assert.deepEqual(readdirSync(logDir).sort(), ['engine-2026-10-07.ndjson.gz', 'engine-2026-10-08.ndjson']);
    assert.equal(gunzipSync(readFileSync(`${old}.gz`)).toString(), '{"kept":1}\n');
  });
});

describe('round 4 ruling 22: only the migration runner changes the schema', () => {
  it('withTx refuses CREATE, DROP, ALTER, PRAGMA and ATTACH, behind comments too; the append-only trigger still fires afterwards', async () => {
    const db = await migrated();
    db.withTx((tx) => repos.fill.insert(tx, sampleRow('fill', 1)));
    for (const sql of ['DROP TRIGGER "fill_no_update"', '/* x */ drop trigger fill_no_delete', '-- c\n  DROP TABLE fill', 'ALTER TABLE fill RENAME TO f2',
      'CREATE TRIGGER t2 AFTER INSERT ON fill BEGIN SELECT 1; END', 'CREATE VIEW v AS SELECT 1', 'PRAGMA writable_schema=ON', "ATTACH DATABASE ':memory:' AS x",
      ';;  VACUUM', 'REINDEX']) {
      assert.throws(() => db.withTx((tx) => tx.run(sql)), /migration runner's alone/, sql);
    }
    assert.throws(() => db.withTx((tx) => tx.run('UPDATE fill SET tip_lamports = 0')), /append_only/);
    assert.equal(db.reader().get("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'fill_no_update'")?.n, 1n);
    assert.equal(isDdl('SELECT 1'), false);
    assert.equal(isDdl('WITH x AS (SELECT 1) SELECT * FROM x'), false);
    assert.equal(isDdl('/* open comment'), false);
    db.close();
  });

  it('ruling 29: the schema runner is reachable neither through db.ts\'s exports nor through the Db object', async () => {
    const dbModule = await import('../../src/m24/db.ts') as Record<string, unknown>;
    assert.equal(dbModule['schema' + 'Tx'], undefined);
    assert.deepEqual(Object.keys(dbModule).filter((k) => /schema|runner/i.test(k)), []);
    const db = await migrated();
    assert.deepEqual(Object.getOwnPropertySymbols(db), []);
    assert.deepEqual(Reflect.ownKeys(db).filter((k) => typeof k !== 'string' || /schema|runner/i.test(k)), []);
    assert.throws(() => schemaFixture({ ...db } as Db, () => 0), /needs a database opened by openDb/);   // a copy carries nothing
    db.close();
  });
});

describe('round 5 rulings 26 and 27: the schema door is not on Db, and SQLite\'s own tables are the runner\'s', () => {
  it('Db has no withSchemaTx; the old repro (drop the trigger, then delete a young quarantine row) fails', async () => {
    const db = await migrated();
    assert.equal((db as unknown as Record<string, unknown>)['withSchema' + 'Tx'], undefined);
    assert.equal(Object.keys(db).some((k) => /schema/i.test(k)), false);
    const wall = Number(db.reader().get("SELECT unixepoch('now') * 1000 AS now")?.now);
    db.withTx((tx) => repos.quarantine.insert(tx, { ...sampleRow('quarantine', 1), createdAt: wall - DAY }));
    assert.throws(() => db.withTx((tx) => tx.run('DROP TRIGGER "quarantine_no_delete"')), /migration runner's alone/);
    assert.throws(() => db.withTx((tx) => tx.run('DELETE FROM quarantine')), /append_only/);
    assert.equal(repos.quarantine.find(db.reader()).length, 1);
    db.close();
  });

  it('withTx refuses any statement naming a sqlite_* table, sqlite_sequence included', async () => {
    const db = await migrated();
    for (const sql of ["UPDATE sqlite_sequence SET seq = 0 WHERE name = 'outbox'", 'DELETE FROM SQLITE_SEQUENCE', "SELECT sql FROM sqlite_schema WHERE name = 'fill'",
      'SELECT * FROM sqlite_master', 'INSERT INTO sqlite_stat1 VALUES (1, 2, 3)']) {
      assert.throws(() => db.withTx((tx) => tx.run(sql)), /sqlite_\* tables are the migration runner's alone|migration runner's alone/, sql);
    }
    db.close();
  });
});

describe('round 5 ruling 28: one statement per call', () => {
  it('a second statement is refused before anything runs; a trailing ; or comment, a ; in a string and a trigger body are fine', async () => {
    const db = await migrated();
    const ins = (i: number): string => {
      const r = sampleRow('kv_state', i);
      return `INSERT INTO kv_state (key, value_json, created_at, updated_at) VALUES ('${r.key}', '{}', ${T0}, ${T0})`;
    };
    for (const sql of [`${ins(1)}; ${ins(2)}`, `${ins(1)};;\n -- x\n ${ins(2)}`, `${ins(1)}; /* c */ ${ins(2)};`]) {
      assert.throws(() => db.withTx((tx) => tx.run(sql)), /one SQL statement per call/, sql);
      assert.throws(() => db.reader().all(`SELECT 1; ${ins(9)}`), /one SQL statement per call/);
    }
    assert.equal(repos.kv_state.find(db.reader()).length, 0);
    db.withTx((tx) => tx.run(`${ins(3)};`));
    db.withTx((tx) => tx.run(`${ins(4)}; -- done`));
    db.withTx((tx) => tx.run(`${ins(5)} /* open comment`));
    db.withTx((tx) => tx.run("INSERT INTO kv_state (key, value_json, created_at, updated_at) VALUES ('a;b', '{\"x\":\";\"}', ?, ?)", T0, T0));
    assert.equal(repos.kv_state.find(db.reader()).length, 4);
    schemaFixture(db, (tx) => tx.run('CREATE TRIGGER two AFTER INSERT ON kv_state BEGIN SELECT 1; SELECT 2; END'));
    db.close();
  });
});
