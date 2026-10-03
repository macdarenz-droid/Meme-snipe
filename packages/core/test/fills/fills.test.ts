import { describe, expect, test } from 'vitest';
import type { PoolState } from '../../src/amm/index.ts';
import { FILL_CONFIG } from '../../src/config/index.ts';
import { createRng } from '../../src/engine/index.ts';
import {
  type FillScenario, type ObservedFees, type RealSwap, NetworkState, ShiftedPool, attemptFee, blockedExitValue, drawAttempt, networkEnterPpm, providerDown, executeBuy, executeSell,
  replaySwap, withSlippage,
} from '../../src/fills/index.ts';
import { bps } from '../../src/units/index.ts';
import { NORMAL_COIN, readFixture } from '../amm/helpers.ts';

type Str = Record<string, string>;
interface PoolVector { signature: string; kind: 'buy' | 'sell'; ixName: string; ixDisc: string; args: [string, string]; event: Str }
const V2_DISCS = ['5df6823ce7e940b2', 'c2ab1c46684d5b2f', 'b817ee6167c5d33d'];
const golden = readFixture<{ pumpswap: PoolVector[] }>('golden.json');
const n = (s: string | undefined) => BigInt(s ?? 'missing');

const swapOf = (v: PoolVector): RealSwap => {
  const e = v.event;
  return {
    side: v.kind,
    mode: v.kind === 'buy' && v.ixName !== 'buy' ? 'exact-quote-in' : 'exact-base',
    amount: BigInt(v.args[0]),
    pre: { baseReserve: n(e['pool_base_token_reserves']), quoteVault: n(e['pool_quote_token_reserves']), virtualQuoteReserves: n(e['virtual_quote_reserves']) },
    fees: {
      split: { lp: bps(Number(e['lp_fee_basis_points'])), protocol: bps(Number(e['protocol_fee_basis_points'])), creator: bps(Number(e['coin_creator_fee_basis_points'])) },
      buybackFeeBps: bps(Number(e['buyback_fee_basis_points'])),
      instruction: V2_DISCS.includes(v.ixDisc) ? 'v2' : 'v1',
    },
    baseSupply: n(e['base_supply']),
  };
};

describe('replaying real swaps with the fees they paid', () => {
  test.each(golden.pumpswap.map((v) => [`${v.ixName} ${v.signature.slice(0, 12)}`, v] as const))('%s reproduces the event', (_, v) => {
    const q = replaySwap(swapOf(v).pre, swapOf(v));
    if (!q.ok) throw new Error(q.detail);
    const e = v.event;
    expect(q.trade.lpFee).toBe(n(e['lp_fee']));
    expect(q.trade.protocolFee).toBe(n(e['protocol_fee']));
    expect(q.trade.creatorFee).toBe(n(e['coin_creator_fee']));
    if (v.kind === 'sell') expect(q.trade.userQuote).toBe(n(e['user_quote_amount_out']));
    else expect(q.trade.base).toBe(n(e['base_amount_out']));
  });
});

const FEES: ObservedFees = { split: { lp: bps(20), protocol: bps(5), creator: bps(95) }, buybackFeeBps: bps(5000), instruction: 'v1' };
const POOL: PoolState = { baseReserve: 200_000_000_000_000n, quoteVault: 80_000_000_000n, virtualQuoteReserves: 0n };
const buyOf = (pre: PoolState, spend: bigint): RealSwap => ({ side: 'buy', mode: 'exact-quote-in', amount: spend, pre, fees: FEES, baseSupply: 1_000_000_000_000_000n });
const sellOf = (pre: PoolState, base: bigint): RealSwap => ({ side: 'sell', mode: 'exact-base', amount: base, pre, fees: FEES, baseSupply: 1_000_000_000_000_000n });
const trade = (pool: PoolState, extra: Partial<Parameters<typeof executeBuy>[0]> = {}) => ({
  pool, fees: FEES, baseSupply: 1_000_000_000_000_000n, coin: NORMAL_COIN, quotedOut: 0n, minOut: 1n, slippagePpm: 1_000_000n, ...extra,
});

