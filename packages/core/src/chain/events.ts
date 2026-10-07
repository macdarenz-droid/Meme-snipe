// pump and PumpSwap events, hand-written from the pinned IDLs (pump-public-docs cb188ce). Both programs emit each
// event twice: as a `Program data:` log line (Anchor `emit!`) and as a self-CPI inner instruction (`emit_cpi!`,
// data = EVENT_IX_TAG + discriminator + borsh). Inner instructions are complete; logs can be truncated, so the
// log reader reports truncation. Events of failed transactions were rolled back and are never returned.
import { type Address, DecodeError, Reader, toHex } from './bytes.ts';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM } from './programs.ts';
import { type Decoded, type LayoutValue, bool, hasDiscriminator, i128, i64, layout, pubkey, readLayout, string, struct, u16, u64, u8, vec } from './schema.ts';

/** Anchor's EVENT_IX_TAG, the u64 0x1d9acb512ea545e4 (= sha256("anchor:event")[0..8] read big-endian) written little-endian: the first 8 bytes of every `emit_cpi!` instruction. */
export const EVENT_IX_TAG = Uint8Array.of(0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d);

export const Shareholder = struct('Shareholder', [
  ['address', pubkey],
  ['shareBps', u16],
] as const);

// pump
export const TradeEventLayout = layout(
  'TradeEvent',
  [189, 219, 127, 211, 78, 230, 97, 238],
  [
    ['mint', pubkey],
    ['solAmount', u64],
    ['tokenAmount', u64],
    ['isBuy', bool],
    ['user', pubkey],
    ['timestamp', i64],
    ['virtualSolReserves', u64],
    ['virtualTokenReserves', u64],
    ['realSolReserves', u64],
    ['realTokenReserves', u64],
  ],
  [
    ['feeRecipient', pubkey],
    ['feeBasisPoints', u64],
    ['fee', u64],
    ['creator', pubkey],
    ['creatorFeeBasisPoints', u64],
    ['creatorFee', u64],
    ['trackVolume', bool],
    ['totalUnclaimedTokens', u64],
    ['totalClaimedTokens', u64],
    ['currentSolVolume', u64],
    ['lastUpdateTimestamp', i64],
    ['ixName', string],
    ['mayhemMode', bool],
    ['cashbackFeeBasisPoints', u64],
    ['cashback', u64],
    ['buybackFeeBasisPoints', u64],
    ['buybackFee', u64],
    ['shareholders', vec(Shareholder)],
    ['quoteMint', pubkey],
    ['quoteAmount', u64],
    ['virtualQuoteReserves', u64],
    ['realQuoteReserves', u64],
    ['holderRewardsBps', u64],
    ['holderRewards', u64],
  ],
);

// pump
export const CreateEventLayout = layout(
  'CreateEvent',
  [27, 114, 169, 77, 222, 235, 99, 118],
  [
    ['name', string],
    ['symbol', string],
    ['uri', string],
    ['mint', pubkey],
    ['bondingCurve', pubkey],
    ['user', pubkey],
    ['creator', pubkey],
    ['timestamp', i64],
  ],
  [
    ['virtualTokenReserves', u64],
    ['virtualSolReserves', u64],
    ['realTokenReserves', u64],
    ['tokenTotalSupply', u64],
    ['tokenProgram', pubkey],
    ['isMayhemMode', bool],
    ['isCashbackEnabled', bool],
    ['quoteMint', pubkey],
    ['virtualQuoteReserves', u64],
    ['creatorFeeBps', u64],
    ['isHolderReward', bool],
  ],
);

// pump
export const CompleteEventLayout = layout(
  'CompleteEvent',
  [95, 114, 97, 156, 212, 46, 152, 8],
  [
    ['user', pubkey],
    ['mint', pubkey],
    ['bondingCurve', pubkey],
    ['timestamp', i64],
  ],
  [
    ['quoteMint', pubkey],
  ],
);

