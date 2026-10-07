// RED TEAM B round 4, SOL-BOOKS x EXIT-FILL (RB-5 slow retries): risk reserves the full possible loss of a trade as
// q + C, with C's exit part = (ladder.maxAttempts + blockedRetryAttempts) attempts at the fee cap. RB-5 added slow retries
// past that bound (each waits twice as long, capped at 1,024 x blockedRetryMs). Their fees are not in C, so a position
// blocked for a week can spend more than R6 reserved for it. Asserts C covers a week of slow retries; FAILS on the merge.
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG, TRIAL_POLICY } from '../../src/config/index.ts';
import { exitSettings, slowRetryWaitMs } from '../../src/exits/index.ts';
import { maxTradeCosts } from '../../src/risk/index.ts';
import { NETWORK, RENT } from '../risk/helpers.ts';

describe('RB-16 slow retries and the R6 reservation', () => {
  test('RB-16a a week blocked: the slow retries\' fees fit in what C reserved past the bounded retries', () => {
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
    const slowFees = BigInt(n) * retryCost;
    console.log('RB-16a', { slowRetriesPerWeek: n, retryCost: String(retryCost), slowFees: String(slowFees), C: String(c.total), ladderWorst: String(c.ladderWorst) });
    // C reserves the bounded ladder and blocked retries only (ladderWorst); anything past it is unreserved.
    expect(slowFees).toBe(0n);
  });
});
