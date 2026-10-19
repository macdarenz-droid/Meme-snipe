// RED TEAM B round 3, RB-11 (on #275 cb1fb7a): live paper applied the backtest's repeated-exit haircut with every earlier
// exit send on the position, no time window. With the conservative 5% per send, from about the 6th send a sell into an
// UNCHANGED pool is below the last rung's min-out (25% under the quote), so every later attempt failed on slippage: the
// bounded retries and RB-5's slow retries alike. Adapted to fills-4 (EXIT-FILL-FIXES): the multiple is now the sends
// inside `exitRetryHaircutWindowMs` before the attempt (`exitRetryCount`), so the probe feeds it real send times.
import { describe, expect, test } from 'vitest';
import { poolSell } from '../../src/amm/index.ts';
import { FILL_CONFIG, TRIAL_POLICY } from '../../src/config/index.ts';
import { slowRetryWaitMs } from '../../src/exits/index.ts';
import { executeSellIn, exitRetryCount, observedFeeContext, type ObservedFees } from '../../src/fills/index.ts';
import { bps, mulDiv } from '../../src/units/index.ts';
import { NORMAL_COIN } from '../amm/helpers.ts';

const S = FILL_CONFIG.scenarios.conservative;
const FEES: ObservedFees = { split: { lp: bps(20), protocol: bps(5), creator: bps(95) }, buybackFeeBps: bps(5000), instruction: 'v1' };
const ctx = observedFeeContext(FEES, 1_000_000_000_000_000n, NORMAL_COIN);
const pool = { baseReserve: 200_000_000_000_000n, quoteVault: 80_000_000_000n, virtualQuoteReserves: 0n };
const tokens = 25_000_000_000n;
const ladder = TRIAL_POLICY.exits.ladder;
const lastBelow = BigInt(ladder.steps.at(-1)!.minOutBelowTriggerBps);
const G = TRIAL_POLICY.exits;

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
    // The episode as sent: the ladder within seconds, then a fast retry every blockedRetryMs.
    const sends = [
      ...Array.from({ length: ladder.maxAttempts }, (_, i) => i * 2_000),
      ...Array.from({ length: G.blockedRetryAttempts }, (_, i) => 8_000 + (i + 1) * G.blockedRetryMs),
    ];
    expect(sends).toHaveLength(ladder.maxAttempts + G.blockedRetryAttempts);
    // The first slow retry goes out its wait after the last fast retry was booked blocked.
    const slowAt = sends.at(-1)! + slowRetryWaitMs(G.blockedRetryMs, 0);
    const multiple = exitRetryCount(sends, slowAt, S);
    // At cb1fb7a the multiple was every earlier send (10), and send 6 onward could never fill.
    expect(multiple).toBe(0);
    expect(fills(multiple), `first send that can never fill at the haircut's full multiple: ${firstFail}`).toBe(true);
  });
});
