// The ledger replay check (LEDGER-REPLAY, docs/ARCHITECTURE.md §15 item 2): an honest ledger replays exactly;
// every kind of tampering fails at the first differing row; the file is never written; the output is deterministic.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { positionId, type IntentId } from '../../src/domain/index.ts';
import { canonical, replayOnce } from '../../src/engine/index.ts';
import type { BookEvent } from '../../src/lifecycle/index.ts';
import { openLedger, openLedgerReader, type LedgerPurpose } from '../../src/ledger/index.ts';
import { connectionOf } from '../../src/ledger/ledger.ts';
import { encodeBookDetail, replayLedger, replayLedgerFile, type ReplayReport, type ReplaySource } from '../../src/ledger/replay/index.ts';
import { raw } from '../../src/units/index.ts';
import { generateStream, stubRun } from '../engine-fixtures.ts';
import { attempt, CONFIG, entryToSubmitted, fill, on, quote, sig } from '../fixtures.ts';
import { tempPath } from './helpers.ts';
import { appliedEvents, recordEvents, type Timed } from './recorder.ts';

const E1 = 'e1' as IntentId;
const X1 = 'x1' as IntentId;
const P1 = positionId('p1');

/** A ledger written from an ENG-1 engine run: the stub strategy walks entries and exits through the stub world. */
const engineLedger = (purpose: LedgerPurpose = 'backtest', slots = 600, seed = 'replay-ledger'): string => {
  const { records } = replayOnce(stubRun(generateStream(seed, slots)));
  const path = tempPath();
  const ledger = openLedger(path, purpose);
  recordEvents(ledger, appliedEvents(records), CONFIG);
  ledger.close();
  return path;
};

const timed = (events: readonly BookEvent[]): Timed[] => events.map((event, ts) => ({ event, ts }));

const landed = (id: IntentId, n: number, h: bigint): BookEvent =>
  on(id, { type: 'status', signature: sig(n), result: 'succeeded', commitment: 'finalized', blockHeight: h, searchedHistory: true });
const notFound = (id: IntentId, n: number, h: bigint): BookEvent =>
  on(id, { type: 'status', signature: sig(n), result: 'not_found', commitment: null, blockHeight: h, searchedHistory: true });

/** Late landings, a cleared landing with its proof, a merged exit trigger and a restart: the book-level events. */
const BOOK_EVENTS: readonly BookEvent[] = [
  // Entry 1 expires, is abandoned, then is reported landed on a fork that is cleared with proof.
  ...entryToSubmitted(1, 1_000n),
  notFound(E1, 1, 1_001n),
  on(E1, { type: 'reconcile', fills: [], blockHeight: 1_001n }),
  on(E1, { type: 'abandon' }),
  on(E1, { type: 'status', signature: sig(1), result: 'succeeded', commitment: 'confirmed', blockHeight: 1_002n, searchedHistory: false }),
  { type: 'orphan_cleared', signature: sig(1), proof: { signature: sig(1), balances: 'unchanged', commitment: 'finalized', status: 'not_found', searchedHistory: true, finalizedBlockHeight: 1_050n } },
  // Entry 2 (allowed only because the landing was cleared) fills 1,000 tokens through a restart.
  ...entryToSubmitted(2, 3_000n),
  { type: 'restart' },
  on('e2' as IntentId, { type: 'status', signature: sig(2), result: 'succeeded', commitment: 'confirmed', blockHeight: 2_000n, searchedHistory: false }),
  on('e2' as IntentId, { type: 'reconcile', fills: [fill('e2' as IntentId, 2, 1_000n)], blockHeight: 2_000n }),
  // An exit of 400 gets a second reason while running, expires, is abandoned, then lands late and is booked.
  { type: 'trigger_exit', positionId: positionId('p2'), reasons: ['stop'], intentId: X1, quantity: raw(400n) },
  on(X1, { type: 'prepare', quote }),
  { type: 'trigger_exit', positionId: positionId('p2'), reasons: ['max_hold'], intentId: 'x2' as IntentId },
  on(X1, { type: 'sign', attempt: attempt(X1, 11, 2_500n) }),
  on(X1, { type: 'submit' }),
  notFound(X1, 11, 2_501n),
  on(X1, { type: 'reconcile', fills: [], blockHeight: 2_501n }),
  on(X1, { type: 'abandon' }),
  landed(X1, 11, 2_600n),
  { type: 'orphan_fill', fill: fill(X1, 11, 400n) },
];

