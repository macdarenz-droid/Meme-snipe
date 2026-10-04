// BT-SOL (owner rule: profit is counted in SOL, not dollars): the backtest report carries exact lamport figures beside
// the dollar ones (net, gross, costs by kind, drawdown, per-trade net and size, mean net) and returns on lamports
// (net ÷ entry lamports). Dollars stay as the secondary figure; the SOL figures never move with the SOL/USD price.
import { describe, expect, test } from 'vitest';
import { parseReport } from '../../../apps/web/src/api/reportSchema.ts';
import { FILL_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { OffchainSeries } from '../src/dataset/offchain.ts';
import { buildReport } from '../src/report.ts';
import type { StrayCost, TradeRecord } from '../src/trades.ts';

const H = 3_600_000;
const T = Date.parse('2026-09-20T00:00:00Z');
// SOL is US$100, then US$200 from T+3h (usable an hour later): the dollar result moves, the lamport result does not.
const SERIES: OffchainSeries = {
  name: 'SOL/USD', source: 'test', tag: 'fixed', barMs: H, fetchedAt: T,
  bars: Array.from({ length: 48 }, (_, k) => ({ start: T - 10 * H + k * H, close: T - 10 * H + k * H < T + 3 * H ? '100.00' : '200.00' })),
};
const SOL = 1_000_000_000n;
const leg = (o: Partial<TradeRecord['legs']['entry']> = {}) => ({ networkBase: 0n, priority: 0n, tip: 0n, venueFee: 0n, creatorFee: 0n, slippage: 0n, ...o });
const trade = (over: Partial<TradeRecord>): TradeRecord => ({
  id: 'p1', mint: 'M'.repeat(43), symbol: 'M', openedAt: T + 4 * H, closedAt: T + 6 * H, entrySol: SOL, tokens: 1_000_000n, exitSol: SOL,
  networkBase: 0n, priority: 0n, tip: 0n, venueFee: 0n, creatorFee: 0n, slippage: 0n, rentPaid: 0n, rentReturned: 0n,
  exitReason: 'time-stop', net: 0n, attempts: 2, failedAttempts: 0, legs: { entry: leg(), exit: leg() }, ...over,
});
const report = (trades: TradeRecord[], stray: StrayCost[] = []) => buildReport({
  runId: 't', generatedAt: '2026-10-03T00:00:00.000Z', codeCommit: 'a'.repeat(40), policy: TRIAL_POLICY, fills: FILL_CONFIG,
  dataset: { id: 'x', from: T, to: T + 24 * H }, engine: { replays: 1, identicalReplays: true, crashes: 0, illegalStates: 0, unreconciledIntents: 0 },
  solUsd: SERIES, candidates: 1, entries: trades.length, groups: [{ group: 'S0', trades, stray }], gates: [],
});

describe('the report in SOL (BT-SOL)', () => {
  // A winner: 1 SOL in, 1.2 SOL out; 0.01 SOL network fee and 0.02 SOL venue fee a leg, 0.002 SOL rent paid and returned.
  const fee = 10_000_000n;
  const win = trade({
    id: 'p1', openedAt: T + 1 * H, closedAt: T + 6 * H, exitSol: 1_200_000_000n, networkBase: 2n * fee, venueFee: 4n * fee, rentPaid: 2_000_000n, rentReturned: 2_000_000n,
    net: 1_200_000_000n - SOL - 2n * fee, legs: { entry: leg({ networkBase: fee, venueFee: 2n * fee }), exit: leg({ networkBase: fee, venueFee: 2n * fee }) },
  });
  // A loser: 1 SOL in, 0.5 SOL out.
  const loss = trade({ id: 'p2', openedAt: T + 7 * H, closedAt: T + 8 * H, exitSol: 500_000_000n, net: -500_000_000n });

  test('each trade carries exact lamports: size, gross, net, costs by kind, and the net return on lamports', () => {
    const t = report([win]).trades[0]!;
    expect([t.sizeLamports, t.netLamports]).toEqual(['1000000000', '180000000']);
    expect(t.costsLamports).toEqual({
      venueFeeLamports: '40000000', creatorFeeLamports: '0', priorityFeeLamports: '0', tipLamports: '0', networkFeeLamports: '20000000',
      slippageLamports: '0', rentPaidLamports: '2000000', rentReturnedLamports: '2000000', totalLamports: '60000000',
    });
    // Gross is net plus every cost, as in dollars.
    expect(t.grossLamports).toBe('240000000');
    expect(t.netReturn).toBe('0.180000000');
    // Dollars stay, at each flow's own price: the SOL move shows in USD only.
    expect(t.netUsd).not.toBe('18');
  });

  test('each result carries net, drawdown, mean net and the mean return in lamports, with stray costs on their day', () => {
    const stray: StrayCost[] = [{ at: T + 9 * H, lamports: 5_000_000n, intentId: 'e9', positionId: 'p9' }];
    const r = report([win, loss], stray).results[0]!;
    expect(r.netLamports).toBe(String(180_000_000n - 500_000_000n - 5_000_000n));
    // Peak +0.18 SOL after the winner, then −0.5 and −0.005: drawdown 0.505 SOL.
    expect(r.maxDrawdownLamports).toBe('505000000');
    expect(r.meanNetLamports).toBe(String((180_000_000n - 500_000_000n) / 2n));
    expect(r.meanReturn).toBe('-0.160000000');
    expect(r.equity.map((e) => e.cumNetLamports)).toEqual(['180000000', '-320000000', '-325000000']);
    expect(r.days.map((d) => d.netLamports)).toEqual(['-325000000']);
    expect(report([]).results[0]).toMatchObject({ netLamports: '0', maxDrawdownLamports: '0', meanNetLamports: null, meanReturn: null });
  });

  test('the app accepts the report (its strict schema knows every lamport field)', () => {
    expect(() => parseReport(JSON.parse(JSON.stringify(report([win, loss]))))).not.toThrow();
  });
});
