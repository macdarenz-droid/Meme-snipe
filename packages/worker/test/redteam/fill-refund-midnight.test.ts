// RED TEAM A, probe RT-A9 (budget leak across midnight UTC, the fills' daily budget `DailyBudget`, persist/state.ts).
//
// FACTS-REREAD's second review fixed "a refund goes back to its own day" for the re-read budget only (`rereadRefund`,
// `reserveBudget`). The fills' budget (FILL_CREDITS_PER_DAY = 20,000 Helius credits a UTC day) has the same
// reserve-then-refund pattern at every caller, and `DailyBudget.refund(n, now)` gives the credits back to the day of
// `now`, not to the day they were reserved on:
//   - worker.ts #downtimeMigrations: spend(min(3,000, remaining), now) ... refund(cap - used, timers.now()) after a
//     backfill that runs for seconds to minutes;
//   - worker.ts #liveCompletion: spend(6) ... refund(6 - used, timers.now()) after the curve read;
//   - seed-start.ts: the boot seed reserves min(SEED_CREDIT_CAP = 150,000, remaining) and refunds after the seed;
//   - sources.ts tradesFill / findCreate: the same.
// A reserve taken before midnight and refunded after it lowers the NEW day's count by what the old day reserved and
// did not use, so the new day spends past its cap by up to the old reserve (here the downtime read's 3,000; a seed
// running over midnight: up to 20,000 more). Helius credits are real money, and the Helius monthly halt also refuses
// the P1 reads held positions need.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DailyBudget } from '../../src/persist/state.ts';
import { FILL_CREDITS_PER_DAY } from '../../src/run/config.ts';
import { DOWNTIME_CREDIT_CAP } from '../../src/run/worker.ts';

const DAY_MS = 86_400_000;

describe('RT-A9: the fills\' budget refunds a pre-midnight reserve to the new day', () => {
  it('a downtime read reserved at 23:59:50 UTC and refunded at 00:00:30 does not let the new day spend past its cap', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rt-a9-')), 'fill-budget.json');
    const midnight = 20_000 * DAY_MS;
    const b = DailyBudget.load(path, FILL_CREDITS_PER_DAY, midnight - 10_000);
    // #downtimeMigrations: the cap is booked before the backfill reads.
    const t0 = midnight - 10_000;
    const cap = Math.min(DOWNTIME_CREDIT_CAP, b.remaining(t0));
    b.spend(cap, t0);
    // Past midnight, while the backfill still runs, the new day's readers (pool fills, completion reads) take all of
    // the new day's budget.
    const t1 = midnight + 5_000;
    const newDay = b.remaining(t1);
    expect(newDay).toBe(FILL_CREDITS_PER_DAY);
    b.spend(newDay, t1);
    expect(b.remaining(t1)).toBe(0);
    // The backfill ends having used nothing (no downtime migrations), and gives back its reserve at timers.now().
    const used = 0;
    b.refund(Math.max(0, cap - used), midnight + 30_000);
    // Correct: the old day's unused reserve never becomes new-day credit; the new day has spent its 20,000.
    expect(b.remaining(midnight + 31_000)).toBe(0);
  });
});