// pump
export const CompletePumpAmmMigrationEventLayout = layout(
  'CompletePumpAmmMigrationEvent',
  [189, 233, 93, 185, 92, 148, 234, 148],
  [
    ['user', pubkey],
    ['mint', pubkey],
    ['mintAmount', u64],
    ['solAmount', u64],
    ['poolMigrationFee', u64],
    ['bondingCurve', pubkey],
    ['timestamp', i64],
    ['pool', pubkey],
  ],
  [
    ['quoteMint', pubkey],
  ],
);

// pump_amm
export const BuyEventLayout = layout(
  'BuyEvent',
  [103, 244, 82, 31, 44, 245, 119, 119],
  [
    ['timestamp', i64],
    ['baseAmountOut', u64],
    ['maxQuoteAmountIn', u64],
    ['userBaseTokenReserves', u64],
    ['userQuoteTokenReserves', u64],
    ['poolBaseTokenReserves', u64],
    ['poolQuoteTokenReserves', u64],
    ['quoteAmountIn', u64],
    ['lpFeeBasisPoints', u64],
    ['lpFee', u64],
    ['protocolFeeBasisPoints', u64],
    ['protocolFee', u64],
    ['quoteAmountInWithLpFee', u64],
    ['userQuoteAmountIn', u64],
    ['pool', pubkey],
    ['user', pubkey],
    ['userBaseTokenAccount', pubkey],
    ['userQuoteTokenAccount', pubkey],
    ['protocolFeeRecipient', pubkey],
    ['protocolFeeRecipientTokenAccount', pubkey],
  ],
  [
    ['coinCreator', pubkey],
    ['coinCreatorFeeBasisPoints', u64],
    ['coinCreatorFee', u64],
    ['trackVolume', bool],
    ['totalUnclaimedTokens', u64],
    ['totalClaimedTokens', u64],
    ['currentSolVolume', u64],
    ['lastUpdateTimestamp', i64],
    ['minBaseAmountOut', u64],
    ['ixName', string],
    ['cashbackFeeBasisPoints', u64],
    ['cashback', u64],
    ['buybackFeeBasisPoints', u64],
    ['buybackFee', u64],
    ['virtualQuoteReserves', i128],
    ['canBoost', bool],
    ['baseSupply', u64],
    ['holderRewardsBps', u64],
    ['holderRewards', u64],
  ],
);

// pump_amm
export const SellEventLayout = layout(
  'SellEvent',
  [62, 47, 55, 10, 165, 3, 220, 42],
  [
    ['timestamp', i64],
    ['baseAmountIn', u64],
    ['minQuoteAmountOut', u64],
    ['userBaseTokenReserves', u64],
    ['userQuoteTokenReserves', u64],
    ['poolBaseTokenReserves', u64],
    ['poolQuoteTokenReserves', u64],
    ['quoteAmountOut', u64],
    ['lpFeeBasisPoints', u64],
    ['lpFee', u64],
    ['protocolFeeBasisPoints', u64],
    ['protocolFee', u64],
    ['quoteAmountOutWithoutLpFee', u64],
    ['userQuoteAmountOut', u64],
    ['pool', pubkey],
    ['user', pubkey],
    ['userBaseTokenAccount', pubkey],
    ['userQuoteTokenAccount', pubkey],
    ['protocolFeeRecipient', pubkey],
    ['protocolFeeRecipientTokenAccount', pubkey],
  ],
  [
    ['coinCreator', pubkey],
    ['coinCreatorFeeBasisPoints', u64],
    ['coinCreatorFee', u64],
    ['cashbackFeeBasisPoints', u64],
    ['cashback', u64],
    ['buybackFeeBasisPoints', u64],
    ['buybackFee', u64],
    ['virtualQuoteReserves', i128],
    ['canBoost', bool],
    ['baseSupply', u64],
    ['holderRewardsBps', u64],
    ['holderRewards', u64],
  ],
);

