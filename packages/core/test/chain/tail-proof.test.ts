// TAIL-PROOF: real mainnet PumpSwap trades after B5 (fixtures/tail-proof.json, built by research/tail-proof/) on
// canonical SOL pools whose events carry a non-zero 8-byte tail, with zero-tail trades as a control. Evidence only:
// it pins that each sampled trade decodes with DEC-1 and that the CORE-2 quote from the event's pre-trade reserves
// reproduces the event's amounts and fees, the pool vaults' real balances, the token transfers the swap made and the
// trader's own balance changes, to the raw unit. It changes no gate: GATE-1c (H5) still refuses non-zero tails.
import { describe, expect, test } from 'vitest';
import { type PoolFeeContext, type PoolState, poolBuyExactBase, poolBuyExactQuoteIn, poolSell } from '../../src/amm/index.ts';
import { decodeEventInstruction, decodeFeeConfig, feeSchedules, fromBase64, fromHex } from '../../src/chain/index.ts';
import { bps } from '../../src/units/index.ts';
import { readFixture } from './helpers.ts';

interface Flow { amount: string; role: string }
interface Vector {
  signature: string; slot: number; eventIndex: number; kind: 'buy' | 'sell'; ixName: string; ixDisc: string; args: [string, string];
  eventData: string; tail: string;
  pool: { address: string; canonical: boolean; creatorFeeBps: string };
  vaults: { quotePre: string; quotePost: string; basePre: string; basePost: string } | null;
  flows: Flow[];
  user: { basePre: string; basePost: string; quotePre: string | null; quotePost: string | null } | null;
}
type TapeEntry =
  | { slot: number; signature: string; type: 'trade'; ixDisc: string; eventData: string }
  | { slot: number; signature: string; type: 'sweep-creator' | 'sweep-protocol'; amount: string; eventData: string | null };
interface Fixture { feeConfig: { slot: number; data: string }; nonzero: Vector[]; zero: Vector[]; tapes: Record<string, TapeEntry[]> }

const fx = readFixture<Fixture>('tail-proof.json');
const FEES = feeSchedules(decodeFeeConfig(fromBase64(fx.feeConfig.data)).value);
/** PumpSwap's upgrade slot (UPG-1); the 8-byte tail exists from the next slot. */
const B5_SLOT = 452_654_882;
const DEFAULT_KEY = '11111111111111111111111111111111';
// Anchor discriminators of sell_v2, buy_exact_quote_in_v2 and buy_v2 (pump IDLs).
const V2_DISCS = ['5df6823ce7e940b2', 'c2ab1c46684d5b2f', 'b817ee6167c5d33d'];
const NORMAL_COIN = { mayhemMode: false, transferFee: false, transferHook: false } as const;

const decode = (v: Vector) => {
  const e = decodeEventInstruction('pump_amm', fromHex(v.eventData));
  if (e === null || (e.name !== 'BuyEvent' && e.name !== 'SellEvent')) throw new Error(`${v.signature}: not a pool trade event`);
  return e;
};

const sum = (v: Vector, pred: (role: string) => boolean) => v.flows.filter((f) => pred(f.role)).reduce((s, f) => s + BigInt(f.amount), 0n);

const check = (v: Vector) => {
  const e = decode(v);
  expect(e.name).toBe(v.kind === 'buy' ? 'BuyEvent' : 'SellEvent');
  expect(e.trailing).toBe(8);
  expect(e.extra).toBe(v.tail);
  expect(v.slot).toBeGreaterThan(B5_SLOT);
  expect(v.pool.canonical).toBe(true);
  const d = e.data;
  expect(d.pool).toBe(v.pool.address);
  // BuyEvent/SellEvent reserves are pre-trade; the effective quote reserve is vault + virtual.
  const pre: PoolState = { baseReserve: d.poolBaseTokenReserves, quoteVault: d.poolQuoteTokenReserves, virtualQuoteReserves: d.virtualQuoteReserves! };
  const override = Number(v.pool.creatorFeeBps);
  const ctx: PoolFeeContext = {
    feeConfig: FEES, canonical: true, quote: 'sol', baseSupply: d.baseSupply!, creatorFeeCharged: d.coinCreator !== DEFAULT_KEY, coin: NORMAL_COIN,
    instruction: V2_DISCS.includes(v.ixDisc) ? 'v2' : 'v1', buybackFeeBps: bps(Number(d.buybackFeeBasisPoints)),
    ...(override > 0 ? { creatorFeeOverride: bps(override) } : {}),
  };
  const a0 = BigInt(v.args[0]);
  const q = v.kind === 'sell' ? poolSell(pre, a0, ctx) : v.ixName === 'buy' ? poolBuyExactBase(pre, a0, ctx) : poolBuyExactQuoteIn(pre, a0, ctx);
  if (!q.ok) throw new Error(`${v.signature}: no quote (${q.reason})`);
  const t = q.trade;

  // The event's own fields: fee rates from the FeeConfig in force, every fee component, the amounts.
  expect([t.fees.lp, t.fees.protocol, t.fees.creator]).toEqual([d.lpFeeBasisPoints, d.protocolFeeBasisPoints, d.coinCreatorFeeBasisPoints!].map(Number));
  expect(t.lpFee).toBe(d.lpFee);
  expect(t.protocolFee).toBe(d.protocolFee);
  expect(t.creatorFee).toBe(d.coinCreatorFee);
  expect(t.buybackFee).toBe(d.buybackFee);
  if (e.name === 'SellEvent') {
    expect(t.base).toBe(e.data.baseAmountIn);
    expect(t.quote).toBe(e.data.quoteAmountOut);
    expect(t.userQuote).toBe(e.data.userQuoteAmountOut);
  } else {
    expect(t.base).toBe(e.data.baseAmountOut);
    expect(t.quote + t.lpFee).toBe(e.data.quoteAmountInWithLpFee);
    expect(t.quote).toBe(v.ixName === 'buy' ? e.data.quoteAmountIn : e.data.userQuoteAmountIn);
    if (v.ixName === 'buy') expect(t.userQuote).toBe(e.data.userQuoteAmountIn);
  }

  // The pool vaults' real token balances around the trade (the pool's one trade in its transaction).
  if (v.vaults) {
    expect(BigInt(v.vaults.quotePre)).toBe(pre.quoteVault);
    expect(BigInt(v.vaults.basePre)).toBe(pre.baseReserve);
    expect(BigInt(v.vaults.quotePost)).toBe(t.after.quoteVault);
    expect(BigInt(v.vaults.basePost)).toBe(t.after.baseReserve);
  }

  // The token transfers the swap instruction itself made: what the trader paid and received.
  if (v.kind === 'buy') {
    expect(sum(v, (r) => r.startsWith('user-quote>'))).toBe(t.userQuote);
    expect(sum(v, (r) => r === 'pool-base>user-base')).toBe(t.base);
    expect(sum(v, (r) => r.endsWith('>pool-quote')) - sum(v, (r) => r.startsWith('pool-quote>'))).toBe(t.after.quoteVault - pre.quoteVault);
  } else {
    expect(sum(v, (r) => r.endsWith('>user-quote'))).toBe(t.userQuote);
    expect(sum(v, (r) => r === 'user-base>pool-base')).toBe(t.base);
    expect(sum(v, (r) => r.startsWith('pool-quote>')) - sum(v, (r) => r.endsWith('>pool-quote'))).toBe(pre.quoteVault - t.after.quoteVault);
  }

  // The trader's own balances (meta), when nothing else in the transaction touched those accounts.
  if (v.user) {
    expect(BigInt(v.user.basePost) - BigInt(v.user.basePre)).toBe(v.kind === 'buy' ? t.base : -t.base);
    if (v.user.quotePre !== null && v.user.quotePost !== null) expect(BigInt(v.user.quotePost) - BigInt(v.user.quotePre)).toBe(v.kind === 'buy' ? -t.userQuote : t.userQuote);
  }
};

