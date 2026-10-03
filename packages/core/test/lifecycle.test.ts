import { describe, expect, test } from 'vitest';
import { raw } from '../src/units/index.ts';
import { intentId, positionId, type IntentId } from '../src/domain/index.ts';
import { applyBookEvent, canOpenNewEntry, emptyBook, isIllegal, liveIntents, type Book, type BookEvent, type Effect } from '../src/lifecycle/index.ts';
import { attempt, entryIntent, entryToSubmitted, fill, on, quote, run, sig, SPEND, CONFIG } from './fixtures.ts';

const E1 = intentId('e1');
const P1 = positionId('p1');
const X1 = intentId('x1');
const X2 = intentId('x2');

const refused = (book: Book, e: BookEvent): string => {
  const r = applyBookEvent(book, e);
  if (!isIllegal(r)) throw new Error(`expected ${e.type} to be refused`);
  return r.reason;
};

const broadcasts = (effects: readonly Effect[]) => effects.filter((f) => f.type === 'broadcast');

/** An open position p1 holding `tokens`, from a confirmed entry e1. */
const openPosition = (tokens: bigint): Book =>
  run(emptyBook(CONFIG), [
    ...entryToSubmitted(1, 1_000n),
    on(E1, { type: 'send_accepted' }),
    on(E1, { type: 'status', signature: sig(1), result: 'succeeded', commitment: 'confirmed', blockHeight: 900n, searchedHistory: false }),
    on(E1, { type: 'reconcile', fills: [fill(E1, 1, tokens)], blockHeight: 1_001n }),
  ]).book;

