// RED TEAM B probes RB-1 and RB-2 (claude/redteam-b c92d903), kept in their SOL-BOOKS form. The owner counts P&L, equity,
// drawdown and every loss limit and kill line in SOL (CLAUDE.md, 2026-10-05): a SOL/USD move alone never trips or hides
// a limit. At 959d8017 the originals fail (risk read a live SOL/USD price and kept micro-dollars). Since SOL-BOOKS risk
// takes no live SOL/USD price at all (`MarketInputs` has none), so each probe is stated in what risk does read: the
// wallet's SOL, the marks and trade results in lamports. The worker-level probes, which run unchanged on both heads,
// are in packages/worker/test/redteam-b-sol*.test.ts.
import { describe, expect, test } from 'vitest';
import { type TradeLamports, tradeNet, tradeUsd } from '../../src/fills/index.ts';
import { evaluateEntry, evaluateExit, riskSnapshot } from '../../src/risk/index.ts';
import { type Lamports, type MicroUsd, lamports, mulDiv } from '../../src/units/index.ts';
import { HOUR, MINT_B, MINUTE, NOW, PRICE, account, baseInput, baseRequest, codes, trade, usd } from '../risk/helpers.ts';

/** A wallet of $20 of SOL at the opening price, its NAV peak that same SOL an hour ago; no trade ever. */
const wallet = usd('20');
const idle = baseInput({
  account: account({ navMarks: [{ atMs: NOW - HOUR, nav: wallet }] }),
  market: { solBalance: { value: lamports(wallet), atMs: NOW - 500 }, regime: 'on' },
});
const scaled = (bpsOfPrice: bigint) => mulDiv(PRICE, bpsOfPrice, 10_000n, 'floor') as MicroUsd;

describe('RB-1 the same SOL trips nothing, whatever SOL/USD did', () => {
  test('RB-1a an idle wallet at its NAV peak (in SOL) latches no kill switch', () => {
    expect(evaluateExit(idle).trips).not.toContain('kill_switch');
  });
  test('RB-1b with the step-up approved, the same SOL is no drawdown: the size is not returned to the minimum', () => {
    const d = evaluateEntry({ ...idle, latches: { ...idle.latches, sizeStepUpApproved: true } }, baseRequest());
    expect(d.allow).toBe(true);
    expect(d.allow && d.caps.some((c) => c.name === 'drawdown returns size to the minimum')).toBe(false);
  });
});

describe('RB-2 a trade that lost SOL is a loss, whatever its dollar figure', () => {
  // Paid 1 SOL, got 0.95 SOL back (-5% in SOL, plus fees), while SOL/USD rose 6%: a dollar gain.
  const legs = { networkBase: 5_000n, priority: 20_000n, tip: 0n, venueFee: 0n, creatorFee: 0n, slippage: 0n };
  const t: TradeLamports = { entrySol: 1_000_000_000n, exitSol: 950_000_000n, legs: { entry: legs, exit: legs }, rentPaid: 2_039_280n, rentReturned: 2_039_280n };
  const booked = (closedAtMs: number) => trade(closedAtMs, '0', { netPnl: tradeNet(t) as Lamports, notional: usd('5') });

  test('RB-2a its dollar figure is a gain, its result (what risk reads) a loss', () => {
    expect(tradeUsd(t, PRICE, scaled(10_600n)).net > 0n).toBe(true);
    expect(booked(NOW - MINUTE).netPnl < 0n).toBe(true);
  });
  test('RB-2b two of them start R8\'s loss cooldown, and R15 caps the next size at the last one\'s', () => {
    const input = baseInput({ account: account({ closedTrades: [booked(NOW - 30 * MINUTE), booked(NOW - 20 * MINUTE)] }) });
    expect(codes(evaluateEntry(input, baseRequest({ mint: MINT_B })))).toContain('loss_cooldown');
    // R15 on a trial-size trade (0.02 SOL in, 0.019 SOL out): a SOL loss, so no larger size after it.
    const small = tradeNet({ ...t, entrySol: 20_000_000n, exitSol: 19_000_000n });
    const one = baseInput({ account: account({ closedTrades: [trade(NOW - 3 * HOUR, '0', { netPnl: small as Lamports, notional: usd('2') })] }), latches: { ...idle.latches, sizeStepUpApproved: true } });
    const d = evaluateEntry(one, baseRequest({ mint: MINT_B }));
    expect(small < 0n).toBe(true);
    expect(d.allow && d.caps.some((c) => c.control === 'R15' && c.notional === usd('2'))).toBe(true);
  });
  test('RB-2c an open position down 25% in SOL is a loss of that SOL today', () => {
    const open = { mint: MINT_B, openedAtMs: NOW - 10 * MINUTE, notional: usd('5'), mark: mulDiv(usd('5'), 7_500n, 10_000n, 'floor') as Lamports, markAtMs: NOW - 100 };
    const input = baseInput({ account: account({ openPositions: [open] }) });
    expect(riskSnapshot(input)!.dayLoss).toBe(usd('1.25'));
    expect(evaluateExit(input).allow).toBe(true);
  });
});
