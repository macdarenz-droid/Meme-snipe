import { strict as assert } from 'node:assert';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { isTxControl, M24_LOG_CODES, OUTBOX_DDL, OUTBOX_RETENTION_MS, openDb, OutboxConsumer, type Db, type OutboxRow, type TxHandle } from '../../src/m24/db.ts';
import { createLogger, M27_LOG_CODES, mergeLogCodes } from '../../src/m27/log.ts';
import { MetricsRegistry } from '../../src/m27/metrics.ts';
import { fakeClock, tempDir, schemaFixture } from '../helpers.ts';

const dir = tempDir('db');
let n = 0;

function setup(over: { path?: string; withOutbox?: boolean; observed?: boolean } = {}) {
  const clock = fakeClock();
  const path = over.path ?? join(dir, `t${n++}.db`);
  const lines: string[] = [];
  const metrics = new MetricsRegistry({ clock, seriesCap: 100, ringBudgetBytes: 0, sink: { append() {} } });
  const log = createLogger({ clock, codes: mergeLogCodes(M27_LOG_CODES, M24_LOG_CODES), runId: 'R', mode: 'paper', sink: { write: (l) => { lines.push(l); return 'written'; } } });
  const db = openDb({ create: true, path, clock, ...(over.observed === false ? {} : {
    metrics: { writeLatencyMs: metrics.histogram('db_write_latency_ms', {}), outboxBacklog: metrics.gauge('outbox_backlog', {}) }, log,
  }) });
  if (over.withOutbox !== false) schemaFixture(db, (tx) => { for (const stmt of `${OUTBOX_DDL}\nCREATE TABLE state (id INTEGER PRIMARY KEY, v TEXT);`.split(';').map((x) => x.trim()).filter(Boolean)) tx.run(stmt); });
  return { db, clock, path, lines, metrics };
}

const count = (db: Db, sql: string): bigint => db.reader().get(sql)?.n as bigint;
/** Rows come back with a null prototype (safe for any column name); compare them as plain objects. */
const plain = (rows: ReadonlyArray<object | undefined>): object[] => rows.map((r) => ({ ...r }));

