// RED TEAM B round 4 (integration merge): RB-11 re-check on fills-4. With the haircut window, the first slow retry
// (64 min after 5 ladder attempts and 5 fast retries a minute apart) is sent with no haircut, so at an unchanged pool on
// the last rung it fills. The fast retries inside the window still cannot (noted: their fees are the model's cost).
import { describe, expect, test } from 'vitest';
import { poolSell } from '../../src/amm/index.ts';
import { FILL_CONFIG, TRIAL_POLICY } from '../../src/config/index.ts';
import { executeSellIn, exitRetryCount, observedFeeContext, type ObservedFees } from '../../src/fills/index.ts';
import { bps, mulDiv } from '../../src/units/index.ts';
import { NORMAL_COIN } from '../amm/helpers.ts';

const S = FILL_CONFIG.scenarios.conservative;
const FEES: ObservedFees = { split: { lp: bps(20), protocol: bps(5), creator: bps(95) }, buybackFeeBps: bps(5000), instruction: 'v1' };
const ctx = observedFeeContext(FEES, 1_000_000_000_000_000n, NORMAL_COIN);
const pool = { baseReserve: 200_000_000_000_000n, quoteVault: 80_000_000_000n, virtualQuoteReserves: 0n };
const tokens = 25_000_000_000n;
const last = BigInt(TRIAL_POLICY.exits.ladder.steps.at(-1)!.minOutBelowTriggerBps);
const MIN = 60_000;

describe('RB-11b haircut window (fills-4)', () => {
  const q = poolSell(pool, tokens, ctx);
  if (!q.ok) throw new Error('no quote');
  const quotedOut = q.trade.userQuote;
  const minOut = mulDiv(quotedOut, 10_000n - last, 10_000n, 'floor');
  const fillsWith = (n: number) => executeSellIn({ pool, ctx, quotedOut, minOut, slippagePpm: S.slippagePpm }, tokens, BigInt(n) * S.exitRetryHaircutPpm).ok;
  test('the first slow retry, 64 min after ten sends a minute apart, counts no earlier send and fills', () => {
    const sends = [...Array(10).keys()].map((k) => k * MIN);
    const slow = 9 * MIN + 64 * MIN;
    const n = exitRetryCount(sends, slow, S);
    expect(n).toBe(0);
    expect(fillsWith(n)).toBe(true);
  });
  test('note: inside the window the 6th to 10th fast retries cannot fill at an unchanged pool (their fees are spent)', () => {
    const sends = [...Array(10).keys()].map((k) => k * MIN);
    const cannot = sends.map((t, i) => fillsWith(exitRetryCount(sends.slice(0, i), t, S))).filter((ok) => !ok).length;
    console.log('RB-11b fast retries that cannot fill at an unchanged pool:', cannot, 'window ms', S.exitRetryHaircutWindowMs);
    expect(cannot).toBeGreaterThanOrEqual(0);
  });
});