const bookLedger = (events: readonly BookEvent[] = BOOK_EVENTS, purpose: LedgerPurpose = 'paper'): string => {
  const path = tempPath();
  const ledger = openLedger(path, purpose);
  recordEvents(ledger, timed(events), CONFIG);
  ledger.close();
  return path;
};

/** Edits a closed ledger file behind the append-only triggers, as an attacker or a bug would. */
const tamper = (path: string, edit: (db: DatabaseSync) => void): void => {
  const db = new DatabaseSync(path, { readBigInts: true });
  for (const t of ['intent_event', 'position_event', 'fill', 'attempt']) {
    db.exec(`DROP TRIGGER ${t}_no_update; DROP TRIGGER ${t}_no_delete;`);
  }
  edit(db);
  db.close();
};

const row = (db: DatabaseSync, sql: string, ...args: (string | bigint)[]) => {
  const r = db.prepare(sql).get(...args);
  if (r === undefined) throw new Error(`no row: ${sql}`);
  return r;
};

const failure = (report: ReplayReport) => {
  if (report.ok) throw new Error('expected the replay to fail');
  return report.failure;
};

describe('ledger replay: honest ledgers pass', () => {
  it('reproduces a ledger written from an ENG-1 engine run exactly', () => {
    const report = replayLedgerFile(engineLedger());
    expect(report).toMatchObject({ ok: true, purpose: 'backtest' });
    // The run walks several full entries and exits; an empty replay would prove nothing.
    expect(report.counts.intents).toBeGreaterThanOrEqual(6);
    expect(report.counts.positions).toBeGreaterThanOrEqual(3);
    expect(report.counts.events).toBeGreaterThan(30);
  });

  it('reproduces late landings, a cleared landing, a merged trigger and a restart', () => {
    const report = replayLedgerFile(bookLedger());
    expect(report).toMatchObject({ ok: true, purpose: 'paper', counts: { intents: 3, positions: 2 } });
  });

  it('works on live, paper and backtest files by their stamp', () => {
    for (const purpose of ['live', 'paper', 'backtest'] as const) {
      expect(replayLedgerFile(bookLedger(BOOK_EVENTS, purpose))).toMatchObject({ ok: true, purpose });
    }
  });

  it('gives the same output byte for byte, passing or failing', () => {
    const path = engineLedger();
    expect(canonical(replayLedgerFile(path))).toBe(canonical(replayLedgerFile(path)));
    tamper(path, (db) => db.prepare("DELETE FROM intent_event WHERE seq = (SELECT MIN(seq) FROM intent_event WHERE event = 'prepare')").run());
    const a = canonical(replayLedgerFile(path));
    expect(a).toBe(canonical(replayLedgerFile(path)));
    expect(a).toContain('"ok":false');
  });
});