// pump_amm
export const CreatePoolEventLayout = layout(
  'CreatePoolEvent',
  [177, 49, 12, 210, 160, 118, 167, 116],
  [
    ['timestamp', i64],
    ['index', u16],
    ['creator', pubkey],
    ['baseMint', pubkey],
    ['quoteMint', pubkey],
    ['baseMintDecimals', u8],
    ['quoteMintDecimals', u8],
    ['baseAmountIn', u64],
    ['quoteAmountIn', u64],
    ['poolBaseAmount', u64],
    ['poolQuoteAmount', u64],
    ['minimumLiquidity', u64],
    ['initialLiquidity', u64],
    ['lpTokenAmountOut', u64],
    ['poolBump', u8],
    ['pool', pubkey],
    ['lpMint', pubkey],
    ['userBaseTokenAccount', pubkey],
    ['userQuoteTokenAccount', pubkey],
  ],
  [
    ['coinCreator', pubkey],
    ['isMayhemMode', bool],
    ['creatorFeeBps', u64],
    ['canEditCreatorFee', bool],
    ['isHolderReward', bool],
  ],
);

// pump_amm
export const InitBoostEventLayout = layout(
  'InitBoostEvent',
  [174, 124, 74, 249, 4, 81, 246, 17],
  [
    ['timestamp', i64],
    ['mint', pubkey],
    ['bondingCurve', pubkey],
    ['pool', pubkey],
    ['virtualQuoteReserves', i128],
    ['realQuoteReservesAfter', u64],
  ],
  [
  ],
);

// pump_amm
export const BoostBuyAndBurnEventLayout = layout(
  'BoostBuyAndBurnEvent',
  [63, 69, 28, 22, 48, 92, 194, 185],
  [
    ['timestamp', i64],
    ['mint', pubkey],
    ['bondingCurve', pubkey],
    ['pool', pubkey],
    ['authority', pubkey],
    ['quoteAmountInRequested', u64],
    ['quoteAmountInUsed', u64],
    ['baseAmountBurned', u64],
    ['virtualQuoteReserves', i128],
    ['realQuoteReservesAfter', u64],
    ['baseReservesAfter', u64],
    ['boostVaultRemaining', u64],
  ],
  [
  ],
);


export type TradeEvent = LayoutValue<typeof TradeEventLayout>;
export type CreateEvent = LayoutValue<typeof CreateEventLayout>;
export type CompleteEvent = LayoutValue<typeof CompleteEventLayout>;
export type CompletePumpAmmMigrationEvent = LayoutValue<typeof CompletePumpAmmMigrationEventLayout>;
export type BuyEvent = LayoutValue<typeof BuyEventLayout>;
export type SellEvent = LayoutValue<typeof SellEventLayout>;
export type CreatePoolEvent = LayoutValue<typeof CreatePoolEventLayout>;
export type InitBoostEvent = LayoutValue<typeof InitBoostEventLayout>;
export type BoostBuyAndBurnEvent = LayoutValue<typeof BoostBuyAndBurnEventLayout>;

export type PumpEventData =
  | { readonly program: 'pump'; readonly name: 'TradeEvent'; readonly data: TradeEvent }
  | { readonly program: 'pump'; readonly name: 'CreateEvent'; readonly data: CreateEvent }
  | { readonly program: 'pump'; readonly name: 'CompleteEvent'; readonly data: CompleteEvent }
  | { readonly program: 'pump'; readonly name: 'CompletePumpAmmMigrationEvent'; readonly data: CompletePumpAmmMigrationEvent }
  | { readonly program: 'pump_amm'; readonly name: 'BuyEvent'; readonly data: BuyEvent }
  | { readonly program: 'pump_amm'; readonly name: 'SellEvent'; readonly data: SellEvent }
  | { readonly program: 'pump_amm'; readonly name: 'CreatePoolEvent'; readonly data: CreatePoolEvent }
  | { readonly program: 'pump_amm'; readonly name: 'InitBoostEvent'; readonly data: InitBoostEvent }
  | { readonly program: 'pump_amm'; readonly name: 'BoostBuyAndBurnEvent'; readonly data: BoostBuyAndBurnEvent };

export type EventName = PumpEventData['name'];
export type EventProgram = PumpEventData['program'];

/** An event from these programs that this module does not decode (e.g. admin events). Kept, not dropped. */
export interface OtherEvent {
  readonly program: EventProgram;
  readonly name: 'other';
  readonly discriminator: string;
}

