// Golden vectors: real mainnet trades (fixtures/golden.json, built by fixtures/fetch-golden.ts). Each quote is fed the
// instruction's own arguments and the pre-trade state, and must reproduce the on-chain event to the raw unit.
import { describe, expect, test } from 'vitest';
import {
  type CurveFeeContext, type CurveState, type PoolFeeContext, type PoolState,
  curveBuyExactQuoteIn, curveBuyExactTokens, curveFees, curveSell, effectiveQuoteReserve, poolBuyExactBase, poolBuyExactQuoteIn, poolSell,
} from '../../src/amm/index.ts';
import { bps } from '../../src/units/index.ts';
import { AMM_FEE_CONFIG, PUMP_FEE_CONFIG, readFixture } from './helpers.ts';

const DEFAULT_KEY = '11111111111111111111111111111111';
type Str = Record<string, string>;
interface CurveVector { signature: string; slot: number; ixName: string; args: [string, string]; event: Str & { is_buy: boolean } }
interface PoolVector { signature: string; slot: number; kind: 'buy' | 'sell'; ixName: string; args: [string, string]; event: Str; pool: { address: string; canonical: boolean; quote: 'sol' | 'exotic'; creator_fee_bps: string } }
interface Golden { curve: CurveVector[]; pumpswap: PoolVector[] }

const golden = readFixture<Golden>('golden.json');
const n = (s: string | undefined) => BigInt(s ?? 'missing');

describe('pump curve golden vectors', () => {
  const buys = golden.curve.filter((v) => v.event.is_buy);
  const sells = golden.curve.filter((v) => !v.event.is_buy);

  test('fixture holds at least 5 buys and 5 sells', () => {
    expect(buys.length).toBeGreaterThanOrEqual(5);
    expect(sells.length).toBeGreaterThanOrEqual(5);
  });

  test.each(golden.curve.map((v) => [`${v.ixName} ${v.signature.slice(0, 12)}`, v] as const))('%s', (_, v) => {
    const e = v.event;
    const sol = n(e.sol_amount);
    const tok = n(e.token_amount);
    // TradeEvent reserves are post-trade; undo this trade to get the state the program priced against.
    const pre: CurveState = {
      virtualQuoteReserves: n(e.virtual_sol_reserves) + (e.is_buy ? -sol : sol),
      virtualTokenReserves: n(e.virtual_token_reserves) + (e.is_buy ? tok : -tok),
      realQuoteReserves: n(e.real_sol_reserves) + (e.is_buy ? -sol : sol),
      realTokenReserves: n(e.real_token_reserves) + (e.is_buy ? tok : -tok),
      complete: false,
    };
    const ctx: CurveFeeContext = { feeTiers: PUMP_FEE_CONFIG.feeTiers, supply: 1_000_000_000_000_000n, creatorFeeCharged: e.creator !== DEFAULT_KEY };
    const [a0] = v.args.map(BigInt) as [bigint, bigint];
    const t = !e.is_buy ? curveSell(pre, a0, ctx) : v.ixName === 'buy' ? curveBuyExactTokens(pre, a0, ctx) : curveBuyExactQuoteIn(pre, a0, ctx);
    expect(t.tokens).toBe(tok);
    expect(t.quote).toBe(sol);
    expect(t.protocolFee).toBe(n(e.fee));
    expect(t.creatorFee).toBe(n(e.creator_fee));
    expect(t.after.virtualQuoteReserves).toBe(n(e.virtual_sol_reserves));
    expect(t.after.virtualTokenReserves).toBe(n(e.virtual_token_reserves));
    expect(t.after.realQuoteReserves).toBe(n(e.real_sol_reserves));
    expect(t.after.realTokenReserves).toBe(n(e.real_token_reserves));
    // The tier our code picks equals the rates the program charged.
    expect(curveFees(pre, ctx)).toEqual({ protocol: Number(e.fee_basis_points), creator: Number(e.creator_fee_basis_points) });
    if (v.ixName !== 'buy' && e.is_buy) expect(t.userQuote).toBeLessThanOrEqual(a0);
  });
});

