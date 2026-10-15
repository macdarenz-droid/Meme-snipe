// A-M01-03 on the CORE-2 mainnet goldens (fixtures/core2, imported by card Z07; research addendum A08): 353 PumpSwap
// Buy/SellEvents and 313 pump curve TradeEvents, each re-quoted from the state the program priced against.
// - Exact-in buys and sells reproduce the event to the raw unit (output, net quote and every fee component); exact-base
//   buys (`buy`, base out fixed) are re-quoted as exact-in at what the trader paid and match within 1 bp (ARCH M01).
// - Goldens use the chain's own tier rule; the engine's conservative rule never gives more (ruling Z07-2).
// - A08: a quote from the tier table alone (no per-pool creator rate) or on the vault alone (no virtual reserve) fails
//   vectors. Reserve timing: PumpSwap event reserves are pre-swap (vault balances agree); pump TradeEvent reserves are
//   post-trade (undoing the trade gives the priced state).
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { Bps, Slot, UnixMs } from '@bot/types';
import { DEFAULT_PUBKEY, MINTS } from '../src/constants.ts';
import type { FeeInputs } from '../src/fees.ts';
import type { CpPoolState } from '../src/pool.ts';
import { quoteDetail, type Leg } from '../src/quote.ts';
import { CORE2_INPUTS, readJson } from './helpers.ts';

type Str = Record<string, string>;
interface CurveVector { signature: string; ixName: string; args: [string, string]; event: Str & { is_buy: boolean } }
interface PoolVector { signature: string; eventIndex: number; kind: 'buy' | 'sell'; ixName: string; args: [string, string]; event: Str; pool: { address: string; canonical: boolean; quote: 'sol' | 'exotic'; creator_fee_bps: string } }
interface VaultDelta { signature: string; eventIndex: number; quotePre: string; quotePost: string; basePre: string; basePost: string }
const G = readJson<{ curve: CurveVector[]; pumpswap: PoolVector[]; vaultDeltas: VaultDelta[] }>('fixtures/core2/golden.json');
const n = (s: string | undefined): bigint => BigInt(s ?? 'missing');
const TOKEN_SUPPLY = n(readJson<Str>('fixtures/core2/pump-global.json').tokenTotalSupply);
const common = { asOfSlot: 0n as Slot, commitment: 'confirmed' as const, observedAtMs: 0 as UnixMs, baseDecimals: 6, isMayhemMode: false, swappedMints: false };

/** The pre-swap pool a PumpSwap event was priced on. */
const poolOf = (v: PoolVector): CpPoolState => ({
  ...common, venue: 'pumpswap', poolId: v.pool.address, baseMint: 'base', quoteMint: v.pool.quote === 'sol' ? MINTS.wsol : 'exotic-mint',
  baseReserve: n(v.event.pool_base_token_reserves), quoteReserveReal: n(v.event.pool_quote_token_reserves), quoteReserveVirtual: n(v.event.virtual_quote_reserves),
  baseMintSupply: n(v.event.base_supply), isCanonical: v.pool.canonical, curveComplete: null,
  coinCreatorSet: v.event.coin_creator !== DEFAULT_PUBKEY, creatorFeeBps: Number(v.pool.creator_fee_bps) as Bps, realBaseReserve: null,
});

/** The curve a TradeEvent was priced on: its reserves are post-trade, so the trade is undone. */
const curveOf = (v: CurveVector): CpPoolState => {
  const e = v.event;
  const sol = n(e.sol_amount), tok = n(e.token_amount), s = e.is_buy ? -1n : 1n;
  const vSol = n(e.virtual_sol_reserves) + s * sol, rSol = n(e.real_sol_reserves) + s * sol;
  return {
    ...common, venue: 'pump_curve', poolId: 'curve', baseMint: e.mint ?? 'mint', quoteMint: MINTS.wsol,
    baseReserve: n(e.virtual_token_reserves) - s * tok, quoteReserveReal: rSol, quoteReserveVirtual: vSol - rSol,
    baseMintSupply: TOKEN_SUPPLY, isCanonical: null, curveComplete: false, coinCreatorSet: e.creator !== DEFAULT_PUBKEY,
    creatorFeeBps: 0, realBaseReserve: n(e.real_token_reserves) - s * tok,
  };
};

