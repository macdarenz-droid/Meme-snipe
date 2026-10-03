import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { VENUES } from '../../src/domain/index.ts';
import { INTENT_STATUSES, POSITION_STATUSES } from '../../src/lifecycle/index.ts';
import { openLedger, openLedgerReader } from '../../src/ledger/index.ts';
import { V1_INTENT_STATUSES, V1_POSITION_STATUSES, V1_VENUES } from '../../src/ledger/migrations.ts';
import { connectionOf } from '../../src/ledger/adapters/ledger.ts';
import { openReader, openWriter, type Migration } from '../../src/ledger/adapters/sqlite.ts';
import { lamports, raw } from '../../src/units/index.ts';
import { attempt, entryIntent, fill, MINT, sig } from '../fixtures.ts';
import { runChild, tempPath } from './helpers.ts';

const LIMITS = { maxHeld: lamports(50_000_000), maxCount: 2 };
const raw_ = (path: string) => new DatabaseSync(path, { readBigInts: true });

describe('ledger storage settings', () => {
  it('uses WAL, synchronous=FULL and foreign keys', () => {
    const ledger = openLedger(tempPath(), 'paper');
    const db = connectionOf(ledger);
    expect(db.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toBe('wal');
    expect(db.prepare('PRAGMA synchronous').get()?.['synchronous']).toBe(2n); // FULL
    expect(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1n);
    ledger.close();
  });

  it('allows one writer: a second open is refused while the first is alive, and allowed after close', () => {
    const path = tempPath();
    const first = openLedger(path, 'paper');
    expect(() => openLedger(path, 'paper')).toThrow(/already has a writer/);
    first.close();
    openLedger(path, 'paper').close();
  });

  it('six processes opening at the same moment get exactly one writer', async () => {
    const path = tempPath();
    openLedger(path, 'paper').close();
    const startAt = Date.now() + 1_000;
    const children = Array.from({ length: 6 }, () => runChild(['writer', path, String(startAt)]));
    const outcomes = await Promise.all(children.map((c) => c.line('writer ')));
    await Promise.all(children.map((c) => c.exit));
    expect(outcomes.filter((o) => o === 'writer ok'), outcomes.join('\n')).toHaveLength(1);
    expect(outcomes.filter((o) => o.startsWith('writer refused') && o.includes('already has a writer'))).toHaveLength(5);
  }, 20_000);

  it('a leftover empty lock file does not let a second writer in, and a foreign one fails closed', () => {
    const path = tempPath();
    writeFileSync(`${path}-writer.lock`, '');
    const first = openLedger(path, 'paper');
    expect(() => openLedger(path, 'paper')).toThrow(/already has a writer/);
    first.close();
    const other = tempPath();
    writeFileSync(`${other}-writer.lock`, '12345'); // half-written or foreign content: refuse, never take over
    expect(() => openLedger(other, 'paper')).toThrow(/cannot take the writer lock/);
  });

  it('a backtest ledger and a live ledger never open as each other', () => {
    const path = tempPath();
    openLedger(path, 'backtest').close();
    expect(() => openLedger(path, 'live')).toThrow(/backtest ledger, not live/);
    expect(openLedgerReader(path).purpose()).toBe('backtest');
  });

  it('the read-only connection cannot write', () => {
    const path = tempPath();
    openLedger(path, 'paper').close();
    const reader = openLedgerReader(path);
    const db = connectionOf(reader);
    expect(() => db.exec("INSERT INTO ledger_meta (key, value) VALUES ('x', 'y')")).toThrow(/readonly/);
    reader.close();
  });
});

describe('append-only and exact amounts', () => {
  it('refuses UPDATE and DELETE on ledger tables, even from another connection', () => {
    const path = tempPath();
    const ledger = openLedger(path, 'paper');
    ledger.recordIntent(entryIntent(1), { status: 'candidate', ts: 1 });
    ledger.close();
    const db = raw_(path);
    expect(() => db.exec("UPDATE intent SET spend = '1'")).toThrow(/append-only: intent/);
    expect(() => db.exec('DELETE FROM intent_event')).toThrow(/append-only: intent_event/);
    expect(() => db.exec('DELETE FROM schema_migrations')).toThrow(/append-only: schema_migrations/);
    db.close();
  });

  it('refuses INSERT OR REPLACE and upserts on the ledger\'s own connection', () => {
    const ledger = openLedger(tempPath(), 'paper');
    ledger.recordIntent(entryIntent(1), { status: 'candidate', ts: 1 });
    const db = connectionOf(ledger);
    const copy = `SELECT intent_id, idem_key, purpose, side, mint, venue, position_id, '999999', NULL, decision_id, created_ts FROM intent`;
    expect(() => db.exec(`INSERT OR REPLACE INTO intent ${copy}`)).toThrow(/append-only: intent/);
    expect(() => db.exec(`REPLACE INTO intent ${copy}`)).toThrow(/append-only: intent/);
    expect(() => db.exec(`INSERT INTO intent ${copy} WHERE true ON CONFLICT (intent_id) DO UPDATE SET spend = excluded.spend`)).toThrow(/append-only: intent/);
    expect(ledger.intent('e1')?.intent).toMatchObject({ spend: 16_000_000n });
    ledger.close();
  });

  it('round-trips u64 amounts exactly and stores them as text, never as float', () => {
    const path = tempPath();
    const ledger = openLedger(path, 'paper');
    const i = entryIntent(1);
    const max = 18_446_744_073_709_551_615n; // u64 max: larger than SQLite INTEGER and far beyond float precision
    ledger.recordIntent(i, { status: 'confirmed_fill', ts: 1 });
    ledger.recordFill({ ...fill(i.id, 1, 0n), tokens: raw(max), sol: lamports(max - 1n) }, 2);
    const f = ledger.fills(i.id)[0];
    expect(f?.tokens).toBe(max);
    expect(f?.sol).toBe(max - 1n);
    ledger.close();
    const db = raw_(path);
    expect(db.prepare('SELECT typeof(tokens) t, tokens FROM fill').get()).toEqual({ t: 'text', tokens: '18446744073709551615' });
    expect(() => db.exec(`INSERT INTO fee (kind, lamports, ts) VALUES ('tip', '1.5', 1)`)).toThrow(/CHECK/);
    expect(() => db.exec(`INSERT INTO fee (kind, lamports, ts) VALUES ('tip', '-1', 1)`)).toThrow(/CHECK/);
    expect(() => db.exec(`INSERT INTO fee (kind, lamports, ts) VALUES ('tip', '007', 1)`)).toThrow(/CHECK/);
    expect(() => db.exec(`INSERT INTO fee (kind, lamports, ts) VALUES ('tip', 1.5, 1)`)).toThrow(/CHECK/); // a float is refused
    db.close();
  });

  it('records fees and rent by kind', () => {
    const ledger = openLedger(tempPath(), 'paper');
    const i = entryIntent(1);
    ledger.recordIntent(i, { status: 'reconciled', ts: 1 });
    ledger.recordFee({ intentId: i.id, signature: sig(1), kind: 'priority', lamports: lamports(5_000), ts: 2 });
    ledger.recordFee({ intentId: i.id, kind: 'rent_paid', lamports: lamports(2_039_280), ts: 2 });
    expect(ledger.feesFor(i.id)).toEqual([{ kind: 'priority', lamports: 5_000n }, { kind: 'rent_paid', lamports: 2_039_280n }]);
    ledger.close();
  });
});

describe('intents, outbox and reservations', () => {
  it('refuses a second intent with the same idempotency key and writes nothing for it', () => {
    const ledger = openLedger(tempPath(), 'paper');
    expect(ledger.recordIntent(entryIntent(1, 'same-decision'), { status: 'candidate', ts: 1 })).toEqual({ ok: true });
    const dup = entryIntent(2, 'same-decision'); // new id, same key
    expect(ledger.recordIntent(dup, { status: 'candidate', ts: 2 })).toEqual({ ok: false, reason: 'duplicate_key', existingIntentId: 'e1' });
    expect(ledger.intent(dup.id)).toBeNull();
    expect(ledger.unresolvedIntents().map((r) => r.intent.id)).toEqual(['e1']);
    ledger.close();
  });

  it('the database itself refuses a duplicate key that bypasses the check', () => {
    const path = tempPath();
    const ledger = openLedger(path, 'paper');
    ledger.recordIntent(entryIntent(1, 'k'), { status: 'candidate', ts: 1 });
    ledger.close();
    const db = raw_(path);
    expect(() => db.exec(`INSERT INTO intent (intent_id, idem_key, purpose, side, mint, venue, position_id, spend, created_ts)
      SELECT 'other', idem_key, purpose, side, mint, venue, 'p9', spend, 2 FROM intent`)).toThrow(/UNIQUE constraint failed: intent.idem_key/);
    db.close();
  });

  it('writes a transition and its effects together; persist is the write itself; done is recorded once', () => {
    const ledger = openLedger(tempPath(), 'paper');
    const i = entryIntent(1);
    const a = attempt(i.id, 1, 500n);
    ledger.recordIntent(i, { status: 'prepared', ts: 1 });
    ledger.atomically(() => {
      ledger.recordAttempt(a, 2);
      ledger.appendIntentTransition({
        intentId: i.id, status: 'submitted', event: 'submit', ts: 2,
        effects: [
          { type: 'persist', entity: 'intent', id: i.id },
          { type: 'broadcast', intentId: i.id, attemptId: a.id, signedBytesRef: a.signedBytesRef, signature: a.signature },
        ],
      });
    });
    const pending = ledger.pendingOutbox();
    expect(pending.map((p) => p.effect.type)).toEqual(['broadcast']);
    expect(ledger.attempts(i.id)).toEqual([a]);
    expect(ledger.intent(i.id)?.status).toBe('submitted');
    const item = pending[0]!;
    ledger.completeOutbox(item.outboxId, 'done', 3);
    expect(ledger.pendingOutbox()).toEqual([]);
    expect(() => ledger.completeOutbox(item.outboxId, 'done', 4)).toThrow(/UNIQUE/);
    ledger.close();
  });

  it('keeps bigints inside effects exact', () => {
    const ledger = openLedger(tempPath(), 'paper');
    const i = entryIntent(1);
    ledger.recordIntent(i, { status: 'reconciled', ts: 1 });
    const big = lamports(18_446_744_073_709_551_615n);
    ledger.appendIntentTransition({ intentId: i.id, status: 'reconciled', event: 'x', ts: 2, effects: [{ type: 'release_reservation', intentId: i.id, amount: big }] });
    expect(ledger.pendingOutbox()[0]?.effect).toEqual({ type: 'release_reservation', intentId: i.id, amount: big });
    ledger.close();
  });

  it('rolls back every write in a group when any part fails', () => {
    const ledger = openLedger(tempPath(), 'paper');
    const i = entryIntent(1);
    expect(() => ledger.atomically(() => {
      ledger.recordIntent(i, { status: 'candidate', ts: 1 });
      ledger.appendIntentTransition({ intentId: i.id, status: 'not-a-status' as never, event: 'bad', ts: 2 });
    })).toThrow(/CHECK/);
    expect(ledger.intent(i.id)).toBeNull();
    ledger.close();
  });

  it('a signer rule backed by the schema: one signature per intent and blockhash', () => {
    const ledger = openLedger(tempPath(), 'paper');
    const i = entryIntent(1);
    ledger.recordIntent(i, { status: 'prepared', ts: 1 });
    const a = attempt(i.id, 1, 500n);
    ledger.recordAttempt(a, 1);
    expect(() => ledger.recordAttempt({ ...a, id: 'a2' as never, signature: sig(2) }, 2)).toThrow(/UNIQUE constraint failed: attempt.intent_id, attempt.blockhash/);
    ledger.close();
  });

  it('reserves within limits, refuses over the amount or count, and frees on release', () => {
    const ledger = openLedger(tempPath(), 'paper');
    for (const n of [1, 2, 3]) ledger.recordIntent(entryIntent(n), { status: 'risk_approved', ts: n });
    const reserve = (n: number, amount: number) => ledger.reserveExposure({
      reservationId: `r${n}`, intentId: `e${n}`, amount: lamports(amount), limits: LIMITS, ts: 10 + n,
      transition: { status: 'exposure_reserved', event: 'reserve' },
    });
    expect(reserve(1, 30_000_000)).toEqual({ ok: true, heldAfter: 30_000_000n });
    expect(reserve(2, 30_000_000)).toEqual({ ok: false, reason: 'over_limit' });
    expect(ledger.intent('e2')?.status).toBe('risk_approved'); // a refused reservation writes nothing
    expect(reserve(2, 20_000_000)).toEqual({ ok: true, heldAfter: 50_000_000n });
    expect(reserve(3, 1)).toEqual({ ok: false, reason: 'too_many' });
    expect(reserve(1, 1)).toEqual({ ok: false, reason: 'already_reserved' });
    ledger.endReservation('r1', 'released', 20);
    expect(() => ledger.endReservation('r1', 'kept', 21)).toThrow(/UNIQUE/);
    expect(ledger.heldExposure()).toBe(20_000_000n);
    expect(reserve(3, 30_000_000)).toEqual({ ok: true, heldAfter: 50_000_000n });
    expect(ledger.intent('e3')?.status).toBe('exposure_reserved');
    ledger.close();
  });

  it('refuses to reserve with a missing or malformed limit, and writes nothing', () => {
    const ledger = openLedger(tempPath(), 'paper');
    ledger.recordIntent(entryIntent(1), { status: 'risk_approved', ts: 1 });
    const bad: unknown[] = [
      { maxHeld: undefined, maxCount: Number.NaN },
      { maxHeld: lamports(10), maxCount: Number.NaN },
      { maxHeld: lamports(10), maxCount: 0 },
      { maxHeld: lamports(10), maxCount: 1.5 },
      { maxHeld: lamports(10), maxCount: Number.POSITIVE_INFINITY },
      { maxHeld: 10, maxCount: 1 },
      { maxHeld: -1n, maxCount: 1 },
      { maxCount: 1 },
      undefined,
    ];
    for (const limits of bad) {
      expect(() => ledger.reserveExposure({ reservationId: 'r1', intentId: 'e1', amount: lamports(1_000_000_000_000), limits: limits as never, ts: 2 }), JSON.stringify(limits ?? null, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)))
        .toThrow(/maxHeld|maxCount/);
    }
    expect(ledger.heldReservations()).toEqual([]);
    ledger.close();
  });

  it('refuses a reservation for an exit or an unknown intent', () => {
    const ledger = openLedger(tempPath(), 'paper');
    const exit = { id: 'x1', key: 'exit:p1:1', purpose: 'exit', side: 'sell', mint: MINT, venue: 'pumpswap', positionId: 'p1', quantity: raw(5) } as const;
    ledger.recordIntent(exit as never, { status: 'exposure_reserved', ts: 1 });
    const r = (intentId: string) => ledger.reserveExposure({ reservationId: `r-${intentId}`, intentId, amount: lamports(1), limits: LIMITS, ts: 2 });
    expect(r('x1')).toEqual({ ok: false, reason: 'not_an_entry' });
    expect(r('nope')).toEqual({ ok: false, reason: 'unknown_intent' });
    ledger.close();
  });
});

