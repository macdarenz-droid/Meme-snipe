// SEEN-TAGS: a candle book's remembered trades as 96-bit tags in per-minute buckets.
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { RepeatTags, tradeRepeatTag } from '../../src/facts/index.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const MIN = 60_000;
const tag = (i: number) => tradeRepeatTag(`sig${i}`, BigInt(i), BigInt(2 * i));

describe('RepeatTags', () => {
  it('a tag is two 48-bit numbers, the same for the same trade and different for another reserve', () => {
    const t = tradeRepeatTag('5Sig', 10n, 20n);
    expect(t.every((n) => Number.isSafeInteger(n) && n >= 0 && n < 2 ** 48)).toBe(true);
    expect(tradeRepeatTag('5Sig', 10n, 20n)).toEqual(t);
    expect(tradeRepeatTag('5Sig', 10n, 21n)).not.toEqual(t);
  });

  it('finds every trade added, in the open minute, sorted minutes and a late trade for an older minute, and no other', () => {
    const r = new RepeatTags();
    for (let i = 0; i < 600; i++) r.add(tag(i), Math.floor(i / 50));
    // A late trade stamped in minute 3, after minute 11's trades: its bucket reopens, then sorts again.
    r.add(tag(10_000), 3);
    r.add(tag(601), 11);
    expect(r.size).toBe(602);
    for (const i of [...Array.from({ length: 602 }, (_, i) => i).filter((i) => i !== 600), 10_000]) expect(r.has(tag(i)), String(i)).toBe(true);
    for (let i = 20_000; i < 21_000; i++) expect(r.has(tag(i))).toBe(false);
    // Same hi, other lo: not the same trade.
    const [hi, lo] = tag(5);
    expect(r.has([hi, (lo + 1) % 2 ** 48])).toBe(false);
  });

  it('sweep forgets a minute only once it ended at or before the cutoff', () => {
    const r = new RepeatTags();
    r.add(tag(1), 10);
    r.add(tag(2), 11);
    r.sweep(11 * MIN - 1);
    expect([r.has(tag(1)), r.has(tag(2)), r.size]).toEqual([true, true, 2]);
    r.sweep(11 * MIN);
    expect([r.has(tag(1)), r.has(tag(2)), r.size]).toEqual([false, true, 1]);
  });

  it('a full hour of 51 trades a minute in 100 books holds under 24 B a trade', () => {
    gc();
    const before = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    const books = Array.from({ length: 100 }, () => new RepeatTags());
    let n = 0;
    for (let m = 0; m < 60; m++) for (const b of books) for (let k = 0; k < 51; k++) b.add(tag(n++), m);
    for (const b of books) b.add(tag(n++), 60);
    gc();
    const per = (process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - before) / n;
    expect(books.reduce((s, b) => s + b.size, 0)).toBe(n);
    expect(per).toBeLessThan(24);
  }, 60_000);
});
