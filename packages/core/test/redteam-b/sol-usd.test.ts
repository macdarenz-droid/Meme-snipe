// RED TEAM B probes: the owner's rule (CLAUDE.md, 2026-10-05) says P&L, equity, drawdown and every loss limit and kill
// line are counted in SOL; a SOL/USD move alone must never trip or hide a limit. Each test asserts that rule and FAILS
// at 959d801 (risk is still kept in micro-dollars; SOL-BOOKS #197 unmerged).
import { describe, expect, test } from 'vitest';
import { TRIAL_POLICY, usd } from '../../src/config/index.ts';
import { type TradeLamports, tradeNet, tradeUsd } from '../../src/fills/index.ts';
import { evaluateEntry, evaluateExit } from '../../src/risk/index.ts';
import { type MicroUsd, lamports, microUsdToLamports, mulDiv } from '../../src/units/index.ts';
import { HOUR, MINT_B, MINUTE, NOW, PRICE, account, baseInput, baseRequest, codes, trade } from '../risk/helpers.ts';

const floor = TRIAL_POLICY.reserve.opsFloor;
/** A wallet whose SOL above the floor was worth $20 at PRICE: NAV peak $20 recorded an hour ago, no trade ever. */
const walletSol = floor + microUsdToLamports(usd('20'), PRICE, 'floor');
const at = (price: MicroUsd) => baseInput({
  account: account({ navMarks: [{ atMs: NOW - HOUR, nav: usd('20') }] }),
  market: { solPrice: { value: price, atMs: NOW - 500 }, solBalance: { value: lamports(walletSol), atMs: NOW - 500 }, regime: 'on' },
});
const scaled = (bpsOfPrice: bigint) => mulDiv(PRICE, bpsOfPrice, 10_000n, 'floor') as MicroUsd;

describe('RB-1 SOL/USD move alone trips limits (no trade, SOL quantity unchanged)', () => {
  test('RB-1a a 31% fall in SOL/USD latches the R10 kill switch on an idle wallet', () => {
    const exit = evaluateExit(at(scaled(6_900n)));
    // Owner rule: the SOL quantity did not change, so nothing may trip. At 959d801 this returns ['kill_switch'], and the
    // worker's #markAccount latches it (owner re-arm only).
    expect(exit.trips).not.toContain('kill_switch');
  });
  test('RB-1b an 11% fall in SOL/USD alone forces the size back to the minimum (R2 drawdown reset) after step-up', () => {
    const input = { ...at(scaled(8_900n)), latches: { ...at(PRICE).latches, sizeStepUpApproved: true } };
    const d = evaluateEntry(input, baseRequest());
    const same = evaluateEntry({ ...at(PRICE), latches: input.latches }, baseRequest());
    expect(d.allow && same.allow).toBe(true);
    // Same SOL, same pool: the size (in SOL) should not drop because the dollar fell.
    expect(d.allow && d.caps.some((c) => c.name === 'drawdown returns size to the minimum')).toBe(false);
  });
});

describe('RB-2 SOL/USD rise hides a SOL loss', () => {
  // Paid 1 SOL, got 0.95 SOL back (-5% in SOL, plus fees): a loss in the owner's units.
  const legs = { networkBase: 5_000n, priority: 20_000n, tip: 0n, venueFee: 0n, creatorFee: 0n, slippage: 0n };
  const t: TradeLamports = { entrySol: 1_000_000_000n, exitSol: 950_000_000n, legs: { entry: legs, exit: legs }, rentPaid: 2_039_280n, rentReturned: 2_039_280n };
  test('RB-2a a trade that lost SOL is booked as a dollar win when SOL/USD rose 6% during it', () => {
    expect(tradeNet(t) < 0n).toBe(true);
    const u = tradeUsd(t, PRICE, scaled(10_600n));
    // account.ts #value books netPnl = tradeUsd(...).net; risk's isLoss reads netPnl.
    expect(u.net < 0n).toBe(true);
  });
  test('RB-2b so R15 (no larger size after a loss) and R8 (loss streak cooldown) do not fire after two SOL-losing trades', () => {
    const net = tradeUsd(t, PRICE, scaled(10_600n)).net as MicroUsd;
    const asBooked = (closedAtMs: number) => ({ ...trade(closedAtMs, '0'), netPnl: net, notional: usd('5') });
    const input = baseInput({ account: account({ closedTrades: [asBooked(NOW - 30 * MINUTE), asBooked(NOW - 20 * MINUTE)] }) });
    const d = evaluateEntry(input, baseRequest({ mint: MINT_B }));
    expect(codes(d)).toContain('loss_cooldown');
  });
  test('RB-2c an open position down 25% in SOL shows zero marked loss when SOL/USD rose 34% (daily loss blind)', () => {
    // $5 notional at PRICE; now 0.75 of its SOL, valued at 1.34 * PRICE = $5.025 > notional, so markedLoss = 0.
    const open = { mint: MINT_B, openedAtMs: NOW - 10 * MINUTE, notional: usd('5'), mark: mulDiv(usd('5'), 7_500n * 13_400n, 10_000n * 10_000n, 'floor') as MicroUsd, markAtMs: NOW - 100 };
    const input = baseInput({ account: account({ openPositions: [open] }), market: { solPrice: { value: scaled(13_400n), atMs: NOW - 500 }, solBalance: { value: lamports(walletSol), atMs: NOW - 500 }, regime: 'on' } });
    const exit = evaluateExit(input);
    // A 25% loss of a $5 position is $1.25 in today's units, 6.25% of the $20 bankroll; risk sees $0.
    const snap = (evaluateEntry(input, baseRequest()) as { snapshot: { dayLoss: bigint } }).snapshot;
    expect(snap.dayLoss > 0n).toBe(true);
    expect(exit.allow).toBe(true);
  });
});
