// OOM-MINT: the let-go creates' week, held in sorted hourly tag arrays.
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { HourTags, hourTag } from '../src/engine/hour-tags.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const H = 3_600_000;
const WEEK = 7 * 24 * H;

describe('HourTags', () => {
  it('a tag is a 53-bit integer, the same for the same mint', () => {
    const t = hourTag('7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr');
    expect(Number.isSafeInteger(t) && t >= 0).toBe(true);
    expect(hourTag('7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr')).toBe(t);
    expect(hourTag('7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hs')).not.toBe(t);
  });

  it('finds every mint added, in the open hour and in sealed ones, and no other', () => {
    const s = new HourTags(WEEK);
    const mints = Array.from({ length: 3_000 }, (_, i) => `Mint${i}`);
    mints.forEach((m, i) => s.add(m, i * 5_000));
    expect(s.size).toBe(3_000);
    for (const m of mints) expect(s.has(m), m).toBe(true);
    for (let i = 3_000; i < 6_000; i++) expect(s.has(`Mint${i}`)).toBe(false);
  });

  it('keeps an hour until keepMs after it ends, to the millisecond', () => {
    const s = new HourTags(WEEK);
    s.add('A', 10 * H + 5);
    s.add('B', 11 * H);
    s.prune(11 * H + WEEK - 1);
    expect([s.has('A'), s.has('B')]).toEqual([true, true]);
    s.prune(11 * H + WEEK);
    expect([s.has('A'), s.has('B')]).toEqual([false, true]);
    s.prune(12 * H + WEEK);
    expect([s.has('A'), s.has('B'), s.size]).toEqual([false, false, 0]);
  });

  it('a week at 75 creates a minute holds under 8 MB', () => {
    gc();
    const s = new HourTags(WEEK);
    const n = 7 * 24 * 60 * 75;
    const before = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    for (let i = 0; i < n; i++) s.add(`M${i}`, Math.floor((i / 75) * 60_000));
    s.add('last', 7 * 24 * H);
    gc();
    const grew = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - before;
    expect(s.size).toBe(n + 1);
    expect(s.has('M0') && s.has(`M${n - 1}`)).toBe(true);
    expect(grew).toBeLessThan(8 * 1024 * 1024);
  }, 60_000);
});