describe('TAIL-PROOF fixture', () => {
  test('holds at least 200 non-zero-tail trades from at least 20 pools, and at least 100 zero-tail controls', () => {
    expect(fx.nonzero.length).toBeGreaterThanOrEqual(200);
    expect(new Set(fx.nonzero.map((v) => v.pool.address)).size).toBeGreaterThanOrEqual(20);
    expect(fx.zero.length).toBeGreaterThanOrEqual(100);
    for (const k of ['buy', 'sell'] as const) expect(fx.nonzero.filter((v) => v.kind === k).length).toBeGreaterThanOrEqual(50);
    // Every non-zero vector also checks the vaults and the swap's own transfers.
    expect(fx.nonzero.filter((v) => v.vaults !== null).length).toBeGreaterThanOrEqual(150);
    for (const v of fx.nonzero) expect(v.flows.length).toBeGreaterThanOrEqual(3);
  });
  test('the tails are what each set says', () => {
    for (const v of fx.nonzero) expect(decode(v).extra).not.toBe('00'.repeat(8));
    for (const v of fx.zero) expect(decode(v).extra).toBe('00'.repeat(8));
  });
});

describe('non-zero tail: decode, quote and balance deltas equal', () => {
  test.each(fx.nonzero.map((v) => [`${v.kind} ${v.signature.slice(0, 12)}#${v.eventIndex} tail ${v.tail}`, v] as const))('%s', (_, v) => check(v));
});

describe('zero tail (control): decode, quote and balance deltas equal', () => {
  test.each(fx.zero.map((v) => [`${v.kind} ${v.signature.slice(0, 12)}#${v.eventIndex}`, v] as const))('%s', (_, v) => check(v));
});

describe('what the tail tracks (observation from consecutive pool tapes; not a decoded field)', () => {
  const u64le = (hex: string): bigint => BigInt(`0x${(hex.match(/../g) ?? []).reverse().join('') || '0'}`);
  const tapes = Object.entries(fx.tapes);
  test('the fixture holds consecutive tapes with v2 trades and at least one creator sweep', () => {
    expect(tapes.length).toBeGreaterThanOrEqual(2);
    const all = tapes.flatMap(([, t]) => t);
    expect(all.filter((e) => e.type === 'trade' && V2_DISCS.includes(e.ixDisc)).length).toBeGreaterThanOrEqual(10);
    expect(all.filter((e) => e.type === 'sweep-creator').length).toBeGreaterThanOrEqual(1);
  });
  test.each(tapes)('pool %s: each trade\'s tail is the previous tail plus its coin_creator_fee on a v2 instruction (0 on v1); a creator sweep pays out exactly the tail and resets it to 0', (_, tape) => {
    let tail: bigint | null = null;
    let checked = 0;
    for (const en of tape) {
      if (en.type === 'sweep-creator') {
        if (tail !== null) { expect(BigInt(en.amount)).toBe(tail); tail = 0n; }
        continue;
      }
      if (en.type !== 'trade') continue;
      const e = decodeEventInstruction('pump_amm', fromHex(en.eventData));
      if (e === null || (e.name !== 'BuyEvent' && e.name !== 'SellEvent')) throw new Error(`${en.signature}: not a pool trade event`);
      const got = u64le(e.extra);
      if (tail !== null) {
        expect(got).toBe(tail + (V2_DISCS.includes(en.ixDisc) ? e.data.coinCreatorFee! : 0n));
        checked++;
      }
      tail = got;
    }
    expect(checked).toBeGreaterThanOrEqual(50);
  });
});
