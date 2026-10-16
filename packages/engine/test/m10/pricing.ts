// Test binding of M10's `PoolPricing` to @bot/venue's `quoteExactIn` (the composition root does the same), and the
// pools of ARCH Table 2-A. No address literals (lint rule bot/no-program-id-literal); ids are labels.
import type { Bps, Slot, UnixMs } from '@bot/types';
import { MINTS } from '@bot/venue/constants';
import { quoteExactIn, type CpPoolState, type FeeInputs } from '@bot/venue';
import type { PoolPricing } from '../../src/m10/costs.ts';

export const SOL = 1_000_000_000n;

export function pricingOf(p: CpPoolState, fees: FeeInputs): PoolPricing {
  return {
    effectiveQuoteLamports: p.quoteReserveReal + p.quoteReserveVirtual,
    realQuoteLamports: p.quoteReserveReal,
    quote(side, amountIn) {
      const q = quoteExactIn(p, side, amountIn, fees);
      return q.ok ? { ok: true, value: { amountOut: q.value.amountOut, venueFeeLamports: q.value.venueFeeLamports } } : { ok: false, error: { code: q.error.code } };
    },
  };
}

/** One flat tier of `totalBps` split lp / protocol / creator as PumpSwap's canonical schedule does (rounded into lp). */
export function flatFees(totalBps: number): FeeInputs {
  const protocol = Math.floor(totalBps / 6), creator = Math.floor(totalBps / 6), lp = totalBps - protocol - creator;
  const fees = { lpBps: lp as Bps, protocolBps: protocol as Bps, creatorBps: creator as Bps };
  const cfg = { account: 'fee-config', asOfSlot: 1n as Slot, configHash: 'test', tiers: [{ thresholdLamports: 0n, fees }], flat: fees, exoticFlat: fees };
  return { curve: null, pumpswap: cfg, creatorFeeConfigurable: true };
}

/** A canonical wSOL PumpSwap pool with effective quote `q` SOL and k ≈ 84.99 SOL × 206.9M tokens [EX-03] (ARCH 2.2). */
export function archPool(qSol: bigint, over: Partial<CpPoolState> = {}): CpPoolState {
  const k = 84_990_000_000n * 206_900_000_000_000n;
  const Q = qSol * SOL;
  return {
    venue: 'pumpswap', poolId: `pool-q${qSol}`, baseMint: `mint-q${qSol}`, quoteMint: MINTS.wsol,
    baseReserve: k / Q, quoteReserveReal: Q, quoteReserveVirtual: 0n,
    baseMintSupply: 1_000_000_000_000_000n, isCanonical: true, curveComplete: null,
    asOfSlot: 1_000n as Slot, commitment: 'confirmed', observedAtMs: 0 as UnixMs,
    coinCreatorSet: true, creatorFeeBps: 0, isMayhemMode: false, baseDecimals: 6, realBaseReserve: null, swappedMints: false,
    ...over,
  };
}

/** The pool at min(real, effective) quote depth with the same spot price (real vault only, base scaled). */
export function atMinDepth(p: CpPoolState): CpPoolState {
  const eff = p.quoteReserveReal + p.quoteReserveVirtual;
  const d = p.quoteReserveReal < eff ? p.quoteReserveReal : eff;
  return { ...p, quoteReserveReal: d, quoteReserveVirtual: 0n, baseReserve: (p.baseReserve * d) / eff };
}
