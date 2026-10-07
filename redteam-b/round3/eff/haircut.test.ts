// RED TEAM B round 3, RB-11 (on #275 cb1fb7a): live paper now applies the backtest's repeated-exit haircut
// (exitRetry x exitRetryHaircutPpm, N2) with exitRetry = every earlier exit send on the position, no time window. With
// the conservative 5% per send, from about the 6th send a sell into an UNCHANGED pool is below the last rung's min-out
// (25% under the quote), so every later attempt fails on slippage: the bounded retries and RB-5's slow retries alike.
import { describe, expect, test } from 'vitest';
import { poolSell } from '../../src/amm/index.ts';
import { FILL_CONFIG, TRIAL_POLICY } from '../../src/config/index.ts';
import { executeSellIn, observedFeeContext, type ObservedFees } from '../../src/fills/index.ts';
import { bps, mulDiv } from '../../src/units/index.ts';
import { NORMAL_COIN } from '../amm/helpers.ts';

const S = FILL_CONFIG.scenarios.conservative;
const FEES: ObservedFees = { split: { lp: bps(20), protocol: bps(5), creator: bps(95) }, buybackFeeBps: bps(5000), instruction: 'v1' };
const ctx = observedFeeContext(FEES, 1_000_000_000_000_000n, NORMAL_COIN);
const pool = { baseReserve: 200_000_000_000_000n, quoteVault: 80_000_000_000n, virtualQuoteReserves: 0n };
const tokens = 25_000_000_000n;
const ladder = TRIAL_POLICY.exits.ladder;
const lastBelow = BigInt(ladder.steps.at(-1)!.minOutBelowTriggerBps);

describe('RB-11 the repeated-exit haircut has no window', () => {
  const q = poolSell(pool, tokens, ctx);
  if (!q.ok) throw new Error('no quote');
  const quotedOut = q.trade.userQuote;
  const minOut = mulDiv(quotedOut, 10_000n - lastBelow, 10_000n, 'floor');
  const fills = (sends: number) => executeSellIn({ pool, ctx, quotedOut, minOut, slippagePpm: S.slippagePpm }, tokens, BigInt(sends) * S.exitRetryHaircutPpm).ok;
  test('RB-11a the first slow retry (after 5 ladder attempts and 5 fast retries, 10 earlier sends) fills at an unchanged pool', () => {
    // Unchanged pool, last rung: the only thing between the attempt and its fill is the haircut.
    expect(fills(0)).toBe(true);
    const firstFail = [...Array(40).keys()].find((k) => !fills(k));
    // At cb1fb7a: firstFail is 6, so sends 6.. never fill, however long the position waits.
    expect(fills(ladder.maxAttempts + TRIAL_POLICY.exits.blockedRetryAttempts), `first send that can never fill: ${firstFail}`).toBe(true);
  });
});
