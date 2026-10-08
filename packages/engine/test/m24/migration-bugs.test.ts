// Known Zeroed bugs that touch the persistence, config and observability code of card Z02 (docs/MIGRATION.md, M24 and
// M27 rows, "Bugs left behind", "Red team C", "Red team A and B"). Each test names its bug. The fail-before runs (old
// Zeroed code, or the C02 port before the fix) are recorded in the Z02 pull request.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'vitest';
import { openDb, OUTBOX_DDL, type Db } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { createRepos, type Repo, type RowOf } from '../../src/m24/repos.ts';
import { TABLES, type TableName } from '../../src/m24/schema.ts';
import { FileLogSink, REOPEN_MS } from '../../src/m27/logfile.ts';
import { MetricsRegistry, type RollupRow } from '../../src/m27/metrics.ts';
import { fakeClock, tempDir, waitFor, schemaFixture } from '../helpers.ts';
import { sampleRow } from './samples.ts';

const dir = tempDir('bugs');
let n = 0;
const fresh = (): string => join(dir, `b${n++}.db`);
const repos = createRepos();
const YEAR = 365 * 86_400_000;
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

async function migrated(path: string): Promise<Db> {
  const db = openDb({ create: true, path, clock: fakeClock() });
  const r = await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` });
  assert.equal(r.ok, true);
  return db;
}

const userObjects = (path: string): string[] => {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return (raw.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  } finally { raw.close(); }
};

describe('R2-C2 (red team C): a 0-byte database never opens as a fresh one', () => {
  it('openDb refuses an existing empty file, with or without a WAL beside it, and leaves it as it was', () => {
    const path = fresh();
    writeFileSync(path, '');                                           // truncated by a disk or operator fault
    assert.throws(() => openDb({ create: true, path, clock: fakeClock() }), /exists and is empty/);
    assert.equal(statSync(path).size, 0);
    writeFileSync(`${path}-wal`, 'x');
    assert.throws(() => openDb({ create: true, path, clock: fakeClock() }), /exists and is empty/);
    assert.equal(statSync(path).size, 0);
  });

  it('a missing file is a first start: it is created, set to WAL and is no longer empty', async () => {
    const path = fresh();
    const db = await migrated(path);
    db.close();
    assert.ok(statSync(path).size > 0);
    openDb({ create: true, path, clock: fakeClock() }).close();                     // and opens again
  });
});

describe('RB-15 / R4-1 (red teams B and C): the first start latches nothing (start test, B-M24-02)', () => {
  it('a fresh database beside an old Zeroed ledger and a stand-in database migrates and holds no halt, breach or alert', async () => {
    const host = join(dir, `host${n++}`);
    mkdirSync(join(host, 'zeroed'), { recursive: true });
    mkdirSync(join(host, 'bot'));
    const old = new DatabaseSync(join(host, 'zeroed', 'ledger.sqlite'));    // left on the host by the old worker
    old.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, sha256 TEXT); CREATE TABLE position (id TEXT); INSERT INTO position VALUES ('p1')");
    old.close();
    const standIn = new DatabaseSync(join(host, 'zeroed', 'standin.sqlite'));
    standIn.exec("CREATE TABLE host_events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT); INSERT INTO host_events (ts, kind) VALUES ('2026-10-07T00:00:00Z', 'start')");
    standIn.close();
    const db = await migrated(join(host, 'bot', 'bot.db'));
    const r = db.reader();
    assert.equal(repos.system_state.find(r).length, 0);
    assert.equal(repos.breaker_event.find(r).length, 0);
    assert.equal(repos.limit_state.find(r).length, 0);
    assert.equal(repos.alert.find(r).length, 0);
    assert.equal(repos.command.find(r).length, 0);
    db.close();
  });

  it('a foreign database at the path (the stand-in\'s, or an old Zeroed ledger) is refused, never migrated on top of, and left untouched', async () => {
    const cases = [
      ['CREATE TABLE host_events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT)', ['host_events']],
      ['CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL); CREATE TABLE position (id TEXT)',
        ['position', 'schema_migrations']],
    ] as const;
    for (const [ddl, objects] of cases) {
      const path = fresh();
      const old = new DatabaseSync(path);
      old.exec(`PRAGMA journal_mode=WAL; ${ddl}`);
      old.close();
      const db = openDb({ create: true, path, clock: fakeClock() });
      const r = await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` });
      db.close();
      assert.equal(r.ok ? null : r.error.code, 'E_FOREIGN_DATABASE', ddl);
      assert.deepEqual(userObjects(path), [...objects]);
    }
  });
});

