// APP-SOL: the worker serves every money figure in lamports beside the dollars, from the lamports it already holds
// (fills, the paper account's trade net, the open P&L), and the current SOL price for the app's dollar line.
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor, type Endpoint } from '../../../apps/web/src/api/schemas.ts';
import { schemaFor as baselineSchema } from '../../../apps/web/test/fixtures/app-money-schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import { openPnl, route, usdText, views } from '../src/run/api.ts';
import type { MicroUsd } from '../../core/src/units/index.ts';
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

describe('the interim daily-loss meter in SOL rounds on the safe side (review B1)', () => {
  // $150.000001 per SOL: dollar figures that do not divide into whole lamports.
  const PRICE = 150_000_001n as MicroUsd;
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  const served = (lossMicro: bigint) => {
    const h = makeWorker();
    const base = h.worker.apiInputs();
    void h.worker.stop();
    const closed = { positionId: 'p1', mint: 'm', openedAtMs: base.nowMs - 120_000, closedAtMs: base.nowMs - 60_000, notional: 2_000_000n, netLamports: -1n, netPnl: -lossMicro, stoppedOut: false, booked: 0n, openSolPrice: PRICE };
    const i = { ...base, solPrice: PRICE, trades: [closed], stops: { atMs: base.nowMs, codes: [], dayLoss: lossMicro } };
    const status = views.status(i as never) as { risk: { kind: string; usedUsd: string; limitUsd: string | null; usedLamports: string | null; limitLamports: string | null }[] };
    return { meter: status.risk.find((r) => r.kind === 'daily-loss')!, limitMicro: (BigInt(base.policy.capital.bankroll) * BigInt(base.policy.loss.dailyBps)) / 10_000n };
  };

  it('used is rounded up and the limit down, exactly', () => {
    const { meter, limitMicro } = served(1_234_567n);
    expect(meter.usedUsd).toBe('1.234567');
    expect(BigInt(meter.usedLamports!)).toBe(ceilDiv(1_234_567n * 1_000_000_000n, PRICE));
    expect(BigInt(meter.limitLamports!)).toBe((limitMicro * 1_000_000_000n) / PRICE);
    // Neither divides evenly here, so rounding the other way would read differently.
    expect((1_234_567n * 1_000_000_000n) % PRICE).not.toBe(0n);
    expect((limitMicro * 1_000_000_000n) % PRICE).not.toBe(0n);
  });

  it('whenever the dollars say the limit is reached, so do the SOL figures (never more room in SOL)', () => {
    const { limitMicro } = served(0n);
    for (const loss of [limitMicro, limitMicro + 1n, limitMicro - 1n, limitMicro / 2n]) {
      const { meter } = served(loss);
      const reachedUsd = loss >= limitMicro;
      const reachedSol = BigInt(meter.usedLamports!) >= BigInt(meter.limitLamports!);
      if (reachedUsd) expect(reachedSol, String(loss)).toBe(true);
    }
    // At the boundary itself: used equals the limit in dollars, and in SOL used is at least the limit.
    const at = served(limitMicro).meter;
    expect(BigInt(at.usedLamports!) >= BigInt(at.limitLamports!)).toBe(true);
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
