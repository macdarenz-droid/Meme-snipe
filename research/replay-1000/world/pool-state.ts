// REPLAY-1000: a PumpSwap pool's state after a transaction, rebuilt from that transaction alone.
// - Vault balances: the transaction's own post token balances (meta), exact.
// - `virtual_quote_reserves`: from the effective quote reserve E = quote vault + virtual. Every trade event states its
//   pre-trade vault and virtual reserves; a buy adds `quoteAmountInWithLpFee` to E and a sell removes
//   `quoteAmountOutWithoutLpFee` (v1 and v2 alike: v2 parks fees in the vault and lowers virtual by the same amount); the
//   fee sweeps move SOL out of the vault and raise virtual by the same amount (E unchanged, research/tail-proof); a
//   boost buy-and-burn states its post values. So virtual after the transaction = E after its last event − the quote
//   vault after it. `validate-pools.ts` checks this against every next trade's own pre-trade fields.
import { recordFromRpc, transactionEvents, type RpcTransactionBase64 } from '../../../packages/core/src/chain/index.ts';
import { accountKeys as messageKeys, decodeTransaction } from '../../../packages/core/src/chain/message.ts';

export interface RpcTx {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly meta: {
    readonly err: unknown;
    readonly preTokenBalances?: readonly TokenBal[];
    readonly postTokenBalances?: readonly TokenBal[];
    readonly preBalances?: readonly number[];
    readonly postBalances?: readonly number[];
    readonly loadedAddresses?: { readonly writable: readonly string[]; readonly readonly: readonly string[] };
    readonly logMessages?: readonly string[];
  };
  readonly transaction: readonly [string, string];
}
export interface TokenBal {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly programId?: string;
  readonly uiTokenAmount: { readonly amount: string; readonly decimals: number };
}

/** Every account key of a transaction in index order: static keys, then loaded writable, then loaded read-only. */
export const accountKeys = (signature: string, tx: RpcTx): string[] => {
  const rec = recordFromRpc(signature, tx as unknown as RpcTransactionBase64);
  return messageKeys(decodeTransaction(rec.transaction), rec.loadedAddresses).map(String);
};

/** The post (or pre) token balance of `address` in a transaction, or null when it is not listed. */
export const tokenBalance = (keys: readonly string[], tx: RpcTx, address: string, when: 'pre' | 'post'): bigint | null => {
  const i = keys.indexOf(address);
  if (i < 0) return null;
  const list = when === 'pre' ? tx.meta.preTokenBalances : tx.meta.postTokenBalances;
  const b = list?.find((x) => x.accountIndex === i);
  return b === undefined ? null : BigInt(b.uiTokenAmount.amount);
};

export interface PoolAfter {
  readonly baseVault: bigint;
  readonly quoteVault: bigint;
  /** null when the transaction holds no pool event and no earlier E is given. */
  readonly virtualQuoteReserves: bigint | null;
  /** E after the transaction, carried to the next one when it has no event. */
  readonly effective: bigint | null;
  /** Pre-trade fields of the first trade event (for validation against the previous transaction's result). */
  readonly firstPre: { readonly quoteVault: bigint; readonly baseVault: bigint; readonly virtual: bigint } | null;
  readonly events: readonly string[];
}

type D = Record<string, unknown>;

/**
 * The pool after one successful transaction. `prevEffective` is E after the pool's previous transaction (needed only
 * when this one has no pool event, as with a lone sweep). Null when the transaction does not touch either vault
 * (user volume accounts, an account extend): the pool's reserves are as before it.
 */
export const poolAfter = (signature: string, tx: RpcTx, pool: { readonly address: string; readonly baseVault: string; readonly quoteVault: string }, prevEffective: bigint | null): PoolAfter | null => {
  const keys = accountKeys(signature, tx);
  const qv = tokenBalance(keys, tx, pool.quoteVault, 'post');
  const bv = tokenBalance(keys, tx, pool.baseVault, 'post');
  if (qv === null || bv === null) return null; // the vaults are not in it: nothing it did moved them
  const events = transactionEvents(recordFromRpc(signature, tx as unknown as RpcTransactionBase64)).filter((e) => ((e as { data?: D }).data)?.['pool'] === pool.address);
  let effective = prevEffective;
  let firstPre: PoolAfter['firstPre'] = null;
  for (const e of events) {
    const d = (e as { data?: D }).data as D;
    const n = (k: string) => d[k] as bigint;
    if (e.name === 'BuyEvent' || e.name === 'SellEvent') {
      const pre = n('poolQuoteTokenReserves') + n('virtualQuoteReserves');
      firstPre ??= { quoteVault: n('poolQuoteTokenReserves'), baseVault: n('poolBaseTokenReserves'), virtual: n('virtualQuoteReserves') };
      effective = e.name === 'BuyEvent' ? pre + n('quoteAmountInWithLpFee') : pre - n('quoteAmountOutWithoutLpFee');
    } else if (e.name === 'BoostBuyAndBurnEvent' || e.name === 'InitBoostEvent') {
      effective = n('realQuoteReservesAfter') + n('virtualQuoteReserves');
    } else if (e.name === 'CreatePoolEvent') {
      effective = n('poolQuoteAmount');
    }
  }
  return { baseVault: bv, quoteVault: qv, virtualQuoteReserves: effective === null ? null : effective - qv, effective, firstPre, events: events.map((e) => e.name) };
};
