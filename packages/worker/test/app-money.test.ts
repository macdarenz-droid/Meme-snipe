// APP-MONEY (AUDIT-RM1 F4): the app's money totals count the account's own costs with the trades, as core risk and the
// backtest report do, and the daily-loss meter is the figure R7 reads. Before, stats, charts and calendar summed closed
// trades only and the meter summed today's losing trades only, so they disagreed with the wallet.
import { describe, expect, it } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, RUG_CONFIG, TRIAL_POLICY, startSession, usd as dollars } from '../../core/src/config/index.ts';
import type { MarketEvent, StrategyContext } from '../../core/src/engine/index.ts';
import { emptyBook } from '../../core/src/lifecycle/book.ts';
import { NO_LATCHES, riskSnapshot } from '../../core/src/risk/index.ts';
import { lamports } from '../../core/src/units/index.ts';
import { DAY_START, HOUR, NOW, PRICE, SOL, account, trade, usd } from '../../core/test/risk/helpers.ts';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor } from '../../../apps/web/src/api/schemas.ts';
import { ACCOUNT_KEY, LiveStrategy, SOL_PRICE_KEY } from '../src/engine/strategy.ts';
import { route, usdText, views } from '../src/run/api.ts';
import { strategyConfig } from '../src/run/settings.ts';
import { makeWorker, passingMarket } from './worker-harness.ts';

type History = ReturnType<typeof account>;
const moment = (ms: number) => ({ slot: BigInt(ms), txIndex: 0, ixIndex: 0, receivedAt: ms });
const session = startSession(TRIAL_POLICY);

/** The strategy's stops after one account event at NOW, and core's own snapshot of the same input. */
const judged = (h: History) => {
  const s = new LiveStrategy({ session, rugs: RUG_CONFIG, config: strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG) });
  const fact = { history: h, latches: NO_LATCHES, solBalance: { value: lamports(SOL), atMs: NOW }, paper: true, oneTimeRent: 0n };
  const facts: Record<string, unknown> = { [SOL_PRICE_KEY]: { value: PRICE, atMs: NOW }, [ACCOUNT_KEY]: fact };
  const ctx: StrategyContext = {
    now: moment(NOW), book: emptyBook({ maxOpenPositions: session.policy.positions.maxOpen }), rng: { next: () => 0 } as never,
    lookup: (k) => (k in facts ? { ok: true, moment: moment(NOW), value: facts[k], source: 'test' } : { ok: false, reason: 'missing' } as never),
    history: () => [],
  };
  s.onMarket({ kind: 'market', id: 'e1', moment: moment(NOW), key: ACCOUNT_KEY, value: fact } satisfies MarketEvent, ctx);
  const core = riskSnapshot({ session, mode: 'paper', clock: { now: () => moment(NOW) }, account: h, latches: NO_LATCHES, market: { solPrice: { value: PRICE, atMs: NOW }, solBalance: { value: lamports(SOL), atMs: NOW }, regime: 'unknown' } } as never);
  return { stops: s.riskStops()!, core: core! };
};

/** The status, stats, charts and calendar the app reads, from a worker's inputs with these trades, costs and stops. */
const servedWith = (patch: Record<string, unknown>) => {
  const h = makeWorker();
  // SOL-BOOKS: R7's figures come in lamports and are shown at the SOL price, here the tests' $100 opening price.
  const i = { ...h.worker.apiInputs(), solPrice: PRICE, halted: [], budgetHalted: [], nowMs: NOW, regime: null, stops: { atMs: NOW, codes: [] as string[], dayLoss: 0n }, trades: [], accountCosts: [], ...patch };
  void h.worker.stop();
  const env = (e: 'status' | 'stats' | 'charts', data: unknown) => checkEnvelope(JSON.parse(JSON.stringify({ mode: 'paper', asOf: new Date(NOW).toISOString(), data })), 'paper', schemaFor(e, 'paper')).data;
  const month = new Date(NOW).toISOString().slice(0, 7);
  return {
    status: env('status', views.status(i as never)) as { risk: { kind: string; usedUsd: string; limitUsd: string | null }[]; haltReasons: { code: string }[] },
    stats: env('stats', views.stats(i as never)) as { trades: number; netUsd: string; maxDrawdownUsd: string; meanNetUsd: string | null },
    charts: env('charts', views.charts(i as never)) as { cumulative: { cumNetUsd: string }[]; daily: { date: string; netUsd: string }[]; costsByKind: { kind: string; amountUsd: string }[]; costsDaily: { totalUsd: string }[] },
    calendar: views.calendar(i as never, month) as { days: { date: string; netUsd: string; trades: number }[] },
  };
};
const meter = (s: ReturnType<typeof servedWith>['status']) => s.risk.find((r) => r.kind === 'daily-loss');

