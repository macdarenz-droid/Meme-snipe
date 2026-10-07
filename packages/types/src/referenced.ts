// Types the shared contract references whose semantic owner is another module (ARCH 18 cross-group contracts;
// B-M19-01 decision recorded in the C01 PR). `@bot/types` has no dependencies and every other package depends on
// it, so it cannot import these from their owners. They are defined here once, copied verbatim from the owning
// ARCH section, and the owners import them from `@bot/types` (lint rule `bot/no-shared-type-redefinition`).
import type { Bps, DecimalStr, BaseUnits, BlockHeight, Cu, Lamports, MicroLamportsPerCu, Pubkey, Signature, Slot } from './types.ts';

// ---- M01 venue registry and quote model (semantic owner: M01, group A) ----
export type VenueId = 'pump_curve' | 'pumpswap' | 'raydium_amm_v4' | 'raydium_cpmm';   // v1 allowlist (D18)

export interface FeeSchedule {
  lpBps: Bps; protocolBps: Bps; creatorBps: Bps; totalBps: Bps;   // per side
  feeOnBuy: 'added_on_top' | 'from_input';                        // pump curve adds on top [EX-05]
  sourceAccount: Pubkey; asOfSlot: Slot; configHash: string;
}

export interface Quote {
  side: 'buy' | 'sell';
  amountIn: bigint;                    // lamports for buy, base units for sell
  amountOut: bigint;                   // base units for buy, lamports for sell
  venueFeeLamports: Lamports;          // lamports-equivalent
  priceImpactBps: Bps;                 // vs pre-trade spot
  spotBeforeSolPerToken: DecimalStr;
  feeSchedule: FeeSchedule; poolAsOfSlot: Slot;
}

// ---- M02 IDL decoders (semantic owner: M02, group A) ----
export type DecodedEvent =
  | { kind: 'pump_trade'; mint: Pubkey; isBuy: boolean; solAmount: Lamports; tokenAmount: BaseUnits; feeBps: Bps; fee: Lamports; creatorFeeBps: Bps; creatorFee: Lamports; quoteMint: Pubkey | null; slot: Slot; signature: Signature } // [EX-37]
  | { kind: 'pump_complete'; mint: Pubkey; slot: Slot; signature: Signature }
  | { kind: 'pump_migration'; mint: Pubkey; pool: Pubkey; baseAmount: BaseUnits; solAmount: Lamports; poolMigrationFee: Lamports; slot: Slot; signature: Signature } // [EX-03]
  | { kind: 'pumpswap_buy' | 'pumpswap_sell'; pool: Pubkey; baseAmount: BaseUnits; quoteAmount: Lamports; lpFeeBps: Bps; protocolFeeBps: Bps; coinCreatorFeeBps: Bps; virtualQuoteReserves: bigint; slot: Slot; signature: Signature } // [EX-37]
  | { kind: 'pumpswap_init_boost'; pool: Pubkey; virtualQuoteReserves: bigint; slot: Slot; signature: Signature } // [EX-V01]
  | { kind: 'unknown_event'; programId: Pubkey; discriminatorHex: string; signature: Signature };

// ---- M08 feature engine (semantic owner: M08, group A); dumpFlagState added by ARCH 5.0b I-26 ----
export interface Features { robustZ(poolId: Pubkey, lookbackMs: number): number | null; rollingMedian(poolId: Pubkey, windowMs: number): DecimalStr | null;
  madScale(poolId: Pubkey, windowMs: number): number | null; dumpFlag(poolId: Pubkey): boolean /* −4 × MAD rule [ST-V08] */;
  basketReturn(windowMs: number): number | null /* equal-weight log return of all watched pools' SOL prices, for the regime filter (8.1) */;
  dumpFlagState(poolId: Pubkey): 'dump' | 'clear' | 'insufficient' }   // ARCH 5.0b I-26 (C-18)

// ---- M16 transaction builder (semantic owner: M16, group B) ----
export interface UnsignedTx { messageBytes: Uint8Array; version: 0; lookupTables: Pubkey[]; feePayer: Pubkey;
  blockhash: string; lastValidBlockHeight: BlockHeight; cuLimit: Cu; cuPrice: MicroLamportsPerCu; tipLamports: Lamports;
  sellAmountBase: BaseUnits | null; balanceReadSlot: Slot | null; quote: Quote; minOut: bigint;
  declared: { purposeHint: 'buy' | 'exit' | 'sweep' | 'janitor'; programs: Pubkey[] } }   // informational only; the signer derives everything itself (M17)
