// DATA-1c's volume-hours CSV (FACTS-1d), parsed once in core for the live reader and the backtest: the header, then
// exactly 24 rows in hour order, covered 1 or 0. Anything else refuses the whole day.
import { describe, expect, it } from 'vitest';
import { VOLUME_HOURS_HEADER, dailyChainVolume, parseVolumeHoursCsv } from '../../src/facts/index.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const D = 20_727; // 2026-10-01
const csv = (lamports: (h: number) => bigint = (h) => BigInt(h + 1), uncovered: number[] = []) =>
  [VOLUME_HOURS_HEADER, ...Array.from({ length: 24 }, (_, h) => `${D * DAY + h * HOUR},${lamports(h)},${uncovered.includes(h) ? 0 : 1}`)].join('\n') + '\n';

describe('parseVolumeHoursCsv', () => {
  it('reads 24 rows in order; the day sums when every hour is covered', () => {
    const rows = parseVolumeHoursCsv(csv(), D)!;
    expect(rows.length).toBe(24);
    expect(rows[0]).toEqual({ hourStartMs: D * DAY, lamports: 1n, covered: true });
    expect(rows[23]).toEqual({ hourStartMs: D * DAY + 23 * HOUR, lamports: 24n, covered: true });
    expect(dailyChainVolume(rows)).toEqual([{ day: D, volumeLamports: 300n }]);
    expect(parseVolumeHoursCsv(csv().replace(/\n/g, '\r\n'), D)).toEqual(rows);
    expect(parseVolumeHoursCsv(csv().trimEnd(), D)).toEqual(rows);
    expect(parseVolumeHoursCsv(csv(() => (1n << 64n) - 1n), D)![0]!.lamports).toBe((1n << 64n) - 1n);
  });

  it('an uncovered hour is kept as uncovered, with its partial lamports, and the day is unknown, never smaller', () => {
    const rows = parseVolumeHoursCsv(csv(() => 5n, [11]), D)!;
    expect(rows[11]).toEqual({ hourStartMs: D * DAY + 11 * HOUR, lamports: 5n, covered: false });
    expect(rows.filter((r) => !r.covered).length).toBe(1);
    expect(dailyChainVolume(rows)).toEqual([]);
  });

  it.each([
    ['a wrong header', (t: string) => t.replace(VOLUME_HOURS_HEADER, 'hour_start_ms,lamports')],
    ['a missing row', (t: string) => t.split('\n').filter((_l, i) => i !== 5).join('\n')],
    ['an extra row', (t: string) => t + `${D * DAY + 24 * HOUR},1,1\n`],
    ['rows out of order', (t: string) => { const l = t.split('\n'); [l[1], l[2]] = [l[2]!, l[1]!]; return l.join('\n'); }],
    ['an hour of another day', (t: string) => t.replaceAll(String(D * DAY), String((D + 1) * DAY))],
    ['an hour with a leading zero', (t: string) => t.replace(`\n${D * DAY},`, `\n0${D * DAY},`)],
    ['a covered value other than 0 or 1', (t: string) => t.replace(/,1\n/, ',2\n')],
    ['a covered value written as true', (t: string) => t.replace(/,1\n/, ',true\n')],
    ['a negative amount', (t: string) => t.replace(/,(\d+),1\n/, ',-1,1\n')],
    ['a decimal amount', (t: string) => t.replace(/,(\d+),1\n/, ',1.5,1\n')],
    ['an amount above u64', (t: string) => t.replace(/,(\d+),1\n/, ',18446744073709551616,1\n')],
    ['an amount with a leading zero', (t: string) => t.replace(/,(\d+),1\n/, ',01,1\n')],
    ['a missing column', (t: string) => t.replace(/,1\n/, '\n')],
    ['an extra column', (t: string) => t.replace(/,1\n/, ',1,1\n')],
    ['a blank line inside', (t: string) => t.replace('\n', '\n\n')],
    ['an empty file', () => ''],
  ])('refuses the whole day with %s', (_name, mutate) => {
    expect(parseVolumeHoursCsv(csv(), D)).not.toBeNull();
    expect(parseVolumeHoursCsv(mutate(csv()), D)).toBeNull();
  });

  it('refuses a day number that is not a whole day', () => {
    expect(parseVolumeHoursCsv(csv(), D + 0.5)).toBeNull();
    expect(parseVolumeHoursCsv(csv(), D + 1)).toBeNull();
  });
});
