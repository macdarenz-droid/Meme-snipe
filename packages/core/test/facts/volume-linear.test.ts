// FACTS-1d review: the producer's chain volume is kept one row at a time. A restart loads the whole persisted window at
// once (365 days, 8,760 rows), so the cost must grow with the rows, not with their square, and the answer must stay
// exactly `dailyChainVolume`'s.
import { describe, expect, it } from 'vitest';
import { TRIAL_POLICY } from '../../src/config/index.ts';
import { CURVE_VOLUME_KEY } from '../../src/gates/index.ts';
import { ChainVolumeDays, RAW, dailyChainVolume, producerOptions, type VolumeHour } from '../../src/facts/index.ts';
import { FactWorld, offchain } from './helpers.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const D0 = 20_654; // 2026-07-20
const KEEP = producerOptions(TRIAL_POLICY).volumeKeepMs;
const window = (days: number): VolumeHour[] =>
  Array.from({ length: days * 24 }, (_, i) => ({ hourStartMs: D0 * DAY + i * HOUR, lamports: BigInt(1 + (i % 97)) * 1_000_000_000n, covered: true }));

/** The producer's rule before this change: every kept hour, trimmed by the latest row, summed from scratch. */
const reference = (rows: readonly VolumeHour[], keepMs: number) => {
  const kept = new Map<number, VolumeHour>();
  for (const r of rows) {
    const prev = kept.get(r.hourStartMs);
    kept.set(r.hourStartMs, prev !== undefined && (prev.lamports !== r.lamports || prev.covered !== r.covered) ? { ...r, covered: false } : r);
    for (const t of [...kept.keys()]) if (t < r.hourStartMs - keepMs) kept.delete(t);
  }
  return dailyChainVolume([...kept.values()]);
};

describe('ChainVolumeDays', () => {
  it('gives dailyChainVolume\'s answer, with repeats, contradictions, gaps, out-of-order rows and trimming', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648), seed % n);
    for (let run = 0; run < 30; run++) {
      const keep = (3 + rnd(5)) * DAY + rnd(24) * HOUR;
      const rows: VolumeHour[] = [];
      for (let i = 0; i < 400; i++) {
        const h = rnd(12 * 24);
        const pick = rnd(20);
        rows.push({ hourStartMs: D0 * DAY + (pick === 0 ? h : Math.min(i, 12 * 24 - 1)) * HOUR, lamports: BigInt(pick === 1 ? 5 : 1), covered: pick !== 2 });
      }
      const v = new ChainVolumeDays(keep);
      for (const r of rows) v.add(r);
      expect(v.days()).toEqual(reference(rows, keep));
    }
  });

  it('says when the complete days change, and only then', () => {
    const v = new ChainVolumeDays(KEEP);
    const day = window(2);
    for (let i = 0; i < 23; i++) expect(v.add(day[i]!)).toBe(false);
    expect(v.add(day[23]!)).toBe(true);
    expect(v.add(day[23]!)).toBe(false);
    expect(v.add({ ...day[5]!, lamports: 0n })).toBe(true);
    expect(v.days()).toEqual([]);
  });

  it('drops days older than the kept window, whole or in part, on a jump, and says so', () => {
    const keep = 3 * DAY;
    const v = new ChainVolumeDays(keep);
    for (const r of window(2)) v.add(r);
    expect(v.days().map((d) => d.day)).toEqual([D0, D0 + 1]);
    // A row 3 days and 5 hours after day 1 starts: day 0 goes whole, day 1 loses its first 5 hours.
    expect(v.add({ hourStartMs: (D0 + 1) * DAY + keep + 5 * HOUR, lamports: 1n, covered: true })).toBe(true);
    expect(v.days()).toEqual([]);
    const w = new ChainVolumeDays(keep);
    for (const r of window(2)) w.add(r);
    expect(w.add({ hourStartMs: D0 * DAY + keep + 24 * HOUR, lamports: 1n, covered: true })).toBe(true);
    expect(w.days().map((d) => d.day)).toEqual([D0 + 1]);
    const x = new ChainVolumeDays(keep);
    for (const r of window(1)) x.add(r);
    expect(x.add({ hourStartMs: D0 * DAY + 10 * keep, lamports: 1n, covered: true })).toBe(true);
    expect(x.days()).toEqual([]);
  });

  it('loading a 365-day window visits each row a bounded number of times', () => {
    const rows = window(368);
    const v = new ChainVolumeDays(KEEP);
    for (const r of rows) v.add(r);
    expect(v.days().length).toBe(dailyChainVolume(rows).length - 0);
    expect(v.steps).toBeLessThanOrEqual(2 * rows.length);
  });

  it('the producer loads a 365-day window at once in well under a second, and releases one fact per completed day', () => {
    const rows = window(365);
    const w = new FactWorld(producerOptions(TRIAL_POLICY));
    const at = (D0 + 366) * DAY;
    const t0 = performance.now();
    rows.forEach((r, i) => w.push(offchain(RAW.volumeHour, r, BigInt(1 + i), at)));
    const ms = performance.now() - t0;
    expect((w.last(CURVE_VOLUME_KEY) as { days: unknown[] }).days.length).toBe(365);
    expect(w.facts(CURVE_VOLUME_KEY).length).toBe(365);
    // Measured about 0.3 s here; the old rule (every kept hour re-summed on each row) took about 9 s. 3 s leaves room.
    expect(ms).toBeLessThan(3_000);
  });
});
