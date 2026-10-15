// A-M01-04 pool orientation (pure parts). `normalisePool` turns a decoded pool and its two vaults into a `CpPoolState`
// whose quote is wSOL and whose base is the token; `checkOrientation` compares one decoded PumpSwap swap with our model
// on the snapshot before it (ARCH M01 failure table; ruling Z07-20: a factor-10 band, not 1%).
// VERIFY results (card Z07):
// - Vault owner: the pinned pump_amm.json (pump-public-docs 8cda1fa) declares `pool_base_token_account` and
//   `pool_quote_token_account` as associated token accounts of the pool, seeds [pool, token_program, mint] under the
//   associated-token program (pump_amm.json:429 and the swap instructions): a vault's `owner` is the pool address.
// - Event reserves: the pinned BuyEvent/SellEvent carry `pool_base_token_reserves`, `pool_quote_token_reserves`
//   [VF-06], but the frozen `DecodedEvent` (`@bot/types` 1.0.0) does not, and no official page says whether they are
//   pre- or post-trade [VF-06]. So the active method is logic 5's fallback: our modelled price for the event's exact
//   amounts on our snapshot at S − 1 (or up to `max_slot_gap` slots older). A buy's `quoteAmount` is
//   `quote_amount_in`, which is the net input for `buy` but the spend limit (fees included) for `buy_exact_quote_in`
//   (CORE-2 goldens); the event does not say which, so a buy is compared both ways and passes on the closer one.
//   Fees differ from the price by at most their bps, far below what an inverted pool gives (orders of magnitude).
import type { DecodedAccount } from '@bot/decoders';
import type { BaseUnits, Commitment, DecodedEvent, Lamports, Pubkey, Result, Slot, UnixMs, VenueId } from '@bot/types';
import { DEFAULT_PUBKEY, MINTS } from './constants.ts';
import type { CpPoolState } from './pool.ts';

export type NormaliseError = { code: 'E_NOT_SOL_QUOTED' | 'E_VENUE_NOT_SPECIFIED' | 'E_LAYOUT'; detail: string };
type Account = DecodedAccount;

export interface NormaliseContext {
  poolId: Pubkey; asOfSlot: Slot; commitment: Commitment; observedAtMs: UnixMs;
  /**
   * NEW (Z07): `pumpPoolAuthorityPda(token mint)`, computed by the caller (it is asynchronous); null when not known,
   * which leaves `isCanonical` null and the pool unquotable (C-04).
   */
  canonicalCreator: Pubkey | null;
}

const fail = (code: NormaliseError['code'], detail: string): { ok: false; error: NormaliseError } => ({ ok: false, error: { code, detail } });

/** A vault: a token account of `mint` owned by the pool (logic 2). */
function vaultAmount(v: Account, mint: Pubkey, poolId: Pubkey, which: string): Result<bigint, NormaliseError> {
  if (v.kind !== 'spl_token_account') return fail('E_LAYOUT', `${which} vault is not a token account`);
  if (v.mint !== mint) return fail('E_LAYOUT', `${which} vault holds another mint`);
  if (v.owner !== poolId) return fail('E_LAYOUT', `${which} vault is not owned by the pool`);
  return { ok: true, value: v.amount };
}

/**
 * Logic 1-3. PumpSwap: reserves follow the mints, not the field names. A pool whose base mint is wSOL is read with the
 * roles swapped (NEW `swappedMints`, clarification C-83: the program charges fees on its own sides, which the quote
 * model does not mirror, so such a pool's fee is `E_FEE_UNKNOWN`); with a non-zero virtual quote reserve it cannot be
 * read (the virtual reserve sits on the token side) and is `E_LAYOUT`. Neither mint wSOL: `E_NOT_SOL_QUOTED`.
 * `mint` is the token mint's address, supply and decimals (NEW `address` and `decimals`, C-82). The pump curve has no
 * vaults: its reserves are the curve account's. Raydium: `E_VENUE_NOT_SPECIFIED` (A-M01-06).
 */