/**
 * `trailing` counts bytes after the last field of the pinned IDL and `extra` holds them as hex. They are kept, never
 * interpreted: since the unannounced 2026-10-02 upgrade (PumpSwap from slot 452,654,883, pump from 452,654,933) both
 * programs append 8 undocumented bytes to TradeEvent, BuyEvent and SellEvent (absent from pump-public-docs cb188ce, the
 * npm SDKs and the on-chain IDL accounts). On SOL PumpSwap pools they are the unswept creator fee as a u64 (TAIL-PROOF;
 * GATE-1c reads them in `gates/tails.ts`); every documented field before them decodes and cross-checks unchanged (test/chain/events.test.ts, test/chain/upgrade.test.ts; venues.md 2.7).
 */
export type ProgramEvent = (PumpEventData & { readonly trailing: number; readonly extra: string }) | OtherEvent;

/**
 * POOL-FIRST-READ part 2: PumpSwap events this module does not decode, proven on mainnet to leave every pool's base
 * vault, quote vault and virtual quote reserves unchanged (research/pool-noop-events: the pool's swap before and the
 * one after chain exactly across each, on contiguous tapes). Anchor event discriminators, sha256("event:<Name>")[0..8].
 * Only these exact discriminators; any other unnamed PumpSwap event may move the reserves.
 */
export const PUMP_AMM_NO_CHANGE_EVENTS: ReadonlyMap<string, string> = new Map([
  ['929fbdac925838f4', 'CloseUserVolumeAccumulatorEvent'],
  ['6161d7905d92167c', 'ExtendAccountEvent'],
]);

/** True for a PumpSwap event in `PUMP_AMM_NO_CHANGE_EVENTS` (an unnamed one carrying its discriminator). */
export const isNoChangePoolEvent = (e: unknown): boolean => {
  if (typeof e !== 'object' || e === null) return false;
  const x = e as { program?: unknown; name?: unknown; discriminator?: unknown };
  return x.program === 'pump_amm' && x.name === 'other' && typeof x.discriminator === 'string' && PUMP_AMM_NO_CHANGE_EVENTS.has(x.discriminator);
};

type AnyLayout = { name: string; discriminator: Uint8Array; base: readonly unknown[]; added: readonly unknown[] };
const LAYOUTS: Record<EventProgram, readonly AnyLayout[]> = {
  pump: [TradeEventLayout, CreateEventLayout, CompleteEventLayout, CompletePumpAmmMigrationEventLayout],
  pump_amm: [BuyEventLayout, SellEventLayout, CreatePoolEventLayout, InitBoostEventLayout, BoostBuyAndBurnEventLayout],
};

export const programName = (programId: Address | string): EventProgram | null =>
  programId === PUMP_PROGRAM ? 'pump' : programId === PUMP_AMM_PROGRAM ? 'pump_amm' : null;

/**
 * Decodes `discriminator (8) + borsh body` emitted by `program`. A known discriminator with a body that does not
 * fit its layout throws; an unknown discriminator returns kind 'other'.
 */
export const decodeEventBytes = (program: EventProgram, bytes: Uint8Array): ProgramEvent => {
  if (bytes.length < 8) throw new DecodeError(`event of ${bytes.length} bytes has no discriminator`);
  for (const l of LAYOUTS[program]) {
    if (!hasDiscriminator(bytes, l.discriminator)) continue;
    const decoded = readLayout(l as never, new Reader(bytes, 8)) as Decoded<never>;
    const extra = toHex(bytes.subarray(bytes.length - decoded.trailing));
    return { program, name: l.name, data: decoded.value, trailing: decoded.trailing, extra } as ProgramEvent;
  }
  return { program, name: 'other', discriminator: toHex(bytes.subarray(0, 8)) };
};

/** Decodes a self-CPI event instruction's data, or returns null when the data is not an event (no tag). */
export const decodeEventInstruction = (program: EventProgram, data: Uint8Array): ProgramEvent | null => {
  if (!hasDiscriminator(data, EVENT_IX_TAG)) return null;
  return decodeEventBytes(program, data.subarray(8));
};
