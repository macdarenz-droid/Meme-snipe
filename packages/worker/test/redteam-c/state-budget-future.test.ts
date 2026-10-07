// RED TEAM C: the fill's daily credit budget only rolls forward, by design, so a clock stepped back keeps today's spend.
// But one boot with the clock far ahead (an RTC reading 2027, a VM restore with a wrong clock) dates the file in the
// future, and every later day, once the clock is right, reads "already spent" until that future date: no restart fill
// for months, so every restart gap stays open and H14 reads not covered (no trades, with no alert). A day more than one
// day ahead of the clock cannot be a real UTC day already spent.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DailyBudget } from '../../src/persist/state.ts';
import { tempState } from '../worker-harness.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 7, 3);

describe('red team C: fill budget dated in the far future', () => {
  it('a budget file dated a year ahead does not hold the budget at zero for a week of correct clocks', () => {
    const path = join(tempState(), 'fill-budget.json');
    // Written by one boot whose clock read 2027-10-07.
    writeFileSync(path, JSON.stringify({ version: 1, day: '2027-10-07', spent: 5_000 }));
    const b = DailyBudget.load(path, 5_000, NOW);
    expect(b.remaining(NOW + 7 * DAY)).toBeGreaterThan(0);
  });
});