describe('positions, decisions and commands', () => {
  it('tracks the latest position state', () => {
    const ledger = openLedger(tempPath(), 'paper');
    const i = entryIntent(1);
    ledger.recordIntent(i, { status: 'candidate', ts: 1 });
    ledger.openPosition({ positionId: 'p1', mint: MINT, venue: 'pump-curve', entryIntentId: i.id, ts: 2 });
    ledger.appendPositionState({ positionId: 'p1', status: 'open', quantity: 900n, cost: lamports(16_000_000), event: 'filled', ts: 3 });
    expect(ledger.positions()).toEqual([{ positionId: 'p1', mint: MINT, venue: 'pump-curve', entryIntentId: 'e1', status: 'open', quantity: 900n, cost: 16_000_000n, statusTs: 3 }]);
    ledger.close();
  });

  it('records a decision with its reasons against a snapshot taken no later than the decision', () => {
    const ledger = openLedger(tempPath(), 'paper');
    const base = { mint: MINT, venue: 'pump-curve', quoteMint: 'So11111111111111111111111111111111111111112', asOfSlot: 10n, featuresetVer: 'f1', features: { buyers: 12 } } as const;
    expect(() => ledger.recordFeatureSnapshot({ ...base, decisionTs: 100, maxReceiptTs: 101 })).toThrow(/CHECK/);
    const snapshotId = ledger.recordFeatureSnapshot({ ...base, decisionTs: 100, maxReceiptTs: 100 });
    expect(() => ledger.recordDecision({ snapshotId, decidedTs: 100, strategyVer: 's1', action: 'reject', reasons: [], mode: 'paper' })).toThrow(/CHECK/);
    expect(ledger.recordDecision({ snapshotId, decidedTs: 100, strategyVer: 's1', action: 'reject', reasons: ['stale_quote'], mode: 'paper' })).toBe(1n);
    expect(() => ledger.recordDecision({ snapshotId: 99n, decidedTs: 100, strategyVer: 's1', action: 'enter', reasons: ['ok'], mode: 'paper' })).toThrow(/FOREIGN KEY/);
    ledger.close();
  });

  it('records commands with their auth level and refuses anything but pause from Telegram', () => {
    const ledger = openLedger(tempPath(), 'paper');
    ledger.recordCommand({ commandId: 'c1', command: 'pause', authLevel: 'telegram', issuedBy: 'owner', issuedTs: 1 });
    expect(() => ledger.recordCommand({ commandId: 'c2', command: 'resume', authLevel: 'telegram', issuedBy: 'owner', issuedTs: 2 })).toThrow(/CHECK/);
    ledger.recordCommand({ commandId: 'c3', command: 'close_position', args: { positionId: 'p1' }, authLevel: 'dashboard_passkey', issuedBy: 'owner', issuedTs: 3 });
    expect(ledger.pendingCommands().map((c) => [c.commandId, c.authLevel])).toEqual([['c1', 'telegram'], ['c3', 'dashboard_passkey']]);
    expect(() => ledger.recordCommand({ commandId: 'c4', command: 'pause', authLevel: 'dashboard', issuedBy: 'tg:123456789' as never, issuedTs: 5 })).toThrow(/CHECK/);
    ledger.recordCommandResult('c1', true, 'paused', 4);
    expect(ledger.pendingCommands().map((c) => c.commandId)).toEqual(['c3']);
    ledger.close();
  });

  it('makes a consistent snapshot copy for backups', () => {
    const ledger = openLedger(tempPath(), 'paper');
    ledger.recordIntent(entryIntent(1), { status: 'candidate', ts: 1 });
    const copy = tempPath('copy.db');
    ledger.snapshotTo(copy);
    ledger.close();
    const reader = openLedgerReader(copy);
    expect(reader.intent('e1')?.status).toBe('candidate');
    reader.close();
  });
});

