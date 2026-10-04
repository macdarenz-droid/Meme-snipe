// The SPA panel: daily realised net per variant over one fixed capital base on a common Melbourne calendar; a variant
// active on fewer than MIN_DAYS days is ineligible.
import { describe, expect, it } from 'vitest';
import { MIN_DAYS } from '../../core/src/stats/index.ts';
import { spaPanel, spaVariant } from '../src/study/spa.ts';

// 2026-09-01T00:00Z is 10:00 in Melbourne, so a trade opened and closed that hour belongs to Melbourne 2026-09-01.
const at = (day: number, h = 0) => Date.parse('2026-09-01T00:00:00Z') + day * 86_400_000 + h * 3_600_000;
const calendar = Array.from({ length: 12 }, (_, k) => `2026-09-${String(k + 1).padStart(2, '0')}`);

describe('SPA panel', () => {
  it('sums each Melbourne day of closes over the capital base, with zeros on idle days', () => {
    const v = spaVariant('U2', [
      { openedAt: at(0), closedAt: at(0, 1), net: '1000' },
      { openedAt: at(0, 2), closedAt: at(0, 3), net: '-400' },
      { openedAt: at(2), closedAt: at(2, 1), net: '500' },
    ], calendar, 100_000n);
    expect(v.daily.slice(0, 4)).toEqual([0.006, 0, 0.005, 0]);
    expect(v.daily).toHaveLength(12);
    expect(v).toMatchObject({ activeDays: 2, entries: 3, eligible: false });
  });

  it('marks a variant eligible from activity alone, at MIN_DAYS active days', () => {
    const daily = (n: number) => Array.from({ length: n }, (_, k) => ({ openedAt: at(k), closedAt: at(k, 1), net: '-1' }));
    const p = spaPanel([{ variant: 'a', trades: daily(MIN_DAYS) }, { variant: 'b', trades: daily(MIN_DAYS - 1) }], calendar, 1_000n);
    expect(p.variants.map((x) => x.eligible)).toEqual([true, false]);
    expect(p).toMatchObject({ capitalBaseLamports: '1000', minDays: MIN_DAYS });
  });

  it('refuses a close outside the calendar and a non-positive base', () => {
    expect(() => spaVariant('U2', [{ openedAt: at(20), closedAt: at(20, 1), net: '1' }], calendar, 10n)).toThrow(/outside the calendar/);
    expect(() => spaVariant('U2', [], calendar, 0n)).toThrow(/positive/);
  });
});
