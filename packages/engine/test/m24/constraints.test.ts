// B-M24-02 acceptance and trigger/index tests: append-only tables (UPDATE always aborts, DELETE only past the
// retention horizon, CL-51), PERTOKEN and the other unique indexes, the signal update-once rule and the CHECKs.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { openDb, type Db, type TxHandle } from '../../src/m24/db.ts';
import { MS_MAX, MS_MIN, tableStatements } from '../../src/m24/ddl.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { createRepos, type RowOf } from '../../src/m24/repos.ts';
import { deleteExpired } from '../../src/m24/retention.ts';
import { snake, TABLES, type TableName } from '../../src/m24/schema.ts';
import { fakeClock, tempDir } from '../helpers.ts';
import { pubkey, sampleRow, sha256, signature, ulid } from './samples.ts';

const dir = tempDir('constraints');
let n = 0;
const DAY = 86_400_000;
const repos = createRepos();

async function migrated(): Promise<Db> {
  const path = join(dir, `c${n++}.db`);
  const db = openDb({ create: true, path, clock: fakeClock() });
  const r = await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` });
  assert.equal(r.ok, true);
  return db;
}

/** The engine clock's now in these tests; the retention triggers read only the time the retention job sets (ruling 10). */
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const sqliteNowMs = (_db: Db): number => NOW;

const insert = <N extends TableName>(db: Db, table: N, row: RowOf<N>): void => db.withTx((tx) => repos[table].insert(tx, row));
const fails = (db: Db, fn: (tx: TxHandle) => unknown, re: RegExp): void => assert.throws(() => db.withTx(fn), re);

describe('append-only tables (B-M24-02 logic 3; CL-51)', () => {
  it('acceptance: an UPDATE on fill aborts with append_only', async () => {
    const db = await migrated();
    insert(db, 'fill', sampleRow('fill', 1));
    fails(db, (tx) => tx.run('UPDATE fill SET tip_lamports = 0'), /append_only/);
    db.close();
  });

  it('every append-only table refuses UPDATE and the DELETE of a row inside its horizon', async () => {
    const db = await migrated();
    const appendOnly = (Object.keys(TABLES) as TableName[]).filter((t) => TABLES[t].appendOnly);
    assert.deepEqual(appendOnly.sort(), ['audit_event', 'breaker_event', 'candidate_event', 'cash_flow', 'config_version', 'cost_item', 'cost_item_correction',
      'coverage_report', 'equity_point', 'fill', 'gate_evaluation', 'metric_rollup_1m', 'position_event', 'price_reference', 'quarantine', 'reconcile_run',
      'sandwich_check', 'screen_result', 'shadow_result', 'strategy_stage', 'trade', 'trial_registry', 'universe_manifest', 'wallet_snapshot']);
    for (const table of appendOnly) {
      const row = sampleRow(table, 3) as Record<string, unknown>;
      row.createdAt = Date.UTC(2026, 9, 6);
      db.withTx((tx) => (repos[table] as { insert(tx: TxHandle, r: unknown): void }).insert(tx, row));
      const firstCol = snake(Object.keys(TABLES[table].columns)[1] as string);
      fails(db, (tx) => tx.run(`UPDATE "${table}" SET "${firstCol}" = "${firstCol}"`), /append_only/);
      fails(db, (tx) => tx.run(`DELETE FROM "${table}"`), /append_only/);
    }
    db.close();
  });

  it('the retention job deletes past the horizon (7 years for fill, 30 days for 30 s wallet snapshots); forever never; a plain DELETE never', async () => {
    const db = await migrated();
    const clock = fakeClock(NOW);
    insert(db, 'fill', { ...sampleRow('fill', 1), createdAt: NOW - 2_558 * DAY });
    insert(db, 'fill', { ...sampleRow('fill', 2), createdAt: NOW - 2_550 * DAY });
    fails(db, (tx) => tx.run('DELETE FROM fill WHERE fill_id = ?', ulid(1)), /append_only/);   // outside the job: refused
    assert.equal(deleteExpired(db, 'fill', clock), 1);
    assert.deepEqual(repos.fill.find(db.reader()).map((f) => f.fillId), [ulid(2)]);
    insert(db, 'wallet_snapshot', { ...sampleRow('wallet_snapshot', 1), granularity: '30s', createdAt: NOW - 31 * DAY });
    insert(db, 'wallet_snapshot', { ...sampleRow('wallet_snapshot', 2), granularity: 'daily', createdAt: NOW - 31 * DAY });
    assert.equal(deleteExpired(db, 'wallet_snapshot', clock), 1);
    assert.deepEqual(repos.wallet_snapshot.find(db.reader()).map((w) => w.granularity), ['daily']);
    insert(db, 'config_version', { ...sampleRow('config_version', 1), createdAt: MS_MIN });
    fails(db, (tx) => tx.run('DELETE FROM config_version'), /append_only/);
    assert.throws(() => deleteExpired(db, 'config_version', clock), /no expiring/);
    assert.equal(db.reader().get('SELECT now_ms FROM retention_clock')?.now_ms, 0n);          // reset before commit
    db.close();
  });

  it('a time stamped in seconds instead of milliseconds is refused, so it cannot pass the horizon at once (review m3)', async () => {
    const db = await migrated();
    const nowSec = Math.floor(sqliteNowMs(db) / 1000);
    fails(db, (tx) => repos.fill.insert(tx, { ...sampleRow('fill', 1), createdAt: nowSec }), /CHECK constraint failed: created_at/);
    fails(db, (tx) => repos.trade.insert(tx, { ...sampleRow('trade', 1), createdAt: nowSec }), /CHECK constraint failed: created_at/);
    assert.equal(db.withTx((tx) => tx.get('SELECT count(*) AS n FROM fill'))?.n, 0n);
    for (const [table, def] of Object.entries(TABLES)) {
      for (const [col, c] of Object.entries(def.columns)) {
        if (c.kind === 'ms') {
          assert.ok(tableStatements(table, def)[0]?.includes(`CHECK (${'nullable' in c ? `"${snake(col)}" IS NULL OR (` : ''}"${snake(col)}" >= ${MS_MIN} AND "${snake(col)}" < ${MS_MAX}`), `${table}.${col}`);
        }
      }
    }
    db.close();
  });

  it('a time stamped in microseconds is refused, so no row is kept past its horizon for ever (red team n3)', async () => {
    const db = await migrated();
    const nowUs = sqliteNowMs(db) * 1000;
    fails(db, (tx) => repos.fill.insert(tx, { ...sampleRow('fill', 1), createdAt: nowUs }), /CHECK constraint failed: created_at/);
    fails(db, (tx) => repos.trade.insert(tx, { ...sampleRow('trade', 1), createdAt: nowUs }), /CHECK constraint failed: created_at/);
    assert.equal(db.withTx((tx) => tx.get('SELECT count(*) AS n FROM fill'))?.n, 0n);
    db.close();
  });

  it('signal: decision fields change once while undecided; nothing else ever changes', async () => {
    const db = await migrated();
    insert(db, 'signal', sampleRow('signal', 1, true));
    const id = { candidateId: ulid(1) };
    assert.equal(db.withTx((tx) => repos.signal.update(tx, id, { decision: 'accepted', decidedAt: Date.UTC(2026, 9, 7), riskChecksJson: '[]' })), 1);
    fails(db, (tx) => repos.signal.update(tx, id, { decision: 'rejected' }), /append_only/);
    insert(db, 'signal', sampleRow('signal', 2, true));
    fails(db, (tx) => repos.signal.update(tx, { candidateId: ulid(2) }, { strategyId: 'other' }), /append_only/);
    db.close();
  });
});

describe('PERTOKEN and unique indexes (B-M24-02 logic 4)', () => {
  it('acceptance: a second non-terminal buy intent for the same mint violates the unique index', async () => {
    const db = await migrated();
    const buy = (i: number, state: RowOf<'order_intent'>['state'], side: 'buy' | 'sell' = 'buy'): RowOf<'order_intent'> =>
      ({ ...sampleRow('order_intent', i), mint: pubkey(7), side, state });
    insert(db, 'order_intent', buy(1, 'in_flight'));
    fails(db, (tx) => repos.order_intent.insert(tx, buy(2, 'created')), /UNIQUE constraint failed: order_intent\.mint/);
    insert(db, 'order_intent', buy(3, 'created', 'sell'));
    insert(db, 'order_intent', buy(4, 'filled'));
    assert.equal(db.withTx((tx) => repos.order_intent.updateVersioned(tx, { intentId: ulid(1) }, 1, { state: 'filled' })).ok, true);   // sample version = 1
    insert(db, 'order_intent', buy(5, 'reserved'));
    db.close();
  });

  it('a second non-terminal position for the same mint is refused; terminal ones are not counted', async () => {
    const db = await migrated();
    const pos = (i: number, state: RowOf<'position'>['state']): RowOf<'position'> => ({ ...sampleRow('position', i), mint: pubkey(9), state });
    insert(db, 'position', pos(1, 'open'));
    fails(db, (tx) => repos.position.insert(tx, pos(2, 'opening')), /UNIQUE constraint failed: position\.mint/);
    for (const [i, s] of [[3, 'closed'], [4, 'open_failed'], [5, 'written_off']] as const) insert(db, 'position', pos(i, s));
    db.close();
  });

  it('idempotency key, signature, reservation intent, cost item kind, open alert dedupe key, audit hash and trial key are unique', async () => {
    const db = await migrated();
    const dup = <N extends TableName>(table: N, a: RowOf<N>, b: RowOf<N>, re: RegExp): void => {
      insert(db, table, a);
      fails(db, (tx) => repos[table].insert(tx, b), re);
    };
    dup('order_intent', { ...sampleRow('order_intent', 1), idempotencyKey: 'k' }, { ...sampleRow('order_intent', 2), idempotencyKey: 'k', mint: pubkey(2) }, /idempotency_key/);
    dup('tx_attempt', sampleRow('tx_attempt', 1), { ...sampleRow('tx_attempt', 2), signature: signature(1) }, /tx_attempt\.signature/);
    dup('reservation', sampleRow('reservation', 1), { ...sampleRow('reservation', 2), intentId: ulid(1) }, /reservation\.intent_id/);
    dup('cost_item', sampleRow('cost_item', 1), { ...sampleRow('cost_item', 2), attemptId: ulid(1), kind: 'text-1' }, /cost_item\.attempt_id, cost_item\.kind/);
    dup('audit_event', sampleRow('audit_event', 1), { ...sampleRow('audit_event', 2), hash: sha256(1) }, /audit_event\.hash/);
    dup('trial_registry', sampleRow('trial_registry', 1), { ...sampleRow('trial_registry', 2), trialKey: 'text-1', kind: 'coarse_screen' }, /trial_key/);
    const alert = (i: number, state: RowOf<'alert'>['state']): RowOf<'alert'> => ({ ...sampleRow('alert', i), dedupeKey: 'd', state });
    dup('alert', alert(1, 'open'), alert(2, 'snoozed'), /alert\.dedupe_key/);
    db.withTx((tx) => repos.alert.update(tx, { alertId: ulid(1) }, { state: 'resolved' }));
    insert(db, 'alert', alert(3, 'open'));
    insert(db, 'alert', alert(4, 'resolved'));
    db.close();
  });
});

describe('column CHECKs and STRICT tables (B-M24-02 logic 2)', () => {
  const cases: Array<[string, unknown, boolean]> = [
    ['u64', '0', true], ['u64', '18446744073709551615', true], ['u64', '18446744073709551616', false], ['u64', '1abc', false], ['u64', '01', false],
    ['u64', '-1', false], ['u64', '', false], ['u64', '99999999999999999999', false],
    ['i128', '-5', true], ['i128', '0', true], ['i128', '-0', false], ['i128', '--5', false], ['i128', '1'.repeat(40), false],
    ['decimal', '0.5', true], ['decimal', '-12.000001', true], ['decimal', '7', true], ['decimal', '1e5', false], ['decimal', '01.5', false],
    ['decimal', '1.', false], ['decimal', '.5', false], ['decimal', '1.2.3', false], ['decimal', `0.${'1'.repeat(31)}`, false],
    ['pubkey', pubkey(1), true], ['pubkey', `${'0'.repeat(32)}`, false], ['pubkey', 'short', false],
    ['ulid', ulid(1), true], ['ulid', ulid(1).toLowerCase(), false], ['sha256', sha256(0xabcdef), true], ['sha256', sha256(0xabcdef).toUpperCase(), false],
    ['json', '{"a":1}', true], ['json', '{a:1}', false], ['lamports', -1n, false], ['lamports', 0n, true], ['bool', 2, false], ['ms', -1, false],
    ['ms', MS_MIN, true], ['ms', MS_MIN - 1, false], ['ms', 1_759_000_000, false], ['ms', MS_MAX - 1, true], ['ms', MS_MAX, false],
    ['ms', 1_759_000_000_000_000, false],
    ['int', 'abc', false], ['int', 1.5, false],
  ];
  const where: Record<string, [TableName, string]> = {
    u64: ['order_intent', 'amountIn'], i128: ['fill', 'tokenDeltaBase'], decimal: ['bar_1m', 'open'], pubkey: ['pool', 'poolId'], ulid: ['run', 'runId'],
    sha256: ['coverage_report', 'manifestSha256'], json: ['kv_state', 'valueJson'], lamports: ['reservation', 'lamports'], bool: ['pool', 'isCanonical'],
    ms: ['kv_state', 'updatedAt'], int: ['candidate', 'version'],
  };
  for (const [kind, value, ok] of cases) {
    it(`${kind} ${ok ? 'accepts' : 'rejects'} ${JSON.stringify(typeof value === 'bigint' ? `${value}n` : value).slice(0, 40)}`, async () => {
      const db = await migrated();
      const [table, column] = where[kind] as [TableName, string];
      const row = { ...sampleRow(table, 1), [column]: value } as RowOf<typeof table>;
      if (ok) insert(db, table, row);
      else fails(db, (tx) => repos[table].insert(tx, row as never), /CHECK constraint failed|cannot store/);
      db.close();
    });
  }

  it('untrusted symbol and name are limited to 32 and 64 UTF-8 bytes', async () => {
    const db = await migrated();
    insert(db, 'token', { ...sampleRow('token', 1), symbol: 'é'.repeat(16), name: 'n'.repeat(64) });
    fails(db, (tx) => repos.token.insert(tx, { ...sampleRow('token', 2), symbol: 'é'.repeat(17) }), /CHECK constraint failed/);
    fails(db, (tx) => repos.token.insert(tx, { ...sampleRow('token', 3), name: 'n'.repeat(65) }), /CHECK constraint failed/);
    db.close();
  });

  it('trade rows keep net = gross - total costs and total = the sum of the costs (VM-06 invariant)', async () => {
    const db = await migrated();
    const good = sampleRow('trade', 1);
    insert(db, 'trade', good);
    fails(db, (tx) => repos.trade.insert(tx, { ...sampleRow('trade', 2), netPnlLamports: 0n }), /CHECK constraint failed/);
    fails(db, (tx) => repos.trade.insert(tx, { ...sampleRow('trade', 3), costTipsLamports: 1n }), /CHECK constraint failed/);
    db.close();
  });

  it('order_intent.purpose defaults to trade (CL-44)', async () => {
    const db = await migrated();
    const r = sampleRow('order_intent', 1);
    const cols = Object.keys(r).filter((k) => k !== 'purpose');
    db.withTx((tx) => tx.run(`INSERT INTO order_intent (${cols.map((k) => `"${snake(k)}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((k) => { const v = (r as Record<string, unknown>)[k]; return typeof v === 'boolean' ? (v ? 1 : 0) : v as string; })));
    assert.equal(repos.order_intent.get(db.reader(), { intentId: ulid(1) })?.purpose, 'trade');
    db.close();
  });
});
