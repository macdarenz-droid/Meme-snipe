import { describe, expect, test } from 'vitest';
import { type FeedEvent, type Moment } from '../../core/src/engine/index.ts';
import { BLOCK_TX, LANDING_TX } from '../src/sim/market.ts';
import { StreamReplay } from '../src/sim/replay.ts';
import { parseCsv } from '../src/dataset/csv.ts';

const m = (slot: number, txIndex: number, ixIndex = 0): Moment => ({ slot: BigInt(slot), txIndex, ixIndex, receivedAt: slot * 400 });

describe('StreamReplay', () => {
  const rows = [m(1, 0), m(1, 3), m(1, BLOCK_TX), m(2, 0), m(2, 7), m(2, BLOCK_TX), m(3, 0)];
  const setup = () => {
    let i = 0;
    const log: string[] = [];
    const r = new StreamReplay<Moment>({ next: () => (i < rows.length ? { moment: rows[i]!, item: rows[i++]! } : null) },
      (x) => [{ kind: 'market', id: `r:${x.slot}:${x.txIndex}`, moment: x, key: 'k', value: null }]);
    const drain = () => {
      for (let e = r.feed.next(); e !== null; e = r.feed.next()) log.push(e.id);
    };
    return { r, log, drain };
  };

  test('a landing hook in a slot runs after every transaction and the block of that slot, before the next slot', () => {
    const { r, log, drain } = setup();
    r.hook({ id: 'land', moment: m(2, LANDING_TX), run: () => log.push('LAND') });
    for (let s = r.advance(); s !== 'done'; s = r.advance()) if (s === 'events') drain();
    expect(log).toEqual(['r:1:0', 'r:1:3', `r:1:${BLOCK_TX}`, 'r:2:0', 'r:2:7', `r:2:${BLOCK_TX}`, 'LAND', 'r:3:0']);
  });

  test('the feed never releases a row or report before the clock reaches it', () => {
    const { r } = setup();
    expect(r.feed.next()).toBeNull();
    r.advance();
    expect(r.feed.next()?.id).toBe('r:1:0');
    expect(r.feed.next()).toBeNull();
  });

  test('world reports are ordered with rows; scheduling at or before now is refused', () => {
    const { r, log, drain } = setup();
    r.advance();
    drain();
    const w = (id: string, at: Moment): FeedEvent => ({ kind: 'world', id, moment: at, event: { type: 'tick', blockHeight: 1n } });
    r.schedule(w('w:b', m(2, 5)));
    r.schedule(w('w:a', m(2, 5)));
    expect(() => r.schedule(w('w:c', m(1, 0)))).toThrow(/after now/);
    expect(() => r.schedule(w('w:a', m(3, 5)))).toThrow(/duplicate/);
    for (let s = r.advance(); s !== 'done'; s = r.advance()) if (s === 'events') drain();
    expect(log.slice(3, 7)).toEqual(['r:2:0', 'w:a', 'w:b', 'r:2:7']);
  });

  test('released events are frozen', () => {
    const { r } = setup();
    r.advance();
    const e = r.feed.next()!;
    expect(Object.isFrozen(e)).toBe(true);
  });
});

describe('CSV', () => {
  test('quoted fields with commas, quotes and newlines (Go encoding/csv)', () => {
    const out: string[][] = [];
    parseCsv('a,b,c\n1,"x, ""y""\nz",3\r\n4,,6\n', (f) => out.push(f));
    expect(out).toEqual([['a', 'b', 'c'], ['1', 'x, "y"\nz', '3'], ['4', '', '6']]);
  });
});

describe('regime boundaries', () => {
  test('the engine sees a regime event at the first block at or after the boundary slot plus the observation delay, never before', async () => {
    const { Market } = await import('../src/sim/market.ts');
    const scheduled: { key: string; slot: bigint }[] = [];
    const market = new Market({ heartbeatBlocks: 1_000, discoveryLag: () => 1, active: () => false, observationSlots: 2, receiptMs: 0,
      schedule: (x) => { if (x.kind === 'market') scheduled.push({ key: x.key, slot: x.moment.slot }); }, regimeBoundaries: [{ slot: 12n, label: 'pump-2026-10-02' }] });
    const at = (slot: number) => {
      expect(market.release({ kind: 'block', slot: BigInt(slot), blockTime: slot, parentSlot: BigInt(slot - 1) })).toEqual([]);
      return scheduled.splice(0);
    };
    expect(at(10)).toEqual([]);
    expect(at(11)).toEqual([]);
    expect(at(13)).toEqual([{ key: 'regime', slot: 15n }]);
    expect(market.regime).toBe('pump-2026-10-02');
    expect(at(14)).toEqual([]);
  });
});
