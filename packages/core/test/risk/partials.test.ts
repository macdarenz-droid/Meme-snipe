// RISK-PARTIAL (audit M3): what a partial sale realized counts in equity at its own time; a closed trade's whole result
// stays one trade for the statistics, its partial parts at their times and the rest at the close.
import { describe, expect, test } from 'vitest';
import { NO_LATCHES, evaluateEntry, riskSnapshot } from '../../src/risk/index.ts';
import type { Lamports } from '../../src/units/index.ts';
import { DAY_START, HOUR, MINT_A, NOW, account, baseInput, baseRequest, codes, trade, usd } from './helpers.ts';

const neg = (x: string) => -usd(x) as Lamports;
const snap = (a: ReturnType<typeof account>) => riskSnapshot(baseInput({ account: a }))!;
const held = (partials: { atMs: number; pnl: Lamports }[], notional = usd('2.5')) =>
  ({ mint: MINT_A, openedAtMs: DAY_START - 3 * HOUR, notional, mark: notional, markAtMs: NOW - 500, partials });

describe('partial sales in the account figures (RISK-PARTIAL)', () => {
  test('an open position\'s realized partial counts in equity and in the day loss now', () => {
    const s = snap(account({ openPositions: [held([{ atMs: NOW - HOUR, pnl: neg('0.6') }])] }));
    expect(s.equity).toBe(usd('19.4'));
    expect(s.dayLoss).toBe(usd('0.6'));
    // A gain is realized too: equity rises, and so does the high-water mark.
    const g = snap(account({ openPositions: [held([{ atMs: NOW - HOUR, pnl: usd('1') }])] }));
    expect(g.equity).toBe(usd('21'));
    expect(g.highWaterMark).toBe(usd('21'));
  });

  test('a closed trade: each part at its own time, the rest at the close; a part before the day start is not today\'s', () => {
    // Yesterday +$0.50 on the first half; today the trade closes with a whole result of $0 (today's half lost $0.50).
    const t = trade(NOW - HOUR, '0', { partials: [{ atMs: DAY_START - HOUR, pnl: usd('0.5') }] });
    const s = snap(account({ closedTrades: [t] }));
    expect(s.equity).toBe(usd('20'));
    expect(s.dayLoss).toBe(usd('0.5'));
    // The same trade with nothing realized before the close: no loss today.
    expect(snap(account({ closedTrades: [trade(NOW - HOUR, '0')] })).dayLoss).toBe(0n);
  });

  test('statistics count whole trades: a losing partial in a winning trade is no loss, a winning partial in a losing one is', () => {
    const win = trade(NOW - 2 * HOUR, '0.2', { partials: [{ atMs: NOW - 3 * HOUR, pnl: neg('0.3') }] });
    expect(snap(account({ closedTrades: [win] })).lossStreak).toBe(0);
    const loss = trade(NOW - 2 * HOUR, '-0.2', { partials: [{ atMs: NOW - 3 * HOUR, pnl: usd('0.3') }] });
    expect(snap(account({ closedTrades: [loss] })).lossStreak).toBe(1);
  });

  test('a part dated after now is refused as an invalid history', () => {
    const d = evaluateEntry(baseInput({ account: account({ openPositions: [held([{ atMs: NOW + 1, pnl: usd('0') }])] }) }), baseRequest());
    expect(codes(d)).toContain('bankroll_invalid');
    const c = evaluateEntry(baseInput({ account: account({ closedTrades: [trade(NOW - HOUR, '0', { partials: [{ atMs: NOW + 1, pnl: usd('0') }] })] }) }), baseRequest());
    expect(codes(c)).toContain('bankroll_invalid');
  });

  test('NAV waits for a balance read at or after a partial sale', () => {
    const base = baseInput({ account: account({ openPositions: [held([{ atMs: NOW - 400, pnl: usd('0') }])] }), latches: NO_LATCHES });
    // The balance was read at NOW - 500, before the sale at NOW - 400: not consistent, no NAV.
    expect(riskSnapshot(base)!.nav).toBeNull();
    const after = { ...base, market: { ...base.market, solBalance: { ...base.market.solBalance!, atMs: NOW - 300 } } };
    expect(riskSnapshot(after)!.nav).not.toBeNull();
  });
});
