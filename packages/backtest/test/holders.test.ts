// HolderBook (BT-1d, schema 3): per token account, causal, owner from user_token_owner.
import { describe, expect, test } from 'vitest';
import { bps } from '../../core/src/units/index.ts';
import { HolderBook } from '../src/dataset/holders.ts';
import type { AmmSwapRow, CoverageRow, CurveTradeRow, MovementRow } from '../src/dataset/rows.ts';

const amm = (slot: number, txIdx: number, side: 'buy' | 'sell', base: bigint, over: Partial<AmmSwapRow> = {}): AmmSwapRow => ({
  kind: 'amm', slot: BigInt(slot), blockTime: slot, txIdx, evIdx: 0, signature: `s${slot}:${txIdx}`, pool: 'P', baseMint: 'M', quoteMint: 'Q', side,
  mode: 'exact-base', amount: base, baseAmount: base, quoteAmount: 0n, userQuote: 0n, pre: { baseReserve: 0n, quoteVault: 0n, virtualQuoteReserves: 0n },
  fees: { split: { lp: bps(0), protocol: bps(0), creator: bps(0) }, buybackFeeBps: bps(0), instruction: 'v1' }, baseSupply: 0n, ixName: side, user: 'SIGNER',
  userTokenAccount: 'acct-O', userTokenOwner: 'O', ...over,
});
const curve = (slot: number, isBuy: boolean, tokens: bigint, over: Partial<CurveTradeRow> = {}): CurveTradeRow => ({
  kind: 'curve', slot: BigInt(slot), blockTime: slot, txIdx: 0, evIdx: 0, signature: `c${slot}`, mint: 'C', isBuy, solAmount: 0n, tokenAmount: tokens,
  virtualSolReserves: 0n, virtualTokenReserves: 0n, realSolReserves: 0n, realTokenReserves: 0n, mayhem: false, quoteMint: '', user: 'SIGNER',
  userTokenAccount: 'acct-X', userTokenOwner: 'X', ...over,
});
const move = (slot: number, kind: MovementRow['kind'], from: string, to: string, amount: bigint, mint = 'M'): MovementRow => ({
  slot: BigInt(slot), blockTime: slot, txIdx: 1, outerIx: 0, innerIx: null, mint, kind, fromOwner: from, toOwner: to, amount,
  fromAccount: from === '' ? '' : `acct-${from}`, toAccount: to === '' ? '' : `acct-${to}`,
});
const balances = (b: HolderBook, mint = 'M') => {
  const h = b.holdersAsOf(mint);
  if (h.unresolved) throw new Error(`unresolved: ${h.reason}`);
  return Object.fromEntries(h.accounts.map((a) => [a.owner, a.amount]));
};