export function normalisePool(venue: VenueId, decodedPool: Account, vaults: { baseVault: Account; quoteVault: Account } | null,
  mint: { address: Pubkey; supplyBase: BaseUnits; decimals: number | null }, ctx: NormaliseContext): Result<CpPoolState, NormaliseError> {
  const common = { poolId: ctx.poolId, asOfSlot: ctx.asOfSlot, commitment: ctx.commitment, observedAtMs: ctx.observedAtMs, baseMintSupply: mint.supplyBase, baseDecimals: mint.decimals };
  if (venue === 'pump_curve') {
    if (decodedPool.kind !== 'pump_bonding_curve') return fail('E_LAYOUT', 'not a bonding curve');
    return {
      ok: true,
      value: {
        ...common, venue, baseMint: mint.address, quoteMint: MINTS.wsol, baseReserve: decodedPool.virtualToken, quoteReserveReal: decodedPool.realQuote,
        quoteReserveVirtual: decodedPool.virtualQuote - decodedPool.realQuote, isCanonical: null, curveComplete: decodedPool.complete,
        coinCreatorSet: decodedPool.creator !== DEFAULT_PUBKEY, creatorFeeBps: 0, isMayhemMode: false, realBaseReserve: decodedPool.realToken, swappedMints: false,
      },
    };
  }
  if (venue !== 'pumpswap') return fail('E_VENUE_NOT_SPECIFIED', `${venue} until A-M01-06`);
  if (decodedPool.kind !== 'pumpswap_pool') return fail('E_LAYOUT', 'not a PumpSwap pool');
  if (vaults === null) return fail('E_LAYOUT', 'vaults missing');
  const p = decodedPool;
  let token: Pubkey;
  let tokenVault: Account;
  let solVault: Account;
  let swapped: boolean;
  if (p.quoteMint === MINTS.wsol && p.baseMint !== MINTS.wsol) {
    [token, tokenVault, solVault, swapped] = [p.baseMint, vaults.baseVault, vaults.quoteVault, false];
  } else if (p.baseMint === MINTS.wsol && p.quoteMint !== MINTS.wsol) {
    if (p.virtualQuoteReserves !== 0n) return fail('E_LAYOUT', 'a swapped pool with a virtual quote reserve on the token side');
    [token, tokenVault, solVault, swapped] = [p.quoteMint, vaults.quoteVault, vaults.baseVault, true];
  } else {
    return fail('E_NOT_SOL_QUOTED', 'neither mint is wSOL');
  }
  if (mint.address !== token) return fail('E_LAYOUT', 'the mint read is not the pool token');
  const base = vaultAmount(tokenVault, token, ctx.poolId, 'token');
  if (!base.ok) return base;
  const quote = vaultAmount(solVault, MINTS.wsol, ctx.poolId, 'SOL');
  if (!quote.ok) return quote;
  return {
    ok: true,
    value: {
      ...common, venue, baseMint: token, quoteMint: MINTS.wsol, baseReserve: base.value, quoteReserveReal: quote.value as Lamports,
      quoteReserveVirtual: swapped ? 0n : p.virtualQuoteReserves, isCanonical: ctx.canonicalCreator === null ? null : p.creator === ctx.canonicalCreator,
      curveComplete: null, coinCreatorSet: p.coinCreator !== DEFAULT_PUBKEY, creatorFeeBps: p.creatorFeeBps, isMayhemMode: p.isMayhemMode,
      realBaseReserve: null, swappedMints: swapped,
    },
  };
}

export type SwapEvent = Extract<DecodedEvent, { kind: 'pumpswap_buy' | 'pumpswap_sell' }>;
export interface OrientationResult { status: 'pass' | 'fail' | 'not_evaluable'; observedBps: number | null; reason: string }
/** Ruling Z07-20: `venue.orientation.tolerance_bps` is retired; the band is fixed (`ORIENTATION_BAND_FACTOR`). */
export interface OrientationSettings { maxSlotGap: number }