describe('money totals count the account\'s costs (APP-MONEY)', () => {
  const SETUP = { atMs: DAY_START + HOUR, usd: 1_234_567n, lamports: 8_230_447n, kind: 'wallet_setup' };

  it('an account with its setup cost and no trades: net, drawdown, the curve and the day all read −setup', () => {
    const s = servedWith({ accountCosts: [SETUP] });
    expect(s.stats).toMatchObject({ trades: 0, netUsd: '-1.234567', maxDrawdownUsd: '1.234567', meanNetUsd: null });
    expect(s.charts.cumulative.map((c) => c.cumNetUsd)).toEqual(['-1.234567']);
    expect(s.charts.daily.map((d) => d.netUsd)).toEqual(['-1.234567']);
    expect(s.charts.costsByKind).toEqual([{ mode: 'paper', kind: 'rentKeptUsd', amountUsd: '1.234567' }]);
    expect(s.charts.costsDaily.map((d) => d.totalUsd)).toEqual(['1.234567']);
    expect(s.calendar.days.map((d) => [d.netUsd, d.trades])).toEqual([['-1.234567', 0]]);
  });

  it('with trades: costs and trades in time order; win rate and mean net stay per trade', () => {
    const t = (atMs: number, net: bigint) => ({ positionId: `p${atMs}`, mint: 'm', openedAtMs: atMs - 60_000, closedAtMs: atMs, notional: 2_000_000n, netLamports: 0n, netPnl: net, stoppedOut: false, booked: 0n, openSolPrice: null });
    const s = servedWith({ trades: [t(DAY_START + 2 * HOUR, 3_000_000n), t(DAY_START + 3 * HOUR, -1_000_000n)], accountCosts: [SETUP] });
    expect(s.stats).toMatchObject({ trades: 2, netUsd: '0.765433', meanNetUsd: '1' });
    // −1.234567, then +3 (peak 1.765433), then −1: the deepest fall from a peak is the setup's 1.234567 from the start.
    expect(s.stats.maxDrawdownUsd).toBe('1.234567');
    expect(s.charts.cumulative.map((c) => c.cumNetUsd)).toEqual(['-1.234567', '1.765433', '0.765433']);
    expect(s.calendar.days).toEqual([expect.objectContaining({ netUsd: '0.765433', trades: 2 })]);
  });

  it('a real worker\'s inputs carry the same costs its account gives risk', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true });
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => { m.slot(); m.pool(); });
    const i = h.worker.apiInputs();
    expect(i.accountCosts.length).toBe(1);
    expect(i.accountCosts[0]!.kind).toBe('wallet_setup');
    expect(i.accountCosts[0]!.usd > 0n).toBe(true);
    const stats = checkEnvelope(JSON.parse(JSON.stringify(route('/api/v1/paper/stats', () => i).body)), 'paper', schemaFor('stats', 'paper')).data as { netUsd: string };
    const tradeNet = i.trades.filter((t) => t.closedAtMs !== null).reduce((s, t) => s + (t.netPnl ?? 0n), 0n);
    expect(stats.netUsd).toBe(usdText(tradeNet - i.accountCosts[0]!.usd));
    await h.worker.stop();
  });
});

