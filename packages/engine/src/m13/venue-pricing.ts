// The typed adapter between `recordedPricing` (phase0-input.ts) and @bot/venue's `quoteExactIn` (ruling Z09-27: no
// `as never`). A recorded state becomes a `CpPoolState` field by field with its unit brands, and the recorded per-side
// fee total becomes one flat PumpSwap fee schedule (all in the LP component; the per-component ceil differs from the
// three-way split by at most 2 lamports a leg). `@bot/venue` is a runtime dependency of @bot/engine (ruling Z09-10).
import type { BaseUnits, Bps, Lamports, Slot, UnixMs } from '@bot/types';
import { quoteExactIn, type CpPoolState, type FeeInputs } from '@bot/venue';
import { MINTS } from '@bot/venue/constants';
import { recordedPricing, type RecordedPool, type RecordedPricing } from './phase0-input.ts';

export function toCpPoolState(p: RecordedPool): CpPoolState {
  return {
    venue: p.venue, poolId: p.poolId, baseMint: p.baseMint, quoteMint: p.quoteMint,
    baseReserve: p.baseReserve as BaseUnits, quoteReserveReal: p.quoteReserveReal as Lamports, quoteReserveVirtual: p.quoteReserveVirtual,
    baseMintSupply: p.baseMintSupply as BaseUnits, isCanonical: p.isCanonical, curveComplete: p.curveComplete,
    asOfSlot: p.asOfSlot as Slot, commitment: p.commitment, observedAtMs: p.observedAtMs as UnixMs,
    coinCreatorSet: p.coinCreatorSet, creatorFeeBps: p.creatorFeeBps as Bps, isMayhemMode: p.isMayhemMode, baseDecimals: p.baseDecimals,
    realBaseReserve: p.realBaseReserve, swappedMints: p.swappedMints,
  };
}

/** One flat PumpSwap schedule of `totalBps` per side, applied at every market cap. */
export function flatFeeInputs(totalBps: number): FeeInputs {
  const fees = { lpBps: totalBps as Bps, protocolBps: 0 as Bps, creatorBps: 0 as Bps };
  const cfg = { account: 'recorded', asOfSlot: 0n as Slot, configHash: 'recorded-fee-total', tiers: [{ thresholdLamports: 0n, fees }], flat: fees, exoticFlat: fees };
  return { curve: null, pumpswap: cfg, creatorFeeConfigurable: false };
}

export function venueRecordedPricing(): RecordedPricing {
  return recordedPricing<FeeInputs>({
    quote: (p, side, amountIn, fees) => {
      const q = quoteExactIn(toCpPoolState(p), side, amountIn, fees);
      return q.ok ? { ok: true, value: { amountOut: q.value.amountOut, venueFeeLamports: q.value.venueFeeLamports } } : { ok: false, error: { code: q.error.code } };
    },
    feesForTotal: flatFeeInputs,
    wsolMint: MINTS.wsol,
  });
}
