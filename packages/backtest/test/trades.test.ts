import { describe, expect, test } from 'vitest';
import { FILL_CONFIG } from '../../core/src/config/index.ts';
import { applyBookEvent, emptyBook, isIllegal, type Book, type BookEvent } from '../../core/src/lifecycle/index.ts';
import { attempt, CONFIG, entryIntent, entryToSubmitted, fill, on } from '../../core/test/fixtures.ts';
import type { RunResult } from '../src/run.ts';
import type { AttemptRecord } from '../src/sim/world.ts';
import { tradesOf } from '../src/trades.ts';

const apply = (events: readonly BookEvent[]): Book =>
  events.reduce((b, e) => {
    const r = applyBookEvent(b, e);
    if (isIllegal(r)) throw new Error(`${e.type}: ${r.reason}`);
    return r.state;
  }, emptyBook(CONFIG));

describe('trades with several positions per entry intent (LEDGER-1b)', () => {
  test('a late buy landing becomes its own trade with its own fill and fee; the ended main position adds nothing', () => {
    const i = entryIntent(1);
    const a = attempt(i.id, 1, 100n);
    const late = fill(i.id, 1, 5_000n, 16_000_000n);
    const book = apply([
      ...entryToSubmitted(1, 100n),
      on(i.id, { type: 'send_accepted' }),
      on(i.id, { type: 'status', signature: a.signature, result: 'not_found', commitment: null, blockHeight: 101n, searchedHistory: true }),
      on(i.id, { type: 'reconcile', fills: [], blockHeight: 101n }),
      on(i.id, { type: 'abandon' }),
      // The attempt believed dead lands after all: the book opens `<position>.o1` for it.
      on(i.id, { type: 'status', signature: a.signature, result: 'succeeded', commitment: 'confirmed', blockHeight: 102n, searchedHistory: false }),
      { type: 'orphan_fill', fill: late },
    ]);
    const ids = Object.keys(book.positions).sort();
    expect(ids).toEqual([i.positionId, `${i.positionId}.o1`]);
    const rec: AttemptRecord = {
      intentId: i.id, signature: a.signature, purpose: 'entry', mint: i.mint, priorityFee: 20_000n, lastValidBlockHeight: 100n, outcome: 'filled',
      reason: 'filled', landedSlot: 1n, landedAt: 1_000, fee: 30_000n, fill: late, costs: null,
    };
    const run = { attempts: [rec], book, scenario: 'base', symbols: new Map(), endValue: () => 7_000_000n, endedAt: 9_000 } as unknown as RunResult;
    const { trades, stray } = tradesOf(run, FILL_CONFIG);
    expect(stray).toEqual([]);
    expect(trades.map((t) => t.id)).toEqual([`${i.positionId}.o1`]);
    const t = trades[0]!;
    expect([t.entrySol, t.tokens, t.openedAt, t.exitReason, t.exitSol]).toEqual([16_000_000n, 5_000n, 1_000, 'blocked', 7_000_000n]);
    expect(t.networkBase + t.priority + t.tip).toBe(30_000n);
  });
});

describe('one entry, a filled position and a late one', () => {
  test('each attempt’s fee is counted once, and the token account rent once', () => {
    const i = entryIntent(1);
    const a1 = attempt(i.id, 1, 100n);
    const a2 = attempt(i.id, 2, 300n);
    const f2 = fill(i.id, 2, 7_000n, 16_000_000n);
    const f1 = fill(i.id, 1, 6_000n, 16_000_000n);
    const book = apply([
      ...entryToSubmitted(1, 100n),
      on(i.id, { type: 'send_accepted' }),
      on(i.id, { type: 'status', signature: a1.signature, result: 'not_found', commitment: null, blockHeight: 101n, searchedHistory: true }),
      on(i.id, { type: 'reconcile', fills: [], blockHeight: 101n }),
      on(i.id, { type: 'sign_replacement', attempt: a2, blockHeight: 101n }),
      on(i.id, { type: 'submit' }),
      on(i.id, { type: 'send_accepted' }),
      on(i.id, { type: 'status', signature: a2.signature, result: 'succeeded', commitment: 'confirmed', blockHeight: 120n, searchedHistory: false }),
      on(i.id, { type: 'reconcile', fills: [f2], blockHeight: 121n }),
      // The first attempt, believed expired, lands after all.
      on(i.id, { type: 'status', signature: a1.signature, result: 'succeeded', commitment: 'confirmed', blockHeight: 122n, searchedHistory: false }),
      { type: 'orphan_fill', fill: f1 },
    ]);
    expect(Object.keys(book.positions).sort()).toEqual([i.positionId, `${i.positionId}.o2`]);
    const rec = (sig: typeof a1.signature, f: typeof f1, fee: bigint, at: number): AttemptRecord => ({
      intentId: i.id, signature: sig, purpose: 'entry', mint: i.mint, priorityFee: 20_000n, lastValidBlockHeight: 100n, outcome: 'filled',
      reason: 'filled', landedSlot: 1n, landedAt: at, fee, fill: f, costs: null,
    });
    const run = { attempts: [rec(a1.signature, f1, 30_000n, 2_000), rec(a2.signature, f2, 30_000n, 1_000)], book, scenario: 'base', symbols: new Map(), endValue: () => 0n, endedAt: 9_000 } as unknown as RunResult;
    const { trades } = tradesOf(run, FILL_CONFIG);
    expect(trades.map((t) => [t.id, t.tokens]).sort()).toEqual([[i.positionId, 7_000n], [`${i.positionId}.o2`, 6_000n]]);
    const fees = trades.reduce((s, t) => s + t.networkBase + t.priority + t.tip, 0n);
    // Two attempts, each base 5,000 + priority 20,000 + tip 5,000, counted once each.
    expect(fees).toBe(60_000n);
    expect(trades.reduce((s, t) => s + t.rentPaid, 0n)).toBe(FILL_CONFIG.network.tokenAccountRent);
  });
});

describe('a fill without its attempt', () => {
  test('is refused with a clear error instead of a guessed open time', () => {
    const i = entryIntent(1);
    const a = attempt(i.id, 1, 100n);
    const book = apply([
      ...entryToSubmitted(1, 100n),
      on(i.id, { type: 'send_accepted' }),
      on(i.id, { type: 'status', signature: a.signature, result: 'succeeded', commitment: 'confirmed', blockHeight: 10n, searchedHistory: false }),
      on(i.id, { type: 'reconcile', fills: [fill(i.id, 1, 5_000n)], blockHeight: 11n }),
    ]);
    const run = { attempts: [], book, scenario: 'base', symbols: new Map(), endValue: () => 0n, endedAt: 9_000 } as unknown as RunResult;
    expect(() => tradesOf(run, FILL_CONFIG)).toThrow(/has no landed attempt record/);
  });
});
