// The app's read API against the app's own contract (UI-2: apps/web/src/api/contract.ts and its strict schemas): every
// endpoint, from a real worker that made a paper trade, passes checkEnvelope in paper mode; other modes are not served.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor, type Endpoint } from '../../../apps/web/src/api/schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import { COMMANDS, route } from '../src/run/api.ts';
import { COMMAND_LINES_PER_MINUTE } from '../src/run/worker.ts';
import { MINT, T, dueTimers, makeWorker, passingMarket } from './worker-harness.ts';

/** Test-only (POS-1): these tests move a held position's price by re-publishing the pool fact. */
const HELD = { heldPoolFacts: true } as const;

const ENDPOINTS: Exclude<Endpoint, 'calendar'>[] = ['status', 'funnel', 'decisions', 'position', 'trades', 'charts', 'stats'];

describe('the app API (UI-2 contract)', () => {
  it('every endpoint, with a paper trade open and then closed, passes the app\'s strict paper schema', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    const get = (path: string) => route(path, () => h.worker.apiInputs());
    const all = (): Record<string, { mode: string; data: unknown }> => {
      const bodies: Record<string, { mode: string; data: unknown }> = {};
      for (const e of ENDPOINTS) {
        const r = get(PATHS[e]('paper'));
        expect(r.status, e).toBe(200);
        bodies[e] = checkEnvelope(JSON.parse(JSON.stringify(r.body)), 'paper', schemaFor(e, 'paper'));
      }
      const month = new Date(h.timers.now()).toISOString().slice(0, 7);
      checkEnvelope(JSON.parse(JSON.stringify(get(PATHS.calendar('paper', month)).body)), 'paper', schemaFor('calendar', 'paper'));
      return bodies;
    };
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => { m.slot(); m.pool(); });
    // The trade is open: the position endpoint shows it. (A second entry after the loss is refused by risk, so the open
    // position is checked here, before the stop.)
    const open = all();
    const pos = open['position']!.data as { mint: string; exit: string } | null;
    expect(pos).not.toBeNull();
    expect(pos!.mint).toBe(MINT);
    await m.run(6_000, 400, () => { m.slot(); m.pool(700_000n); });
    const bodies = all();
    expect(bodies['position']!.data).toBeNull();

    const trades = bodies['trades']!.data as { mint: string; exitReason: string; netUsd: string; fills: { side: string }[] }[];
    expect(trades.length).toBeGreaterThanOrEqual(1);
    expect(trades[0]).toMatchObject({ mint: MINT, exitReason: 'price-stop' });
    expect(trades[0]!.fills.map((f) => f.side)).toEqual(['buy', 'sell']);
    expect(trades[0]!.netUsd.startsWith('-')).toBe(true);
    const funnel = bodies['funnel']!.data as { stages: { stage: string; count: number }[] };
    expect(funnel.stages.find((s) => s.stage === 'entered')!.count).toBe(1);
    const stats = bodies['stats']!.data as { trades: number };
    expect(stats.trades).toBe(trades.length);
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

  it('a flood of refused commands journals at most COMMAND_LINES_PER_MINUTE lines a minute, then counts the rest on one line', async () => {
    // The clock moves only when the test moves it, so the 50 requests fall inside one minute.
    const timers = dueTimers(T - 16 * 86_400_000);
    const h = makeWorker({ timers, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18784', ZEROED_API_ADDR: '127.0.0.1:18785' } });
    const started = h.worker.start();
    let result: unknown = null;
    void started.then((r) => (result = r));
    for (let k = 0; k < 600 && result === null; k++) {
      timers.set(timers.now() + 100);
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(result).toEqual({ ok: true });
    const post = (c: string) => fetch(`http://127.0.0.1:18785/api/v1/commands/${c}`, { method: 'POST' });
    for (let k = 0; k < 50; k++) expect((await post('pause')).status).toBe(403);
    // The next minute: the count of the rest comes first, and a command name is cut to 32 characters on its line.
    h.timers.set(h.timers.now() + 60_000);
    expect((await post('x'.repeat(5_000))).status).toBe(404);
    await h.worker.stop();
    const refused = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['action'] === 'command_refused').map((l) => (l['reasons'] as string[])[0]);
    expect(refused).toEqual([...Array<string>(COMMAND_LINES_PER_MINUTE).fill('command pause refused'), `${50 - COMMAND_LINES_PER_MINUTE} more commands refused`, `command ${'x'.repeat(32)} refused`]);
  });
});