/**
 * Ruling Z07-20 (SPEC-A C-86): the check exists to detect INVERSION, which the mint-based guard (`normalisePool`) is
 * the primary defence against. A swap fails only when its price is more than a factor of 10 from the model's
 * (|log10(swap / model)| > 1). At 1% it failed 58 of 171 real CORE-2 swaps on earlier-slot snapshots, and a
 * quarantine never clears. An inverted pool whose raw price ratio is within about [0.316, 3.16] (the inverse is then
 * within a factor 10 of the price) cannot be told apart by price; the mint guard covers it.
 */
export const ORIENTATION_BAND_FACTOR = 10n;

const BPS = 10_000n;
/**
 * POLICY (card Z07): a swap whose own quote amount is under 10,000 lamports is not evaluable: one lamport of rounding
 * is then more than 1 bp, and the recorded dust buys (164 lamports) differ from the model by up to 129 bps from rounding
 * alone. The test reads the event's amount, never the model's, so an inverted model cannot hide behind it.
 */
export const MIN_EVALUABLE_LAMPORTS = 10_000n;
/** True when `event` is more than `ORIENTATION_BAND_FACTOR` times `model`, or less than its tenth. */
const outsideBand = (event: bigint, model: bigint): boolean => event * ORIENTATION_BAND_FACTOR < model || event > model * ORIENTATION_BAND_FACTOR;
const absBps = (event: bigint, model: bigint): number => {
  const d = event > model ? event - model : model - event;
  return Number((d * BPS + model - 1n) / model);                  // ceil: never under-report a deviation
};

/**
 * Logic 5 (modelled-price method, see the header): one swap against our snapshot `p` from before it. A sell's gross
 * quote out is floor(Q·t / (B + t)); a buy of exactly b tokens costs ceil(Q·b / (B − b)) before fees. `observedBps` is
 * |event / model − 1| in bps, rounded up, for the record; `fail` when the event is more than a factor of 10 from the
 * model either way (Z07-20), or when the model cannot fill the event's base amount at all (an inverted pool).
 */
export function checkOrientation(p: CpPoolState, e: SwapEvent, s: OrientationSettings): OrientationResult {
  if (e.pool !== p.poolId) return { status: 'not_evaluable', observedBps: null, reason: 'another pool' };
  if (p.asOfSlot >= e.slot || e.slot - 1n - p.asOfSlot > BigInt(s.maxSlotGap)) return { status: 'not_evaluable', observedBps: null, reason: 'no snapshot before the swap within the slot gap' };
  const Q = p.quoteReserveReal + p.quoteReserveVirtual;
  const B = p.baseReserve;
  if (Q <= 0n || B <= 0n || e.baseAmount <= 0n) return { status: 'not_evaluable', observedBps: null, reason: 'empty pool or zero swap' };
  if (e.quoteAmount < MIN_EVALUABLE_LAMPORTS) return { status: 'not_evaluable', observedBps: null, reason: 'swap too small to compare' };
  let observed: number;
  let outside: boolean;
  if (e.kind === 'pumpswap_sell') {
    const model = (Q * e.baseAmount) / (B + e.baseAmount);
    if (model === 0n) return { status: 'fail', observedBps: null, reason: 'the model gives nothing for the base amount' };
    observed = absBps(e.quoteAmount, model);
    outside = outsideBand(e.quoteAmount, model);
  } else {
    if (e.baseAmount >= B) return { status: 'fail', observedBps: null, reason: 'the model cannot fill the base amount' };
    const model = (Q * e.baseAmount + B - e.baseAmount - 1n) / (B - e.baseAmount);
    const total = BigInt(e.lpFeeBps + e.protocolFeeBps + e.coinCreatorFeeBps);
    const asSpend = (e.quoteAmount * BPS) / (BPS + total);           // quote_amount_in as a spend limit, fees taken out
    observed = Math.min(absBps(e.quoteAmount, model), absBps(asSpend, model));
    outside = outsideBand(e.quoteAmount, model) && outsideBand(asSpend, model);
  }
  return outside
    ? { status: 'fail', observedBps: observed, reason: `swap price ${observed} bps from the model, past a factor of 10` }
    : { status: 'pass', observedBps: observed, reason: 'within a factor of 10' };
}