describe('ShiftedPool: later trades see our impact', () => {
  test('without our trades the state is the real post-trade state', () => {
    const p = new ShiftedPool();
    const r = p.applyReal(buyOf(POOL, 1_000_000_000n))!;
    expect(p.state).toEqual(r.real);
    expect(r.shifted).toEqual(r.real);
  });

  test('a real buy after our buy gets fewer tokens, and the shifted pool keeps our tokens out', () => {
    const p = new ShiftedPool();
    const first = p.applyReal(buyOf(POOL, 1_000_000_000n))!;
    const ours = executeBuy(trade(p.state!), 2_000_000_000n);
    if (!ours.ok) throw new Error(ours.detail);
    p.applyOurs(ours.after);
    // The next real buyer arrives with the same spend; its pre-trade reserves in the data do not include our trade.
    const theirsPre = first.real;
    const untouched = replaySwap(theirsPre, buyOf(theirsPre, 1_000_000_000n));
    const shiftedPre = p.state!;
    const r = p.applyReal(buyOf(theirsPre, 1_000_000_000n))!;
    const onShifted = replaySwap(shiftedPre, buyOf(theirsPre, 1_000_000_000n));
    if (!untouched.ok || !onShifted.ok) throw new Error('quote');
    expect(onShifted.trade.base).toBeLessThan(untouched.trade.base);
    expect(r.shifted).toEqual(onShifted.trade.after);
    // Our tokens are still out of the pool: the shifted base reserve is below the real one by about what we bought.
    expect(r.real.baseReserve - r.shifted.baseReserve).toBeGreaterThan(0n);
    expect(p.state).toEqual(r.shifted);
  });

  test('selling back what we bought returns the pool close to the real one', () => {
    const p = new ShiftedPool();
    p.applyReal(buyOf(POOL, 1_000_000_000n));
    const bought = executeBuy(trade(p.state!), 2_000_000_000n);
    if (!bought.ok) throw new Error(bought.detail);
    p.applyOurs(bought.after);
    const sold = executeSell(trade(p.state!), bought.out);
    if (!sold.ok) throw new Error(sold.detail);
    p.applyOurs(sold.after);
    expect(p.delta.base).toBe(0n);
    // The fees we paid stay in the pool: effective quote is higher by about the LP fees of both legs.
    expect(p.delta.vault).toBeGreaterThan(0n);
    expect(sold.out).toBeLessThan(2_000_000_000n);
  });

  test('a swap that cannot be quoted on its own state makes the pool unknown, and keeps our delta', () => {
    const p = new ShiftedPool();
    const first = p.applyReal(buyOf(POOL, 1_000_000_000n))!;
    const ours = executeBuy(trade(p.state!), 2_000_000_000n);
    if (!ours.ok) throw new Error(ours.detail);
    p.applyOurs(ours.after);
    const delta = p.delta;
    expect(delta.base).toBeLessThan(0n);
    expect(p.applyReal(sellOf({ baseReserve: 0n, quoteVault: 0n, virtualQuoteReserves: 0n }, 5n))).toBeNull();
    expect(p.state).toBeNull();
    expect(p.delta).toEqual(delta);
    expect(() => p.applyOurs(POOL)).toThrow(RangeError);
    // The next swap resyncs the real state; our tokens are still out of the shifted pool.
    const r = p.applyReal(buyOf(first.real, 1_000_000_000n))!;
    expect(r.real.baseReserve - r.shifted.baseReserve).toBeGreaterThan(0n);
  });
});