describe('ledger replay: compaction', () => {
  it('gives the same report with and without moving ended intents out of the book, passing or failing', () => {
    const variants: [string, (db: DatabaseSync) => void][] = [
      ['honest', () => {}],
      ['deleted prepare', (db) => db.prepare("DELETE FROM intent_event WHERE seq = (SELECT MAX(seq) FROM intent_event WHERE event = 'prepare')").run()],
      ['repeated submit', (db) => {
        const r = row(db, "SELECT * FROM intent_event WHERE event = 'submit' ORDER BY seq LIMIT 1");
        db.prepare('INSERT INTO intent_event (intent_id, status, event, detail, ts) VALUES (?, ?, ?, ?, ?)')
          .run(r['intent_id'] as string, r['status'] as string, r['event'] as string, r['detail'] as string, r['ts'] as bigint);
      }],
    ];
    for (const [label, edit] of variants) {
      for (const path of [engineLedger('backtest', 1_500, `compact-${label}`), bookLedger()]) {
        tamper(path, edit);
        const compacted = replayLedgerFile(path);
        expect(canonical(compacted), label).toBe(canonical(replayLedgerFile(path, { compact: false })));
        expect(compacted.ok, label).toBe(label === 'honest');
      }
    }
  }, 60_000);

  it('refuses a key reused after its intent was moved out of the book', () => {
    // 70 ended entries fill the archive. The schema's UNIQUE key stops a reused key from being stored, so the
    // reused key is fed through a source that overrides one intent row: the reducer must still refuse it.
    const events = Array.from({ length: 70 }, (_, k) => {
      const n = k + 1;
      return [...entryToSubmitted(n, 1_000n).slice(0, 4), on(`e${n}` as IntentId, { type: 'cancel' })];
    }).flat();
    const reader = openLedgerReader(bookLedger(events));
    expect(replayLedger(reader).ok).toBe(true);
    const e1 = reader.intent('e1')!;
    const source: ReplaySource = {
      purpose: () => reader.purpose(), decisionModes: () => reader.decisionModes(), allPositions: () => reader.allPositions(),
      intentEvents: () => reader.intentEvents(), positionEvents: () => reader.positionEvents(), allReservations: () => reader.allReservations(),
      attempts: (id) => reader.attempts(id), fills: (id) => reader.fills(id), pendingOutbox: () => reader.pendingOutbox(),
      allIntents: () => reader.allIntents().map((r) => (r.intent.id === 'e70' ? { ...r, intent: { ...r.intent, key: e1.intent.key } } : r)),
    };
    for (const compact of [true, false]) {
      expect(failure(replayLedger(source, { compact }))).toMatchObject({ kind: 'illegal', intentId: 'e70', event: 'propose_entry', reason: 'idempotency key already used (from book)' });
    }
    reader.close();
  });
});