describe('HolderBook', () => {
  test('a swap credits its user token owner, never the signer; the venue takes the other side', () => {
    const b = new HolderBook();
    b.swap(amm(1, 0, 'buy', 100n));
    b.swap(amm(2, 0, 'sell', 40n));
    b.swap(curve(3, true, 7n));
    expect(balances(b)).toEqual({ O: 60n });
    expect(balances(b, 'C')).toEqual({ X: 7n });
    const h = b.holdersAsOf('M');
    expect(!h.unresolved && h.accounts[0]).toMatchObject({ address: 'acct-O', mint: 'M', ownerProgram: null, delegate: null, delegatedAmount: 0n });
    expect(!h.unresolved && h.venueNetChange).toBe(-60n);
  });

  test('a boost buy-and-burn credits nobody', () => {
    const b = new HolderBook();
    b.swap(amm(1, 0, 'buy', 100n, { ixName: 'boost_buy_and_burn', userTokenAccount: '', userTokenOwner: '' }));
    expect(balances(b)).toEqual({});
  });

  test('movements: a transfer moves, a burn only debits, a mint only credits; empty owners are left out', () => {
    const b = new HolderBook();
    b.swap(amm(1, 0, 'buy', 100n));
    b.movement(move(2, 'transfer', 'O', 'R', 30n));
    b.movement(move(3, 'burn', 'R', '', 5n));
    b.movement(move(4, 'mint', '', 'Z', 9n));
    b.movement(move(5, 'transfer', 'O', '', 1n));
    // The transfer with an empty destination owner is left out whole.
    expect(balances(b)).toEqual({ O: 70n, R: 25n, Z: 9n });
  });

  test('an empty swap owner makes the mint unresolved from that transaction on', () => {
    const b = new HolderBook();
    b.swap(amm(1, 0, 'buy', 100n));
    expect(balances(b)).toEqual({ O: 100n });
    b.swap(amm(2, 0, 'buy', 5n, { userTokenOwner: '' }));
    expect(b.holdersAsOf('M')).toEqual({ unresolved: true, reason: 'swap_owner_unknown', fromSlot: 2n });
  });

  test('coverage notes take effect only when the replay reaches them', () => {
    const coverage: CoverageRow[] = [{ mint: 'M', scope: 'unresolved', slot: 5n, reason: 'transfer_fee', count: 1, txIdx: 3, fromSlot: 1n, toSlot: 9n }];
    const b = new HolderBook(coverage);
    b.swap(amm(5, 2, 'buy', 10n));
    expect(balances(b)).toEqual({ O: 10n });
    b.swap(amm(5, 3, 'buy', 10n));
    expect(b.holdersAsOf('M')).toEqual({ unresolved: true, reason: 'transfer_fee', fromSlot: 5n });
  });

  test('activity in the lead-in without movements, and a mint searched only in its pump transactions, are unresolved', () => {
    const coverage: CoverageRow[] = [
      { mint: '*', scope: 'no_movements', slot: null, reason: 'lead_in', count: null, txIdx: null, fromSlot: 1n, toSlot: 10n },
      { mint: 'OTHER', scope: 'pump_transactions', slot: null, reason: '', count: null, txIdx: null, fromSlot: 20n, toSlot: 30n },
    ];
    const b = new HolderBook(coverage);
    b.swap(amm(3, 0, 'buy', 10n));
    b.swap(curve(15, true, 4n));
    b.swap(amm(25, 0, 'buy', 1n, { baseMint: 'OTHER' }));
    expect(b.holdersAsOf('M')).toMatchObject({ unresolved: true, reason: 'no_movements' });
    expect(balances(b, 'C')).toEqual({ X: 4n });
    expect(b.holdersAsOf('OTHER')).toMatchObject({ unresolved: true, reason: 'pump_transactions' });
  });

  test('delegates from account operations; an owner change or a negative balance makes the mint unresolved', () => {
    const b = new HolderBook();
    b.swap(amm(1, 0, 'buy', 100n));
    b.applyAccountOps({ slot: 2n, txIdx: 0 }, [{ kind: 'approve', mint: 'M', account: 'acct-O', delegate: 'D', amount: 50n }]);
    const h = b.holdersAsOf('M');
    expect(!h.unresolved && h.accounts[0]).toMatchObject({ delegate: 'D', delegatedAmount: 50n });
    b.applyAccountOps({ slot: 3n, txIdx: 0 }, [{ kind: 'revoke', mint: 'M', account: 'acct-O' }]);
    expect(b.holdersAsOf('M')).toMatchObject({ unresolved: false });
    b.applyAccountOps({ slot: 4n, txIdx: 0 }, [{ kind: 'owner', mint: 'M', account: 'acct-O', newOwner: 'N' }]);
    expect(b.holdersAsOf('M')).toMatchObject({ unresolved: true, reason: 'owner_change', fromSlot: 4n });
    const n = new HolderBook();
    n.swap(amm(1, 0, 'sell', 5n));
    expect(n.holdersAsOf('M')).toMatchObject({ unresolved: true, reason: 'negative_balance' });
    // Within one transaction the order of a swap and a movement does not matter.
    const t = new HolderBook();
    t.movement({ ...move(7, 'transfer', 'O', 'R', 10n), txIdx: 0 });
    t.swap(amm(7, 0, 'buy', 10n));
    expect(balances(t)).toEqual({ R: 10n });
  });

  test('inputs out of chain order are refused', () => {
    const b = new HolderBook();
    b.swap(amm(5, 2, 'buy', 1n));
    expect(() => b.swap(amm(5, 1, 'buy', 1n))).toThrow(/chain order/);
    expect(() => b.movement(move(4, 'mint', '', 'Z', 1n))).toThrow(/chain order/);
  });
});