describe('our execution', () => {
  test('min out is enforced after the scenario slippage', () => {
    const q = executeBuy(trade(POOL), 2_000_000_000n);
    if (!q.ok) throw new Error(q.detail);
    expect(executeBuy(trade(POOL, { minOut: q.out + 1n }), 2_000_000_000n)).toMatchObject({ ok: false, reason: 'slippage' });
    // Quoted 1% more than executes: at 1.5x the shortfall grows by half.
    const quoted = q.out + q.out / 100n;
    const c = executeBuy(trade(POOL, { quotedOut: quoted, slippagePpm: 1_500_000n }), 2_000_000_000n);
    if (!c.ok) throw new Error(c.detail);
    expect(c.out).toBe(q.out - (quoted - q.out + 1n) / 2n);
  });

  test('withSlippage leaves a better-than-quoted fill alone and never goes below zero', () => {
    expect(withSlippage(110n, 100n, 1_500_000n)).toBe(110n);
    expect(withSlippage(10n, 100n, 2_000_000n)).toBe(0n);
    expect(() => withSlippage(1n, 1n, 999_999n)).toThrow(RangeError);
  });

  test('an unquotable pool refuses with the CORE-2 reason', () => {
    expect(executeSell(trade({ baseReserve: 1n, quoteVault: 0n, virtualQuoteReserves: 0n }), 5n)).toMatchObject({ ok: false, reason: 'no-liquidity' });
  });

  test('blocked exit value: last ladder rung on a quotable pool, otherwise 0', () => {
    const q = executeSell(trade(POOL), 1_000_000_000n);
    if (!q.ok) throw new Error(q.detail);
    expect(blockedExitValue(POOL, 1_000_000_000n, FEES, 1_000_000_000_000_000n, NORMAL_COIN, 2500)).toBe((q.out * 7500n) / 10_000n);
    expect(blockedExitValue(null, 1_000_000_000n, FEES, 1n, NORMAL_COIN, 2500)).toBe(0n);
    expect(blockedExitValue({ ...POOL, quoteVault: 0n }, 5n, FEES, 1n, NORMAL_COIN, 2500)).toBe(0n);
  });
});

describe('landing draws', () => {
  const base = FILL_CONFIG.scenarios.base;

  test('the same seed gives the same draws; the land share matches the configured rate', () => {
    const draw = (seed: string) => { const r = createRng(seed); return Array.from({ length: 20_000 }, () => drawAttempt(r, base, 'pumpswap')); };
    const a = draw('s');
    expect(draw('s')).toEqual(a);
    const lands = a.filter((d) => d.fate === 'lands').length / a.length;
    expect(lands).toBeGreaterThan(0.64);
    expect(lands).toBeLessThan(0.68);
    // Regular latencies, and the long tail: a tail draw never lands sooner than the regular one it replaces.
    const possible = new Set([...base.landingSlots, ...base.landingSlots.flatMap((x) => base.landingTail.slots.map((t) => Math.max(x, t)))]);
    expect(new Set(a.map((d) => d.landingSlots))).toEqual(possible);
  });

  test('dropPpm splits the misses into dropped and failed', () => {
    const s: FillScenario = { ...base, dropPpm: 500_000n };
    const r = createRng('d');
    const a = Array.from({ length: 20_000 }, () => drawAttempt(r, s, 'pump-curve'));
    const dropped = a.filter((d) => d.fate === 'dropped').length;
    const failed = a.filter((d) => d.fate === 'fails').length;
    expect(Math.abs(dropped - failed) / (dropped + failed)).toBeLessThan(0.05);
    expect(a.filter((d) => d.fate === 'lands').length / a.length).toBeLessThan(0.51);
  });

  test('fees: success pays base, priority and tip; failure base and priority; a dropped attempt nothing', () => {
    const net = FILL_CONFIG.network;
    expect(attemptFee(net, 20_000n, 'filled')).toBe(5_000n + 20_000n + 5_000n);
    expect(attemptFee(net, 20_000n, 'failed')).toBe(25_000n);
    expect(attemptFee(net, 20_000n, 'dropped')).toBe(0n);
  });

  test('scenarios: conservative is the §11 one', () => {
    const c = FILL_CONFIG.scenarios.conservative;
    expect(c.slippagePpm).toBe(1_500_000n);
    expect(c.takeProfit).toBe('close');
    expect(c.rentRecovery).toBe(false);
    expect(Math.min(...c.landingSlots)).toBeGreaterThanOrEqual(Math.max(...base.landingSlots));
  });
});

