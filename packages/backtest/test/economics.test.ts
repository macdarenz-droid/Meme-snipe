// BT-1c items 5-7: all-in expectancy, currency at each flow's own time, operating costs.
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { OffchainSeries } from '../src/dataset/offchain.ts';
import { economics } from '../src/economics.ts';
import { buildReport } from '../src/report.ts';
import type { StrayCost, TradeRecord } from '../src/trades.ts';

const H = 3_600_000;
const T = Date.parse('2026-09-20T00:00:00Z');
// SOL is US$100 until T+2h (usable from T+4h on), then US$200 (usable from T+5h).
const SERIES: OffchainSeries = {
  name: 'SOL/USD', source: 'test', tag: 'fixed', barMs: H, fetchedAt: T,
  bars: Array.from({ length: 48 }, (_, k) => ({ start: T - 10 * H + k * H, close: T - 10 * H + k * H < T + 3 * H ? '100.00' : '200.00' })),
};
const SOL = 1_000_000_000n;
const zeroLeg = { networkBase: 0n, priority: 0n, tip: 0n, venueFee: 0n, creatorFee: 0n, slippage: 0n };
const trade = (over: Partial<TradeRecord> = {}): TradeRecord => ({
  id: 'p1', mint: 'm', symbol: 'M', openedAt: T + 4 * H, closedAt: T + 6 * H, entrySol: SOL, tokens: 1_000_000n, exitSol: SOL,
  networkBase: 0n, priority: 0n, tip: 0n, venueFee: 0n, creatorFee: 0n, slippage: 0n, rentPaid: 0n, rentReturned: 0n,
  exitReason: 'time-stop', net: 0n, attempts: 2, failedAttempts: 0, legs: { entry: zeroLeg, exit: zeroLeg }, ...over,
});
const report = (trades: TradeRecord[], stray: StrayCost[] = []) => buildReport({
  runId: 't', generatedAt: '2026-10-03T00:00:00.000Z', codeCommit: 'a'.repeat(40), policy: TRIAL_POLICY, fills: FILL_CONFIG,
  dataset: { id: 'x', from: T, to: T + 24 * H }, engine: { replays: 1, identicalReplays: true, crashes: 0, illegalStates: 0, unreconciledIntents: 0 },
  solUsd: SERIES, candidates: 1, entries: trades.length, groups: [{ group: 'S0', trades, stray }], gates: [],
});

describe('currency (item 6)', () => {
  test('the entry is converted at the entry-time price and the exit at the exit-time price', () => {
    const r = report([trade()]);
    const t = r.trades[0]!;
    expect(t.sizeUsd).toBe('100');
    expect(t.netUsd).toBe('100');
  });

  test('each leg\'s costs at its own time; SOL returns reported apart from USD flows; idle SOL marked to market', () => {
    const fee = 10_000_000n; // 0.01 SOL each leg
    const t = trade({ exitSol: SOL, networkBase: 2n * fee, net: -2n * fee, legs: { entry: { ...zeroLeg, networkBase: fee }, exit: { ...zeroLeg, networkBase: fee } } });
    const r = report([t]);
    expect(r.trades[0]!.costs.networkFeeUsd).toBe('3'); // $1 at entry + $2 at exit
    expect(r.trades[0]!.netUsd).toBe('97'); // +200 - 100 - 1 - 2
    const e = economics({ trades: [t], stray: [], entryDecisions: 1, solUsd: SERIES, window: { from: T, to: T + 24 * H }, policy: TRIAL_POLICY, research: RESEARCH_CONFIG });
    expect(e.sol.tradeNetLamports).toBe(-2n * fee);
    expect(e.usd.tradeNetMicro).toBe(97_000_000n);
    // The bankroll (US$20 at the start price) and the ops reserve, held as SOL, revalued at the end price.
    expect(e.markToMarket.startPriceMicro).toBe(100_000_000n);
    expect(e.markToMarket.endPriceMicro).toBe(200_000_000n);
    expect(e.markToMarket.bankrollLamports).toBe(200_000_000n);
    expect(e.markToMarket.idleRevaluationMicro).toBe(20_000_000n + (TRIAL_POLICY.reserve.opsFloor as bigint) * 100n / 1000n);
  });
});

