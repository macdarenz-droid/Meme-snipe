// APP-SOL: the worker serves every money figure in lamports beside the dollars, from the lamports it already holds
// (fills, the paper account's trade net, the open P&L), and the current SOL price for the app's dollar line.
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor, type Endpoint } from '../../../apps/web/src/api/schemas.ts';
import { schemaFor as baselineSchema } from '../../../apps/web/test/fixtures/app-money-schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import { openPnl, route, usdText, views } from '../src/run/api.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd, microUsdToLamports } from '../../core/src/units/index.ts';
import { makeWorker, passingMarket } from './worker-harness.ts';

const HELD = { heldPoolFacts: true } as const;

describe('lamports beside dollars (APP-SOL)', () => {
  it('a real worker with a closed trade and an open one serves exact lamports the app\'s schema accepts', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => { m.slot(); m.pool(); });
    let i = h.worker.apiInputs();
    const get = <T,>(e: Endpoint, path = PATHS[e as Exclude<Endpoint, 'calendar'>]('paper')) => {
      checkEnvelope(JSON.parse(JSON.stringify(route(path, () => i).body)), 'paper', baselineSchema(e, 'paper'));
      return checkEnvelope(JSON.parse(JSON.stringify(route(path + '?money=lamports', () => i).body)), 'paper', schemaFor(e, 'paper')).data as T;
    };

    // The open trade.
    const p = Object.values(i.book.positions).find((x) => x.status === 'open')!;
    const o = i.open(p)!;
    const fills = [...i.attempts.values()].filter((a) => a.trade === p.id && a.outcome === 'filled');
    const pnl = openPnl(o.liquidation, fills, i.exitFee(p));
    const pos = get<Record<string, string>>('position');
    expect(pos).toMatchObject({ sizeLamports: String(p.cost), liquidationValueLamports: String(o.liquidation), unrealizedLamports: String(pnl.gross), costsSoFarLamports: String(pnl.fees), pnlLamports: String(pnl.net) });

    const status = get<{ solPriceUsd: string; risk: { kind: string; usedLamports: string | null; limitLamports: string | null }[] }>('status');
    expect(status.solPriceUsd).toBe(usdText(i.solPrice!));
    expect(status.risk.find((r) => r.kind === 'open-exposure')!.usedLamports).toBe(String(p.cost));
    const daily = status.risk.find((r) => r.kind === 'daily-loss')!;
    expect(daily.limitLamports).not.toBeNull();

    // The price falls through the stop: the trade closes; then another entry.
    await m.run(6_000, 400, () => { m.slot(); m.pool(700_000n); });
    await m.run(14_000, 400, () => { m.slot(); m.pool(700_000n); });
    i = h.worker.apiInputs();

    const closed = i.trades.filter((t) => t.closedAtMs !== null);
    expect(closed.length).toBeGreaterThanOrEqual(1);
    const trades = get<{ id: string; netLamports: string; sizeLamports: string; grossLamports: string; costs: { totalLamports: string; venueFeeLamports: string; rentPaidLamports: string; rentReturnedLamports: string }; fills: { side: string; filledLamports: string }[] }[]>('trades');
    for (const t of trades) {
      const src = closed.find((x) => x.positionId === t.id)!;
      expect(t.netLamports).toBe(String(src.netLamports));
      const buys = [...i.attempts.values()].filter((a) => a.trade === t.id && a.purpose === 'entry' && a.outcome === 'filled');
      expect(t.sizeLamports).toBe(String(buys.reduce((s, a) => s + a.fill!.sol, 0n)));
      expect(BigInt(t.grossLamports)).toBe(BigInt(t.netLamports) + BigInt(t.costs.totalLamports));
      expect(BigInt(t.costs.totalLamports) > 0n).toBe(true);
      expect(t.costs.rentPaidLamports).toBe(String(i.legs.network.tokenAccountRent));
      const returned = [...i.attempts.values()].some((a) => a.trade === t.id && a.purpose === 'exit' && a.outcome === 'filled' && i.legs.closedAccount(a.signature));
      expect(t.costs.rentReturnedLamports).toBe(returned ? t.costs.rentPaidLamports : '0');
      expect(t.fills.find((f) => f.side === 'buy')!.filledLamports).toBe(t.sizeLamports);
    }

    const stats = get<{ netLamports: string; maxDrawdownLamports: string; meanNetLamports: string | null }>('stats');
    const tradeNet = closed.reduce((s, t) => s + (t.netLamports ?? 0n), 0n);
    const net = tradeNet - i.accountCosts.filter((c) => c.kind !== 'late_settlement').reduce((s, c) => s + c.lamports, 0n);
    expect(stats.netLamports).toBe(String(net));
    expect(stats.meanNetLamports).toBe(String(tradeNet / BigInt(closed.length)));
    const charts = get<{ cumulative: { cumNetLamports: string }[]; daily: { netLamports: string }[]; costsByKind: { amountLamports: string }[] }>('charts');
    expect(charts.cumulative.at(-1)!.cumNetLamports).toBe(String(net));
    expect(charts.daily.reduce((s, d) => s + BigInt(d.netLamports), 0n)).toBe(net);
    const month = new Date(h.timers.now()).toISOString().slice(0, 7);
    const cal = get<{ days: { netLamports: string }[] }>('calendar', PATHS.calendar('paper', month));
    expect(cal.days.reduce((s, d) => s + BigInt(d.netLamports), 0n)).toBe(net);

    await h.worker.stop();
  });
});

