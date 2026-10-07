// RED TEAM B round 2, item 4: the exit ladder at $1k and $10k positions (large impact). Rung min-out is a ratio of the
// full-size trigger value, so the ladder is size-neutral; fees stay capped lamports; the liquidation value is quoted at
// the real size (impact included), so a large position's stop fires on its executable value, never on spot.
import { describe, expect, test } from 'vitest';
import type { PoolState } from '../../src/amm/index.ts';
import { TRIAL_POLICY } from '../../src/config/index.ts';
import { liquidationValue, planAttempt } from '../../src/exits/index.ts';
import { type ObservedFees, observedFeeContext } from '../../src/fills/index.ts';
import { bps } from '../../src/units/index.ts';
import { NORMAL_COIN } from '../amm/helpers.ts';

const L = TRIAL_POLICY.exits.ladder;
const FEES: ObservedFees = { split: { lp: bps(20), protocol: bps(5), creator: bps(95) }, buybackFeeBps: bps(5000), instruction: 'v1' };
const CTX = observedFeeContext(FEES, 1_000_000_000_000_000n, NORMAL_COIN);
const SOL = 1_000_000_000n;

describe('RB-9 ladder at scale', () => {
  test('RB-9a rung choice and min-out ratio are the same at $5, $1k and $10k (size-neutral); fees capped', () => {
    for (const value of [40_000_000n, 8n * SOL, 80n * SOL]) {
      for (const quoteBps of [10_000n, 9_300n, 8_000n, 7_400n]) {
        const p = planAttempt(L, 1, value, (value * quoteBps) / 10_000n);
        const small = planAttempt(L, 1, 40_000_000n, (40_000_000n * quoteBps) / 10_000n);
        expect(p.ok).toBe(small.ok);
        if (p.ok && small.ok) {
          expect(p.rung).toBe(small.rung);
          expect(p.priorityFee <= L.maxFeePerAttempt).toBe(true);
          expect(p.minOut * 40_000_000n / value - small.minOut).toBeLessThanOrEqual(1n);
        }
      }
    }
  });
  test('RB-9b a $10k position in a pool at the R12 floor (1000x notional): value is quoted at size, below spot x qty', () => {
    const pool: PoolState = { baseReserve: 200_000_000_000_000n, quoteVault: 40_000n * SOL, virtualQuoteReserves: 0n };
    const qty = 4_000_000_000_000n; // 2% of base reserve
    const v = liquidationValue({ venue: 'pumpswap', pool, ctx: CTX }, qty);
    expect(v.ok).toBe(true);
    const spot = (qty * pool.quoteVault) / pool.baseReserve;
    if (v.ok) expect(v.value < spot).toBe(true);
  });
});