describe('ledger replay: tampering fails at the first differing row', () => {
  it('a modified event', () => {
    const path = engineLedger();
    let seq = 0n;
    tamper(path, (db) => {
      seq = row(db, "SELECT MIN(seq) AS s FROM intent_event WHERE event = 'send_accepted'")['s'] as bigint;
      db.prepare("UPDATE intent_event SET detail = replace(detail, '\"send_accepted\"', '\"send_timeout\"') WHERE seq = ?").run(seq);
    });
    const f = failure(replayLedgerFile(path));
    expect(f).toMatchObject({ kind: 'divergence', table: 'intent_event', seq, event: 'send_timeout' });
    expect(f.expected).toMatchObject({ status: 'unknown', event: 'send_timeout' });
    expect(f.actual).toMatchObject({ status: 'pending', event: 'send_accepted' });
    expect(f.intentKey).toMatch(/^entry:/);
  });

  it('a modified payload: the attempt in a sign event', () => {
    const path = engineLedger();
    tamper(path, (db) => {
      const s = row(db, "SELECT MIN(seq) AS s FROM intent_event WHERE event = 'sign'")['s'] as bigint;
      db.prepare("UPDATE intent_event SET detail = replace(detail, '\"1000000000\"', '\"999999999\"') WHERE seq = ?").run(s);
    });
    expect(failure(replayLedgerFile(path))).toMatchObject({ kind: 'divergence', table: 'attempt', reason: 'stored attempts differ from the replay' });
  });

  it('a reordered sequence', () => {
    const path = engineLedger();
    let first = 0n;
    tamper(path, (db) => {
      first = row(db, "SELECT MIN(seq) AS s FROM intent_event WHERE event = 'mark_eligible'")['s'] as bigint;
      const a = row(db, 'SELECT * FROM intent_event WHERE seq = ?', first);
      const b = row(db, 'SELECT * FROM intent_event WHERE seq = ?', first + 1n);
      const put = db.prepare('UPDATE intent_event SET intent_id = ?, status = ?, event = ?, detail = ? WHERE seq = ?');
      put.run(b['intent_id'] as string, b['status'] as string, b['event'] as string, b['detail'] as string, first);
      put.run(a['intent_id'] as string, a['status'] as string, a['event'] as string, a['detail'] as string, first + 1n);
    });
    const f = failure(replayLedgerFile(path));
    expect(f).toMatchObject({ kind: 'illegal', table: 'intent_event', seq: first, event: 'approve_risk' });
    expect(f.reason).toMatch(/risk approval needs an eligible intent \(from candidate\)/);
  });

  it('a deleted event', () => {
    const path = engineLedger();
    let gone = 0n;
    tamper(path, (db) => {
      gone = row(db, "SELECT MIN(seq) AS s FROM intent_event WHERE event = 'prepare'")['s'] as bigint;
      db.prepare('DELETE FROM intent_event WHERE seq = ?').run(gone);
    });
    const f = failure(replayLedgerFile(path));
    expect(f).toMatchObject({ kind: 'illegal', seq: gone + 1n, event: 'sign' });
    expect(f.reason).toMatch(/only a prepared intent can be signed/);
  });

  it('an inserted foreign event: a copy of another intent row appended', () => {
    const path = engineLedger();
    tamper(path, (db) => {
      const r = row(db, "SELECT * FROM intent_event WHERE event = 'submit' ORDER BY seq LIMIT 1");
      db.prepare('INSERT INTO intent_event (intent_id, status, event, detail, ts) VALUES (?, ?, ?, ?, ?)')
        .run(r['intent_id'] as string, r['status'] as string, r['event'] as string, r['detail'] as string, r['ts'] as bigint);
    });
    expect(failure(replayLedgerFile(path))).toMatchObject({ kind: 'illegal', event: 'submit', reason: expect.stringMatching(/only a signed intent can be submitted/) });
  });

  it('an inserted foreign event: a row naming another intent than its event', () => {
    const path = engineLedger();
    let seq = 0n;
    tamper(path, (db) => {
      seq = row(db, "SELECT MAX(seq) AS s FROM intent_event WHERE event = 'send_accepted'")['s'] as bigint;
      const other = row(db, 'SELECT intent_id FROM intent ORDER BY created_ts LIMIT 1')['intent_id'] as string;
      db.prepare('UPDATE intent_event SET intent_id = ? WHERE seq = ?').run(other, seq);
    });
    expect(failure(replayLedgerFile(path))).toMatchObject({ kind: 'divergence', seq, reason: 'the stored event does not write this intent' });
  });

  it('an inserted foreign position row', () => {
    const path = engineLedger();
    tamper(path, (db) => {
      const p = row(db, 'SELECT position_id FROM position ORDER BY created_ts LIMIT 1')['position_id'] as string;
      db.prepare("INSERT INTO position_event (position_id, status, quantity, cost, event, ts) VALUES (?, 'closed', '0', '0', 'exit_filled', 1)").run(p);
    });
    expect(failure(replayLedgerFile(path))).toMatchObject({ kind: 'divergence', table: 'position_event', reason: 'stored position row that no replayed event wrote' });
  });

  it('an orphan_cleared without a proof', () => {
    const honest = bookLedger();
    expect(replayLedgerFile(honest).ok).toBe(true);
    for (const forged of ['{"balances":"changed"}', 'null']) {
      const path = bookLedger();
      tamper(path, (db) => {
        const s = row(db, "SELECT seq FROM intent_event WHERE event = 'orphan_cleared'")['seq'] as bigint;
        db.prepare("UPDATE intent_event SET detail = json_set(detail, '$.book.proof', json(?)) WHERE seq = ?")
          .run(forged === 'null' ? 'null' : JSON.stringify({ ...JSON.parse(String(row(db, 'SELECT json_extract(detail, \'$.book.proof\') AS p FROM intent_event WHERE seq = ?', s)['p'])), ...JSON.parse(forged) }), s);
      });
      const f = failure(replayLedgerFile(path));
      expect(f).toMatchObject({ kind: forged === 'null' ? 'schema' : 'illegal', event: 'orphan_cleared', intentId: E1, intentKey: expect.stringMatching(/^entry:/) });
      expect(f.reason).toMatch(forged === 'null' ? /detail\.book\.proof: must be a plain object/ : /needs unchanged balances/);
    }
  });

  it('a fill amount changed by 1 lamport, in the fill table or in the stored event', () => {
    const table = engineLedger();
    tamper(table, (db) => db.prepare("UPDATE fill SET sol = CAST(CAST(sol AS INTEGER) + 1 AS TEXT) WHERE fill_id = (SELECT MIN(fill_id) FROM fill)").run());
    const f = failure(replayLedgerFile(table));
    expect(f).toMatchObject({ kind: 'divergence', table: 'fill' });
    const sol = (x: unknown) => (x as { sol: bigint }[])[0]!.sol;
    expect(sol(f.actual) - sol(f.expected)).toBe(1n);

    const event = engineLedger();
    tamper(event, (db) => {
      const s = row(db, "SELECT MIN(seq) AS s FROM intent_event WHERE event = 'reconcile'")['s'] as bigint;
      const cost = row(db, "SELECT json_extract(detail, '$.book.event.fills[0].sol.$bigint') AS c FROM intent_event WHERE seq = ?", s)['c'] as string;
      db.prepare("UPDATE intent_event SET detail = json_set(detail, '$.book.event.fills[0].sol.$bigint', ?) WHERE seq = ?").run(String(BigInt(cost) + 1n), s);
    });
    expect(failure(replayLedgerFile(event))).toMatchObject({ kind: 'divergence', table: 'position_event', reason: 'stored position state differs from the replay' });
  });
});

