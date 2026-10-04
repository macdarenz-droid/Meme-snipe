// WATCH-1's coherent quote snapshot of a held position's PumpSwap pool: the pool, both vaults, the mint, PumpSwap's
// GlobalConfig and its pump-fees FeeConfig, read together in one getMultipleAccounts (one bank, one context slot). The
// pool state and the whole fee context come from that read alone, never from the feed's facts or observed swap terms,
// so a stop judged on it judges one moment of the chain. Pure: the reader passes the accounts in.
import type { PoolFeeContext, PoolState } from '../../../core/src/amm/index.ts';
import {
  type Address, NATIVE_MINT, NATIVE_MINT_2022, PUMP_AMM_GLOBAL_CONFIG, PUMP_AMM_PROGRAM, PUMP_FEES_PROGRAM, SYSTEM_PROGRAM, decodeFeeConfig, decodeGlobalConfig, decodeMint, decodePool,
  decodeTokenAccount, feeConfigAddress, feeSchedules, pumpPoolAuthority, toAddress,
} from '../../../core/src/chain/index.ts';
import { bps } from '../../../core/src/units/index.ts';

/** The account a read returns: its owner and raw data; null when it does not exist. */
export type ReadAccount = { readonly owner: string; readonly data: Uint8Array } | null;

export interface PoolSnapshot {
  readonly mint: string;
  readonly pool: string;
  /** The read's context slot: every account is as of the end of this slot. */
  readonly slot: bigint;
  readonly state: PoolState;
  readonly ctx: PoolFeeContext;
}

export const PUMP_AMM_FEE_CONFIG: Address = feeConfigAddress(PUMP_AMM_PROGRAM);

/** The snapshot's addresses, in read order: pool, base vault, quote vault, mint, GlobalConfig, FeeConfig. */
export const snapshotAddresses = (pool: string, baseVault: string, quoteVault: string, mint: string): string[] =>
  [pool, baseVault, quoteVault, mint, PUMP_AMM_GLOBAL_CONFIG, PUMP_AMM_FEE_CONFIG];

const SOL_QUOTES: ReadonlySet<string> = new Set([NATIVE_MINT, NATIVE_MINT_2022, SYSTEM_PROGRAM]);

/**
 * Decodes one coherent read (`accounts` in `snapshotAddresses` order) into the pool state and fee context, or says why
 * it cannot: a missing or foreign account, vaults or mint that are not the pool's, a quote that is not SOL. A pool
 * whose layout moved (other vaults) is refused, so the caller reads its layout again.
 */
export const decodeSnapshot = (mint: string, pool: string, slot: bigint, accounts: readonly ReadAccount[]): { readonly ok: true; readonly snapshot: PoolSnapshot } | { readonly ok: false; readonly reason: string } => {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (accounts.length !== 6) return no(`expected 6 accounts, got ${accounts.length}`);
  const [poolAcc, baseAcc, quoteAcc, mintAcc, globalAcc, feeAcc] = accounts;
  if (poolAcc == null || baseAcc == null || quoteAcc == null || mintAcc == null || globalAcc == null || feeAcc == null) return no('an account of the snapshot does not exist');
  try {
    if (poolAcc.owner !== PUMP_AMM_PROGRAM) return no('the pool is not a PumpSwap account');
    const p = decodePool(poolAcc.data).value;
    if (p.baseMint !== mint) return no(`the pool's base mint is ${p.baseMint}, not ${mint}`);
    if (!SOL_QUOTES.has(p.quoteMint)) return no(`quote mint ${p.quoteMint} is not SOL`);
    const base = decodeTokenAccount(baseAcc.data, toAddress(baseAcc.owner));
    const quote = decodeTokenAccount(quoteAcc.data, toAddress(quoteAcc.owner));
    if (base.mint !== p.baseMint || base.owner !== pool || quote.mint !== p.quoteMint || quote.owner !== pool) return no('the vaults read are not the pool\'s');
    const m = decodeMint(mintAcc.data, toAddress(mintAcc.owner));
    if (globalAcc.owner !== PUMP_AMM_PROGRAM) return no('GlobalConfig is not a PumpSwap account');
    const global = decodeGlobalConfig(globalAcc.data).value;
    if (feeAcc.owner !== PUMP_FEES_PROGRAM) return no('FeeConfig is not a pump-fees account');
    const fees = feeSchedules(decodeFeeConfig(feeAcc.data).value);
    const ext = (kind: string) => m.extensions.find((e) => e.kind === kind) as { readonly fields: Record<string, unknown> } | undefined;
    const tf = ext('TransferFeeConfig')?.fields as { olderTransferFee: { transferFeeBasisPoints: number }; newerTransferFee: { transferFeeBasisPoints: number } } | undefined;
    const hook = ext('TransferHook')?.fields as { programId: string | null } | undefined;
    const ctx: PoolFeeContext = {
      feeConfig: { flatFees: fees.flatFees, feeTiers: fees.feeTiers, exoticFlatFees: fees.exoticFlatFees },
      canonical: p.creator === pumpPoolAuthority(toAddress(mint)),
      quote: 'sol',
      baseSupply: m.supply,
      creatorFeeCharged: p.coinCreator !== SYSTEM_PROGRAM,
      ...(p.creatorFeeBps !== undefined && p.creatorFeeBps > 0n ? { creatorFeeOverride: bps(Number(p.creatorFeeBps)) } : {}),
      coin: {
        mayhemMode: p.isMayhemMode === true,
        transferFee: tf !== undefined && (tf.olderTransferFee.transferFeeBasisPoints > 0 || tf.newerTransferFee.transferFeeBasisPoints > 0),
        transferHook: hook !== undefined && hook.programId !== null,
      },
      // Our sells go through the v2 instruction (TX-1); prices are the same, only where fees land differs.
      instruction: 'v2',
      buybackFeeBps: bps(Number(global.buybackBasisPoints ?? 0n)),
    };
    return { ok: true, snapshot: { mint, pool, slot, state: { baseReserve: base.amount, quoteVault: quote.amount, virtualQuoteReserves: p.virtualQuoteReserves ?? 0n }, ctx } };
  } catch (e) {
    return no(`undecodable: ${e instanceof Error ? e.message : String(e)}`);
  }
};
