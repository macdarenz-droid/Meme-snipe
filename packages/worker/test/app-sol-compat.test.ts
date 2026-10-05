import { describe, expect, it } from 'vitest';
import { route, views, startApiServer, type ApiInputs } from '../src/run/api.ts';
import { schemaFor as baselineSchema } from '../../../apps/web/test/fixtures/app-money-schemas.ts';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { makeWorker } from './worker-harness.ts';

const fields = (v: unknown): string[] => Array.isArray(v) ? v.flatMap(fields) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...fields(x)]) : [];
const added = (v: unknown) => fields(v).filter((k) => k.endsWith('Lamports') || k === 'solPriceUsd');
const input = () => {
  const h = makeWorker();
  const i = { ...h.worker.apiInputs(), trades: [], accountCosts: [{ atMs: h.timers.now(), amount: 100_000n, lamports: 1234567n, kind: 'wallet_setup' }], stops: { atMs: h.timers.now(), codes: [], dayLoss: 100_000n } } as ApiInputs;
  void h.worker.stop();
  return i;
};

describe('APP-SOL capability preserves the existing v1 contract', () => {
  it('default and unknown capabilities omit every APP-SOL field, keeping base money and enums', () => {
    const i = input();
    for (const path of ['status', 'stats', 'charts', `calendar/${new Date(i.nowMs).toISOString().slice(0, 7)}`]) {
      for (const suffix of ['', '?money=unknown']) {
        const r = route(`/api/v1/paper/${path}${suffix}`, () => i);
        expect(r.status).toBe(200);
        expect(added(r.body)).toEqual([]);
        expect(() => checkEnvelope(r.body, 'paper', baselineSchema(path.split('/')[0] as 'status' | 'stats' | 'charts' | 'calendar', 'paper'))).not.toThrow();
      }
    }
    expect((route('/api/v1/paper/stats', () => i).body as any).data).toMatchObject({ netUsd: '-0.1', netSol: '-0.001234567', solMoveUsd: '0' });
    expect((route('/api/v1/paper/charts', () => i).body as any).data.costsByKind).toEqual([{ mode: 'paper', kind: 'rentKeptUsd', amountUsd: '0.1' }]);
  });
  it('explicit capability serves exact lamports without changing base dollar fields', () => {
    const i = input();
    const r = route('/api/v1/paper/stats?money=lamports', () => i);
    expect(r.status).toBe(200);
    expect((r.body as any).data).toMatchObject({ netLamports: '-1234567', maxDrawdownLamports: '1234567', netUsd: '-0.1' });
  });
  it('a late settlement without a dollar valuation cannot disappear from SOL totals', () => {
    const base = input();
    const i = { ...base, accountCosts: [], trades: [{ positionId: 'p1', mint: 'm', openedAtMs: base.nowMs - 6000, closedAtMs: base.nowMs - 2000, notional: 100n, netPnl: -30n, netLamports: -3n, booked: 0n, stoppedOut: false, late: [{ atMs: base.nowMs - 1000, usd: null, lamports: -5n }] }] } as unknown as ApiInputs;
    // The base dollar timeline cannot represent this unvalued event. Aggregate SOL fields fail closed.
    expect(views.stats(i)).not.toHaveProperty('netLamports');
    expect(views.charts(i).daily[0]).not.toHaveProperty('netLamports');
    expect(views.charts(i).cumulative[0]).not.toHaveProperty('cumNetLamports');
    expect(views.calendar(i, new Date(base.nowMs).toISOString().slice(0, 7)).days[0]).not.toHaveProperty('netLamports');
    // A trade's own lamports still include the late loss, with no conversion.
    expect(views.trades(i)[0]).toMatchObject({ netLamports: '-8' });
  });
  it('the HTTP server preserves capability queries through dispatch', async () => {
    const i = input();
    const server = await startApiServer('127.0.0.1', 0, () => i);
    try {
      const address = server.address() as { port: number };
      const modern = await fetch(`http://127.0.0.1:${address.port}/api/v1/paper/stats?money=lamports`).then((r) => r.json());
      expect((modern as { data: { netLamports: string } }).data.netLamports).toBe('-1234567');
      const legacy = await fetch(`http://127.0.0.1:${address.port}/api/v1/paper/stats`).then((r) => r.json());
      expect(() => checkEnvelope(legacy, 'paper', baselineSchema('stats', 'paper'))).not.toThrow();
      expect(added(legacy)).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });
  it('a late-fill position owns its exact entry size, so Return cannot use zero or its sibling entry', () => {
    const base = input();
    const i = { ...base, trades: [{ positionId: 'p1.o2', mint: 'm', openedAtMs: base.nowMs - 2000, closedAtMs: base.nowMs - 1000, notional: 100n, netPnl: 30n, netLamports: 3n, booked: 0n, stoppedOut: false }],
      book: { positions: { 'p1.o2': { id: 'p1.o2', entryIntentId: 'buy' } }, intents: { buy: { intent: { id: 'buy', purpose: 'entry' }, fills: [{ signature: 'a', sol: 11n }, { signature: 'b', sol: 29n }] } } },
      attempts: new Map(), legs: { ...base.legs, attempts: new Map() } } as unknown as ApiInputs;
    expect(views.trades(i)[0]).toMatchObject({ sizeLamports: '29', netLamports: '3' });
  });
  it('partial, close, late and account costs count exactly once at their own time', () => {
    const base = input();
    const i = { ...base, accountCosts: [{ atMs: base.nowMs - 4000, amount: 20n, lamports: 2n, kind: 'failed_entry' }], trades: [{ positionId: 'p1', mint: 'm', openedAtMs: base.nowMs - 6000, closedAtMs: base.nowMs - 2000, notional: 100n, netPnl: -30n, netLamports: -3n, booked: 0n, stoppedOut: false, partials: [{ atMs: base.nowMs - 3000, pnl: 40n, lamports: 4n }], late: [{ atMs: base.nowMs - 1000, usd: -50n, lamports: -5n }] }] } as unknown as ApiInputs;
    expect(views.charts(i).cumulative.map((c) => c.cumNetLamports)).toEqual(['-2', '2', '-5', '-10']);
    expect(views.stats(i)).toMatchObject({ netLamports: '-10', maxDrawdownLamports: '12', meanNetLamports: '-8' });
    expect(views.trades(i)[0]).toMatchObject({ netLamports: '-8' });
  });
});