/** What the trader put in: the spend argument (exact-in buys), what was paid (exact-base buys), or base in (sells). */
const swapInput = (v: PoolVector): bigint => (v.kind === 'sell' ? n(v.event.base_amount_in) : v.ixName === 'buy' ? n(v.event.user_quote_amount_in) : n(v.args[0]));
const legOf = (p: CpPoolState, side: 'buy' | 'sell', amountIn: bigint, inputs: FeeInputs, rule: 'chain' | 'conservative'): Leg | null => {
  const d = quoteDetail(p, side, amountIn, inputs, rule);
  return d.ok ? d.value.leg : null;
};
const within1Bp = (got: bigint, want: bigint): boolean => (got > want ? got - want : want - got) * 10_000n <= want;

describe('A-M01-03 PumpSwap goldens (CORE-2, 353 events)', () => {
  it('the fixture holds 353 PumpSwap events with buys, sells, both instruction families and negative virtual reserves', () => {
    assert.equal(G.pumpswap.length, 353);
    assert.ok(G.pumpswap.some((v) => v.kind === 'sell') && G.pumpswap.some((v) => v.ixName === 'buy') && G.pumpswap.some((v) => v.ixName.startsWith('buy_exact_quote_in')));
    assert.ok(G.pumpswap.some((v) => n(v.event.virtual_quote_reserves) < 0n));
  });

  it('every exact-in buy and sell reproduces the event to the raw unit; every exact-base buy is within 1 bp (≥ 20 recorded swaps, ARCH M01)', () => {
    let exact = 0, near = 0;
    const bad: string[] = [];
    for (const v of G.pumpswap) {
      const e = v.event;
      const leg = legOf(poolOf(v), v.kind, swapInput(v), CORE2_INPUTS, 'chain');
      assert.ok(leg !== null, v.signature);
      const label = `${v.ixName} ${v.signature.slice(0, 12)}`;
      assert.deepEqual([leg.split.lpBps, leg.split.protocolBps, leg.split.creatorBps], [e.lp_fee_basis_points, e.protocol_fee_basis_points, e.coin_creator_fee_basis_points].map(Number), label);
      if (v.kind === 'sell') {
        assert.equal(leg.netQuote, n(e.quote_amount_out), label);
        assert.equal(leg.amountOut, n(e.user_quote_amount_out), label);
      } else if (v.ixName === 'buy') {
        // Re-quoted as exact-in at what was paid: never more than the program gave, and within 1 bp; below 10,000
        // lamports one lamport is worth more than 1 bp, so dust trades get four lamports' worth instead.
        const paid = n(e.user_quote_amount_in), want = n(e.base_amount_out);
        const ok = leg.amountOut <= want && (paid >= 10_000n ? within1Bp(leg.amountOut, want) : (want - leg.amountOut) * paid <= 4n * want);
        if (!ok) bad.push([label, leg.amountOut, want, paid].join(' '));
        near++;
        continue;
      } else {
        assert.equal(leg.amountOut, n(e.base_amount_out), label);
        assert.equal(leg.netQuote, n(e.user_quote_amount_in), label);
      }
      assert.deepEqual([leg.lpFee, leg.protocolFee, leg.creatorFee], [n(e.lp_fee), n(e.protocol_fee), n(e.coin_creator_fee)], label);
      exact++;
    }
    assert.deepEqual(bad, []);
    assert.ok(exact >= 20 && near >= 1, `${exact} exact, ${near} near`);
  });

  it('ruling Z07-2: on every vector the conservative (engine) output is ≤ the chain-rule output', () => {
    let differ = 0;
    for (const v of G.pumpswap) {
      const chain = legOf(poolOf(v), v.kind, swapInput(v), CORE2_INPUTS, 'chain');
      const cons = legOf(poolOf(v), v.kind, swapInput(v), CORE2_INPUTS, 'conservative');
      assert.ok(chain !== null && cons !== null, v.signature);
      assert.ok(cons.amountOut <= chain.amountOut, v.signature);
      if (cons.amountOut < chain.amountOut) differ++;
    }
    // Ruling Z07-18: no recorded swap crosses a tier, so the two rules agree on all 353 (the crossing cases are the
    // tier tests in fees.test.ts and quote.test.ts).
    assert.equal(differ, 0);
  });

  it('A08: a quote from the tier table alone, or on the vault alone, fails vectors that the per-pool quote reproduces', () => {
    const fails = (mutate: (p: CpPoolState) => CpPoolState, inputs: FeeInputs): number => G.pumpswap.filter((v) => {
      if (v.ixName === 'buy') return false;
      const leg = legOf(mutate(poolOf(v)), v.kind, swapInput(v), inputs, 'chain');
      return leg === null || leg.amountOut !== n(v.kind === 'sell' ? v.event.user_quote_amount_out : v.event.base_amount_out);
    }).length;
    assert.equal(fails((p) => p, CORE2_INPUTS), 0);
    const tableOnly = fails((p) => ({ ...p, creatorFeeBps: 0 }), CORE2_INPUTS);
    const vaultOnly = fails((p) => ({ ...p, quoteReserveVirtual: 0n }), CORE2_INPUTS);
    assert.ok(tableOnly >= 1, `tier table alone failed ${tableOnly}`);
    assert.ok(vaultOnly >= 1, `vault alone failed ${vaultOnly}`);
  });

  it('reserve timing: the event reserves are the pre-swap vault balances (61 recorded vault deltas)', () => {
    const byKey = new Map(G.pumpswap.map((v) => [`${v.signature}:${v.eventIndex}`, v]));
    assert.equal(G.vaultDeltas.length, 61);
    for (const d of G.vaultDeltas) {
      const v = byKey.get(`${d.signature}:${d.eventIndex}`);
      assert.ok(v !== undefined);
      assert.equal(n(v.event.pool_quote_token_reserves), n(d.quotePre));
      assert.equal(n(v.event.pool_base_token_reserves), n(d.basePre));
    }
  });
});

