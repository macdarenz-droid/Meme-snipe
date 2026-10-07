// RED TEAM B: sizing and risk invariants under scaled bankrolls ($5 to $10,000) and random pools, including negative
// signed virtual_quote_reserves. Deterministic PRNG. Edge 0 must never allow an entry (planned S0 resume config).
import { describe, expect, test } from 'vitest';
import { type Policy, type PolicySession, TRIAL_POLICY, usd } from '../../src/config/index.ts';
import type { PoolState } from '../../src/amm/index.ts';
import { PPM, costAtSize, roundTripImpactPpm } from '../../src/costs/index.ts';
import { NO_LATCHES, evaluateEntry } from '../../src/risk/index.ts';
import { type MicroUsd, lamports, lamportsToMicroUsd, microUsdToLamports } from '../../src/units/index.ts';
import { NETWORK, NOW, PRICE, RENT, SOL, account, baseInput, baseRequest, quoterFor } from '../risk/helpers.ts';

let s = 0x9e3779b9;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; };
const between = (lo: number, hi: number) => lo + (hi - lo) * rnd();

const scaledPolicy = (bankrollUsd: number): Policy => {
  const k = bankrollUsd / 20;
  const u = (x: number) => usd(x.toFixed(6));
  return { ...TRIAL_POLICY, capital: { ...TRIAL_POLICY.capital, bankroll: u(20 * k), minNotional: u(2 * k), maxNotional: u(5 * k) } } as Policy;
};
const session = (policy: Policy): PolicySession => ({ policy, versionHash: 'x', baselineHash: 'x', changesFromBaseline: [], running: true, requestChange: () => ({ ok: false, reason: '' }) as never, end: () => {} });

const randomPool = (): PoolState => {
  const vault = BigInt(Math.floor(between(1, 5_000))) * SOL;
  // Negative virtual down to -60% of the vault, or zero, or a small positive.
  const r = rnd();
  const virtualQuoteReserves = r < 0.5 ? -(vault * BigInt(Math.floor(between(0, 600)))) / 1000n : r < 0.8 ? 0n : (vault * BigInt(Math.floor(between(0, 100)))) / 1000n;
  return { baseReserve: BigInt(Math.floor(between(1e13, 9e14))), quoteVault: vault, virtualQuoteReserves };
};

describe('RB-3 edge 0 never enters, at any scale or pool', () => {
  test('RB-3a 3,000 random (bankroll, pool, step-up, stop) cases with edgePpm 0 are all refused as expected_net_not_positive or earlier', () => {
    for (let i = 0; i < 3_000; i++) {
      const bankroll = [5, 20, 100, 1_000, 10_000][i % 5]!;
      const policy = scaledPolicy(bankroll);
      const balance = lamports(TRIAL_POLICY.reserve.opsFloor + microUsdToLamports(usd(String(bankroll * 1.2)), PRICE, 'ceil'));
      const input = baseInput({
        session: session(policy), account: account({ openingEquity: policy.capital.bankroll }),
        latches: { ...NO_LATCHES, sizeStepUpApproved: rnd() < 0.5 },
        market: { solPrice: { value: PRICE, atMs: NOW - 500 }, solBalance: { value: balance, atMs: NOW - 500 }, regime: 'on' },
      });
      const pool = randomPool();
      const liq = lamportsToMicroUsd(lamports((pool.quoteVault + pool.virtualQuoteReserves) * 2n > 0n ? (pool.quoteVault + pool.virtualQuoteReserves) * 2n : 0n), PRICE, 'floor');
      const d = evaluateEntry(input, baseRequest({ edgePpm: 0n, quote: quoterFor(pool), poolLiquidity: liq, stopBps: Math.floor(between(100, 2000)) }));
      expect(d.allow, `case ${i}`).toBe(false);
    }
  });
});

describe('RB-4 allowed entries respect every cap at every scale', () => {
  test('RB-4a with a real edge: notional <= max, impact <= limit, expected net > 0 at the chosen size, reservation fits', () => {
    let allowed = 0;
    for (let i = 0; i < 3_000; i++) {
      const bankroll = [5, 20, 100, 1_000, 10_000][i % 5]!;
      const policy = scaledPolicy(bankroll);
      const balance = lamports(TRIAL_POLICY.reserve.opsFloor + microUsdToLamports(usd(String(bankroll * 1.2)), PRICE, 'ceil'));
      const input = baseInput({
        session: session(policy), account: account({ openingEquity: policy.capital.bankroll }),
        latches: { ...NO_LATCHES, sizeStepUpApproved: rnd() < 0.7 },
        market: { solPrice: { value: PRICE, atMs: NOW - 500 }, solBalance: { value: balance, atMs: NOW - 500 }, regime: 'on' },
      });
      const pool = randomPool();
      const eff = pool.quoteVault + pool.virtualQuoteReserves;
      const liq = lamportsToMicroUsd(lamports(eff * 2n > 0n ? eff * 2n : 0n), PRICE, 'floor');
      const edgePpm = BigInt(Math.floor(between(1_000, 400_000)));
      const q = quoterFor(pool);
      const d = evaluateEntry(input, baseRequest({ edgePpm, quote: q, poolLiquidity: liq, stopBps: Math.floor(between(100, 2000)) }));
      if (!d.allow) continue;
      allowed++;
      const ctx = `case ${i} bankroll ${bankroll} pool ${JSON.stringify(pool, (_k, v) => typeof v === 'bigint' ? String(v) : v)}`;
      expect(d.notional <= policy.capital.maxNotional, ctx).toBe(true);
      expect(d.spendLamports <= microUsdToLamports(policy.capital.maxNotional, PRICE, 'ceil'), ctx).toBe(true);
      const imp = roundTripImpactPpm(q, d.spendLamports);
      expect(imp !== null && imp <= BigInt(policy.liquidity.maxImpactBps) * 100n, ctx).toBe(true);
      // R12: notional <= pool liquidity / multiple.
      expect(d.notional <= (liq / BigInt(policy.liquidity.floorNotionalMultiple)) || d.notional === policy.capital.minNotional, ctx).toBe(true);
      const c = costAtSize(q, d.spendLamports, NETWORK, RENT);
      expect(c.ok, ctx).toBe(true);
      if (c.ok) {
        const paid = c.trade.roundTrip.paid;
        const net = (paid * edgePpm) / PPM - c.trade.totalLoss - (paid * edgePpm * c.trade.vPpm) / (PPM * PPM);
        expect(net > 0n, `${ctx} net ${net}`).toBe(true);
      }
      expect(d.reservation.amount <= d.reservation.limits.maxHeld, ctx).toBe(true);
    }
    expect(allowed).toBeGreaterThan(50);
  });
});