describe('stress in the fill model (BT-1c item 4)', () => {
  const { conservative: c, base: b, optimistic: o } = FILL_CONFIG.scenarios;

  test('the values are marked provisional and differ by scenario', () => {
    expect(FILL_CONFIG.provisional).toBe(true);
    for (const v of ['pumpswap', 'pump-curve'] as const) {
      expect(c.landPpm[v]).toBeLessThan(b.landPpm[v]);
      expect(b.landPpm[v]).toBeLessThan(o.landPpm[v]);
    }
    for (const s of [c, b, o]) {
      expect(s.dropPpm).toBeGreaterThan(0n);
      expect(s.congestion.network.enterPpm).toBeGreaterThan(0n);
      expect(s.congestion.providerFailPpm).toBeGreaterThan(0n);
      expect(s.landingTail.ppm).toBeGreaterThan(0n);
      expect(s.exitRetryHaircutPpm).toBeGreaterThan(0n);
    }
  });

  test('one persistent shared network state over slot windows: bursts last, at the stationary share, from the seed', () => {
    const net = c.congestion.network;
    const a = new NetworkState('seed', c);
    const again = new NetworkState('seed', c);
    const windows = 200_000;
    let on = 0;
    let runs = 0;
    let prev = false;
    const seq: boolean[] = [];
    for (let w = 0n; w < BigInt(windows); w++) {
      const x = a.congested(w);
      seq.push(x);
      if (x) on++;
      if (x && !prev) runs++;
      prev = x;
    }
    // Deterministic from the seed; asking again gives the same answer; an earlier window than the first is refused.
    for (const w of [5n, 17n, 199_999n]) expect(again.congested(w)).toBe(seq[Number(w)]);
    expect(() => again.congested(4n)).toThrow(RangeError);
    const enter = Number(net.enterPpm) / 1e6;
    const stay = Number(net.stayPpm) / 1e6;
    expect(Math.abs(on / windows - enter / (enter + 1 - stay))).toBeLessThan(0.01);
    // Mean burst length 1 / (1 - stay) windows: persistent, not one window at a time.
    expect(Math.abs(on / runs - 1 / (1 - stay)) / (1 / (1 - stay))).toBeLessThan(0.1);
    expect(1 / (1 - stay)).toBeGreaterThan(2);
  });

  test('the base network state is congested at least 8% of the time with no market activity (the earlier burst share)', () => {
    const n = FILL_CONFIG.scenarios.base.congestion.network;
    const enter = Number(n.enterPpm) / 1e6;
    expect(enter / (enter + 1 - Number(n.stayPpm) / 1e6)).toBeGreaterThanOrEqual(0.08);
  });

  test('market activity raises the entry probability up to a cap, never below the base; provider failures sit on top', () => {
    const n = c.congestion.network;
    expect(networkEnterPpm(c, 0n)).toBe(n.enterPpm);
    expect(networkEnterPpm(c, 100n * 1_000_000_000n)).toBeGreaterThan(networkEnterPpm(c, 1_000_000_000n));
    expect(networkEnterPpm(c, 10n ** 18n)).toBe(n.maxEnterPpm);
    const busy = new NetworkState('act', c, () => 10n ** 18n);
    const calm = new NetworkState('act', c, () => 0n);
    let b = 0;
    let q = 0;
    for (let w = 0n; w < 50_000n; w++) {
      if (busy.congested(w)) b++;
      if (calm.congested(w)) q++;
    }
    expect(b).toBeGreaterThan(q);
    // With varying activity, the state at w + k is the same whether or not the windows between were asked.
    const vol = (w: bigint) => (w % 7n === 0n ? 10n ** 12n : 0n);
    const every = new NetworkState('gap', c, vol);
    const skip = new NetworkState('gap', c, vol);
    every.congested(0n);
    skip.congested(0n);
    for (let w = 1n; w < 5_000n; w++) every.congested(w);
    for (const w of [4_999n, 2_500n, 3n]) expect(skip.congested(w)).toBe(every.congested(w));
    let down = 0;
    for (let w = 0n; w < 50_000n; w++) if (providerDown('s', w, c)) down++;
    expect(Math.abs(down / 50_000 - Number(c.congestion.providerFailPpm) / 1e6)).toBeLessThan(0.005);
  });

  test('in a congested window every attempt lands less often and later', () => {
    const r1 = createRng('calm');
    const r2 = createRng('calm');
    const calm = Array.from({ length: 20_000 }, () => drawAttempt(r1, c, 'pumpswap', false));
    const busy = Array.from({ length: 20_000 }, () => drawAttempt(r2, c, 'pumpswap', true));
    const landed = (a: typeof calm) => a.filter((d) => d.fate === 'lands').length / a.length;
    expect(landed(busy)).toBeLessThan(landed(calm) * (Number(c.congestion.landFactorPpm) / 1e6) + 0.02);
    // Same draws, so each busy latency is the calm one plus the burst's extra slots.
    busy.forEach((d, k) => expect(d.landingSlots).toBe(calm[k]!.landingSlots + c.congestion.extraLandingSlots));
  });

  test('a long tail of landing delays at the configured share', () => {
    const r = createRng('tail');
    const a = Array.from({ length: 50_000 }, () => drawAttempt(r, c, 'pumpswap', false));
    const tailMin = Math.min(...c.landingTail.slots);
    const share = a.filter((d) => d.landingSlots >= tailMin && tailMin > Math.max(...c.landingSlots)).length / a.length;
    expect(Math.abs(share - Number(c.landingTail.ppm) / 1e6)).toBeLessThan(0.005);
  });

  test('liquidity worsens on each repeated exit attempt', () => {
    const outs = [0, 1, 2, 3].map((k) => {
      const x = executeSell(trade(POOL), 1_000_000_000n, BigInt(k) * c.exitRetryHaircutPpm);
      if (!x.ok) throw new Error(x.detail);
      return x;
    });
    for (let k = 1; k < outs.length; k++) expect(outs[k]!.out).toBeLessThan(outs[k - 1]!.out);
    // The haircut is a cost of the attempt, in lamports, and the pool sees the same sell whatever it.
    expect(outs[2]!.costs.extraSlippage - outs[0]!.costs.extraSlippage).toBe(outs[0]!.out - outs[2]!.out);
    expect(outs[2]!.after).toEqual(outs[0]!.after);
  });
});

