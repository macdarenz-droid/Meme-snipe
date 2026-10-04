// POS-1: the pool state after a swap, live and in the backtest, is one implementation. The live worker derives it from
// the decoded Buy/SellEvent (core fills `swapEventState`); the backtest from DATA-1's amm row (`readAmm`, then
// `ShiftedPool.applyReal`). Both map the logged fields with core's `realSwap` and replay with `replaySwap`; this test
// proves the two paths give the same pool, to the unit, on every real mainnet swap of CORE-2's golden fixture, and that
// the state is the real one (the next swap's pre-trade reserves, the measured vault balances).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectiveQuoteReserve } from '../../core/src/amm/index.ts';
import { ShiftedPool, swapEventState, type SwapEvent } from '../../core/src/fills/index.ts';
import { readAmm, type AmmSwapRow, type DatasetRow } from '../src/dataset/rows.ts';

type Str = Record<string, string>;
interface PoolVector { signature: string; slot: number; eventIndex: number; kind: 'buy' | 'sell'; ixName: string; ixDisc: string; event: Str; pool: { address: string } }
interface VaultDelta { signature: string; eventIndex: number; quotePre: string; quotePost: string; basePre: string; basePost: string }
const golden = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'core', 'test', 'amm', 'fixtures', 'golden.json'), 'utf8')) as { pumpswap: PoolVector[]; vaultDeltas: VaultDelta[] };
// Anchor discriminator of sell_v2 (pump IDL): the event does not say it, so the replay takes the v1 split.
const SELL_V2 = '5df6823ce7e940b2';

/** The event as DEC-1 decodes it: camelCase fields, integers as bigint. Buys log their instruction name; sells none. */
const eventOf = (v: PoolVector): SwapEvent => {
  const data: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v.event)) data[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = /^-?\d+$/.test(x) ? BigInt(x) : x;
  if (v.kind === 'buy') data['ixName'] = v.ixName;
  return { program: 'pump_amm', name: v.kind === 'buy' ? 'BuyEvent' : 'SellEvent', data } as unknown as SwapEvent;
};

/** The same swap as DATA-1's amm_trades row (schema 3 columns), read by the backtest's own reader. */
const rowOf = (v: PoolVector): AmmSwapRow => {
  const e = v.event;
  const buy = v.kind === 'buy';
  const cols: Str = {
    slot: String(v.slot), block_time: '1790968137', tx_idx: '0', ev_idx: String(v.eventIndex), signature: v.signature, pool: v.pool.address,
    base_mint: 'base', quote_mint: 'So11111111111111111111111111111111111111112', side: v.kind,
    base_amount: buy ? e['base_amount_out']! : e['base_amount_in']!, quote_amount: buy ? e['quote_amount_in']! : e['quote_amount_out']!,
    user_quote_amount: buy ? e['user_quote_amount_in']! : e['user_quote_amount_out']!,
    pool_base_token_reserves: e['pool_base_token_reserves']!, pool_quote_token_reserves: e['pool_quote_token_reserves']!, virtual_quote_reserves: e['virtual_quote_reserves'] ?? '',
    lp_fee_basis_points: e['lp_fee_basis_points']!, protocol_fee_basis_points: e['protocol_fee_basis_points']!,
    coin_creator_fee_basis_points: e['coin_creator_fee_basis_points'] ?? '', buyback_fee_basis_points: e['buyback_fee_basis_points'] ?? '',
    base_supply: e['base_supply'] ?? '', ix_name: buy ? v.ixName : '', user: 'u', user_token_account: '', user_token_owner: '',
  };
  const names = Object.keys(cols);
  const out: DatasetRow[] = [];
  readAmm(`${names.join(',')}\n${names.map((n) => cols[n]).join(',')}\n`, out);
  return out[0] as AmmSwapRow;
};