describe('ledger replay: stored event schema', () => {
  const edit = (path: string, sql: string) => tamper(path, (db) => {
    const s = row(db, "SELECT MIN(seq) AS s FROM intent_event WHERE event = 'reserve_exposure'")['s'] as bigint;
    db.prepare(`UPDATE intent_event SET detail = ${sql} WHERE seq = ?`).run(s);
  });

  it('every stored event carries version 1', () => {
    const db = new DatabaseSync(engineLedger(), { readOnly: true });
    const versions = db.prepare("SELECT DISTINCT json_extract(detail, '$.v') AS v FROM intent_event WHERE detail IS NOT NULL").all();
    db.close();
    expect(versions).toEqual([{ v: 1 }]);
  });

  for (const [label, sql, reason] of [
    ['an unknown version', "json_set(detail, '$.v', 2)", /detail\.v: unknown version 2/],
    ['no version', "json_remove(detail, '$.v')", /detail\.v: unknown version undefined/],
    ['an extra top-level field', "json_set(detail, '$.note', 'x')", /detail\.note: unknown field/],
    ['an extra field in the event', "json_set(detail, '$.book.event.reservation.extra', 1)", /detail\.book\.event\.reservation\.extra: unknown field/],
    ['a missing field', "json_remove(detail, '$.book.event.reservation.amount')", /reservation\.amount: missing/],
    ['an amount that is not a bigint', "json_set(detail, '$.book.event.reservation.amount', 16000000)", /reservation\.amount: must be a bigint >= 0/],
    ['a negative amount', "json_set(detail, '$.book.event.reservation.amount', json('{\"$bigint\":\"-1\"}'))", /reservation\.amount: must be a bigint >= 0/],
    ['a malformed id', "json_set(detail, '$.book.intentId', 'bad id!')", /detail\.book\.intentId: intent id must be/],
    ['an unknown event type', "json_set(detail, '$.book.event.type', 'teleport')", /detail\.book\.event\.type: must be one of/],
  ] as const) {
    it(`refuses ${label}`, () => {
      const path = engineLedger();
      edit(path, sql);
      const f = failure(replayLedgerFile(path));
      expect(f).toMatchObject({ kind: 'schema', table: 'intent_event', event: 'reserve_exposure' });
      expect(f.reason).toMatch(reason);
    });
  }

  it('refuses to encode an event off the schema', () => {
    const e = entryToSubmitted(1, 1_000n)[0]!;
    expect(encodeBookDetail(e)).toEqual({ v: 1, book: e });
    expect(() => encodeBookDetail({ ...e, extra: 1 } as unknown as BookEvent)).toThrow(/detail\.book\.extra: unknown field/);
    expect(() => encodeBookDetail(on(E1, { type: 'reject', reason: '' }))).toThrow(/reason: must be a non-empty string/);
  });
});

