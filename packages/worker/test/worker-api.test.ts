// The app's read API against the app's own contract (UI-2: apps/web/src/api/contract.ts and its strict schemas): every
// endpoint, from a real worker that made a paper trade, passes checkEnvelope in paper mode; other modes are not served.
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor, type Endpoint } from '../../../apps/web/src/api/schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import { route } from '../src/run/api.ts';
import { MINT, makeWorker, passingMarket } from './worker-harness.ts';

const ENDPOINTS: Exclude<Endpoint, 'calendar'>[] = ['status', 'funnel', 'decisions', 'position', 'trades', 'charts', 'stats'];

describe('the app API (UI-2 contract)', () => {
  it('every endpoint of a worker with a closed paper trade and an open one passes the app\'s strict paper schema', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => { m.slot(); m.pool(); });
    await m.run(6_000, 400, () => { m.slot(); m.pool(700_000n); });
    // A second entry at the lower price stays open.
    await m.run(14_000, 400, () => { m.slot(); m.pool(700_000n); });
    const get = (path: string) => route(path, () => h.worker.apiInputs());
    const bodies: Record<string, { mode: string; data: unknown }> = {};
    for (const e of ENDPOINTS) {
      const r = get(PATHS[e]('paper'));
      expect(r.status, e).toBe(200);
      bodies[e] = checkEnvelope(JSON.parse(JSON.stringify(r.body)), 'paper', schemaFor(e, 'paper'));
    }
    const month = new Date(h.timers.now()).toISOString().slice(0, 7);
    const cal = get(PATHS.calendar('paper', month));
    checkEnvelope(JSON.parse(JSON.stringify(cal.body)), 'paper', schemaFor('calendar', 'paper'));

    const trades = bodies['trades']!.data as { mint: string; exitReason: string; netUsd: string; fills: { side: string }[] }[];
    expect(trades.length).toBeGreaterThanOrEqual(1);
    expect(trades[0]).toMatchObject({ mint: MINT, exitReason: 'price-stop' });
    expect(trades[0]!.fills.map((f) => f.side)).toEqual(['buy', 'sell']);
    expect(trades[0]!.netUsd.startsWith('-')).toBe(true);
    const funnel = bodies['funnel']!.data as { stages: { stage: string; count: number }[] };
    expect(funnel.stages.find((s) => s.stage === 'entered')!.count).toBe(1);
    const stats = bodies['stats']!.data as { trades: number };
    expect(stats.trades).toBe(trades.length);
    const pos = bodies['position']!.data as { mint: string; exit: string } | null;
    if (pos !== null) expect(pos.mint).toBe(MINT);
    await h.worker.stop();
  });

  it('serves paper only: backtest and live paths are not served, the backtest report is empty, writes are refused', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const get = (path: string) => route(path, () => h.worker.apiInputs());
    expect(get(PATHS.status('live')).status).toBe(404);
    expect(get(PATHS.trades('backtest')).status).toBe(404);
    expect(get('/api/v1/paper/nothing').status).toBe(404);
    expect(get(PATHS.backtestReport()).body).toMatchObject({ mode: 'backtest', data: null });
    await h.worker.stop();
  });

  it('listens on loopback only, separate from health; GET only', async () => {
    const h = makeWorker({ config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18795', ZEROED_API_ADDR: '127.0.0.1:18794' } });
    expect(await h.worker.start()).toEqual({ ok: true });
    const r = await fetch('http://127.0.0.1:18794/api/v1/paper/status');
    expect(r.status).toBe(200);
    checkEnvelope(await r.json(), 'paper', schemaFor('status', 'paper'));
    expect((await fetch('http://127.0.0.1:18794/api/v1/paper/status', { method: 'POST' })).status).toBe(405);
    expect((await fetch('http://127.0.0.1:18795/api/v1/paper/status')).status).toBe(404);
    await h.worker.stop();
  });
});
