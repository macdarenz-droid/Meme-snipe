// B-M24-02 repositories: every table round-trips through its typed repository; reads, updates, the compare-and-set
// update and upsert; the B-M27-01 rollup sink; and candidate and watchlist state surviving a restart (owner lesson).
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { openDb, type Db } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { createRepos, isVersioned, metricRollupSink, MutableRepo, Repo, VersionedRepo, type RowOf } from '../../src/m24/repos.ts';
import { TABLES, type TableName } from '../../src/m24/schema.ts';
import { labelsHash, MetricsRegistry } from '../../src/m27/metrics.ts';
import { fakeClock, tempDir } from '../helpers.ts';
import { pubkey, sampleRow, ulid } from './samples.ts';

const dir = tempDir('repos');
let n = 0;
const repos = createRepos();
const MS = Date.UTC(2026, 9, 7);

async function migrated(path = join(dir, `r${n++}.db`)): Promise<Db> {
  const db = openDb({ create: true, path, clock: fakeClock() });
  assert.equal((await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` })).ok, true);
  return db;
}

describe('typed repositories (B-M24-02 interfaces)', () => {
  it('one repository per table: append-only tables read and insert only, versioned ones compare-and-set only, the others update', () => {
    for (const name of Object.keys(TABLES) as TableName[]) {
      const repo = repos[name] as Repo<TableName>;
      assert.equal(repo.table, name);
      assert.equal(repo instanceof VersionedRepo, !TABLES[name].appendOnly && isVersioned(name), name);
      assert.equal(repo instanceof MutableRepo, !TABLES[name].appendOnly && !isVersioned(name), name);
    }
    assert.deepEqual((Object.keys(TABLES) as TableName[]).filter((t) => isVersioned(t)).sort(), ['candidate', 'order_intent', 'position', 'tx_attempt']);
    assert.equal(isVersioned('strategy'), false);                        // version is part of its key
    assert.throws(() => new MutableRepo('order_intent'), /only by compare-and-set/);
    assert.throws(() => new VersionedRepo('kv_state'), /no version column outside its key/);
    assert.throws(() => new VersionedRepo('strategy'), /no version column outside its key/);
  });

  it('every table round-trips a full row and a row with every nullable column null', async () => {
    const db = await migrated();
    for (const name of Object.keys(TABLES) as TableName[]) {
      if (name === 'schema_migrations' || name === 'system_state' || name === 'outbox' || name === 'retention_clock') continue;
      const repo = repos[name] as Repo<TableName>;
      for (const [i, nulls] of [[1, false], [2, true]] as const) {
        const row: RowOf<TableName> = sampleRow(name, i, nulls);
        db.withTx((tx) => repo.insert(tx, row));
        const key: Record<string, unknown> = Object.fromEntries(TABLES[name].key.map((k: string) => [k, (row as Record<string, unknown>)[k]]));
        assert.deepEqual(repo.get(db.reader(), key as never), row, `${name} ${nulls ? 'nulls' : 'full'}`);
      }
    }
    assert.equal(repos.pool.get(db.reader(), { poolId: pubkey(99) }), null);
    db.close();
  });

  it('find filters by equality (null matches NULL), orders, limits and refuses a name that is not a column', async () => {
    const db = await migrated();
    for (let i = 1; i <= 5; i++) {
      db.withTx((tx) => repos.candidate.insert(tx, { ...sampleRow('candidate', i), state: i % 2 === 0 ? 'watched' : 'eligible', cooldownUntil: i === 5 ? null : MS + i }));
    }
    const r = db.reader();
    assert.deepEqual(repos.candidate.find(r, { state: 'watched' }, { orderBy: 'firstSeenAt', desc: true }).map((c) => c.candidateId), [ulid(4), ulid(2)]);
    assert.deepEqual(repos.candidate.find(r, { cooldownUntil: null }).map((c) => c.candidateId), [ulid(5)]);
    assert.equal(repos.candidate.find(r, {}, { orderBy: 'firstSeenAt', limit: 2 }).length, 2);
    assert.equal(repos.candidate.find(r, {}, { limit: -3 }).length, 0);
    assert.equal(repos.candidate.find(r, {}, { limit: Number.NaN }).length, 0);
    assert.equal(repos.candidate.find(r, {}, { limit: 2.7 }).length, 2);
    assert.throws(() => repos.candidate.find(r, { stat: 'watched' } as never), /candidate has no column "stat"/);     // review m2: not every row
    assert.throws(() => repos.candidate.find(r, {}, { orderBy: 'nope' as never }), /candidate has no column "nope"/);
    assert.equal(repos.candidate.find(r).length, 5);
    db.close();
  });

  it('update sets fields, never the key; updateVersioned is a compare-and-set (E_STATE_CHANGED) and never sets the version itself', async () => {
    const db = await migrated();
    db.withTx((tx) => repos.candidate.insert(tx, { ...sampleRow('candidate', 1), version: 0, state: 'eligible' }));
    const key = { candidateId: ulid(1) };
    assert.deepEqual(db.withTx((tx) => repos.candidate.updateVersioned(tx, key, 0, { version: 9, candidateId: ulid(2) } as never)), { ok: true, value: 1 });
    assert.deepEqual(db.withTx((tx) => repos.candidate.updateVersioned(tx, key, 1, { state: 'signalled' })), { ok: true, value: 2 });
    assert.deepEqual(db.withTx((tx) => repos.candidate.updateVersioned(tx, key, 1, { state: 'evicted' })), { ok: false, error: { code: 'E_STATE_CHANGED' } });
    const row = repos.candidate.get(db.reader(), key);
    assert.deepEqual([row?.state, row?.version], ['signalled', 2]);
    const t = Date.UTC(2026, 9, 7);
    db.withTx((tx) => repos.kv_state.insert(tx, { key: 'k', valueJson: '{}', createdAt: t, updatedAt: t }));
    assert.equal(db.withTx((tx) => repos.kv_state.update(tx, { key: 'k' }, { valueJson: '[]', key: 'z' } as never)), 1);
    assert.equal(db.withTx((tx) => repos.kv_state.update(tx, { key: 'k' }, {})), 0);
    assert.throws(() => db.withTx((tx) => repos.kv_state.update(tx, { key: 'k' }, { valueJsn: '[1]' } as never)), /kv_state has no column "valueJsn"/);
    assert.throws(() => db.withTx((tx) => repos.candidate.updateVersioned(tx, key, 2, { stat: 'evicted' } as never)), /candidate has no column "stat"/);
    assert.equal(repos.kv_state.get(db.reader(), { key: 'k' })?.valueJson, '[]');
    db.close();
  });

  it('a versioned row has no plain update or upsert, so a stale compare-and-set after any change returns E_STATE_CHANGED (ARCH 7.1)', async () => {
    const db = await migrated();
    for (const table of ['candidate', 'order_intent', 'tx_attempt', 'position'] as const) {
      const repo = repos[table] as unknown as MutableRepo<typeof table>;
      assert.equal(typeof repo.update, 'undefined', table);
      assert.equal(typeof repo.upsert, 'undefined', table);
    }
    const key = { intentId: ulid(1) };
    db.withTx((tx) => repos.order_intent.insert(tx, { ...sampleRow('order_intent', 1), version: 0, state: 'created' }));
    const stale = repos.order_intent.get(db.reader(), key)?.version as number;   // a writer reads version 0, then awaits I/O
    assert.deepEqual(db.withTx((tx) => repos.order_intent.updateVersioned(tx, key, stale, { state: 'risk_checking' })), { ok: true, value: 1 });
    assert.throws(() => db.withTx((tx) => (repos.order_intent as unknown as MutableRepo<'order_intent'>).update(tx, key, { state: 'cancelled' })), TypeError);
    assert.deepEqual(db.withTx((tx) => repos.order_intent.updateVersioned(tx, key, stale, { state: 'cancelled' })), { ok: false, error: { code: 'E_STATE_CHANGED' } });
    assert.deepEqual([repos.order_intent.get(db.reader(), key)?.state, repos.order_intent.get(db.reader(), key)?.version], ['risk_checking', 1]);
    db.close();
  });

  it('upsert inserts, then replaces every non-key field', async () => {
    const db = await migrated();
    const base = { key: 'universe.cursor', valueJson: '{"a":1}', createdAt: MS + 1, updatedAt: MS + 1 };
    db.withTx((tx) => repos.kv_state.upsert(tx, base));
    db.withTx((tx) => repos.kv_state.upsert(tx, { ...base, valueJson: '{"a":2}', updatedAt: MS + 2 }));
    assert.deepEqual(repos.kv_state.get(db.reader(), { key: 'universe.cursor' }), { ...base, valueJson: '{"a":2}', updatedAt: MS + 2 });
    db.close();
  });

  it('refuses to read an integer column beyond 2^53 into a number', async () => {
    const db = await migrated();
    db.withTx((tx) => repos.candidate.insert(tx, sampleRow('candidate', 1)));
    db.withTx((tx) => tx.run('UPDATE candidate SET version = ?', 2n ** 60n));
    assert.throws(() => repos.candidate.get(db.reader(), { candidateId: ulid(1) }), RangeError);
    db.close();
  });
});

describe('metric_rollup_1m sink (B-M27-01 logic 2 meets B-M24-02)', () => {
  it('writes the registry rollups of a finished minute into the append-only table', async () => {
    const db = await migrated();
    const clock = fakeClock(Date.UTC(2026, 9, 7, 12, 0, 0));
    const reg = new MetricsRegistry({ clock, seriesCap: 50, ringBudgetBytes: 0, sink: metricRollupSink(db, repos.metric_rollup_1m, clock, { maxBytes: 1_000_000 }) });
    reg.counter('send_429_total', { path: 'rpc' }).inc(3);
    reg.tick();
    clock.advance(60_000);
    reg.tick();
    const rows = repos.metric_rollup_1m.find(db.reader(), { metric: 'send_429_total' });
    assert.deepEqual(rows, [{ metric: 'send_429_total', labelsHash: labelsHash({ path: 'rpc' }), minute: Date.UTC(2026, 9, 7, 12, 0, 0), scope: 'aggregate', count: 1, sum: 3,
      p50: null, p95: null, p99: null, createdAt: Date.UTC(2026, 9, 7, 12, 1, 0) }]);
    db.close();
  });
});

describe('candidate and watchlist state survive a restart (owner lesson; A-M05-01, A-M05-02)', () => {
  it('candidates with their version and cooldown, transitions, blacklist, eviction tail and cursors are read back after reopening', async () => {
    const path = join(dir, 'restart.db');
    const db = await migrated(path);
    const candidate: RowOf<'candidate'> = { ...sampleRow('candidate', 1), state: 'cooldown', cooldownUntil: MS + 1_800_000, version: 4 };
    const event: RowOf<'candidate_event'> = { ...sampleRow('candidate_event', 1), candidateId: candidate.candidateId, fromState: 'in_position', toState: 'cooldown', reason: 'position_closed' };
    const black: RowOf<'blacklist'> = { ...sampleRow('blacklist', 1), reason: 'authority_changed', until: null };
    const tail: RowOf<'watch_tail'> = { ...sampleRow('watch_tail', 1), reason: 'budget' };
    const cursor: RowOf<'discovery_cursor'> = { ...sampleRow('discovery_cursor', 1), source: 'migration_backfill' };
    const pool: RowOf<'enumerated_pool'> = sampleRow('enumerated_pool', 1);
    db.withTx((tx) => {
      repos.candidate.insert(tx, candidate);
      repos.candidate_event.insert(tx, event);
      repos.blacklist.insert(tx, black);
      repos.watch_tail.insert(tx, tail);
      repos.discovery_cursor.insert(tx, cursor);
      repos.enumerated_pool.insert(tx, pool);
    });
    db.close();
    const again = await migrated(path);
    const r = again.reader();
    assert.deepEqual(repos.candidate.find(r), [candidate]);
    assert.deepEqual(repos.candidate_event.find(r, { candidateId: candidate.candidateId }), [event]);
    assert.deepEqual(repos.blacklist.find(r), [black]);
    assert.deepEqual(repos.watch_tail.find(r), [tail]);
    assert.deepEqual(repos.discovery_cursor.find(r), [cursor]);
    assert.deepEqual(repos.enumerated_pool.find(r), [pool]);
    again.close();
  });
});
