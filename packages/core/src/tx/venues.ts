// Swap instructions for the two venues, from the pinned IDLs (pump-public-docs cb188ce): the pump curve's unified
// v2 interface (`buy_exact_quote_in_v2`, `sell_v2`: every account mandatory, the same order for every coin) and
// PumpSwap's v1 `buy_exact_quote_in` / `sell` (supervisor ruling from the CORE-2b review: v1 on SOL pools until v2
// vault retention is verified there; docs/DECISIONS.md). PumpSwap's remaining accounts follow pump-swap-sdk 1.20.0
// (`pool-v2`, buyback fee recipient and its quote ATA), which the pinned IDL does not list. Every account list and
// data layout is compared byte for byte with real mainnet swaps in test/tx/golden.test.ts.
import {
  type Address,
  type BondingCurve,
  type Global,
  type GlobalConfig,
  NATIVE_MINT,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM,
  PUMP_FEE_CONFIG,
  PUMP_FEES_PROGRAM,
  PUMP_GLOBAL,
  PUMP_PROGRAM,
  type Pool,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  bondingCurveAddress,
} from '../chain/index.ts';
import { type AccountMeta, type Instruction, Writer, discriminator, ro, signerW, w } from './instruction.ts';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAddress,
  eventAuthority,
  globalVolumeAccumulator,
  poolCoinCreatorVaultAuthority,
  poolV2Address,
  pumpCreatorVault,
  sharingConfigAddress,
  userVolumeAccumulator,
} from './programs.ts';

/** Anchor discriminators (pinned IDLs; PumpSwap's v1 family). */
export const DISC = {
  curveBuyExactQuoteInV2: 'c2ab1c46684d5b2f',
  curveSellV2: '5df6823ce7e940b2',
  poolBuyExactQuoteIn: 'c62e1552b4d9e870',
  poolSell: '33e685a4017f83ad',
} as const;

/** All-zero key: `Pubkey::default()`, the "unset" value of pump's optional pubkey fields. */
const DEFAULT_KEY = SYSTEM_PROGRAM;
/** pump-swap-sdk `POOL_ACCOUNT_NEW_SIZE`: shorter pools need `extend_account` first, which we do not send. */
export const POOL_ACCOUNT_MIN_BYTES = 300;

export type Refusal = { readonly ok: false; readonly reason: BuildRefusal; readonly detail: string };
export type BuildRefusal =
  | 'unsupported-coin'
  | 'curve-complete'
  | 'not-sol-quoted'
  | 'missing-chain-field'
  | 'pool-layout-outdated'
  | 'unsupported-mint'
  | 'invalid-amount'
  | 'over-policy';
export const refuse = (reason: BuildRefusal, detail: string): Refusal => ({ ok: false, reason, detail });

const pick = <T>(list: readonly T[], index: number, what: string): T => {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError(`${what} index must be a non-negative integer`);
  return list[index % list.length]!;
};

// ---------- pump bonding curve ----------

export interface CurveMarket {
  readonly mint: Address;
  /** The mint's owner: SPL Token for old coins, Token-2022 for `create_v2` coins. */
  readonly baseTokenProgram: Address;
  readonly curve: BondingCurve;
  /** The curve account's data length: pump grows short (old) curves at the trader's expense. */
  readonly accountBytes: number;
  /** pump `Global`, for its fee-recipient lists only (prices come from the CORE-2 quote, not from here). */
  readonly pumpGlobal: Global;
}

export interface CurveAccounts {
  readonly feeRecipient: Address;
  readonly buybackFeeRecipient: Address;
  readonly userBaseAta: Address;
}

/**
 * Checks a curve can be traded by these builders and picks the fee recipients. `feeIndex` and `buybackIndex` come
 * from the engine's seeded randomness (pump asks integrators to spread write locks over the 8 recipients).
 */