describe('C1 and RB-14 (red teams C and B): the M24 backup carries every piece of engine state', () => {
  it('every table, the trading state, limits, breakers, discovery cursors and saved series included, is in the online backup', async () => {
    const path = fresh();
    const db = await migrated(path);
    const tables = (Object.keys(TABLES) as TableName[]).filter((t) => t !== 'schema_migrations' && t !== 'outbox' && t !== 'retention_clock');
    for (const name of tables) {
      const row = name === 'system_state' ? { ...sampleRow(name, 1), id: 1, tradingState: 'exits_only' } : sampleRow(name, 1);
      db.withTx((tx) => (repos[name] as Repo<TableName>).insert(tx, row as RowOf<TableName>));
    }
    db.withTx((tx) => repos.kv_state.insert(tx, { ...sampleRow('kv_state', 2), key: 'm05.graduates', valueJson: '{"unobserved":[{"from":0,"to":1}]}' }));
    db.withTx((tx) => db.outbox.append(tx, 'state', { id: 'x' }));
    db.withRetentionClock(Date.UTC(2026, 9, 8), () => 0);                              // leaves its row (now_ms 0)
    const copy = `${path}.restore`;
    await db.backupTo(copy);
    const restored = openDb({ create: true, path: copy, clock: fakeClock() });
    for (const name of [...tables, 'schema_migrations', 'outbox', 'retention_clock'] as const) {
      const all = (h: Db): unknown[] => h.reader().all(`SELECT * FROM "${name}" ORDER BY 1`).map((x) => ({ ...x }));
      assert.deepEqual(all(restored), all(db), name);
      assert.ok(all(db).length > 0, name);
    }
    assert.equal(repos.system_state.find(restored.reader())[0]?.tradingState, 'exits_only');
    restored.close();
    db.close();
  });
});

