// H5-POOL-TAILS parity: the live store keeps a fetched pool trade as its decoded event (`data.poolQuoteTokenReserves`
// and the tail); the backtest releases DATA-1's amm row as `tradeTailValue` (`readAmm`'s `pre.quoteVault` and
// `extra_hex`). On every real post-B5 PumpSwap trade of TAIL-PROOF's fixture (zero and non-zero tails), and with the
// vault moved below the tail, both give the same H5 tail answer (GATE-1c `checkPoolTails`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeEventInstruction, fromHex } from '../../core/src/chain/index.ts';
import { AsOfStore, SimClock, type AsOfEntry, type Moment } from '../../core/src/engine/index.ts';
import { checkPoolTails, poolTradeKeys, type TailCheck } from '../../core/src/gates/index.ts';
import { readAmm, type AmmSwapRow, type DatasetRow } from '../src/dataset/rows.ts';
import { tradeTailValue } from '../src/sim/facts.ts';

interface Vector { signature: string; slot: number; eventIndex: number; kind: 'buy' | 'sell'; ixName: string; eventData: string; tail: string; pool: { address: string } }
const fx = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'core', 'test', 'chain', 'fixtures', 'tail-proof.json'), 'utf8')) as { nonzero: Vector[]; zero: Vector[] };
const ALL = [...fx.nonzero, ...fx.zero];
const POOL = 'Pool1111111111111111111111111111111111111111';
const ORIGIN: Moment = { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 };
const u64le = (hex: string): bigint => BigInt(`0x${(hex.match(/../g) ?? []).reverse().join('')}`);

type Data = Record<string, bigint | string | undefined>;
const decoded = (v: Vector) => decodeEventInstruction('pump_amm', fromHex(v.eventData)) as unknown as { name: string; data: Data; trailing: number; extra: string };
const str = (x: bigint | string | undefined): string => (x === undefined ? '' : String(x));

/** The swap as DATA-1's amm_trades row: the logged fields, read by the backtest's own reader (as pool-state.test.ts). */
const rowOf = (v: Vector, vault?: bigint): AmmSwapRow => {
  const d = decoded(v).data;
  const buy = v.kind === 'buy';
  const cols: Record<string, string> = {
    slot: String(v.slot), block_time: '1791039600', tx_idx: '0', ev_idx: String(v.eventIndex), signature: v.signature, pool: v.pool.address,
    base_mint: 'base', quote_mint: 'So11111111111111111111111111111111111111112', side: v.kind,
    base_amount: str(buy ? d['baseAmountOut'] : d['baseAmountIn']), quote_amount: str(buy ? d['quoteAmountIn'] : d['quoteAmountOut']),
    user_quote_amount: str(buy ? d['userQuoteAmountIn'] : d['userQuoteAmountOut']),
    pool_base_token_reserves: str(d['poolBaseTokenReserves']), pool_quote_token_reserves: str(vault ?? d['poolQuoteTokenReserves']), virtual_quote_reserves: str(d['virtualQuoteReserves']),
    lp_fee_basis_points: str(d['lpFeeBasisPoints']), protocol_fee_basis_points: str(d['protocolFeeBasisPoints']),
    coin_creator_fee_basis_points: str(d['coinCreatorFeeBasisPoints']), buyback_fee_basis_points: str(d['buybackFeeBasisPoints']),
    base_supply: str(d['baseSupply']), ix_name: buy ? v.ixName : '', user: 'u', user_token_account: '', user_token_owner: '', extra_hex: v.tail,
  };
  const names = Object.keys(cols);
  const out: DatasetRow[] = [];
  readAmm(`${names.join(',')}\n${names.map((n) => cols[n]).join(',')}\n`, out);
  return out[0] as AmmSwapRow;
};

/** The live store's value for the same fetched trade. */
const liveOf = (v: Vector, vault?: bigint) => {
  const e = decoded(v);
  return { event: vault === undefined ? e : { ...e, data: { ...e.data, poolQuoteTokenReserves: vault } }, txSlot: BigInt(v.slot), signature: v.signature };
};
const backtestOf = (v: Vector, vault?: bigint) => {
  const row = rowOf(v, vault);
  return tradeTailValue(row, row.pre.quoteVault);
};

const check = (values: readonly { v: Vector; value: unknown }[]): TailCheck => {
  const clock = new SimClock(ORIGIN);
  const store = new AsOfStore(clock);
  const [buy, sell] = poolTradeKeys(POOL);
  [...values].sort((a, b) => a.v.slot - b.v.slot).forEach(({ v, value }, i) => {
    const m: Moment = { slot: BigInt(v.slot), txIndex: 0, ixIndex: i, receivedAt: 1_000 + i };
    clock.advanceTo(m);
    store.record(v.kind === 'buy' ? buy! : sell!, value, m, `ev:${v.signature}:${v.eventIndex}`);
  });
  return checkPoolTails({ now: clock.now(), history: (k, f, t) => store.history(k, f, t) as readonly AsOfEntry[] }, POOL, { slot: 0n, ms: 0 });
};

describe('H5-POOL-TAILS: live and backtest give the same tail answer on real trades', () => {
  it('each real trade, alone: the same answer (a pass) both ways', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(300);
    for (const v of ALL) {
      expect(rowOf(v).extraHex).toBe(v.tail);
      const live = check([{ v, value: liveOf(v) }]);
      expect(check([{ v, value: backtestOf(v) }]), v.signature).toEqual(live);
      expect(live, v.signature).toEqual({ ok: true, events: 1 });
    }
  });

  it('each non-zero tail with the vault one lamport below it: the same refusal (H5 event-tail) both ways', () => {
    for (const v of fx.nonzero) {
      const vault = u64le(v.tail) - 1n;
      const live = check([{ v, value: liveOf(v, vault) }]);
      expect(check([{ v, value: backtestOf(v, vault) }]), v.signature).toEqual(live);
      expect(live, v.signature).toMatchObject({ ok: false, code: 'event-tail', signature: v.signature });
    }
  });

  it('the whole sample on one tape, with one trade moved above its vault: the same answer, naming the same trade', () => {
    const bad = fx.nonzero[Math.floor(fx.nonzero.length / 2)]!;
    const vault = (v: Vector) => (v === bad ? u64le(v.tail) - 1n : undefined);
    const live = check(ALL.map((v) => ({ v, value: liveOf(v, vault(v)) })));
    expect(check(ALL.map((v) => ({ v, value: backtestOf(v, vault(v)) })))).toEqual(live);
    expect(live).toMatchObject({ ok: false, code: 'event-tail', signature: bad.signature });
    expect(check(ALL.map((v) => ({ v, value: backtestOf(v) })))).toEqual(check(ALL.map((v) => ({ v, value: liveOf(v) }))));
  });
});
