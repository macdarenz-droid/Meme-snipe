// PAPER-1: the settlement the backtest and paper mode share (fills/settle.ts).
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG } from '../../src/config/index.ts';
import { TokenAccounts, feeParts, tradeNet, tradeRent, tradeUsd, type TradeLamports } from '../../src/fills/index.ts';
import type { MicroUsd } from '../../src/units/index.ts';

const NONE = { networkBase: 0n, priority: 0n, tip: 0n, venueFee: 0n, creatorFee: 0n, slippage: 0n };
const usd = (d: number) => BigInt(Math.round(d * 1_000_000)) as MicroUsd;
const scenario = (closeSuccessPpm: bigint, dustPpm: bigint) => ({ ...FILL_CONFIG.scenarios.conservative, closeSuccessPpm, dustPpm });

describe('dollar results value each cash flow at its own SOL price (M5)', () => {
  test('buy 0.02 SOL at $100, sell for 0.024 SOL at $80: −$0.08, not +$0.32; SOL +0.004; the SOL move is −$0.40', () => {
    const t: TradeLamports = { entrySol: 20_000_000n, exitSol: 24_000_000n, legs: { entry: NONE, exit: NONE }, rentPaid: 0n, rentReturned: 0n };
    const v = tradeUsd(t, usd(100), usd(80));
    expect(v.net).toBe(-80_000n);
    expect(v.netLamports).toBe(4_000_000n);
    expect(v.trading).toBe(320_000n);
    expect(v.solMove).toBe(-400_000n);
    expect(v.trading + v.solMove).toBe(v.net);
  });

  test('rent leaves at the entry price and comes back at the exit price; fees on top of the swap amounts', () => {
    const fee = { ...NONE, networkBase: 5_000n, priority: 20_000n, tip: 5_000n };
    const t: TradeLamports = { entrySol: 20_000_000n, exitSol: 20_000_000n, legs: { entry: fee, exit: fee }, rentPaid: 1_000_000n, rentReturned: 1_000_000n };
    expect(tradeNet(t)).toBe(-60_000n);
    const v = tradeUsd(t, usd(100), usd(80));
    // 0.02 SOL in at $100, out at $80; fees 30,000 lamports each leg; rent $0.10 out, $0.08 back.
    expect(v.net).toBe(1_600_000n - 2_000_000n - 3_000n - 2_400n - 100_000n + 80_000n);
    expect(v.trading + v.solMove).toBe(v.net);
  });
});

describe('fees and rent (M4, M8)', () => {
  test('a landed failure pays base and priority, a fill base, priority and tip, anything else nothing', () => {
    const net = FILL_CONFIG.network;
    expect(feeParts(net, 500_000n, 'failed')).toEqual({ base: 5_000n, priority: 500_000n, tip: 0n });
    expect(feeParts(net, 500_000n, 'filled')).toEqual({ base: 5_000n, priority: 500_000n, tip: net.tip });
    for (const o of ['dropped', 'expired', 'in_flight']) expect(feeParts(net, 500_000n, o)).toEqual({ base: 0n, priority: 0n, tip: 0n });
  });

  test('rent: the first trade of an entry pays it, and gets it back only when its account closed', () => {
    const net = FILL_CONFIG.network;
    expect(tradeRent(net, true, true)).toEqual({ rentPaid: net.tokenAccountRent, rentReturned: net.tokenAccountRent });
    expect(tradeRent(net, true, false)).toEqual({ rentPaid: net.tokenAccountRent, rentReturned: 0n });
    expect(tradeRent(net, false, true)).toEqual({ rentPaid: 0n, rentReturned: 0n });
  });

  test('token accounts: a full sell closes; a failed close makes the account sell-only until a later close; a partial never closes', () => {
    const leg = (purpose: 'entry' | 'exit', tokens: bigint, sig: string) => ({ purpose, mint: 'M', tokens, closeSeed: `s:${sig}`, dustSeed: `s:M:${sig}` });
    const ok = new TokenAccounts();
    ok.settle(leg('entry', 100n, 'a'), scenario(1_000_000n, 0n));
    expect(ok.settle(leg('exit', 40n, 'b'), scenario(1_000_000n, 0n))).toEqual({ ok: true, closedAccount: false });
    expect(ok.settle(leg('exit', 60n, 'c'), scenario(1_000_000n, 0n))).toEqual({ ok: true, closedAccount: true });

    const bad = new TokenAccounts();
    bad.settle(leg('entry', 100n, 'a'), scenario(0n, 0n));
    expect(bad.settle(leg('exit', 100n, 'b'), scenario(0n, 0n))).toEqual({ ok: false, reason: 'close failed' });
    expect(bad.closes('M', 100n)).toBe(false);
    expect(bad.settle(leg('exit', 100n, 'c'), scenario(0n, 0n))).toEqual({ ok: true, closedAccount: false });

    const dust = new TokenAccounts();
    dust.settle(leg('entry', 100n, 'a'), scenario(1_000_000n, 1_000_000n));
    expect(dust.settle(leg('exit', 100n, 'b'), scenario(1_000_000n, 1_000_000n))).toEqual({ ok: true, closedAccount: false });
  });

  test('a restore rebuilds the same state from settled attempts without drawing a close again', () => {
    const s = scenario(0n, 0n);
    const leg = (purpose: 'entry' | 'exit', tokens: bigint, sig: string) => ({ purpose, mint: 'M', tokens, closeSeed: `s:${sig}`, dustSeed: `s:M:${sig}` });
    const a = new TokenAccounts();
    a.restore(leg('entry', 100n, 'a'), s, 'filled');
    // A sell that filled had its close succeed (closeSuccessPpm 0 would fail any new draw): it closed the account.
    expect(a.restore(leg('exit', 100n, 'b'), s, 'filled')).toBe(true);
    const b = new TokenAccounts();
    b.restore(leg('entry', 100n, 'a'), s, 'filled');
    expect(b.restore(leg('exit', 100n, 'b'), s, 'close failed')).toBe(false);
    expect(b.closes('M', 100n)).toBe(false);
  });
});
