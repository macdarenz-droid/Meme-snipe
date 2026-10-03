import { describe, expect, test } from 'vitest';
import {
  civilFromDays, daylightEndUtc, daylightStartUtc, daysFromCivil, melbourneDay, melbourneOffsetMinutes, melbourneTime,
  melbourneWeek, weekdayOfDays,
} from '../../src/risk/index.ts';

const H = 3_600_000;
const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => Date.UTC(y, mo - 1, d, h, mi, s, ms);

describe('Melbourne tz rules, 2026-10-04 start of daylight time', () => {
  test('the change happens at 02:00 AEST = 16:00 UTC on Saturday 3 October', () => {
    expect(daylightStartUtc(2026)).toBe(utc(2026, 10, 3, 16));
    expect(melbourneOffsetMinutes(utc(2026, 10, 3, 15, 59, 59, 999))).toBe(600);
    expect(melbourneOffsetMinutes(utc(2026, 10, 3, 16))).toBe(660);
    expect(melbourneTime(utc(2026, 10, 3, 15, 59))).toMatchObject({ year: 2026, month: 10, day: 4, hour: 1, minute: 59, zone: 'AEST' });
    expect(melbourneTime(utc(2026, 10, 3, 16, 0))).toMatchObject({ year: 2026, month: 10, day: 4, hour: 3, minute: 0, zone: 'AEDT' });
  });

  test('4 October 2026 is a 23-hour day', () => {
    const d = melbourneDay(utc(2026, 10, 4, 0));
    expect(d.date).toEqual({ year: 2026, month: 10, day: 4 });
    expect(d.start).toBe(utc(2026, 10, 3, 14)); // 00:00 AEST
    expect(d.end).toBe(utc(2026, 10, 4, 13)); // 00:00 AEDT on the 5th
    expect(d.end - d.start).toBe(23 * H);
  });

  test('the week of the change starts Monday 5 October 00:00 AEDT', () => {
    expect(melbourneWeek(utc(2026, 10, 7, 2))).toEqual({ start: utc(2026, 10, 4, 13), end: utc(2026, 10, 11, 13) });
    // Sunday the 4th (local) belongs to the week that began Monday 28 September 00:00 AEST; that week is 167 hours.
    const w = melbourneWeek(utc(2026, 10, 4, 12, 59, 59, 999));
    expect(w).toEqual({ start: utc(2026, 9, 27, 14), end: utc(2026, 10, 4, 13) });
    expect(w.end - w.start).toBe(167 * H);
  });
});

describe('Melbourne tz rules, 2027-04-04 end of daylight time', () => {
  test('the change happens at 03:00 AEDT = 16:00 UTC on Saturday 3 April', () => {
    expect(daylightEndUtc(2027)).toBe(utc(2027, 4, 3, 16));
    expect(melbourneOffsetMinutes(utc(2027, 4, 3, 15, 59, 59, 999))).toBe(660);
    expect(melbourneOffsetMinutes(utc(2027, 4, 3, 16))).toBe(600);
    expect(melbourneTime(utc(2027, 4, 3, 15, 59))).toMatchObject({ day: 4, hour: 2, minute: 59, zone: 'AEDT' });
    expect(melbourneTime(utc(2027, 4, 3, 16, 0))).toMatchObject({ day: 4, hour: 2, minute: 0, zone: 'AEST' });
  });

  test('4 April 2027 is a 25-hour day and its week is 169 hours', () => {
    const d = melbourneDay(utc(2027, 4, 4, 5));
    expect(d.start).toBe(utc(2027, 4, 3, 13)); // 00:00 AEDT
    expect(d.end).toBe(utc(2027, 4, 4, 14)); // 00:00 AEST on the 5th
    expect(d.end - d.start).toBe(25 * H);
    const w = melbourneWeek(utc(2027, 4, 4, 5));
    expect(w.start).toBe(utc(2027, 3, 28, 13));
    expect(w.end - w.start).toBe(169 * H);
  });

  test('the new year in Melbourne is still daylight time', () => {
    expect(melbourneDay(utc(2026, 12, 31, 13, 30)).date).toEqual({ year: 2027, month: 1, day: 1 });
    expect(melbourneDay(utc(2026, 12, 31, 13, 30)).start).toBe(utc(2026, 12, 31, 13));
  });
});

describe('calendar arithmetic', () => {
  test('civil dates round-trip and weekdays match', () => {
    for (let d = daysFromCivil(2008, 1, 1); d < daysFromCivil(2041, 1, 1); d += 37) {
      const c = civilFromDays(d);
      expect(daysFromCivil(c.year, c.month, c.day)).toBe(d);
      expect(weekdayOfDays(d)).toBe(new Date(d * 24 * H).getUTCDay());
    }
    expect(civilFromDays(-1)).toEqual({ year: 1969, month: 12, day: 31 });
    expect(daysFromCivil(2028, 2, 29) + 1).toBe(daysFromCivil(2028, 3, 1));
  });

  test('leap years follow the Gregorian rule (2000 yes, 2100 no, 2028 yes)', () => {
    expect(daysFromCivil(2000, 3, 1) - daysFromCivil(2000, 2, 28)).toBe(2);
    expect(daysFromCivil(2100, 3, 1) - daysFromCivil(2100, 2, 28)).toBe(1);
    expect(daysFromCivil(2028, 3, 1) - daysFromCivil(2028, 2, 28)).toBe(2);
    expect(civilFromDays(daysFromCivil(2100, 2, 28) + 1)).toEqual({ year: 2100, month: 3, day: 1 });
  });

  test('a fractional instant after 2008 is refused', () => {
    expect(() => melbourneOffsetMinutes(utc(2026, 1, 1) + 0.5)).toThrow(RangeError);
  });

  test('instants before the 2008 rule are refused', () => {
    expect(() => melbourneOffsetMinutes(utc(2007, 12, 1))).toThrow(RangeError);
    expect(() => melbourneOffsetMinutes(1.5)).toThrow(RangeError);
  });

  // Cross-check against the system tz database (Intl is fine in tests, banned in core).
  const f = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  });
  const parts = (ms: number) => {
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { year: Number(p['year']), month: Number(p['month']), day: Number(p['day']), hour: Number(p['hour']), minute: Number(p['minute']) };
  };
  test('agrees with the tz database every 7 h 13 min from 2008 to 2040, and at every change', () => {
    for (let t = utc(2008, 1, 1); t < utc(2040, 12, 31); t += 7 * H + 13 * 60_000) {
      const { zone: _z, ...mine } = melbourneTime(t);
      expect(mine, new Date(t).toISOString()).toEqual(parts(t));
    }
    for (let y = 2008; y <= 2040; y++) {
      for (const change of [daylightStartUtc(y), daylightEndUtc(y)]) {
        for (const t of [change - 1, change, change + 1]) {
          const { zone: _z, ...mine } = melbourneTime(t);
          expect(mine, new Date(t).toISOString()).toEqual(parts(t));
        }
      }
    }
  }, 60_000);
});