describe('the daily-loss meter is R7\'s figure (APP-MONEY)', () => {
  it('equals core\'s dayLoss on the same inputs: a losing trade, a winning one and a cost booked today', () => {
    const h = account({ closedTrades: [trade(DAY_START + HOUR, '-0.4'), trade(DAY_START + 2 * HOUR, '0.1')], costs: [{ atMs: DAY_START + 3 * HOUR, amount: usd('0.25'), kind: 'wallet_setup' }] });
    const { stops, core } = judged(h);
    expect(core.dayLoss).toBe(usd('0.55'));
    expect(stops.dayLoss).toBe(core.dayLoss);
    const s = servedWith({ stops });
    expect(meter(s.status)).toMatchObject({ usedUsd: '0.55' });
  });

  it('counts a cost booked today with no trade', () => {
    const { stops } = judged(account({ costs: [{ atMs: DAY_START + HOUR, amount: usd('0.3'), kind: 'wallet_setup' }] }));
    expect(stops.dayLoss).toBe(usd('0.3'));
    expect(meter(servedWith({ stops, accountCosts: [{ atMs: DAY_START + HOUR, usd: dollars('0.3'), lamports: 2_000_000n, kind: 'wallet_setup' }] }).status)).toMatchObject({ usedUsd: '0.3' });
  });

  it('a gain today offsets a loss, as R7 counts it: the old sum of losing trades read more', () => {
    const h = account({ closedTrades: [trade(DAY_START + HOUR, '-0.4'), trade(DAY_START + 2 * HOUR, '0.3')] });
    const { stops } = judged(h);
    // SOL-BOOKS: the trades' results are lamports; the app shows them at the trade's price.
    const trades = h.closedTrades.map((t) => ({ positionId: `p${t.closedAtMs}`, mint: t.mint, openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs, notional: t.notional, netLamports: t.netPnl, netPnl: null, stoppedOut: false, booked: 0n, openSolPrice: PRICE }));
    expect(meter(servedWith({ stops, trades }).status)).toMatchObject({ usedUsd: '0.1' });
  });

  it('a current R7 read from before a losing close or a cost: the meter shows the higher realised figure (risk review 1)', () => {
    const t = { positionId: 'p1', mint: 'm', openedAtMs: DAY_START + HOUR, closedAtMs: NOW - 500, notional: 2_000_000n, netLamports: 0n, netPnl: -500_000n, stoppedOut: false, booked: 0n, openSolPrice: null };
    // R7's figure in lamports: 1,000,000 is $0.10 at the $100 price.
    const read = { atMs: NOW - 1_000, codes: [] as string[], dayLoss: 1_000_000n };
    expect(meter(servedWith({ stops: read, trades: [t] }).status)).toMatchObject({ usedUsd: '0.5' });
    expect(meter(servedWith({ stops: read, accountCosts: [{ atMs: NOW - 500, usd: 700_000n, lamports: 4_666_667n, kind: 'wallet_setup' }] }).status)).toMatchObject({ usedUsd: '0.7' });
    // R7's own figure when it is the higher (marked losses only it can see).
    expect(meter(servedWith({ stops: { ...read, dayLoss: 9_000_000n }, trades: [t] }).status)).toMatchObject({ usedUsd: '0.9' });
  });

  it('unknown or old risk: no meter (never a 0), and the risk-unknown chip', () => {
    for (const stops of [null, { atMs: NOW, codes: null, dayLoss: null }, { atMs: NOW - 60_000, codes: [], dayLoss: 0n }]) {
      const s = servedWith({ stops });
      expect(meter(s.status), JSON.stringify(stops, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toBeUndefined();
      expect(s.status.haltReasons.map((x) => x.code)).toContain('risk-unknown');
    }
  });
});

describe('partial sales count at their own time, as core risk counts them (risk review 2, RISK-PARTIAL #132\'s shape)', () => {
  // A partial sale yesterday (+0.3) and the close today: the whole trade nets −0.2, so the close's remainder is −0.5.
  // SOL-BOOKS: a part is its lamports, shown at the trade's price: 3,000,000 at $100 is +$0.30.
  const part = { atMs: DAY_START - HOUR, lamports: 3_000_000n };
  const t = { positionId: 'p1', mint: 'm', openedAtMs: DAY_START - 2 * HOUR, closedAtMs: DAY_START + HOUR, notional: 2_000_000n, netLamports: 0n, netPnl: -200_000n, stoppedOut: false, booked: 0n, openSolPrice: null, partials: [part] };

  it('the day split, the meter, the curve and the net', () => {
    const s = servedWith({ trades: [t], stops: { atMs: NOW, codes: [] as string[], dayLoss: 0n } });
    // Today's realised loss is the close's remainder, not the whole trade's −0.2.
    expect(meter(s.status)).toMatchObject({ usedUsd: '0.5' });
    expect(s.charts.cumulative.map((c) => c.cumNetUsd)).toEqual(['0.3', '-0.2']);
    expect(s.charts.daily.map((d) => d.netUsd)).toEqual(['0.3', '-0.5']);
    expect(s.stats).toMatchObject({ trades: 1, netUsd: '-0.2', maxDrawdownUsd: '0.5' });
    // Both days are in the same month (helpers: 6 and 7 October, Melbourne).
    expect(s.calendar.days.map((d) => [d.netUsd, d.trades])).toEqual([['0.3', 0], ['-0.5', 1]]);
  });

  it('splits the day exactly as core risk does (RISK-PARTIAL in the base): R7\'s figure and the app\'s realised one agree', () => {
    // The same trade for core: its partial yesterday, its whole net −0.2 at today's close.
    const core = account({ closedTrades: [{ ...trade(DAY_START + HOUR, '-0.2'), partials: [{ atMs: DAY_START - HOUR, pnl: usd('0.3') }] }] });
    const { stops, core: snap } = judged(core);
    expect(snap.dayLoss).toBe(usd('0.5'));
    expect(stops.dayLoss).toBe(snap.dayLoss);
    // The app from the paper account's record of it: its own realised figure (a read of 0 before the close) and R7's agree.
    expect(meter(servedWith({ trades: [t], stops: { atMs: NOW, codes: [] as string[], dayLoss: 0n } }).status)).toMatchObject({ usedUsd: '0.5' });
    expect(meter(servedWith({ trades: [t], stops }).status)).toMatchObject({ usedUsd: '0.5' });
  });

  it('an open trade\'s partial is realised already: it counts in net and on its day', () => {
    const open = { ...t, closedAtMs: null, netPnl: null, partials: [{ ...part, atMs: DAY_START + HOUR }] };
    const s = servedWith({ trades: [open] });
    expect(s.stats).toMatchObject({ trades: 0, netUsd: '0.3' });
    expect(s.charts.daily.map((d) => d.netUsd)).toEqual(['0.3']);
  });
});