describe('M3 pattern (red team C): a clock that ran far ahead and came back locks nothing until that date', () => {
  it('outbox: published rows are pruned again within the hour after the clock comes back (a row stamped ahead keeps its 7 days)', () => {
    const clock = fakeClock(T0);
    const db = openDb({ create: true, path: fresh(), clock });
    schemaFixture(db, (tx) => { for (const s of OUTBOX_DDL.split(';').map((x) => x.trim()).filter(Boolean)) tx.run(s); });
    const publishOne = (): void => {
      db.withTx((tx) => db.outbox.append(tx, 't', { a: 1 }));
      db.outbox.drain(() => {});
    };
    publishOne();                                                      // prunes at T0
    clock.set(T0 + YEAR);                                              // the clock jumps a year ahead
    publishOne();
    clock.set(T0 + 3_600_000);                                         // and comes back
    publishOne();                                                      // published at T0 + 1 h
    clock.set(T0 + 8 * 86_400_000 + 2 * 3_600_000);                    // past the 7-day retention of that row
    publishOne();
    const left = db.reader().all('SELECT published_at FROM outbox ORDER BY seq').map((r) => Number(r.published_at));
    assert.deepEqual(left, [T0 + YEAR, T0 + 8 * 86_400_000 + 2 * 3_600_000]);
    db.close();
  });

  it('metrics: minute rollups are written again after the clock comes back', () => {
    const clock = fakeClock(T0);
    const rows: RollupRow[] = [];
    const reg = new MetricsRegistry({ clock, seriesCap: 100, ringBudgetBytes: 1024 * 1024, sink: { append: (r) => { rows.push(...r); } } });
    const c = reg.counter('send_429_total', { path: 'rpc' });
    reg.tick();
    clock.set(T0 + YEAR);
    reg.tick();
    clock.set(T0 + 120_000);                                           // back, two minutes after T0
    reg.tick();
    c.inc(3);
    clock.set(T0 + 180_000);                                           // that minute ends
    reg.tick();
    assert.deepEqual(rows.filter((r) => r.metric === 'send_429_total').map((r) => [r.minute, r.sum]), [[T0 + 120_000, 3]]);
  });

  it('log file: a failed file is retried within 30 s after the clock comes back the same day', async () => {
    const logDir = join(dir, `log${n++}`);
    mkdirSync(logDir, { recursive: true });
    const file = join(logDir, 'engine-2026-10-07.ndjson');
    const clock = fakeClock(T0);
    const s = new FileLogSink({ dir: logDir, clock, retentionDays: 14, maxBytesPerDay: 1_000_000, queueBytes: 1_000_000 });
    assert.equal(s.write('{"a":1}', 'info'), 'written');
    await s.close();
    rmSync(file);
    mkdirSync(file);                                                   // the day file cannot be opened
    clock.set(Date.UTC(2026, 9, 7, 23, 0, 0));                         // 11 hours ahead, the same day
    const t = new FileLogSink({ dir: logDir, clock, retentionDays: 14, maxBytesPerDay: 1_000_000, queueBytes: 1_000_000 });
    assert.equal(t.write('{"b":1}', 'error'), 'lost');
    rmSync(file, { recursive: true });                                 // the cause is removed
    clock.set(T0 + 60_000);                                            // the clock comes back
    clock.advance(REOPEN_MS);
    assert.equal(t.write('{"c":1}', 'error'), 'written');
    await t.close();
    assert.equal(readFileSync(file, 'utf8'), '{"c":1}\n');
  });
});

describe('one writer (B-M24-01 logic 3, ARCH 4.5; LEDGER-1 writer lock): a second writer is refused', () => {
  it('a second openDb of the same file in this process is refused until the first closes', () => {
    const path = fresh();
    const a = openDb({ create: true, path, clock: fakeClock() });
    assert.throws(() => openDb({ create: true, path, clock: fakeClock() }), /already has a writer/);
    a.close();
    openDb({ create: true, path, clock: fakeClock() }).close();
    assert.equal(statSync(`${path}-writer.lock`).mode & 0o777, 0o600);
  });

  it('a writer in another process blocks this one; when that process is killed the lock is gone', async () => {
    const path = fresh();
    openDb({ create: true, path, clock: fakeClock() }).close();
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e',
      `import { openDb } from ${JSON.stringify(new URL('../../src/m24/db.ts', import.meta.url).href)};
       globalThis.held = openDb({ create: true, path: ${JSON.stringify(path)}, clock: { kind: 'sim', nowMs: () => 0 } });
       process.stdout.write('open\\n'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    try {
      await waitFor(() => out.includes('open'), 20_000);
      assert.throws(() => openDb({ create: true, path, clock: fakeClock() }), /already has a writer/);
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    openDb({ create: true, path, clock: fakeClock() }).close();
  });
});

describe('C5 (red team C), the part in B-M27-01: a lamport value sent as a string is refused, never read as no value', () => {
  it('a gauge set with a decimal-string lamport amount throws (the alert rule itself is B-M27-02)', () => {
    const reg = new MetricsRegistry({ clock: fakeClock(T0), seriesCap: 100, ringBudgetBytes: 1024 * 1024, sink: { append() {} } });
    const g = reg.gauge('hot_balance_lamports', {});
    assert.throws(() => g.set('0' as unknown as number), /must be finite/);
    assert.throws(() => g.set(0n as unknown as number), /must be finite/);
  });
});