describe('migrations', () => {
  const v1: Migration = { version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER) STRICT;' };
  const v2: Migration = { version: 2, name: 'two', sql: 'CREATE TABLE b (y INTEGER) STRICT;' };

  it('applies only the missing versions, in order, once', () => {
    const path = tempPath();
    openWriter(path, 'ledger', [v1]).release();
    const { db, release } = openWriter(path, 'ledger', [v1, v2]);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r['version'])).toEqual([1n, 2n]);
    db.close();
    release();
  });

  it('refuses a file newer than the code (no downgrade)', () => {
    const path = tempPath();
    const s = openWriter(path, 'ledger', [v1, v2]);
    s.db.close();
    s.release();
    expect(() => openWriter(path, 'ledger', [v1])).toThrow(/newer than this code/);
    expect(() => openReader(path, 'ledger', [v1])).toThrow(/newer than this code/);
  });

  it('refuses an edited migration and a list with gaps', () => {
    const path = tempPath();
    const s = openWriter(path, 'ledger', [v1]);
    s.db.close();
    s.release();
    expect(() => openWriter(path, 'ledger', [{ ...v1, sql: 'CREATE TABLE a (x TEXT) STRICT;' }])).toThrow(/edited migration/);
    expect(() => openWriter(tempPath(), 'ledger', [v1, { ...v2, version: 3 }])).toThrow(/without gaps/);
  });

  it('a failing migration leaves the file at the previous version', () => {
    const path = tempPath();
    const bad: Migration = { version: 2, name: 'bad', sql: 'CREATE TABLE c (z INTEGER) STRICT; CREATE TABLE a (x INTEGER);' };
    openWriter(path, 'ledger', [v1]).release();
    expect(() => openWriter(path, 'ledger', [v1, bad])).toThrow(/already exists/);
    const db = raw_(path);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'c'").get()).toBeUndefined();
    expect(db.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.['v']).toBe(1n);
    db.close();
  });

  it('schema 1 lists match the domain; a change there must ship as a new migration', () => {
    expect([...V1_VENUES]).toEqual([...VENUES]);
    expect([...V1_INTENT_STATUSES]).toEqual([...INTENT_STATUSES]);
    expect([...V1_POSITION_STATUSES]).toEqual([...POSITION_STATUSES]);
  });
});