describe('SOL-BOOKS: the daily-loss meter and the session limits are risk\'s own lamports', () => {
  // $150.000001 per SOL: dollar figures that do not divide into whole lamports.
  const PRICE = 150_000_001n as MicroUsd;
  const served = (dayLoss: bigint, dailyLimit: bigint, solPrice: MicroUsd = PRICE) => {
    const h = makeWorker();
    const base = h.worker.apiInputs();
    void h.worker.stop();
    const i = { ...base, solPrice, openingSolPrice: PRICE, trades: [], accountCosts: [], stops: { atMs: base.nowMs, codes: [], dayLoss, dailyLimit } };
    const status = views.status(i as never) as { risk: { kind: string; usedUsd: string; limitUsd: string | null; usedLamports: string | null; limitLamports: string | null }[]; session: Record<string, unknown>; haltReasons: { code: string }[] };
    return { meter: status.risk.find((r) => r.kind === 'daily-loss')!, session: status.session, halts: status.haltReasons.map((x) => x.code), base };
  };

  it('used and limit are R7\'s lamports exactly; the dollars beside them round the loss up and the limit down', () => {
    const { meter } = served(8_230_452n, 9_999_999n);
    expect([meter.usedLamports, meter.limitLamports]).toEqual(['8230452', '9999999']);
    expect(meter.usedUsd).toBe(usdText(lamportsToMicroUsd(8_230_452n as Lamports, PRICE, 'ceil')));
    expect(meter.limitUsd).toBe(usdText(lamportsToMicroUsd(9_999_999n as Lamports, PRICE, 'floor')));
    expect(lamportsToMicroUsd(8_230_452n as Lamports, PRICE, 'ceil')).not.toBe(lamportsToMicroUsd(8_230_452n as Lamports, PRICE, 'floor'));
  });

  it('a SOL/USD move alone moves no SOL figure, and the SOL meter alone decides the daily-loss halt', () => {
    const at = served(5_000_000n, 9_999_999n);
    for (const ppm of [500_000n, 1_340_000n]) {
      const moved = served(5_000_000n, 9_999_999n, ((PRICE * ppm) / 1_000_000n) as MicroUsd);
      expect([moved.meter.usedLamports, moved.meter.limitLamports]).toEqual([at.meter.usedLamports, at.meter.limitLamports]);
      expect(moved.halts).not.toContain('daily-loss');
    }
  });

  it('between R7\'s reads, today\'s realised loss in lamports against R7\'s line in lamports decides the daily-loss halt', () => {
    const h = makeWorker();
    const base = h.worker.apiInputs();
    void h.worker.stop();
    const halted = (lossLamports: bigint, limit: bigint) => {
      const t = { positionId: 'p1', mint: 'm', openedAtMs: base.nowMs - 120_000, closedAtMs: base.nowMs - 60_000, notional: 2_000_000n, netLamports: -lossLamports, netPnl: null, stoppedOut: false, booked: 0n, openSolPrice: PRICE };
      const i = { ...base, solPrice: PRICE, openingSolPrice: PRICE, trades: [t], accountCosts: [], stops: { atMs: base.nowMs, codes: [], dayLoss: 0n, dailyLimit: limit } };
      return (views.status(i as never) as { haltReasons: { code: string }[] }).haltReasons.some((x) => x.code === 'daily-loss');
    };
    // Lamports against lamports (the policy's $1.50 is 1,500,000 micro-dollars: never compared with lamports).
    expect(halted(1_200_000n, 1_000_000n)).toBe(true);
    expect(halted(1_600_000n, 2_000_000n)).toBe(false);
    expect(halted(2_000_000n, 2_000_000n)).toBe(true);
  });

  it('a closed trade\'s size is its lamports in dollars at its entry price', () => {
    const h = makeWorker();
    const base = h.worker.apiInputs();
    void h.worker.stop();
    const t = { positionId: 'p1', mint: 'm', openedAtMs: base.nowMs - 120_000, closedAtMs: base.nowMs - 60_000, notional: 20_000_000n, netLamports: -1_000n, netPnl: null, stoppedOut: false, booked: 0n, openSolPrice: 150_000_000n, closeSolPrice: 150_000_000n };
    // 0.02 SOL at $150 is $3 (at the current $200 it would read $4).
    expect(views.trades({ ...base, solPrice: 200_000_000n, trades: [t] } as never)[0]).toMatchObject({ sizeUsd: '3' });
  });

  it('the session limits in lamports are the policy\'s dollars at the opening price, rounded as risk rounds them', () => {
    // The current price differs from the opening one: the limits follow the opening price only.
    const { session, base } = served(0n, 9_999_999n, 200_000_000n as MicroUsd);
    const p = base.policy;
    const b = microUsdToLamports(p.capital.bankroll, PRICE, 'floor');
    expect(session).toMatchObject({
      bankrollLamports: String(b), entryLamports: String(microUsdToLamports(p.capital.minNotional, PRICE, 'ceil')), maxEntryLamports: String(microUsdToLamports(p.capital.maxNotional, PRICE, 'floor')),
      dailyLossLimitLamports: String((b * BigInt(p.loss.dailyBps)) / 10_000n), weeklyLossLimitLamports: String((b * BigInt(p.loss.weeklyBps)) / 10_000n),
    });
    // Before the opening price: none (the app shows the configured dollars).
    const h = makeWorker();
    const none = views.status({ ...h.worker.apiInputs(), openingSolPrice: null } as never) as { session: Record<string, unknown> };
    void h.worker.stop();
    expect(none.session).not.toHaveProperty('bankrollLamports');
  });
});

