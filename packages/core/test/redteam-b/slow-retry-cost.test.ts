// RED TEAM B round 4, RB-16 (SOL-BOOKS x EXIT-FILL): risk reserves the full possible loss of a trade as q + C, with C's
// exit part = (ladder.maxAttempts + blockedRetryAttempts) attempts at the fee cap; RB-5 added slow retries past that.
// Adapted to S1's rule B (EXIT-FILL-FIXES): a fee outside C is allowed only as a slow retry, day 1's inside R4's reserve,
// the later ones counted when paid (core/test/risk/slow-retry-room.test.ts) and bounded by DUST-WRITEOFF (a retry is
// sent only while its least proceeds beat its cost: rules.ts, RB-5c).
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG, TRIAL_POLICY } from '../../src/config/index.ts';
import { exitSettings, slowRetriesWithin, slowRetryWaitMs } from '../../src/exits/index.ts';
import { maxTradeCosts, opsReserve, SLOW_RETRY_RESERVE_MS } from '../../src/risk/index.ts';
import { NETWORK, RENT } from '../risk/helpers.ts';

describe('RB-16 slow retries and the R6 reservation', () => {
  test('RB-16a a week blocked: day 1\'s slow retries are in R4\'s reserve; past C, only slow retries after day 1 spend, counted when paid', () => {
    const g = TRIAL_POLICY.exits;
    const c = maxTradeCosts(TRIAL_POLICY, { network: NETWORK, rent: RENT });
    const retryCost = exitSettings(TRIAL_POLICY, 'close', FILL_CONFIG.network).retryCost;
    let t = 0;
    let n = 0;
    while (true) {
      t += slowRetryWaitMs(g.blockedRetryMs, n);
      if (t > 7 * 86_400_000) break;
      n++;
    }
    expect(n).toBe(slowRetriesWithin(g.blockedRetryMs, 7 * SLOW_RETRY_RESERVE_MS));
    // C holds the planned ladder and the bounded blocked retries, at the fee cap; no slow retry.
    expect(c.ladderWorst).toBe(BigInt(g.ladder.maxAttempts + g.blockedRetryAttempts) * c.perExitAttempt);
    // Day 1's slow retries are reserved before the entry, in R4's operations reserve (beyond C).
    const day1 = slowRetriesWithin(g.blockedRetryMs, SLOW_RETRY_RESERVE_MS);
    const big = { ...RENT, oneTime: 3_000_000n, transient: 20_000_000n };
    const withoutSlow = big.tokenAccount + big.oneTime + big.transient + BigInt(TRIAL_POLICY.reserve.exitAttempts + g.blockedRetryAttempts) * c.perExitAttempt;
    expect(opsReserve(TRIAL_POLICY, { rent: big }, c.perExitAttempt) - withoutSlow).toBe(BigInt(day1) * c.perExitAttempt);
    expect(c.perExitAttempt).toBeGreaterThanOrEqual(retryCost);
    // What a week spends outside both reservations: only the slow retries after day 1, each paid as it lands.
    expect(n - day1).toBe(8);
    expect(retryCost).toBe(510_000n);
    expect(BigInt(n - day1) * retryCost).toBe(4_080_000n);
  });
});
