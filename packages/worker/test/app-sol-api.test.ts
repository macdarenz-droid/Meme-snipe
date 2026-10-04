// APP-SOL: the worker serves every money figure in lamports beside the dollars, from the lamports it already holds
// (fills, the paper account's trade net, the open P&L), and the current SOL price for the app's dollar line.
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor, type Endpoint } from '../../../apps/web/src/api/schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import { openPnl, route, usdText } from '../src/run/api.ts';
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
    const get = <T,>(e: Endpoint, path = PATHS[e as Exclude<Endpoint, 'calendar'>]('paper')) =>
      checkEnvelope(JSON.parse(JSON.stringify(route(path, () => i).body)), 'paper', schemaFor(e, 'paper')).data as T;

    // The open trade.
    const p = Object.values(i.book.positions).find((x) => x.status === 'open')!;
    const o = i.open(p)!;
    const fills = [...i.attempts.values()].filter((a) => a.trade === p.id && a.outcome === 'filled');
    const pnl = openPnl(o.liquidation, fills, i.exitFee);
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
    const trades = get<{ id: string; netLamports: string; sizeLamports: string; grossLamports: string; costs: { totalLamports: string; venueFeeLamports: string }; fills: { side: string; filledLamports: string }[] }[]>('trades');
    for (const t of trades) {
      const src = closed.find((x) => x.positionId === t.id)!;
      expect(t.netLamports).toBe(String(src.netLamports));
      const buys = [...i.attempts.values()].filter((a) => a.trade === t.id && a.purpose === 'entry' && a.outcome === 'filled');
      expect(t.sizeLamports).toBe(String(buys.reduce((s, a) => s + a.fill!.sol, 0n)));
      expect(BigInt(t.grossLamports)).toBe(BigInt(t.netLamports) + BigInt(t.costs.totalLamports));
      expect(BigInt(t.costs.totalLamports) > 0n).toBe(true);
      expect(t.fills.find((f) => f.side === 'buy')!.filledLamports).toBe(t.sizeLamports);
    }

    const stats = get<{ netLamports: string; maxDrawdownLamports: string; meanNetLamports: string | null }>('stats');
    const net = closed.reduce((s, t) => s + (t.netLamports ?? 0n), 0n);
    expect(stats.netLamports).toBe(String(net));
    expect(stats.meanNetLamports).toBe(String(net / BigInt(closed.length)));
    const charts = get<{ cumulative: { cumNetLamports: string }[]; daily: { netLamports: string }[]; costsByKind: { amountLamports: string }[] }>('charts');
    expect(charts.cumulative.at(-1)!.cumNetLamports).toBe(String(net));
    expect(charts.daily.reduce((s, d) => s + BigInt(d.netLamports), 0n)).toBe(net);
    const month = new Date(h.timers.now()).toISOString().slice(0, 7);
    const cal = get<{ days: { netLamports: string }[] }>('calendar', PATHS.calendar('paper', month));
    expect(cal.days.reduce((s, d) => s + BigInt(d.netLamports), 0n)).toBe(net);

    await h.worker.stop();
  });
});