describe('ledger replay: read-only and stamped', () => {
  /**
   * The ledger file byte for byte, and every other file in its folder. A read-only connection to a WAL file
   * creates SQLite's empty `-wal` and its `-shm` lock index; those are locking files, not ledger data, so they are
   * listed by name and the `-wal` must hold no frames (size 0).
   */
  const fingerprint = (path: string) => {
    const dir = dirname(path);
    const db = `${statSync(path).mtimeMs} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    const others = readdirSync(dir).sort().filter((f) => join(dir, f) !== path)
      .map((f) => (f.endsWith('-shm') ? f : `${f} ${statSync(join(dir, f)).size}`));
    return { db, others };
  };
  const SIDECARS = ['ledger.db-shm', 'ledger.db-wal 0', 'ledger.db-writer.lock 0'];

  it('never writes: the file is unchanged byte for byte and no WAL frame is added', () => {
    const path = engineLedger();
    const before = fingerprint(path);
    expect(replayLedgerFile(path).ok).toBe(true);
    expect(fingerprint(path).db).toBe(before.db);
    expect(fingerprint(path).others).toEqual(SIDECARS);
    tamper(path, (db) => db.prepare("DELETE FROM intent_event WHERE seq = (SELECT MAX(seq) FROM intent_event)").run());
    const tampered = fingerprint(path);
    expect(replayLedgerFile(path).ok).toBe(false);
    expect(fingerprint(path).db).toBe(tampered.db);
    expect(fingerprint(path).others).toEqual(SIDECARS);
  });

  it('reads through a read-only connection: a write on it is refused', () => {
    const reader = openLedgerReader(engineLedger());
    expect(replayLedger(reader).ok).toBe(true);
    expect(() => connectionOf(reader).exec("INSERT INTO ledger_meta (key, value) VALUES ('x', 'y')")).toThrow(/readonly/);
    reader.close();
  });

  it('refuses a ledger whose decisions carry another stamp', () => {
    const path = bookLedger(BOOK_EVENTS, 'backtest');
    const ledger = openLedger(path, 'backtest');
    const snap = ledger.recordFeatureSnapshot({ mint: 'm', venue: 'pump-curve', quoteMint: 'q', decisionTs: 1, asOfSlot: 1n, maxReceiptTs: 1, featuresetVer: 'f', features: {} });
    ledger.recordDecision({ snapshotId: snap, decidedTs: 1, strategyVer: 's', action: 'reject', reasons: ['test'], mode: 'replay' });
    ledger.close();
    expect(replayLedgerFile(path).ok).toBe(true);
    const mixed = openLedger(path, 'backtest');
    mixed.recordDecision({ snapshotId: snap, decidedTs: 2, strategyVer: 's', action: 'reject', reasons: ['test'], mode: 'live' });
    mixed.close();
    expect(failure(replayLedgerFile(path))).toMatchObject({ kind: 'stamp', table: 'decision', reason: 'mixed stamps: a backtest ledger holds live decisions' });
  });
});

describe('ledger:replay command', () => {
  const CLI = new URL('../../scripts/ledger-replay.ts', import.meta.url).pathname;
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { encoding: 'utf8' });

  it('passes an honest ledger, fails a tampered one, and refuses files with mixed stamps', () => {
    const good = engineLedger('paper');
    const ok = cli(good);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^ok paper /);

    const bad = engineLedger('paper');
    tamper(bad, (db) => db.prepare("DELETE FROM intent_event WHERE seq = (SELECT MIN(seq) FROM intent_event WHERE event = 'prepare')").run());
    const fail = cli(bad);
    expect(fail.status).toBe(1);
    expect(fail.stdout).toMatch(/^FAIL paper /);
    expect(fail.stdout).toContain('"reason":"only a prepared intent can be signed (from exposure_reserved)"');

    const mixed = cli(good, engineLedger('backtest'));
    expect(mixed.status).toBe(2);
    expect(mixed.stderr).toMatch(/mixed stamps: paper, backtest/);
  });
});