describe('PumpSwap golden vectors', () => {
  const buys = golden.pumpswap.filter((v) => v.kind === 'buy');
  const sells = golden.pumpswap.filter((v) => v.kind === 'sell');

  test('fixture holds at least 5 buys and 5 sells, canonical pools across fee tiers, and a negative virtual reserve if one was seen', () => {
    expect(buys.length).toBeGreaterThanOrEqual(5);
    expect(sells.length).toBeGreaterThanOrEqual(5);
    const canonicalTiers = new Set(golden.pumpswap.filter((v) => v.pool.canonical && v.pool.quote === 'sol').map((v) => v.event.coin_creator_fee_basis_points));
    expect(canonicalTiers.size).toBeGreaterThanOrEqual(2);
    const negative = golden.pumpswap.filter((v) => BigInt(v.event.virtual_quote_reserves ?? '0') < 0n);
    expect(negative.filter((v) => v.kind === 'buy').length).toBeGreaterThanOrEqual(1);
    expect(negative.filter((v) => v.kind === 'sell').length).toBeGreaterThanOrEqual(1);
  });

  const quoteTrade = (v: PoolVector) => {
    const e = v.event;
    // BuyEvent/SellEvent reserves are pre-trade.
    const pre: PoolState = { baseReserve: n(e.pool_base_token_reserves), quoteVault: n(e.pool_quote_token_reserves), virtualQuoteReserves: n(e.virtual_quote_reserves) };
    const override = Number(v.pool.creator_fee_bps);
    const ctx: PoolFeeContext = {
      feeConfig: AMM_FEE_CONFIG, canonical: v.pool.canonical, quote: v.pool.quote, baseSupply: n(e.base_supply), creatorFeeCharged: e.coin_creator !== DEFAULT_KEY,
      ...(override > 0 ? { creatorFeeOverride: bps(override) } : {}),
    };
    const [a0] = v.args.map(BigInt) as [bigint, bigint];
    return { pre, a0, t: v.kind === 'sell' ? poolSell(pre, a0, ctx) : v.ixName === 'buy' ? poolBuyExactBase(pre, a0, ctx) : poolBuyExactQuoteIn(pre, a0, ctx) };
  };

  test.each(golden.pumpswap.map((v) => [`${v.ixName} ${v.signature.slice(0, 12)}`, v] as const))('%s', (_, v) => {
    const e = v.event;
    const { pre, a0, t } = quoteTrade(v);
    expect([t.fees.lp, t.fees.protocol, t.fees.creator]).toEqual([e.lp_fee_basis_points, e.protocol_fee_basis_points, e.coin_creator_fee_basis_points].map(Number));
    expect(t.lpFee).toBe(n(e.lp_fee));
    expect(t.protocolFee).toBe(n(e.protocol_fee));
    expect(t.creatorFee).toBe(n(e.coin_creator_fee));
    if (v.kind === 'sell') {
      expect(t.base).toBe(n(e.base_amount_in));
      expect(t.quote).toBe(n(e.quote_amount_out));
      expect(t.userQuote).toBe(n(e.user_quote_amount_out));
    } else {
      expect(t.base).toBe(n(e.base_amount_out));
      expect(t.quote + t.lpFee).toBe(n(e.quote_amount_in_with_lp_fee));
      // buy_exact_quote_in logs the spend limit in quote_amount_in and the swap input in user_quote_amount_in.
      if (v.ixName === 'buy') {
        expect(t.quote).toBe(n(e.quote_amount_in));
        expect(t.userQuote).toBe(n(e.user_quote_amount_in));
      } else {
        expect(t.quote).toBe(n(e.user_quote_amount_in));
        expect(t.userQuote).toBeLessThanOrEqual(a0);
      }
    }
    expect(effectiveQuoteReserve(t.after) * t.after.baseReserve).toBeGreaterThanOrEqual(effectiveQuoteReserve(pre) * pre.baseReserve);
  });

  test('post-trade pool state equals the next trade\'s pre-trade state in the same transaction', () => {
    const pairs = golden.pumpswap.flatMap((v, i) => {
      const next = golden.pumpswap[i + 1];
      return next && next.signature === v.signature && next.pool.address === v.pool.address ? [[v, next] as const] : [];
    });
    expect(pairs.length).toBeGreaterThanOrEqual(3);
    for (const [first, second] of pairs) {
      const { after } = quoteTrade(first).t;
      expect(after.baseReserve).toBe(n(second.event.pool_base_token_reserves));
      expect(after.quoteVault).toBe(n(second.event.pool_quote_token_reserves));
      expect(after.virtualQuoteReserves).toBe(n(second.event.virtual_quote_reserves));
    }
  });
});