describe('entry lifecycle', () => {
  test('timeout after a buy landed: reconciliation finds the fill and no second buy is produced', () => {
    const log: Effect[] = [];
    let { book } = run(emptyBook(CONFIG), [...entryToSubmitted(1, 1_000n), on(E1, { type: 'send_timeout' })], log);
    expect(book.intents[E1]!.status).toBe('unknown');

    // Nothing can start a second buy while the first is unknown.
    expect(refused(book, { type: 'propose_entry', intent: entryIntent(2) })).toMatch(/entry blocked/);
    expect(refused(book, on(E1, { type: 'sign_replacement', attempt: attempt(E1, 2, 2_000n), blockHeight: 1_001n }))).toMatch(/reconciled/);
    expect(refused(book, on(E1, { type: 'submit' }))).toMatch(/signed/);

    // Rebroadcast sends the same bytes while the blockhash is valid.
    ({ book } = run(book, [{ type: 'tick', blockHeight: 950n }], log));
    ({ book } = run(book, [
      on(E1, { type: 'status', signature: sig(1), result: 'succeeded', commitment: 'confirmed', blockHeight: 960n, searchedHistory: false }),
      on(E1, { type: 'reconcile', fills: [fill(E1, 1, 5_000n)], blockHeight: 1_001n }),
    ], log));

    expect(book.intents[E1]!.status).toBe('reconciled');
    expect(book.positions[P1]).toMatchObject({ status: 'open', quantity: 5_000n });
    expect(book.reserved).toBe(0n);
    const sent = broadcasts(log);
    expect(sent.length).toBe(2);
    expect(new Set(sent.map((b) => b.type === 'broadcast' && `${b.signature}|${b.signedBytesRef}`))).toEqual(new Set([`${sig(1)}|bytes-1`]));
    expect(log.filter((f) => f.type === 'keep_reservation')).toHaveLength(1);
  });

  test('cancel after broadcast does not mark the trade cancelled; it stays unknown until reconciled', () => {
    const base = run(emptyBook(CONFIG), [...entryToSubmitted(1, 1_000n), on(E1, { type: 'send_timeout' })]).book;
    const r = applyBookEvent(base, on(E1, { type: 'cancel' }));
    if (isIllegal(r)) throw new Error(r.reason);
    expect(r.state.intents[E1]).toMatchObject({ status: 'unknown', cancelRequested: true });
    expect(r.effects).toContainEqual({ type: 'alert', level: 'warn', code: 'cancel_after_broadcast', subject: E1 });
    expect(r.state.reserved).toBe(SPEND); // still at risk

    // It landed after all: the trade is a fill, not a cancellation.
    const landed = run(r.state, [
      on(E1, { type: 'status', signature: sig(1), result: 'succeeded', commitment: 'confirmed', blockHeight: 900n, searchedHistory: false }),
      on(E1, { type: 'reconcile', fills: [fill(E1, 1, 7n)], blockHeight: 1_001n }),
    ]).book;
    expect(landed.intents[E1]!.status).toBe('reconciled');
    expect(landed.positions[P1]!.status).toBe('open');

    // It expired: only now does it end as cancelled, and the reservation is released.
    const expired = run(r.state, [
      on(E1, { type: 'status', signature: sig(1), result: 'not_found', commitment: null, blockHeight: 1_001n, searchedHistory: true }),
      on(E1, { type: 'reconcile', fills: [], blockHeight: 1_001n }),
    ]).book;
    expect(expired.intents[E1]!.status).toBe('cancelled');
    expect(expired.reserved).toBe(0n);
    expect(expired.positions[P1]!.status).toBe('closed');
  });

  test('cancel before broadcast stops the intent and releases the reservation', () => {
    const events = entryToSubmitted(1, 1_000n).slice(0, -1);
    const { book, effects } = run(emptyBook(CONFIG), [...events, on(E1, { type: 'cancel' })]);
    expect(book.intents[E1]!.status).toBe('cancelled');
    expect(book.reserved).toBe(0n);
    expect(broadcasts(effects)).toHaveLength(0);
    expect(book.positions[P1]).toBeUndefined();
  });

  test('restart with a pending transaction: entries blocked until reconciled', () => {
    const pending = run(emptyBook(CONFIG), [...entryToSubmitted(1, 1_000n), on(E1, { type: 'send_accepted' })]).book;
    const { book, effects } = run(pending, [{ type: 'restart' }]);
    expect(book.intents[E1]!.status).toBe('unknown');
    expect(book.recovering).toBe(true);
    expect(effects).toContainEqual({ type: 'check_status', intentId: E1, signatures: [sig(1)], searchHistory: true });
    expect(effects).not.toContainEqual({ type: 'reconcile_balances', intentId: E1 });
    const gate = canOpenNewEntry(book);
    expect(gate.ok).toBe(false);
    expect(!gate.ok && gate.reasons).toEqual(expect.arrayContaining(['recovering', 'unresolved_intent']));
    expect(refused(book, { type: 'propose_entry', intent: entryIntent(2) })).toMatch(/recovering/);

    const done = run(book, [
      on(E1, { type: 'status', signature: sig(1), result: 'not_found', commitment: null, blockHeight: 1_001n, searchedHistory: true }),
      on(E1, { type: 'reconcile', fills: [], blockHeight: 1_001n }),
    ]).book;
    expect(done.recovering).toBe(false);
    expect(canOpenNewEntry(done).ok).toBe(false); // the entry is still live until abandoned or replaced
    const abandoned = run(done, [on(E1, { type: 'abandon' })]).book;
    expect(abandoned.reserved).toBe(0n);
    expect(canOpenNewEntry(abandoned)).toEqual({ ok: true });
  });

  test('restart while signed: the bytes are never sent, only waited out', () => {
    const signed = run(emptyBook(CONFIG), entryToSubmitted(1, 1_000n).slice(0, -1)).book;
    const { book } = run(signed, [{ type: 'restart' }]);
    expect(book.intents[E1]).toMatchObject({ status: 'unknown', rebroadcast: false });
    expect(book.positions[P1]!.status).toBe('opening'); // supervised: it may have landed
    const r = applyBookEvent(book, { type: 'tick', blockHeight: 500n });
    expect(!isIllegal(r) && broadcasts(r.effects)).toEqual([]);
    const late = applyBookEvent(book, { type: 'tick', blockHeight: 1_001n });
    expect(!isIllegal(late) && late.effects).toEqual([{ type: 'check_status', intentId: E1, signatures: [sig(1)], searchHistory: true }]);
  });

  test('expired blockhash: replacement only after expiry plus reconciliation', () => {
    const log: Effect[] = [];
    let { book } = run(emptyBook(CONFIG), [...entryToSubmitted(1, 1_000n), on(E1, { type: 'send_accepted' })], log);
    const replace = on(E1, { type: 'sign_replacement', attempt: attempt(E1, 2, 2_000n), blockHeight: 1_001n });
    expect(refused(book, replace)).toMatch(/reconciled/);

    // Past the last valid height a tick asks for a history search instead of rebroadcasting.
    const tick = applyBookEvent(book, { type: 'tick', blockHeight: 1_001n });
    expect(!isIllegal(tick) && tick.effects).toEqual([{ type: 'check_status', intentId: E1, signatures: [sig(1)], searchHistory: true }]);

    // Not found without a history search, or before expiry, proves nothing.
    ({ book } = run(book, [
      on(E1, { type: 'status', signature: sig(1), result: 'not_found', commitment: null, blockHeight: 1_001n, searchedHistory: false }),
      on(E1, { type: 'status', signature: sig(1), result: 'not_found', commitment: null, blockHeight: 1_000n, searchedHistory: true }),
    ], log));
    expect(book.intents[E1]!.status).toBe('pending');

    ({ book } = run(book, [on(E1, { type: 'status', signature: sig(1), result: 'not_found', commitment: null, blockHeight: 1_001n, searchedHistory: true })], log));
    expect(book.intents[E1]!.status).toBe('expired_unfilled');
    expect(refused(book, replace)).toMatch(/reconciled/); // expiry alone is not enough

    ({ book } = run(book, [on(E1, { type: 'reconcile', fills: [], blockHeight: 1_001n })], log));
    expect(book.reserved).toBe(SPEND); // held across the replacement
    expect(refused(book, on(E1, { type: 'sign_replacement', attempt: attempt(E1, 1, 2_000n), blockHeight: 1_001n }))).toMatch(/known signature/);

    ({ book } = run(book, [replace, on(E1, { type: 'submit' })], log));
    expect(book.intents[E1]!.status).toBe('submitted');
    expect(broadcasts(log).map((b) => b.type === 'broadcast' && b.signature)).toEqual([sig(1), sig(2)]);
  });

  test('a late landing after an unfilled reconciliation is booked as a fill, never replaced', () => {
    const resolved = run(emptyBook(CONFIG), [
      ...entryToSubmitted(1, 1_000n),
      on(E1, { type: 'status', signature: sig(1), result: 'not_found', commitment: null, blockHeight: 1_001n, searchedHistory: true }),
      on(E1, { type: 'reconcile', fills: [], blockHeight: 1_001n }),
      on(E1, { type: 'sign_replacement', attempt: attempt(E1, 2, 2_000n), blockHeight: 1_001n }),
    ]).book;
    const { book, effects } = run(resolved, [
      on(E1, { type: 'status', signature: sig(1), result: 'succeeded', commitment: 'confirmed', blockHeight: 1_002n, searchedHistory: true }),
    ]);
    expect(book.intents[E1]!.status).toBe('confirmed_fill');
    expect(effects).toContainEqual({ type: 'alert', level: 'critical', code: 'late_landing', subject: E1 });
    expect(refused(book, on(E1, { type: 'submit' }))).toMatch(/signed/);
    // The replacement was never sent, but it is signed and valid until 2,000: the books stay open until then.
    expect(refused(book, on(E1, { type: 'reconcile', fills: [fill(E1, 1, 9n)], blockHeight: 1_500n }))).toMatch(/can still land/);
    const filled = run(book, [on(E1, { type: 'reconcile', fills: [fill(E1, 1, 9n)], blockHeight: 2_001n })]).book;
    expect(filled.positions[P1]).toMatchObject({ status: 'open', quantity: 9n });
  });

  test('review probe: a non-final failed read never allows a replacement, so no second buy', () => {
    const pending = run(emptyBook(CONFIG), [...entryToSubmitted(1, 1_000n), on(E1, { type: 'send_accepted' })]).book;
    // A failed read at processed or confirmed can come from a fork that is later dropped.
    for (const commitment of ['processed', 'confirmed'] as const) {
      const { book } = run(pending, [on(E1, { type: 'status', signature: sig(1), result: 'failed', commitment, blockHeight: 500n, searchedHistory: false })]);
      expect(book.intents[E1]!.status).toBe('pending');
      expect(refused(book, on(E1, { type: 'reconcile', fills: [], blockHeight: 500n }))).toMatch(/reconcile follows/);
      expect(refused(book, on(E1, { type: 'sign_replacement', attempt: attempt(E1, 2, 1_100n), blockHeight: 500n }))).toMatch(/reconciled/);
    }
    // The original lands; the intent books exactly one buy.
    const { book, effects } = run(pending, [
      on(E1, { type: 'status', signature: sig(1), result: 'failed', commitment: 'processed', blockHeight: 500n, searchedHistory: false }),
      on(E1, { type: 'status', signature: sig(1), result: 'succeeded', commitment: 'confirmed', blockHeight: 600n, searchedHistory: false }),
      on(E1, { type: 'reconcile', fills: [fill(E1, 1, 5_000n)], blockHeight: 600n }),
    ]);
    expect(book.positions[P1]).toMatchObject({ status: 'open', quantity: 5_000n });
    expect(broadcasts(effects)).toHaveLength(0);
  });

  test('a finalized failure is terminal: replacement allowed once balances show nothing', () => {
    const { book } = run(emptyBook(CONFIG), [
      ...entryToSubmitted(1, 1_000n),
      on(E1, { type: 'status', signature: sig(1), result: 'failed', commitment: 'finalized', blockHeight: 500n, searchedHistory: false }),
      on(E1, { type: 'reconcile', fills: [], blockHeight: 500n }),
      on(E1, { type: 'sign_replacement', attempt: attempt(E1, 2, 1_100n), blockHeight: 500n }),
    ]);
    expect(book.intents[E1]).toMatchObject({ status: 'signed', failedSignatures: [sig(1)] });
  });

  test('an earlier attempt landing while a replacement is in flight keeps the books open until it is dead', () => {
    const inFlight = run(emptyBook(CONFIG), [
      ...entryToSubmitted(1, 1_000n),
      on(E1, { type: 'status', signature: sig(1), result: 'not_found', commitment: null, blockHeight: 1_001n, searchedHistory: true }),
      on(E1, { type: 'reconcile', fills: [], blockHeight: 1_001n }),
      on(E1, { type: 'sign_replacement', attempt: attempt(E1, 2, 2_000n), blockHeight: 1_001n }),
      on(E1, { type: 'submit' }),
    ]).book;
    // A status about the old signature cannot expire the new one.
    const stale = run(inFlight, [on(E1, { type: 'status', signature: sig(1), result: 'not_found', commitment: null, blockHeight: 2_001n, searchedHistory: true })]).book;
    expect(stale.intents[E1]!.status).toBe('submitted');

    const { book, effects } = run(inFlight, [on(E1, { type: 'status', signature: sig(1), result: 'succeeded', commitment: 'confirmed', blockHeight: 1_002n, searchedHistory: false })]);
    expect(book.intents[E1]).toMatchObject({ status: 'confirmed_fill', rebroadcast: false });
    expect(effects).toContainEqual({ type: 'alert', level: 'critical', code: 'late_landing', subject: E1 });
    const tick = applyBookEvent(book, { type: 'tick', blockHeight: 1_500n });
    expect(!isIllegal(tick) && broadcasts(tick.effects)).toEqual([]);
    expect(refused(book, on(E1, { type: 'reconcile', fills: [fill(E1, 1, 5n)], blockHeight: 1_500n }))).toMatch(/can still land/);

    // Both landed: both are booked, with an alert.
    const both = run(book, [on(E1, { type: 'reconcile', fills: [fill(E1, 1, 5n), fill(E1, 2, 6n)], blockHeight: 2_001n })]);
    expect(both.book.positions[P1]).toMatchObject({ status: 'open', quantity: 11n, cost: SPEND * 2n });
    expect(both.effects).toContainEqual({ type: 'alert', level: 'critical', code: 'double_fill', subject: E1 });

    // A landing reported after the books closed is never silently ignored.
    const closed = run(book, [on(E1, { type: 'reconcile', fills: [fill(E1, 1, 5n)], blockHeight: 2_001n })]).book;
    const late = applyBookEvent(closed, on(E1, { type: 'status', signature: sig(2), result: 'succeeded', commitment: 'finalized', blockHeight: 2_002n, searchedHistory: true }));
    expect(!isIllegal(late) && late.effects).toEqual([{ type: 'alert', level: 'critical', code: 'unbooked_landing', subject: E1 }]);
  });

  test('an RPC success is acceptance, not a fill', () => {
    const { book } = run(emptyBook(CONFIG), [...entryToSubmitted(1, 1_000n), on(E1, { type: 'send_accepted' })]);
    expect(book.intents[E1]).toMatchObject({ status: 'pending', fills: [] });
    expect(book.positions[P1]).toMatchObject({ status: 'opening', quantity: 0n });
    expect(refused(book, on(E1, { type: 'reconcile', fills: [fill(E1, 1, 5n)], blockHeight: 1_001n }))).toMatch(/reconcile follows/);
  });

  test('a confirmed signature with no balance change is refused, not booked as empty', () => {
    const { book } = run(emptyBook(CONFIG), [
      ...entryToSubmitted(1, 1_000n),
      on(E1, { type: 'status', signature: sig(1), result: 'succeeded', commitment: 'confirmed', blockHeight: 10n, searchedHistory: false }),
    ]);
    expect(refused(book, on(E1, { type: 'reconcile', fills: [], blockHeight: 1_001n }))).toMatch(/no change/);
  });
});