describe('all-in expectancy (item 5)', () => {
  test('failed-attempt fees count in the all-in expectancy and in every daily return; the conditional mean is per filled trade', () => {
    const t = trade({ openedAt: T + 1 * H, closedAt: T + 1.5 * H, exitSol: SOL + 2n * 10_000_000n, net: 20_000_000n });
    const stray: StrayCost[] = [{ at: T + 30 * H, lamports: 5_000_000n }];
    const e = economics({ trades: [t], stray, entryDecisions: 3, solUsd: SERIES, window: { from: T, to: T + 48 * H }, policy: TRIAL_POLICY, research: RESEARCH_CONFIG });
    expect(e.usd.conditionalMeanPerTradeMicro).toBe(2_000_000n); // +0.02 SOL at $100
    expect(e.usd.strayMicro).toBe(-1_000_000n); // 0.005 SOL at $200
    expect(e.usd.allInMicro).toBe(1_000_000n);
    expect(e.usd.allInPerFilledTradeMicro).toBe(1_000_000n);
    expect(e.usd.allInPerEntryDecisionMicro).toBe(333_333n);
    // Daily returns cover every Melbourne day of the window, failed attempts included, as a share of the bankroll.
    const days = new Map(e.dailyReturns.map((d) => [d.day, d.rNet]));
    expect(days.get('2026-09-20')).toBeCloseTo(2 / 20, 12);
    expect(days.get('2026-09-21')).toBeCloseTo(-1 / 20, 12);
    expect([...days.values()].filter((x) => x === 0).length).toBe(e.dailyReturns.length - 2);
  });
});

describe('operating costs (item 7)', () => {
  test('hosting is its own line, against the bankroll and the trade count, with the break-even net per trade', () => {
    expect(RESEARCH_CONFIG.operating.hostingUsdPerMonth).toBe(6_000_000n);
    const trades = [trade(), trade({ id: 'p2' })];
    const e = economics({ trades, stray: [], entryDecisions: 2, solUsd: SERIES, window: { from: T, to: T + 30.4375 * 24 * H }, policy: TRIAL_POLICY, research: RESEARCH_CONFIG });
    expect(e.operating.hostingMicro).toBe(6_000_000n);
    expect(e.operating.hostingPerTradeMicro).toBe(3_000_000n);
    expect(e.operating.breakEvenNetPerTradeMicro).toBe(3_000_000n);
    expect(e.operating.hostingShareOfBankrollPerMonthBps).toBe(3000);
    expect(e.operating.netAfterHostingMicro).toBe(e.usd.allInMicro - 6_000_000n);
  });
});

describe('operating costs at other bankrolls (item 7, supervisor addition)', () => {
  test('hosting share and break-even at US$20, 100 and 200, with sizes from the policy scaled to each bankroll', () => {
    const trades = [trade(), trade({ id: 'p2' })];
    const e = economics({ trades, stray: [], entryDecisions: 2, solUsd: SERIES, window: { from: T, to: T + 30.4375 * 24 * H }, policy: TRIAL_POLICY, research: RESEARCH_CONFIG });
    expect(RESEARCH_CONFIG.operating.projectionBankrolls).toEqual([20_000_000n, 100_000_000n, 200_000_000n]);
    expect(e.atBankrolls.map((b) => b.bankrollMicro)).toEqual([20_000_000n, 100_000_000n, 200_000_000n]);
    const minShare = (TRIAL_POLICY.capital.minNotional as bigint) * 1_000_000n / (TRIAL_POLICY.capital.bankroll as bigint);
    for (const b of e.atBankrolls) {
      // The policy's sizes keep their share of the bankroll.
      expect(b.minNotionalMicro * 1_000_000n / b.bankrollMicro).toBe(minShare);
      expect(b.hostingShareOfBankrollPerMonthBps).toBe(Number(6_000_000n * 10_000n / b.bankrollMicro));
      expect(b.breakEvenNetPerTradeMicro).toBe(3_000_000n);
      expect(b.breakEvenBpsOfMinTrade).toBe(Number(3_000_000n * 10_000n / b.minNotionalMicro));
    }
    expect(e.atBankrolls[2]!.hostingShareOfBankrollPerMonthBps).toBe(300);
  });
});