export const curveAccounts = (m: CurveMarket, user: Address, feeIndex: number, buybackIndex: number): { ok: true; accounts: CurveAccounts } | Refusal => {
  if (m.curve.complete) return refuse('curve-complete', 'the curve has completed; trade on the pool');
  if (m.curve.isMayhemMode !== false) return refuse('unsupported-coin', 'mayhem-mode coin (or the flag is unread)');
  if (m.curve.isCashbackCoin === true) return refuse('unsupported-coin', 'cashback coin');
  if (m.curve.quoteMint !== undefined && m.curve.quoteMint !== DEFAULT_KEY && m.curve.quoteMint !== NATIVE_MINT) return refuse('not-sol-quoted', 'curve quote mint is not SOL');
  if (m.curve.creator === undefined) return refuse('missing-chain-field', 'curve creator is unread');
  if (m.baseTokenProgram !== TOKEN_PROGRAM && m.baseTokenProgram !== TOKEN_2022_PROGRAM) return refuse('unsupported-mint', 'base token program is not a token program');
  if (m.pumpGlobal.buybackFeeRecipients === undefined) return refuse('missing-chain-field', 'Global has no buyback fee recipients');
  const fee = pick([m.pumpGlobal.feeRecipient, ...m.pumpGlobal.feeRecipients], feeIndex, 'fee recipient');
  const buyback = pick(m.pumpGlobal.buybackFeeRecipients, buybackIndex, 'buyback fee recipient');
  return { ok: true, accounts: { feeRecipient: fee, buybackFeeRecipient: buyback, userBaseAta: associatedTokenAddress(user, m.mint, m.baseTokenProgram) } };
};

/** The 27 (buy) or 26 (sell) accounts of the v2 curve trades, in IDL order. Quote side is wrapped SOL on SPL Token. */
const curveMetas = (m: CurveMarket, a: CurveAccounts, user: Address, side: 'buy' | 'sell'): AccountMeta[] => {
  const quoteAta = (owner: Address) => associatedTokenAddress(owner, NATIVE_MINT, TOKEN_PROGRAM);
  const curve = bondingCurveAddress(m.mint);
  const creatorVault = pumpCreatorVault(m.curve.creator!);
  const uva = userVolumeAccumulator(PUMP_PROGRAM, user);
  return [
    ro(PUMP_GLOBAL),
    ro(m.mint),
    ro(NATIVE_MINT),
    ro(m.baseTokenProgram),
    ro(TOKEN_PROGRAM),
    ro(ASSOCIATED_TOKEN_PROGRAM),
    w(a.feeRecipient),
    w(quoteAta(a.feeRecipient)),
    w(a.buybackFeeRecipient),
    w(quoteAta(a.buybackFeeRecipient)),
    w(curve),
    w(associatedTokenAddress(curve, m.mint, m.baseTokenProgram)),
    w(quoteAta(curve)),
    signerW(user),
    w(a.userBaseAta),
    w(quoteAta(user)),
    w(creatorVault),
    w(quoteAta(creatorVault)),
    ro(sharingConfigAddress(m.mint)),
    ...(side === 'buy' ? [ro(globalVolumeAccumulator(PUMP_PROGRAM))] : []),
    w(uva),
    w(quoteAta(uva)),
    ro(PUMP_FEE_CONFIG),
    ro(PUMP_FEES_PROGRAM),
    ro(SYSTEM_PROGRAM),
    ro(eventAuthority(PUMP_PROGRAM)),
    ro(PUMP_PROGRAM),
  ];
};

/** `buy_exact_quote_in_v2(spendable_quote_in, min_tokens_out)`: spend at most `spend` lamports, fees included. */
export const curveBuyIx = (m: CurveMarket, a: CurveAccounts, user: Address, spend: bigint, minTokensOut: bigint): Instruction => ({
  programId: PUMP_PROGRAM,
  accounts: curveMetas(m, a, user, 'buy'),
  data: new Writer().bytes(discriminator(DISC.curveBuyExactQuoteInV2)).u64(spend).u64(minTokensOut).done(),
});

/** `sell_v2(amount, min_sol_output)`. */
export const curveSellIx = (m: CurveMarket, a: CurveAccounts, user: Address, tokens: bigint, minSolOut: bigint): Instruction => ({
  programId: PUMP_PROGRAM,
  accounts: curveMetas(m, a, user, 'sell'),
  data: new Writer().bytes(discriminator(DISC.curveSellV2)).u64(tokens).u64(minSolOut).done(),
});

// ---------- PumpSwap pool ----------

export interface PoolMarket {
  readonly pool: Address;
  readonly state: Pool;
  /** Account data length; pools shorter than `POOL_ACCOUNT_MIN_BYTES` need an `extend_account` we do not send. */
  readonly accountBytes: number;
  readonly baseTokenProgram: Address;
  /** PumpSwap `GlobalConfig`, for its fee-recipient lists. */
  readonly globalConfig: GlobalConfig;
}

export interface PoolAccounts {
  readonly protocolFeeRecipient: Address;
  readonly buybackFeeRecipient: Address;
  readonly userBaseAta: Address;
  /** The wrapped-SOL account the swap spends from (buy) or pays into (sell), created and closed in the same transaction. */
  readonly userQuoteAta: Address;
}

