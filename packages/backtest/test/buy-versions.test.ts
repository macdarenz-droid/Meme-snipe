// The two PumpSwap BuyEvent layouts (RES-2 review): `buy` events (489 bytes) log net quote in n7 and the total in
// n13; `buy_exact_quote_in(_v2)` events (504 bytes: the ix_name string is 15 bytes longer) log the spend limit in
// n7 and the net in n13. The backtest must replay both exactly and report what the trader really paid.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { bps } from '../../core/src/units/index.ts';
import type { AmmSwapRow } from '../src/dataset/rows.ts';
import { Market, type PoolView } from '../src/sim/market.ts';

type Str = Record<string, string>;
interface V { signature: string; slot: number; kind: 'buy' | 'sell'; ixName: string; ixDisc: string; args: [string, string]; event: Str }
const golden = JSON.parse(readFileSync(join(import.meta.dirname, '../../core/test/amm/fixtures/golden.json'), 'utf8')) as { pumpswap: V[] };
const V2 = ['5df6823ce7e940b2', 'c2ab1c46684d5b2f', 'b817ee6167c5d33d'];
const n = (s: string | undefined) => BigInt(s ?? 'missing');

/** A golden swap as DATA-1 writes it: quote_amount = n7 (quote_amount_in / _out), user_quote_amount = n13. */
const rowOf = (v: V, k: number): AmmSwapRow => {
  const e = v.event;
  const exact = v.kind === 'buy' && v.ixName !== 'buy';
  const quoteAmount = n(v.kind === 'buy' ? e['quote_amount_in'] : e['quote_amount_out']);
  const baseAmount = n(v.kind === 'buy' ? e['base_amount_out'] : e['base_amount_in']);
  return {
    kind: 'amm', slot: BigInt(k + 1), blockTime: 1, txIdx: 0, evIdx: 0, signature: v.signature, pool: `pool-${k}`, baseMint: `mint-${k}`, quoteMint: 'q',
    side: v.kind, mode: exact ? 'exact-quote-in' : 'exact-base', amount: exact ? quoteAmount : baseAmount, baseAmount, quoteAmount,
    userQuote: n(v.kind === 'buy' ? e['user_quote_amount_in'] : e['user_quote_amount_out']),
    pre: { baseReserve: n(e['pool_base_token_reserves']), quoteVault: n(e['pool_quote_token_reserves']), virtualQuoteReserves: n(e['virtual_quote_reserves'] ?? '0') },
    fees: { split: { lp: bps(+e['lp_fee_basis_points']!), protocol: bps(+e['protocol_fee_basis_points']!), creator: bps(+e['coin_creator_fee_basis_points']!) },
      buybackFeeBps: bps(+e['buyback_fee_basis_points']!), instruction: V2.includes(v.ixDisc) ? 'v2' : 'v1' },
    baseSupply: n(e['base_supply']), ixName: v.ixName, user: 'u', userTokenAccount: 'a', userTokenOwner: 'u',
  };
};

describe('both BuyEvent layouts', () => {
  // Recorded receipt times: each pool state is released with its row.
  const market = new Market({ heartbeatBlocks: 1_000, discoveryLag: () => 1, active: () => false, observe: null, volumeWindowSlots: 150, hook: () => {}, hasRows: () => true, schedule: () => {} });
  const cases = golden.pumpswap.map((v, k) => {
    const e = market.release(rowOf(v, k))[0];
    return { v, view: e?.kind === 'market' ? (e.value as PoolView) : null };
  });

  test('the golden set holds both layouts: exact-quote-in buys (504-byte events) and plain buys (489-byte events)', () => {
    const exact = golden.pumpswap.filter((v) => v.kind === 'buy' && v.ixName !== 'buy');
    const plain = golden.pumpswap.filter((v) => v.ixName === 'buy');
    expect(exact.length).toBeGreaterThanOrEqual(10);
    expect(plain.length).toBeGreaterThanOrEqual(10);
    expect(exact.some((v) => V2.includes(v.ixDisc))).toBe(true);
    // In the exact-quote-in layout n7 (quote_amount_in) is the spend limit, at or above the net n13.
    for (const v of exact) expect(n(v.event['quote_amount_in'])).toBeGreaterThanOrEqual(n(v.event['user_quote_amount_in']));
  });

  test.each(golden.pumpswap.map((v, k) => [`${v.ixName} ${v.signature.slice(0, 10)}`, k] as const))('%s: tokens and the trader\'s total are exact', (_, k) => {
    const { v, view } = cases[k]!;
    const e = v.event;
    expect(view).not.toBeNull();
    if (v.kind === 'sell') {
      expect(view!.userQuote).toBe(n(e['user_quote_amount_out']));
      return;
    }
    expect(view!.baseAmount).toBe(n(e['base_amount_out']));
    // Total paid: net + LP fee (n12) + protocol fee + creator fee, in both layouts.
    const total = n(e['quote_amount_in_with_lp_fee']) + n(e['protocol_fee']) + n(e['coin_creator_fee']);
    expect(view!.userQuote).toBe(total);
    // The plain layout logs that total in n13.
    if (v.ixName === 'buy') expect(total).toBe(n(e['user_quote_amount_in']));
  });
});