describe('A-M01-03 pump curve goldens (CORE-2, 313 events)', () => {
  it('every sell and exact-in buy reproduces the TradeEvent to the raw unit; every exact-token buy is within 1 bp', () => {
    assert.equal(G.curve.length, 313);
    let exact = 0, near = 0;
    for (const v of G.curve) {
      const e = v.event;
      const side = e.is_buy ? 'buy' : 'sell';
      const exactTokens = e.is_buy && v.ixName === 'buy';
      const amountIn = !e.is_buy ? n(e.token_amount) : exactTokens ? n(e.sol_amount) + n(e.fee) + n(e.creator_fee) : n(v.args[0]);
      const leg = legOf(curveOf(v), side, amountIn, CORE2_INPUTS, 'chain');
      const label = `${v.ixName} ${v.signature.slice(0, 12)}`;
      assert.ok(leg !== null, label);
      assert.deepEqual([leg.split.protocolBps, leg.split.creatorBps], [Number(e.fee_basis_points), Number(e.creator_fee_basis_points)], label);
      if (exactTokens) {
        assert.ok(within1Bp(leg.amountOut, n(e.token_amount)), label);
        near++;
        continue;
      }
      assert.equal(e.is_buy ? leg.amountOut : leg.amountIn, n(e.token_amount), label);
      assert.equal(leg.netQuote, n(e.sol_amount), label);
      assert.deepEqual([leg.protocolFee, leg.creatorFee], [n(e.fee), n(e.creator_fee)], label);
      exact++;
    }
    assert.ok(exact >= 20 && near >= 1, `${exact} exact, ${near} near`);
  });

  it('reserve timing: TradeEvent reserves are post-trade; quoting on them unchanged misses vectors', () => {
    const misses = G.curve.filter((v) => !v.event.is_buy).filter((v) => {
      const e = v.event;
      const asIs = { ...curveOf(v), baseReserve: n(e.virtual_token_reserves), quoteReserveReal: n(e.real_sol_reserves), quoteReserveVirtual: n(e.virtual_sol_reserves) - n(e.real_sol_reserves) };
      const leg = legOf(asIs, 'sell', n(e.token_amount), CORE2_INPUTS, 'chain');
      return leg === null || leg.netQuote !== n(e.sol_amount);
    }).length;
    assert.ok(misses >= 1);
  });
});