export const poolAccounts = (m: PoolMarket, user: Address, feeIndex: number, buybackIndex: number): { ok: true; accounts: PoolAccounts } | Refusal => {
  const p = m.state;
  if (p.quoteMint !== NATIVE_MINT) return refuse('not-sol-quoted', 'pool quote mint is not wrapped SOL');
  if (m.accountBytes < POOL_ACCOUNT_MIN_BYTES) return refuse('pool-layout-outdated', `pool account is ${m.accountBytes} bytes; it needs extend_account first`);
  if (p.isMayhemMode !== false) return refuse('unsupported-coin', 'mayhem-mode pool (or the flag is unread)');
  if (p.isCashbackCoin !== false) return refuse('unsupported-coin', 'cashback pool (or the flag is unread)');
  if (p.coinCreator === undefined) return refuse('missing-chain-field', 'pool coin creator is unread');
  if (m.baseTokenProgram !== TOKEN_PROGRAM && m.baseTokenProgram !== TOKEN_2022_PROGRAM) return refuse('unsupported-mint', 'base token program is not a token program');
  if (m.globalConfig.buybackFeeRecipients === undefined) return refuse('missing-chain-field', 'GlobalConfig has no buyback fee recipients');
  return {
    ok: true,
    accounts: {
      protocolFeeRecipient: pick(m.globalConfig.protocolFeeRecipients, feeIndex, 'protocol fee recipient'),
      buybackFeeRecipient: pick(m.globalConfig.buybackFeeRecipients, buybackIndex, 'buyback fee recipient'),
      userBaseAta: associatedTokenAddress(user, p.baseMint, m.baseTokenProgram),
      userQuoteAta: associatedTokenAddress(user, NATIVE_MINT, TOKEN_PROGRAM),
    },
  };
};

const poolMetas = (m: PoolMarket, a: PoolAccounts, user: Address, side: 'buy' | 'sell'): AccountMeta[] => {
  const p = m.state;
  const quoteAta = (owner: Address) => associatedTokenAddress(owner, NATIVE_MINT, TOKEN_PROGRAM);
  const vaultAuthority = poolCoinCreatorVaultAuthority(p.coinCreator!);
  return [
    w(m.pool),
    signerW(user),
    ro(PUMP_AMM_GLOBAL_CONFIG),
    ro(p.baseMint),
    ro(p.quoteMint),
    w(a.userBaseAta),
    w(a.userQuoteAta),
    w(p.poolBaseTokenAccount),
    w(p.poolQuoteTokenAccount),
    ro(a.protocolFeeRecipient),
    w(quoteAta(a.protocolFeeRecipient)),
    ro(m.baseTokenProgram),
    ro(TOKEN_PROGRAM),
    ro(SYSTEM_PROGRAM),
    ro(ASSOCIATED_TOKEN_PROGRAM),
    ro(eventAuthority(PUMP_AMM_PROGRAM)),
    ro(PUMP_AMM_PROGRAM),
    w(quoteAta(vaultAuthority)),
    ro(vaultAuthority),
    ...(side === 'buy' ? [ro(globalVolumeAccumulator(PUMP_AMM_PROGRAM)), w(userVolumeAccumulator(PUMP_AMM_PROGRAM, user))] : []),
    ro(PUMP_AMM_FEE_CONFIG),
    ro(PUMP_FEES_PROGRAM),
    // Remaining accounts (pump-swap-sdk 1.20.0): pool-v2 when the pool has a coin creator, then the buyback recipient.
    ...(p.coinCreator !== DEFAULT_KEY ? [ro(poolV2Address(p.baseMint))] : []),
    ro(a.buybackFeeRecipient),
    w(quoteAta(a.buybackFeeRecipient)),
  ];
};

/** `buy_exact_quote_in(spendable_quote_in, min_base_amount_out, track_volume = Some(true))`, as pump's SDK sends it. */
export const poolBuyIx = (m: PoolMarket, a: PoolAccounts, user: Address, spend: bigint, minBaseOut: bigint): Instruction => ({
  programId: PUMP_AMM_PROGRAM,
  accounts: poolMetas(m, a, user, 'buy'),
  data: new Writer().bytes(discriminator(DISC.poolBuyExactQuoteIn)).u64(spend).u64(minBaseOut).bool(true).done(),
});

/** `sell(base_amount_in, min_quote_amount_out)`. */
export const poolSellIx = (m: PoolMarket, a: PoolAccounts, user: Address, base: bigint, minQuoteOut: bigint): Instruction => ({
  programId: PUMP_AMM_PROGRAM,
  accounts: poolMetas(m, a, user, 'sell'),
  data: new Writer().bytes(discriminator(DISC.poolSell)).u64(base).u64(minQuoteOut).done(),
});