describe('pool state after a swap: live event path and backtest row path (POS-1)', () => {
  it('every golden PumpSwap swap gives the same pool both ways, and reproduces its event', () => {
    expect(golden.pumpswap.length).toBeGreaterThanOrEqual(300);
    for (const v of golden.pumpswap) {
      const live = swapEventState(eventOf(v));
      if (!live.ok) throw new Error(`${v.signature}: ${live.reason}`);
      const backtest = new ShiftedPool().applyReal(rowOf(v));
      expect(backtest).not.toBeNull();
      expect(backtest!.real).toEqual(live.after);
      expect(backtest!.trade).toEqual(live.trade);
    }
  });

  it('the state is the chain\'s: the next swap in the same transaction starts from it', () => {
    let pairs = 0;
    golden.pumpswap.forEach((v, i) => {
      const next = golden.pumpswap[i + 1];
      if (next === undefined || next.signature !== v.signature || next.pool.address !== v.pool.address) return;
      const s = swapEventState(eventOf(v));
      if (!s.ok) throw new Error(s.reason);
      const pre = { baseReserve: BigInt(next.event['pool_base_token_reserves']!), effective: BigInt(next.event['pool_quote_token_reserves']!) + BigInt(next.event['virtual_quote_reserves'] ?? '0') };
      expect(s.after.baseReserve).toBe(pre.baseReserve);
      expect(effectiveQuoteReserve(s.after)).toBe(pre.effective);
      // Buys and v1 sells give the exact vault/virtual split too.
      if (v.kind === 'buy' || v.ixDisc !== SELL_V2) expect(s.after.quoteVault).toBe(BigInt(next.event['pool_quote_token_reserves']!));
      pairs++;
    });
    expect(pairs).toBeGreaterThanOrEqual(3);
  });

  it('measured vault balances: base and effective reserve exact; the vault exact except after a v2 sell, where it is the v1 lower bound', () => {
    const byKey = new Map(golden.pumpswap.map((v) => [`${v.signature}:${v.eventIndex}`, v]));
    for (const d of golden.vaultDeltas) {
      const v = byKey.get(`${d.signature}:${d.eventIndex}`)!;
      const s = swapEventState(eventOf(v));
      if (!s.ok) throw new Error(s.reason);
      expect(s.after.baseReserve - s.swap.pre.baseReserve).toBe(BigInt(d.basePost) - BigInt(d.basePre));
      if (v.kind === 'sell' && v.ixDisc === SELL_V2) {
        const retained = s.trade.protocolFee + s.trade.creatorFee - s.trade.buybackFee;
        expect(s.after.quoteVault + retained).toBe(BigInt(d.quotePost));
      } else expect(s.after.quoteVault).toBe(BigInt(d.quotePost));
    }
  });

  it('a swap whose logged amounts the replay does not reproduce gives no state', () => {
    const v = golden.pumpswap.find((x) => x.kind === 'buy')!;
    const e = eventOf(v);
    const bump = (k: string): SwapEvent => ({ ...e, data: { ...e.data, [k]: (e.data as unknown as Record<string, bigint>)[k]! + 1n } }) as SwapEvent;
    for (const k of ['lpFee', 'protocolFee', 'coinCreatorFee', 'buybackFee', 'quoteAmountInWithLpFee', 'baseAmountOut']) {
      const s = swapEventState(bump(k));
      expect(s.ok, k).toBe(false);
    }
    const sell = eventOf(golden.pumpswap.find((x) => x.kind === 'sell')!);
    const s = swapEventState({ ...sell, data: { ...sell.data, quoteAmountOut: (sell.data as { quoteAmountOut: bigint }).quoteAmountOut + 1n } } as SwapEvent);
    expect(!s.ok && s.reason).toMatch(/does not reproduce its event: quote/);
    expect(swapEventState({ ...sell, data: { ...sell.data, lpFeeBasisPoints: 20_000n } } as SwapEvent)).toEqual({ ok: false, reason: 'fee rate out of range' });
  });
});
