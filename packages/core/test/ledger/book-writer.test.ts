// Ledger.recordBookEvent: the one writer of book events (BT-1 and the worker), in the format the replay check reads.
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openLedger, LedgerError } from '../../src/ledger/index.ts';
import { replayLedgerFile } from '../../src/ledger/replay/index.ts';
import { emptyBook, type Book } from '../../src/lifecycle/index.ts';
import { lamports } from '../../src/units/index.ts';
import { attempt, CONFIG, entryIntent, entryToSubmitted, fill, on } from '../fixtures.ts';
import { tempPath } from './helpers.ts';

const limits = { maxHeld: lamports(10n ** 15n), maxCount: 1_000 };
const rows = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const n = (t: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n']);
  const out = { intents: n('intent'), events: n('intent_event'), attempts: n('attempt'), reservations: n('reservation'), positions: n('position'), integrity: db.prepare('PRAGMA integrity_check').get()?.['integrity_check'] };
  db.close();
  return out;
};

describe('Ledger.recordBookEvent', () => {
  it('writes a full entry, fill and exit that the replay check accepts', () => {
    const path = tempPath();
    const ledger = openLedger(path, 'backtest');
    let book: Book = emptyBook(CONFIG);
    const id = entryIntent(1).id;
    const events = [
      ...entryToSubmitted(1, 500n),
      on(id, { type: 'send_accepted' }),
      on(id, { type: 'status', signature: attempt(id, 1, 500n).signature, result: 'succeeded', commitment: 'confirmed', blockHeight: 10n, searchedHistory: false }),
      on(id, { type: 'reconcile', fills: [fill(id, 1, 1_000n)], blockHeight: 11n }),
    ];
    events.forEach((e, k) => { book = ledger.recordBookEvent(book, e, { ts: k, limits }).book; });
    ledger.close();
    expect(replayLedgerFile(path)).toMatchObject({ ok: true, purpose: 'backtest' });
    expect(rows(path)).toMatchObject({ intents: 1, attempts: 1, reservations: 1, positions: 1 });
  });

  it('refuses an event the reducer refuses, and writes nothing', () => {
    const path = tempPath();
    const ledger = openLedger(path, 'backtest');
    const book = emptyBook(CONFIG);
    const before = rows(path);
    let caught: unknown = null;
    try {
      ledger.recordBookEvent(book, on(entryIntent(1).id, { type: 'mark_eligible' }), { ts: 1, limits });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LedgerError);
    expect((caught as LedgerError).code).toBe('reducer_refused');
    ledger.close();
    expect(rows(path)).toEqual(before);
  });

  it('a failure inside the write leaves none of the rows of that event', () => {
    const path = tempPath();
    const ledger = openLedger(path, 'backtest');
    let book: Book = emptyBook(CONFIG);
    const [propose, ...rest] = entryToSubmitted(1, 500n);
    book = ledger.recordBookEvent(book, propose!, { ts: 0, limits }).book;
    const reserve = rest.findIndex((e) => e.type === 'intent' && e.event.type === 'reserve_exposure');
    for (const e of rest.slice(0, reserve)) book = ledger.recordBookEvent(book, e, { ts: 1, limits }).book;
    const before = rows(path);
    // The reservation is refused by the limits after the intent row is written: the whole event rolls back.
    let caught: unknown = null;
    try {
      ledger.recordBookEvent(book, rest[reserve]!, { ts: 2, limits: { maxHeld: lamports(1n), maxCount: 1 } });
    } catch (err) {
      caught = err;
    }
    // A write failure is not a reducer refusal: callers must not count it as one.
    expect((caught as LedgerError).code).toBeNull();
    ledger.close();
    expect(rows(path)).toEqual(before);
  });

  it('a process killed mid-transaction leaves no partial rows', async () => {
    const path = tempPath();
    const p = spawn(process.execPath, ['--no-warnings', new URL('./book-child.ts', import.meta.url).pathname, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      let out = '';
      p.stdout.on('data', (d: Buffer) => { out += d.toString(); if (out.includes('ready')) resolve(); });
      p.on('exit', (c) => reject(new Error(`child exited ${c}`)));
    });
    p.kill('SIGKILL');
    await new Promise((r) => p.on('exit', r));
    const ledger = openLedger(path, 'backtest');
    ledger.close();
    // Only the committed proposal remains: its intent and its created row.
    expect(rows(path)).toEqual({ intents: 1, events: 1, attempts: 0, reservations: 0, positions: 0, integrity: 'ok' });
    expect(replayLedgerFile(path)).toMatchObject({ ok: true });
  }, 20_000);
});
