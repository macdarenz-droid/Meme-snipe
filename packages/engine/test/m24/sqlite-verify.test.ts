// VERIFY A-45 (B-M24-01 logic 1; ARCH 4.5, CA-33): the built-in node:sqlite of the pinned Node release supports
// explicit transactions, WAL mode and an online backup. This file re-checks all three on every CI run, so a Node
// change that drops one fails here before the persistence code depends on it. Result and sources: DEPENDENCIES.md, "Built-in modules instead of packages".
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { describe, it } from 'vitest';
import { tempDir } from '../helpers.ts';

const dir = tempDir('verify');

describe('VERIFY A-45: node:sqlite on the pinned Node', () => {
  it('runs on the Node release pinned in .node-version (22.23.3) with SQLite 3.x', () => {
    assert.match(process.version, /^v22\.(2[3-9]|[3-9]\d)\./);
    const db = new DatabaseSync(':memory:');
    assert.match((db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v, /^3\.\d+\.\d+$/);
    db.close();
  });

  it('explicit transactions: BEGIN IMMEDIATE, COMMIT, ROLLBACK and isTransaction', () => {
    const db = new DatabaseSync(join(dir, 'tx.db'));
    db.exec('CREATE TABLE t (v INTEGER)');
    assert.equal(db.isTransaction, false);
    db.exec('BEGIN IMMEDIATE');
    assert.equal(db.isTransaction, true);
    db.prepare('INSERT INTO t VALUES (?)').run(1);
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO t VALUES (?)').run(2);
    db.exec('COMMIT');
    assert.deepEqual(db.prepare('SELECT v FROM t').all().map((r) => (r as { v: number }).v), [2]);
    db.close();
  });

  it('WAL: journal_mode=WAL sticks on a file database and a reader sees the last commit while a write is open', () => {
    const path = join(dir, 'wal.db');
    const writer = new DatabaseSync(path);
    assert.equal((writer.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }).journal_mode, 'wal');
    writer.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);');
    const reader = new DatabaseSync(path, { readOnly: true });
    writer.exec('BEGIN IMMEDIATE');
    writer.prepare('INSERT INTO t VALUES (?)').run(2);
    assert.equal((reader.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n, 1);
    writer.exec('COMMIT');
    assert.equal((reader.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n, 2);
    assert.equal((reader.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    assert.throws(() => reader.exec('INSERT INTO t VALUES (3)'), /readonly/);
    reader.close();
    writer.close();
  });

  it('online backup: backup() copies a live database page by page and the copy passes integrity_check', async () => {
    const src = new DatabaseSync(join(dir, 'src.db'));
    src.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT);');
    const insert = src.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 2_000; i++) insert.run('x'.repeat(200));
    let steps = 0;
    const pages = await backup(src, join(dir, 'copy.db'), { rate: 10, progress: () => { steps++; insert.run('during'); } });
    assert.ok(pages > 10);
    assert.ok(steps > 1);
    const copy = new DatabaseSync(join(dir, 'copy.db'), { readOnly: true });
    assert.equal((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    assert.ok((copy.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n >= 2_000);
    copy.close();
    src.close();
  });
});