const sellQuote = { ...quote, inAmount: 1_000n, quotedOut: SPEND, minOut: 1n };

/** Exit events after a trigger, up to a confirmed signature. */
const exitToConfirmed = (id: IntentId, n: number): BookEvent[] => [
  on(id, { type: 'prepare', quote: sellQuote }),
  on(id, { type: 'sign', attempt: attempt(id, n, 2_000n) }),
  on(id, { type: 'submit' }),
  on(id, { type: 'send_accepted' }),
  on(id, { type: 'status', signature: sig(n), result: 'succeeded', commitment: 'confirmed', blockHeight: 1_500n, searchedHistory: false }),
];

describe('exits', () => {
  test('stop and take-profit trigger in the same tick: one exit intent, quantity never oversold', () => {
    let { book } = run(openPosition(1_000n), [
      { type: 'trigger_exit', positionId: P1, reasons: ['stop', 'take_profit'], intentId: X1 },
      // The same rule set evaluated again in the tick, or a second rule firing separately: no second intent.
      { type: 'trigger_exit', positionId: P1, reasons: ['take_profit'], intentId: X2 },
    ]);
    const exits = liveIntents(book).filter((i) => i.intent.purpose === 'exit');
    expect(exits).toHaveLength(1);
    expect(book.intents[X2]).toBeUndefined();
    expect(exits[0]!.intent).toMatchObject({ id: X1, quantity: 1_000n, key: 'exit:p1:1' });
    expect(book.positions[P1]!.exitOwner).toEqual({ intentId: X1, quantity: 1_000n, reasons: ['stop', 'take_profit'] });

    ({ book } = run(book, exitToConfirmed(X1, 11)));
    expect(book.positions[P1]!.status).toBe('exit_pending');
    expect(refused(book, on(X1, { type: 'reconcile', fills: [fill(X1, 11, 1_001n)], blockHeight: 1_001n }))).toMatch(/more than the exit quantity/);

    ({ book } = run(book, [on(X1, { type: 'reconcile', fills: [fill(X1, 11, 1_000n)], blockHeight: 1_001n })]));
    expect(book.positions[P1]).toMatchObject({ status: 'closed', quantity: 0n, sold: 1_000n, exitOwner: null });
    expect(refused(book, { type: 'trigger_exit', positionId: P1, reasons: ['stop'], intentId: X2 })).toMatch(/nothing to exit/);
  });

  test('a partial exit leaves the rest open for the next exit owner', () => {
    let { book } = run(openPosition(1_000n), [
      { type: 'trigger_exit', positionId: P1, reasons: ['take_profit'], intentId: X1, quantity: raw(400n) },
      ...exitToConfirmed(X1, 11),
      on(X1, { type: 'reconcile', fills: [fill(X1, 11, 400n)], blockHeight: 1_001n }),
    ]);
    expect(book.positions[P1]).toMatchObject({ status: 'open', quantity: 600n, sold: 400n });
    ({ book } = run(book, [{ type: 'trigger_exit', positionId: P1, reasons: ['stop'], intentId: X2, quantity: raw(5_000n) }]));
    expect(book.intents[X2]!.intent).toMatchObject({ quantity: 600n, key: 'exit:p1:2' });
  });

  test('exit blocked when liquidity is gone: state exit_blocked, no fabricated fill', () => {
    const triggered = run(openPosition(1_000n), [{ type: 'trigger_exit', positionId: P1, reasons: ['stop'], intentId: X1 }]).book;

    // While a sell may still land, blocked would be a lie.
    const inFlight = run(triggered, exitToConfirmed(X1, 11).slice(0, 3)).book;
    expect(refused(inFlight, { type: 'exit_blocked', positionId: P1, reason: 'no liquidity' })).toMatch(/may still land/);

    const { book, effects } = run(triggered, [{ type: 'exit_blocked', positionId: P1, reason: 'no liquidity' }]);
    expect(book.positions[P1]).toMatchObject({ status: 'exit_blocked', quantity: 1_000n, sold: 0n, exitOwner: null, blockedReason: 'no liquidity' });
    expect(book.intents[X1]).toMatchObject({ status: 'cancelled', fills: [] });
    expect(effects).toContainEqual({ type: 'alert', level: 'critical', code: 'exit_blocked', subject: P1 });
    expect(effects.some((f) => f.type === 'broadcast')).toBe(false);

    // Escalation: a later attempt takes a new exit owner.
    const retry = run(book, [{ type: 'trigger_exit', positionId: P1, reasons: ['emergency'], intentId: X2 }]).book;
    expect(retry.positions[P1]!.status).toBe('exit_requested');
    expect(retry.intents[X2]!.intent.key).toBe('exit:p1:2');
  });

  test('a daily-loss pause blocks entries but never protective exits', () => {
    const paused = run(openPosition(1_000n), [{ type: 'pause_entries', reason: 'daily_loss' }]).book;
    expect(canOpenNewEntry(paused)).toEqual({ ok: false, reasons: ['paused', 'position_limit'] });
    expect(refused(paused, { type: 'propose_entry', intent: entryIntent(2) })).toMatch(/paused/);

    const { book } = run(paused, [
      { type: 'trigger_exit', positionId: P1, reasons: ['stop'], intentId: X1 },
      ...exitToConfirmed(X1, 11),
      on(X1, { type: 'reconcile', fills: [fill(X1, 11, 1_000n)], blockHeight: 1_001n }),
    ]);
    expect(book.positions[P1]!.status).toBe('closed');
    expect(canOpenNewEntry(book)).toEqual({ ok: false, reasons: ['paused'] });
    expect(canOpenNewEntry(run(book, [{ type: 'resume_entries', reason: 'daily_loss' }]).book)).toEqual({ ok: true });
  });

  test('the open-position limit is configuration; one live entry at a time regardless', () => {
    expect(() => emptyBook({ maxOpenPositions: 0 })).toThrow(RangeError);
    const two = { ...openPosition(1_000n), config: { maxOpenPositions: 2 } };
    expect(canOpenNewEntry(two)).toEqual({ ok: true });
    const second = run(two, [{ type: 'propose_entry', intent: entryIntent(2) }]).book;
    expect(canOpenNewEntry(second)).toEqual({ ok: false, reasons: ['entry_in_progress'] });
    expect(refused(second, { type: 'propose_entry', intent: entryIntent(3) })).toMatch(/entry_in_progress/);
    expect(canOpenNewEntry(openPosition(1_000n))).toEqual({ ok: false, reasons: ['position_limit'] });
  });

  test('a pause stops an entry that has not been sent', () => {
    const signed = run(emptyBook(CONFIG), [...entryToSubmitted(1, 1_000n).slice(0, -1), { type: 'pause_entries', reason: 'daily_loss' }]).book;
    expect(refused(signed, on(E1, { type: 'submit' }))).toMatch(/paused/);
    const cancelled = run(signed, [on(E1, { type: 'cancel' })]).book;
    expect(cancelled.reserved).toBe(0n);
  });
});
