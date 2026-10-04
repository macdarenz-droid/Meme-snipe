import { describe, expect, test } from 'vitest';
import { FILL_CONFIG } from '../../core/src/config/index.ts';
import { entryKey, intentId, positionId, type EntryIntent } from '../../core/src/domain/index.ts';
import { applyBookEvent, emptyBook, isIllegal, type Book, type BookEvent } from '../../core/src/lifecycle/index.ts';
import { attempt, CONFIG, fill, MINT, on, quote, reservation, SPEND } from '../../core/test/fixtures.ts';
import type { RunResult } from '../src/run.ts';
import type { AttemptRecord } from '../src/sim/world.ts';
import { scoreRunAll, scoreRun } from '../src/study/score.ts';
import { spaVariant } from '../src/study/spa.ts';

const apply = (events: readonly BookEvent[]): Book =>
  events.reduce((b, e) => {
    const r = applyBookEvent(b, e);
    if (isIllegal(r)) throw new Error(`${e.type}: ${r.reason}`);
    return r.state;
  }, emptyBook(CONFIG));

/** A study entry intent of `tag` (ids `en:<tag>:<n>` and `p:<tag>:<n>`, as the study strategy names them). */
const entry = (tag: string, n: number): EntryIntent => ({
  id: intentId(`en:${tag}:${n}`), key: entryKey(MINT, `${tag}:${n}`), purpose: 'entry', side: 'buy', mint: MINT, venue: 'pump-curve', positionId: positionId(`p:${tag}:${n}`), spend: SPEND,
});
const submitted = (i: EntryIntent, n: number): BookEvent[] => [
  { type: 'propose_entry', intent: i },
  on(i.id, { type: 'mark_eligible' }),
  on(i.id, { type: 'approve_risk' }),
  on(i.id, { type: 'reserve_exposure', reservation: reservation(i.id) }),
  on(i.id, { type: 'prepare', quote }),
  on(i.id, { type: 'sign', attempt: attempt(i.id, n, 100n) }),
  on(i.id, { type: 'submit' }),
  on(i.id, { type: 'send_accepted' }),
];
const record = (i: EntryIntent, n: number, over: Partial<AttemptRecord>): AttemptRecord => ({
  intentId: i.id, signature: attempt(i.id, n, 100n).signature, purpose: 'entry', mint: i.mint, priorityFee: 20_000n, lastValidBlockHeight: 100n, outcome: 'filled',
  reason: 'filled', landedSlot: 1n, landedAt: 0, fee: 30_000n, fill: null, costs: null, congested: false, forcedDrop: null, exitRetry: 0, closedAccount: false, ...over,
});

const DAY1 = Date.parse('2026-09-10T02:00:00Z');
const DAY2 = Date.parse('2026-09-11T02:00:00Z');
const DAY3 = Date.parse('2026-09-12T02:00:00Z');

/**
 * Tag U2: a failed entry on day 1 (its landed fee 25,000 lamports), then a filled entry on day 2 still held at the
 * end (day 3). Tag S0-U2: one failed entry and no trade at all.
 */
const run = (): RunResult => {
  const failed = entry('U2', 1);
  const filled = entry('U2', 2);
  const lone = entry('S0-U2', 3);
  const f = fill(filled.id, 2, 5_000n, SPEND);
  const book = apply([
    ...submitted(failed, 1),
    on(failed.id, { type: 'status', signature: attempt(failed.id, 1, 100n).signature, result: 'failed', commitment: 'finalized', blockHeight: 101n, searchedHistory: false }),
    on(failed.id, { type: 'reconcile', fills: [], blockHeight: 101n }),
    on(failed.id, { type: 'abandon' }),
    ...submitted(lone, 3),
    on(lone.id, { type: 'status', signature: attempt(lone.id, 3, 100n).signature, result: 'failed', commitment: 'finalized', blockHeight: 103n, searchedHistory: false }),
    on(lone.id, { type: 'reconcile', fills: [], blockHeight: 103n }),
    on(lone.id, { type: 'abandon' }),
    ...submitted(filled, 2),
    on(filled.id, { type: 'status', signature: f.signature, result: 'succeeded', commitment: 'confirmed', blockHeight: 102n, searchedHistory: false }),
    on(filled.id, { type: 'reconcile', fills: [f], blockHeight: 102n }),
  ]);
  const attempts = [
    record(failed, 1, { outcome: 'failed', reason: 'slippage', landedAt: DAY1, fee: 25_000n }),
    record(filled, 2, { landedAt: DAY2, fill: f }),
    record(lone, 3, { outcome: 'failed', reason: 'slippage', landedAt: DAY1, fee: 25_000n }),
  ];
  return { attempts, book, scenario: 'base', symbols: new Map(), endValue: () => 20_000_000n, endedAt: DAY3, records: [] } as unknown as RunResult;
};

describe('failed-entry costs in every result (audit B5)', () => {
  test('a tag\'s failed-entry fee is charged to its next trade: net and returns carry it, with its own time', () => {
    const [t] = scoreRun(run(), FILL_CONFIG);
    expect(t!.tag).toBe('U2');
    const gross = 20_000_000n - SPEND - 30_000n - FILL_CONFIG.network.tokenAccountRent;
    expect(BigInt(t!.net)).toBe(gross - 25_000n);
    expect(t!.rNet).toBe(Number(gross - 25_000n) / Number(SPEND));
    expect(t!.rNetNoRent).toBe(Number(gross - 25_000n) / Number(SPEND));
    expect(t!.stray).toEqual([{ at: DAY1, lamports: '25000' }]);
  });

  test('a failed-entry fee with no trade of its tag to carry it is still returned, by tag', () => {
    const all = scoreRunAll(run(), FILL_CONFIG);
    expect(all.trades.map((t) => t.tag)).toEqual(['U2']);
    expect(all.uncarried).toEqual([{ tag: 'S0-U2', at: DAY1, lamports: '25000' }]);
  });

  test('the SPA daily series books each failed-entry fee on its own day, carried or not', () => {
    const all = scoreRunAll(run(), FILL_CONFIG);
    const cal = ['2026-09-10', '2026-09-11', '2026-09-12'];
    const base = 1_000_000_000n;
    const u2 = spaVariant('U2', all.trades, cal, base);
    const gross = 20_000_000n - SPEND - 30_000n - FILL_CONFIG.network.tokenAccountRent;
    expect(u2.daily).toEqual([-25_000 / 1e9, 0, Number(gross) / 1e9]);
    const s0 = spaVariant('S0-U2', [], cal, base, all.uncarried.filter((x) => x.tag === 'S0-U2'));
    expect(s0.daily).toEqual([-25_000 / 1e9, 0, 0]);
    expect(s0.entries).toBe(0);
  });
});
