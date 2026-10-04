// The app's read API against the app's own contract (UI-2: apps/web/src/api/contract.ts and its strict schemas): every
// endpoint, from a real worker that made a paper trade, passes checkEnvelope in paper mode; other modes are not served.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor, type Endpoint } from '../../../apps/web/src/api/schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import { COMMANDS, NOT_RUNNING, route } from '../src/run/api.ts';
import { MINT, makeWorker, passingMarket } from './worker-harness.ts';

/** Test-only (POS-1): these tests move a held position's price by re-publishing the pool fact. */
const HELD = { heldPoolFacts: true } as const;

const ENDPOINTS: Exclude<Endpoint, 'calendar'>[] = ['status', 'funnel', 'decisions', 'position', 'trades', 'charts', 'stats', 'discovered'];

describe('the app API (UI-2 contract)', () => {
  it('every endpoint of a worker with a closed paper trade and an open one passes the app\'s strict paper schema', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
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
    // APP-HOME: the candidate the worker watched is listed, its pool read and its hard gates passed (it entered).
    const discovered = bodies['discovered']!.data as { tokens: { mint: string; liquidityUsd: string | null; checks: string; checkedAt: string | null; venue: string }[] };
    const tok = discovered.tokens.find((t) => t.mint === MINT)!;
    expect(tok).toMatchObject({ venue: 'PumpSwap', checks: 'passed' });
    expect(tok.liquidityUsd).not.toBeNull();
    expect(tok.checkedAt).not.toBeNull();
    await h.worker.stop();
  });

  it('serves paper only: live and backtest answer "not running" on every app path, the backtest report is empty, writes are refused', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const get = (path: string) => route(path, () => h.worker.apiInputs());
    // API-1: a mode this worker does not run answers every app path with no data and the reason, which the app's
    // envelope check accepts as "not running" for that mode (never a server error).
    const month = new Date(h.timers.now()).toISOString().slice(0, 7);
    for (const m of ['live', 'backtest'] as const) {
      for (const [e, path] of [...ENDPOINTS.map((e) => [e, PATHS[e](m)] as const), ['calendar', PATHS.calendar(m, month)] as const]) {
        const r = get(path);
        expect(r.status, path).toBe(200);
        expect(r.body).toMatchObject({ mode: m, data: null, notRunning: NOT_RUNNING });
        const env = checkEnvelope(JSON.parse(JSON.stringify(r.body)), m, schemaFor(e as Endpoint, m));
        expect(env.notRunning, path).toBe(NOT_RUNNING);
      }
    }
    for (const path of ['/api/v1/demo/status', '/api/v1/live/nothing', '/api/v1/live/calendar', '/api/v1/live/status/2026-10', '/api/v1/paper/nothing']) expect(get(path).status, path).toBe(404);
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

  it('serves no command: pause, close and session are refused and journaled with the auth level each needs', async () => {
    const h = makeWorker({ config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18792', ZEROED_API_ADDR: '127.0.0.1:18793' } });
    expect(await h.worker.start()).toEqual({ ok: true });
    for (const c of Object.keys(COMMANDS)) {
      const r = await fetch(`http://127.0.0.1:18793/api/v1/commands/${c}`, { method: 'POST', body: '{}' });
      expect(r.status, c).toBe(403);
      expect(((await r.json()) as { error: string }).error).toBe(`refused: needs ${COMMANDS[c as keyof typeof COMMANDS]}`);
    }
    expect((await fetch('http://127.0.0.1:18793/api/v1/commands/buy', { method: 'POST' })).status).toBe(404);
    await h.worker.stop();
    const refused = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['action'] === 'command_refused').map((l) => (l['reasons'] as string[])[0]);
    expect(refused).toEqual(['command pause refused', 'command close refused', 'command session refused', 'command buy refused']);
    expect(h.worker.book.positions).toEqual({});
    expect(h.worker.health().paused).toBe(false);
  });
});
