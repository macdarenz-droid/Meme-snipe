// RED TEAM B round 2, item 5: Melbourne day and week boundaries against the system tz database (Intl), every 15 minutes
// across each DST change 2008-2040, plus the risk day/week loss boundaries on the 2026-10-04 change (AEST -> AEDT).
import { describe, expect, test } from 'vitest';
import { TRIAL_POLICY, usd } from '../../src/config/index.ts';
import { daylightEndUtc, daylightStartUtc, melbourneDay, melbourneTime, melbourneWeek } from '../../src/risk/melbourne.ts';
import { evaluateEntry } from '../../src/risk/index.ts';
import { account, baseInput, baseRequest, clockAt, codes, trade } from '../risk/helpers.ts';

const fmt = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short' });
const intl = (ms: number) => {
  const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { year: Number(p['year']), month: Number(p['month']), day: Number(p['day']), hour: Number(p['hour']), minute: Number(p['minute']), weekday: p['weekday'] };
};
const H = 3_600_000;

describe('RB-6 Melbourne calendar vs tz database', () => {
  test('RB-6a wall clock matches Intl every 15 min within ±2 days of every change, 2008-2040', () => {
    for (let y = 2008; y <= 2040; y++) {
      for (const c of [daylightStartUtc(y), daylightEndUtc(y)]) {
        for (let t = c - 48 * H; t <= c + 48 * H; t += 15 * 60_000) {
          const a = melbourneTime(t);
          const b = intl(t);
          expect({ y: a.year, m: a.month, d: a.day, h: a.hour, mi: a.minute }, new Date(t).toISOString()).toEqual({ y: b.year, m: b.month, d: b.day, h: b.hour, mi: b.minute });
        }
      }
    }
  });
  test('RB-6b day start is local midnight, day lengths 23/25 h on change days, week starts Monday 00:00 local', () => {
    for (let y = 2008; y <= 2040; y++) {
      for (const c of [daylightStartUtc(y), daylightEndUtc(y)]) {
        for (let t = c - 72 * H; t <= c + 72 * H; t += H) {
          const d = melbourneDay(t);
          expect(d.start <= t && t < d.end).toBe(true);
          const s = intl(d.start);
          expect([s.hour, s.minute]).toEqual([0, 0]);
          expect(intl(d.start - 60_000).day).not.toBe(s.day);
          const w = melbourneWeek(t);
          expect(intl(w.start).weekday).toBe('Mon');
          expect([intl(w.start).hour, intl(w.start).minute]).toEqual([0, 0]);
          expect(w.start <= t && t < w.end).toBe(true);
        }
      }
    }
    const start2026 = daylightStartUtc(2026);
    const d = melbourneDay(start2026);
    expect(d.end - d.start).toBe(23 * H);
    const e = melbourneDay(daylightEndUtc(2027));
    expect(e.end - e.start).toBe(25 * H);
  });
});

describe('RB-6c risk day loss across the 2026-10-04 change', () => {
  // Sunday 4 Oct 2026: midnight AEST = Sat 3 Oct 14:00Z; next midnight (AEDT) = Sun 4 Oct 13:00Z.
  const sunStart = Date.UTC(2026, 9, 3, 14, 0);
  const monStart = Date.UTC(2026, 9, 4, 13, 0);
  test('a $1.60 loss at 23:59 Sunday local counts on Sunday; at 00:00 Monday local (13:00Z) the day resets', () => {
    expect(melbourneDay(sunStart).start).toBe(sunStart);
    expect(melbourneDay(monStart).start).toBe(monStart);
    const loss = trade(monStart - 60_000, '-1.6');
    const late = baseInput({ clock: clockAt(monStart - 1), account: account({ closedTrades: [loss] }), market: { ...baseInput().market, solPrice: { value: baseInput().market.solPrice!.value, atMs: monStart - 500 }, solBalance: { ...baseInput().market.solBalance!, atMs: monStart - 500 } } });
    expect(codes(evaluateEntry(late, baseRequest({ quoteAtMs: monStart - 200 })))).toContain('daily_loss');
    const next = baseInput({ clock: clockAt(monStart + 1000), account: account({ closedTrades: [loss] }), market: { ...baseInput().market, solPrice: { value: baseInput().market.solPrice!.value, atMs: monStart + 500 }, solBalance: { ...baseInput().market.solBalance!, atMs: monStart + 500 } } });
    expect(codes(evaluateEntry(next, baseRequest({ quoteAtMs: monStart + 800 })))).not.toContain('daily_loss');
    // The week (Mon 28 Sep 00:00 AEST = Sun 27 Sep 14:00Z) still holds it until Mon 5 Oct 00:00 AEDT.
    expect(melbourneWeek(monStart - 1).end).toBe(monStart);
    void TRIAL_POLICY; void usd;
  });
});