describe('openDb: PRAGMAs, file mode and connections (B-M24-01 logic 2-3)', () => {
  it('opens WAL with synchronous=FULL and foreign keys on, files mode 0600', () => {
    const { db, path } = setup();
    const raw = new DatabaseSync(path, { readOnly: true });
    assert.equal((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    raw.close();
    for (const f of [path, `${path}-wal`, `${path}-shm`]) assert.equal(statSync(f).mode & 0o777, 0o600, f);
    db.close();
  });

  it('refuses a database that cannot use WAL, and an in-memory database has no readers', () => {
    assert.throws(() => openDb({ path: '', clock: fakeClock() }), /journal_mode is delete, not wal/);
    const mem = openDb({ path: ':memory:', clock: fakeClock() });
    assert.equal(schemaFixture(mem, (tx) => tx.get('PRAGMA foreign_keys')?.foreign_keys), 1n);
    assert.equal(schemaFixture(mem, (tx) => tx.get('PRAGMA synchronous')?.synchronous), 2n);   // 2 = FULL
    assert.throws(() => mem.reader(), /no reader connections/);
    mem.close();
  });

  it('readers are read-only, rotate over the pool and see committed data only', () => {
    const { db } = setup();
    db.withTx((tx) => tx.run('INSERT INTO state (id, v) VALUES (1, ?)', 'a'));
    const r1 = db.reader();
    const r2 = db.reader();
    assert.notEqual(r1, r2);
    assert.equal(db.reader(), r1);
    assert.deepEqual(plain(r1.all('SELECT id, v FROM state')), [{ id: 1n, v: 'a' }]);
    assert.throws(() => r2.get('INSERT INTO state (id, v) VALUES (2, ?) RETURNING id', 'b'), /readonly/);
    db.close();
  });
});

describe('withTx (B-M24-01 logic 3; ARCH 7.1)', () => {
  it('commits the body, rolls back on a throw and rethrows', () => {
    const { db } = setup();
    assert.equal(db.withTx((tx) => tx.run('INSERT INTO state (id, v) VALUES (1, ?)', 'a').changes), 1);
    assert.throws(() => db.withTx((tx) => { tx.run('INSERT INTO state (id, v) VALUES (2, ?)', 'b'); throw new Error('boom'); }), /boom/);
    assert.equal(count(db, 'SELECT count(*) AS n FROM state'), 1n);
    db.close();
  });

  it('refuses a callback that returns a promise (await inside) and rolls it back', () => {
    const { db } = setup();
    assert.throws(() => db.withTx((tx) => { tx.run('INSERT INTO state (id, v) VALUES (1, ?)', 'a'); return Promise.resolve(1); }), /must be synchronous/);
    assert.equal(count(db, 'SELECT count(*) AS n FROM state'), 0n);
    assert.equal(db.withTx(() => ({ then: 1 })).then, 1);
    db.close();
  });

  it('refuses nesting, transaction control in the body and a handle used after its transaction', () => {
    const { db } = setup();
    assert.throws(() => db.withTx(() => db.withTx(() => 1)), /cannot be nested/);
    assert.throws(() => db.withTx((tx) => tx.run('COMMIT')), /transaction control/);
    assert.throws(() => db.withTx((tx) => tx.run(' rollback')), /transaction control/);
    const leaked = db.withTx((tx) => tx);
    assert.throws(() => leaked.run('INSERT INTO state (id, v) VALUES (9, ?)', 'x'), /outside its withTx/);
    assert.throws(() => leaked.get('SELECT 1'), /outside its withTx/);
    assert.throws(() => leaked.all('SELECT 1'), /outside its withTx/);
    assert.deepEqual(plain(db.withTx((tx) => tx.all('SELECT 1 AS one'))), [{ one: 1n }]);
    db.close();
  });

  it('refuses transaction control behind comments and through get() and all() before it runs (review m1)', () => {
    const { db } = setup();
    for (const sql of ['/* x */ COMMIT', '-- note\nCOMMIT', ' /* a */ -- b\n /* c */ end', 'COMMIT']) {
      assert.throws(() => db.withTx((tx) => { tx.run('INSERT INTO state (id, v) VALUES (1, ?)', 'a'); tx.run(sql); }), /transaction control/, sql);
      assert.throws(() => db.withTx((tx) => tx.get(sql)), /transaction control/, sql);
      assert.throws(() => db.withTx((tx) => tx.all(sql)), /transaction control/, sql);
    }
    assert.equal(count(db, 'SELECT count(*) AS n FROM state'), 0n);           // nothing was committed half-way
    assert.equal(db.withTx((tx) => tx.get('/* fine */ SELECT 1 AS one')?.one), 1n);
    db.close();
  });

  it('refuses transaction control behind empty statements, and scans many leading comments in linear time (red team n1)', () => {
    const { db } = setup();
    for (const sql of ['; COMMIT', ';; BEGIN', ' ;\n; /* x */ ; -- y\n rollback', ';END']) {
      assert.throws(() => db.withTx((tx) => { tx.run('INSERT INTO state (id, v) VALUES (1, ?)', 'a'); tx.run(sql); }), /transaction control/, sql);
    }
    assert.equal(count(db, 'SELECT count(*) AS n FROM state'), 0n);           // nothing was committed half-way
    const started = process.hrtime.bigint();
    assert.equal(db.withTx((tx) => tx.get(`${'/**/'.repeat(30)}SELECT 1 AS one`)?.one), 1n);   // 2^30 steps for a backtracking pattern
    assert.ok(process.hrtime.bigint() - started < 500_000_000n, 'thirty leading comments are scanned at once');
    const many = '/**/ -- c\n;'.repeat(100_000);
    assert.throws(() => db.withTx((tx) => tx.run(`${many}COMMIT`)), /transaction control/);
    assert.equal(db.withTx((tx) => tx.get(`${many}SELECT 1 AS one`)?.one), 1n);
    db.close();
  });

  it('isTxControl: keywords as whole words, comments left open, text with no statement', () => {
    for (const sql of ['COMMIT', 'end;', 'Release x', 'SAVEPOINT s', '\t\vbegin immediate', '/* a */ /**/rollback']) assert.equal(isTxControl(sql), true, sql);
    for (const sql of ['', ' ; ;', '-- COMMIT', '/* COMMIT', '/* x */ -- y', 'COMMITTED', 'ENDING', 'SELECT 1; COMMIT', '"COMMIT"']) assert.equal(isTxControl(sql), false, sql);
  });

  it('runs nothing outside the transaction after SQLite ended it inside withTx (review m1)', () => {
    const { db } = setup();
    schemaFixture(db, (tx) => tx.run("CREATE TRIGGER no_x BEFORE INSERT ON state WHEN NEW.v = 'x' BEGIN SELECT RAISE(ROLLBACK, 'no x'); END"));
    const swallow = (f: () => void): void => {
      try { f(); } catch { /* the body catches the rollback and carries on */ }
    };
    for (const after of [(tx: TxHandle) => tx.run('INSERT INTO state (id, v) VALUES (3, ?)', 'c'), (tx: TxHandle) => tx.get('SELECT 1'), (tx: TxHandle) => tx.all('SELECT 1')]) {
      assert.throws(() => db.withTx((tx) => {
        swallow(() => tx.run('INSERT INTO state (id, v) VALUES (2, ?)', 'x'));
        after(tx);
      }), /transaction ended inside withTx/);
    }
    assert.throws(() => db.withTx((tx) => { swallow(() => tx.run('INSERT INTO state (id, v) VALUES (2, ?)', 'x')); }), /transaction ended inside withTx/);
    assert.equal(count(db, 'SELECT count(*) AS n FROM state'), 0n);           // the insert after the rollback never ran
    db.close();
  });

  it('rethrows when SQLite itself already rolled the transaction back (RAISE(ROLLBACK))', () => {
    const { db } = setup();
    schemaFixture(db, (tx) => tx.run("CREATE TRIGGER no_x BEFORE INSERT ON state WHEN NEW.v = 'x' BEGIN SELECT RAISE(ROLLBACK, 'no x'); END"));
    assert.throws(() => db.withTx((tx) => { tx.run('INSERT INTO state (id, v) VALUES (1, ?)', 'a'); tx.run('INSERT INTO state (id, v) VALUES (2, ?)', 'x'); }), /no x/);
    assert.equal(count(db, 'SELECT count(*) AS n FROM state'), 0n);
    db.close();
  });

  it('records db_write_latency_ms for every transaction', () => {
    const { db, metrics, clock } = setup();
    db.withTx(() => { clock.advance(7); });
    assert.match(metrics.render(), /^db_write_latency_ms_count 2$/m);              // setup + this one
    assert.match(metrics.render(), /^db_write_latency_ms_sum 7$/m);
    db.close();
  });

  it('keeps at most 512 prepared statements per connection', () => {
    const { db } = setup();
    const r = db.reader();
    for (let i = 0; i < 600; i++) assert.equal(r.get(`SELECT ${i} AS x`)?.x, BigInt(i));
    db.close();
  });

  it('reads every integer as a bigint', () => {
    const { db } = setup();
    db.withTx((tx) => tx.run('INSERT INTO state (id, v) VALUES (?, ?)', 9_007_199_254_740_993n, 'big'));
    assert.deepEqual(plain([db.reader().get('SELECT id FROM state')]), [{ id: 9_007_199_254_740_993n }]);
    db.close();
  });
});

describe('transactional outbox (B-M24-01 logic 4)', () => {
  it('appends in the state transaction, so a rollback drops both', () => {
    const { db } = setup();
    assert.throws(() => db.withTx((tx) => {
      tx.run('INSERT INTO state (id, v) VALUES (1, ?)', 'a');
      db.outbox.append(tx, 'state', { id: 1n });
      throw new Error('crash');
    }), /crash/);
    assert.equal(count(db, 'SELECT count(*) AS n FROM outbox'), 0n);
    assert.equal(db.outbox.backlog(), 0);
    db.close();
  });

  it('drains in seq order after commit, marks published, and leaves rows for the next drain when publishing throws', () => {
    const { db, metrics } = setup();
    for (let i = 1; i <= 3; i++) db.withTx((tx) => { tx.run('INSERT INTO state (id, v) VALUES (?, ?)', i, 'v'); db.outbox.append(tx, 'state', { id: BigInt(i), at: i }); });
    assert.equal(db.outbox.backlog(), 3);
    assert.match(metrics.render(), /^outbox_backlog 3$/m);
    assert.throws(() => db.outbox.drain(() => { throw new Error('bus down'); }), /bus down/);
    assert.equal(db.outbox.backlog(), 3);
    const seen: OutboxRow[] = [];
    db.outbox.drain((rows) => seen.push(...rows));
    assert.deepEqual(seen.map((r) => [r.seq, r.topic, r.payloadJson, r.publishedAtMs]), [[1n, 'state', '{"at":1,"id":"1"}', null], [2n, 'state', '{"at":2,"id":"2"}', null], [3n, 'state', '{"at":3,"id":"3"}', null]]);
    assert.equal(db.outbox.backlog(), 0);
    assert.match(metrics.render(), /^outbox_backlog 0$/m);
    const again: OutboxRow[] = [];
    db.outbox.drain((rows) => again.push(...rows));
    assert.equal(again.length, 0);
    db.close();
  });

  it('drains in batches of 500', () => {
    const { db } = setup({ observed: false });
    db.withTx((tx) => { for (let i = 0; i < 1_201; i++) db.outbox.append(tx, 't', { i }); });
    const batches: number[] = [];
    db.outbox.drain((rows) => batches.push(rows.length));
    assert.deepEqual(batches, [500, 500, 201]);
    db.close();
  });

  it('deletes published rows after 7 days, at most once an hour, and never an unpublished row', () => {
    const { db, clock } = setup();
    const rows = () => plain(db.reader().all('SELECT seq, published_at IS NULL AS open FROM outbox ORDER BY seq'));
    db.withTx((tx) => db.outbox.append(tx, 't', { i: 1 }));
    db.outbox.drain(() => {});                                       // T0: row 1 published; prune pass finds nothing old
    clock.advance(OUTBOX_RETENTION_MS + 1);
    db.withTx((tx) => db.outbox.append(tx, 't', { i: 2 }));
    assert.throws(() => db.outbox.drain(() => { throw new Error('keep'); }), /keep/);
    assert.deepEqual(rows(), [{ seq: 1n, open: 0n }, { seq: 2n, open: 1n }]);   // no prune when publishing failed
    let appended = false;
    db.outbox.drain(() => {
      if (appended) return;
      appended = true;
      db.withTx((tx) => db.outbox.append(tx, 't', { i: 3 }));        // arrives during the drain: stays unpublished
    });
    assert.deepEqual(rows(), [{ seq: 2n, open: 0n }, { seq: 3n, open: 1n }]);   // row 1 (older than 7 days) pruned
    db.withTx((tx) => tx.run('UPDATE outbox SET published_at = 0 WHERE seq = 2'));
    db.outbox.drain(() => {});                                       // same hour as the last prune: nothing deleted
    assert.deepEqual(rows(), [{ seq: 2n, open: 0n }, { seq: 3n, open: 0n }]);
    clock.advance(3_600_000);
    db.outbox.drain(() => {});
    assert.deepEqual(rows(), [{ seq: 3n, open: 0n }]);
    db.close();
  });

  it('refuses append outside the active transaction and drain inside one', () => {
    const { db } = setup();
    const leaked = db.withTx((tx) => tx);
    assert.throws(() => db.outbox.append(leaked, 't', {}), /active withTx handle/);
    assert.throws(() => db.withTx(() => db.outbox.drain(() => {})), /never inside withTx/);
    db.close();
  });

  it('logs m24.outbox_replay at open when unpublished rows survived a restart', () => {
    const first = setup();
    first.db.withTx((tx) => { db1Append(first.db, tx); });
    first.db.close();
    const second = setup({ path: first.path, withOutbox: false });
    assert.equal(second.db.outbox.backlog(), 1);
    assert.equal(JSON.parse(second.lines[0] as string).code, 'm24.outbox_replay');
    assert.equal(JSON.parse(second.lines[0] as string).rows, 1);
    second.db.close();
    const quiet = setup({ path: first.path, withOutbox: false, observed: false });
    assert.equal(quiet.db.outbox.backlog(), 1);
    quiet.db.close();
  });

  it('a database without the outbox table opens with an empty backlog', () => {
    const { db } = setup({ withOutbox: false });
    assert.equal(db.outbox.backlog(), 0);
    db.close();
  });
});

function db1Append(db: Db, tx: Parameters<Parameters<Db['withTx']>[0]>[0]): void {
  db.outbox.append(tx, 'state', { id: 1 });
}

describe('integrity checks and online backup', () => {
  it('quick and full checks report ok on a sound database', async () => {
    const { db, path } = setup();
    assert.deepEqual(db.integrityCheck('quick'), { ok: true, messages: ['ok'] });
    assert.deepEqual(db.integrityCheck('full'), { ok: true, messages: ['ok'] });
    db.withTx((tx) => tx.run('INSERT INTO state (id, v) VALUES (1, ?)', 'a'));
    const pages = await db.backupTo(`${path}.bak`);
    assert.ok(pages > 0);
    assert.equal(statSync(`${path}.bak`).mode & 0o777, 0o600);
    assert.equal(existsSync(`${path}.bak-wal`), false);
    const copy = new DatabaseSync(`${path}.bak`, { readOnly: true });
    assert.equal((copy.prepare('SELECT count(*) AS n FROM state').get() as { n: number }).n, 1);
    copy.close();
    db.close();
  });

  it('reports a corrupt index', () => {
    const { db, path } = setup();
    schemaFixture(db, (tx) => { tx.run('CREATE INDEX state_v ON state(v)'); tx.run('INSERT INTO state (id, v) VALUES (1, ?)', 'a'); });
    db.close();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA writable_schema=ON');
    const root = (raw.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'state_v'").get() as { rootpage: number }).rootpage;
    raw.exec("UPDATE sqlite_schema SET sql = 'CREATE INDEX state_v ON state(id)' WHERE name = 'state_v'");
    raw.close();
    assert.ok(root > 0);
    const reopened = openDb({ create: true, path, clock: fakeClock() });
    const r = reopened.integrityCheck('full');
    assert.equal(r.ok, false);
    assert.ok(r.messages.length >= 1 && r.messages[0] !== 'ok');
    reopened.close();
  });
});

describe('OutboxConsumer: idempotent by entity key and seq', () => {
  const row = (seq: bigint, id: string): OutboxRow => ({ seq, topic: 't', payloadJson: `{"id":"${id}"}`, createdAtMs: 0, publishedAtMs: null });
  const key = (r: OutboxRow) => (JSON.parse(r.payloadJson) as { id: string }).id;

  it('applies each (key, seq) once, also across a restart with its saved watermark', () => {
    const applied: string[] = [];
    const c = new OutboxConsumer((r) => applied.push(`${key(r)}@${r.seq}`));
    c.handle([row(1n, 'a'), row(2n, 'b'), row(1n, 'a'), row(3n, 'a')]);
    c.handle([row(2n, 'b'), row(3n, 'a')]);
    assert.deepEqual(applied, ['a@1', 'b@2', 'a@3']);
    assert.equal(c.watermark(), 3n);
    const restarted = new OutboxConsumer((r) => applied.push(`${key(r)}@${r.seq}`), c.watermark());
    restarted.handle([row(3n, 'a'), row(4n, 'a')]);
    assert.deepEqual(applied.slice(3), ['a@4']);
  });

  it('keeps constant memory over a million entity keys (review m5)', () => {
    let applied = 0;
    const c = new OutboxConsumer(() => { applied += 1; });
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;                          // retained heap only, not garbage
    gc();
    const before = process.memoryUsage().heapUsed;
    const batch: OutboxRow[] = [];
    for (let seq = 1n; seq <= 1_000_000n; seq++) {
      batch.push(row(seq, `k${seq}`));
      if (batch.length === 10_000) c.handle(batch.splice(0));
    }
    c.handle([row(999_999n, 'k999999')]);                                   // published again: skipped
    assert.equal(applied, 1_000_000);
    assert.equal(c.watermark(), 1_000_000n);
    gc();
    assert.ok(process.memoryUsage().heapUsed - before < 32 * 1_048_576, 'one entry per key would hold about 120 MB');
  });

  it('applies a drained row exactly once when the publish is retried (drain hands rows over in seq order)', () => {
    const { db } = setup();
    for (let i = 1; i <= 3; i++) db.withTx((tx) => db.outbox.append(tx, 'state', { id: String(i) }));
    const applied: string[] = [];
    const c = new OutboxConsumer((r) => applied.push(key(r)));
    let fail = true;
    assert.throws(() => db.outbox.drain((rows) => { c.handle(rows); if (fail) throw new Error('publish failed'); }), /publish failed/);
    fail = false;
    db.withTx((tx) => db.outbox.append(tx, 'state', { id: '4' }));
    db.outbox.drain((rows) => c.handle(rows));
    assert.deepEqual(applied, ['1', '2', '3', '4']);
    db.close();
  });
});