describe('a trade with no lamport net fails closed (review N1)', () => {
  it('is never counted as 0 SOL: the SOL totals it is part of are not served, so the app shows dollars', () => {
    const h = makeWorker();
    const base = h.worker.apiInputs();
    void h.worker.stop();
    const t = (id: string, closedAtMs: number, netLamports: bigint | null) => ({ positionId: id, mint: 'm', openedAtMs: closedAtMs - 60_000, closedAtMs, notional: 2_000_000n, netLamports, netPnl: -100_000n, stoppedOut: false, booked: 0n, openSolPrice: null });
    const day = base.nowMs - 3_600_000;
    const i = { ...base, trades: [t('a', day, -5_000n), t('b', day + 1_000, null)] };
    const stats = views.stats(i as never) as Record<string, unknown>;
    expect(stats).not.toHaveProperty('netLamports');
    expect(stats).not.toHaveProperty('maxDrawdownLamports');
    expect(stats).toMatchObject({ netUsd: '-0.2' });
    const charts = views.charts(i as never) as { cumulative: Record<string, unknown>[]; daily: Record<string, unknown>[] };
    expect(charts.cumulative[0]).toHaveProperty('cumNetLamports', '-5000');
    expect(charts.cumulative[1]).not.toHaveProperty('cumNetLamports');
    expect(charts.daily[0]).not.toHaveProperty('netLamports');
    const month = new Date(day).toISOString().slice(0, 7);
    const cal = views.calendar(i as never, month) as { days: Record<string, unknown>[] };
    expect(cal.days[0]).not.toHaveProperty('netLamports');
    const trades = views.trades(i as never) as Record<string, unknown>[];
    const b = trades.find((x) => x['id'] === 'b')!;
    expect(b).not.toHaveProperty('netLamports');
    expect(b).not.toHaveProperty('grossLamports');
    expect(trades.find((x) => x['id'] === 'a')).toHaveProperty('netLamports', '-5000');
    // With every trade known, the same figures are served in lamports.
    const all = { ...base, trades: [t('a', day, -5_000n), t('b', day + 1_000, -7_000n)] };
    expect(views.stats(all as never)).toMatchObject({ netLamports: '-12000' });
  });
});