describe('scenario ordering', () => {
  // Every field ordered conservative ≤ base ≤ optimistic in the direction that is better for us.
  const { conservative: c, base: b, optimistic: o } = FILL_CONFIG.scenarios;
  const mean = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const better = <T>(name: string, worse: T, mid: T, best: T, le: (x: T, y: T) => boolean) =>
    test(name, () => {
      expect(le(worse, mid)).toBe(true);
      expect(le(mid, best)).toBe(true);
    });
  const lower = (x: number, y: number) => x >= y; // lower is better: worse value is larger
  better('landing share per venue', c.landPpm, b.landPpm, o.landPpm, (x, y) => (Object.keys(b.landPpm) as (keyof typeof x)[]).every((v) => x[v] <= y[v]));
  better('dropped share (a dropped attempt costs nothing; a failed one pays fees)', c.dropPpm, b.dropPpm, o.dropPpm, (x, y) => x <= y);
  const D = FILL_CONFIG.delays;
  const slotsOf = (n: typeof c.delay) => D[n].eventToProcessedSlots + D[n].processedToConfirmedSlots;
  better('observation delay, slots', slotsOf(c.delay), slotsOf(b.delay), slotsOf(o.delay), lower);
  better('observation delay, provider ms', D[c.delay].providerMs, D[b.delay].providerMs, D[o.delay].providerMs, lower);
  test('delay profiles: stress ≥ adverse ≥ measured in every part; conservative uses adverse', () => {
    expect(c.delay).toBe('adverse');
    for (const k of ['eventToProcessedSlots', 'processedToConfirmedSlots', 'providerMs'] as const) {
      expect(D.stress[k]).toBeGreaterThanOrEqual(D.adverse[k]);
      expect(D.adverse[k]).toBeGreaterThanOrEqual(D.measured[k]);
    }
    expect([D.adverse.eventToProcessedSlots, D.adverse.processedToConfirmedSlots, D.adverse.providerMs]).toEqual([2, 6, 1_000]);
    expect([D.stress.eventToProcessedSlots, D.stress.processedToConfirmedSlots, D.stress.providerMs]).toEqual([4, 12, 2_000]);
    expect(D.measured.status).toBe('unmeasured');
  });
  better('network congestion entry', c.congestion.network.enterPpm, b.congestion.network.enterPpm, o.congestion.network.enterPpm, (x, y) => x >= y);
  better('network congestion persistence', c.congestion.network.stayPpm, b.congestion.network.stayPpm, o.congestion.network.stayPpm, (x, y) => x >= y);
  better('network entry per SOL of market activity', c.congestion.network.activityEnterPpmPerSol, b.congestion.network.activityEnterPpmPerSol, o.congestion.network.activityEnterPpmPerSol, (x, y) => x >= y);
  better('network entry cap', c.congestion.network.maxEnterPpm, b.congestion.network.maxEnterPpm, o.congestion.network.maxEnterPpm, (x, y) => x >= y);
  better('provider failures', c.congestion.providerFailPpm, b.congestion.providerFailPpm, o.congestion.providerFailPpm, (x, y) => x >= y);
  better('landing share in a burst', c.congestion.landFactorPpm, b.congestion.landFactorPpm, o.congestion.landFactorPpm, (x, y) => x <= y);
  better('extra landing slots in a burst', c.congestion.extraLandingSlots, b.congestion.extraLandingSlots, o.congestion.extraLandingSlots, lower);
  test('the congestion window is the same length in every scenario', () => {
    expect(new Set([c, b, o].map((s) => s.congestion.windowSlots)).size).toBe(1);
  });
  better('long-tail share', c.landingTail.ppm, b.landingTail.ppm, o.landingTail.ppm, (x, y) => x >= y);
  better('long-tail latency (mean and worst)', c.landingTail.slots, b.landingTail.slots, o.landingTail.slots, (x, y) => lower(mean(x), mean(y)) && lower(Math.max(...x), Math.max(...y)));
  better('exit retry haircut', c.exitRetryHaircutPpm, b.exitRetryHaircutPpm, o.exitRetryHaircutPpm, (x, y) => x >= y);
  better('discovery lag (mean and worst)', c.discoverySlots, b.discoverySlots, o.discoverySlots, (x, y) => lower(mean(x), mean(y)) && lower(Math.max(...x), Math.max(...y)));
  better('landing latency (mean and worst)', c.landingSlots, b.landingSlots, o.landingSlots, (x, y) => lower(mean(x), mean(y)) && lower(Math.max(...x), Math.max(...y)));
  better('confirmation lag', c.confirmSlots, b.confirmSlots, o.confirmSlots, lower);
  better('finalization lag', c.finalizeSlots, b.finalizeSlots, o.finalizeSlots, lower);
  better('extra slippage', c.slippagePpm, b.slippagePpm, o.slippagePpm, (x, y) => x >= y);
  better('take-profit basis (close is worse than wick)', c.takeProfit, b.takeProfit, o.takeProfit, (x, y) => x === 'close' || y === 'wick');
  better('rent recovery', c.rentRecovery, b.rentRecovery, o.rentRecovery, (x, y) => !x || y);
  better('account close success', c.closeSuccessPpm, b.closeSuccessPpm, o.closeSuccessPpm, (x, y) => x <= y);
  better('dust left in the account', c.dustPpm, b.dustPpm, o.dustPpm, (x, y) => x >= y);
  test('the test covers every scenario field', () => {
    expect(Object.keys(b).sort()).toEqual(['closeSuccessPpm', 'confirmSlots', 'congestion', 'delay', 'discoverySlots', 'dropPpm', 'dustPpm', 'exitRetryHaircutPpm', 'finalizeSlots', 'landPpm', 'landingSlots', 'landingTail', 'name', 'rentRecovery', 'slippagePpm', 'takeProfit']);
  });
});
