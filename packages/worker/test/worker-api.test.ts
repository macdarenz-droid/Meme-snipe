// The app's read API against the app's own contract (UI-2: apps/web/src/api/contract.ts and its strict schemas): every
// endpoint, from a real worker that made a paper trade, passes checkEnvelope in paper mode; other modes are not served.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor, type Endpoint } from '../../../apps/web/src/api/schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import { COMMANDS, NOT_RUNNING, route, servedReason, triggerPrice } from '../src/run/api.ts';
import { COMMAND_LINES_PER_MINUTE } from '../src/run/worker.ts';
import { exitsFor } from '../../core/src/config/index.ts';
import { MINT, T, dueTimers, makeWorker, passingMarket } from './worker-harness.ts';

/** Test-only (POS-1): these tests move a held position's price by re-publishing the pool fact. */
const HELD = { heldPoolFacts: true } as const;

const ENDPOINTS: Exclude<Endpoint, 'calendar'>[] = ['status', 'funnel', 'decisions', 'position', 'trades', 'charts', 'stats', 'discovered'];

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

  it('an open position\'s exit triggers are in a trader\'s words (APP-WORDS a)', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => { m.slot(); m.pool(); });
    const r = route(PATHS.position('paper'), () => h.worker.apiInputs());
    const pos = checkEnvelope(JSON.parse(JSON.stringify(r.body)), 'paper', schemaFor('position', 'paper')).data as { mint: string; exitRules: { rule: string; trigger: string }[] } | null;
    expect(pos).not.toBeNull();
    expect(pos!.mint).toBe(MINT);
    for (const x of pos!.exitRules) expect(x.trigger, x.rule).toMatch(/^(Price at or below \$\d+(\.\d+)?|After \d+ min|At \+\d+(\.\d+)?R or \+\d+(\.\d+)?%)$/);
    // Review B1: the exact values, from the trial policy's exits for the position's universe and its saved stop.
    const inputs = h.worker.apiInputs();
    const p = Object.values(inputs.book.positions).find((x) => x.status === 'open')!;
    const o = inputs.open(p)!;
    const ux = exitsFor(inputs.policy.exits, o.universe as never);
    const trigger = (rule: string, rules = pos!.exitRules) => rules.find((x) => x.rule === rule)!.trigger;
    expect(trigger('time-stop')).toBe(`After ${ux.tMaxMs / 60_000} min`);
    expect(trigger('take-profit')).toBe(`At +${ux.partialAtRBps / 10_000}R or +${ux.partialAtGainBps / 100}%`);
    expect(trigger('price-stop')).toBe(`Price at or below ${triggerPrice(o.stopPrice, inputs.solPrice)}`);
    // A trail is its own line, from the trail price, not the stop's.
    const trail = o.stopPrice * 3n;
    const withTrail = (route(PATHS.position('paper'), () => ({ ...inputs, open: (q) => ({ ...inputs.open(q)!, trail }) })).body as { data: { exitRules: { rule: string; trigger: string }[] } }).data.exitRules;
    expect(trigger('trail', withTrail)).toBe(`Price at or below ${triggerPrice(trail, inputs.solPrice)}`);
    expect(trigger('trail', withTrail)).not.toBe(trigger('price-stop', withTrail));
    await h.worker.stop();
  });

  it('a typed reasons line is served as whole JSON within the app\'s text limit, cut by entries (review N2)', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ gate: `H${(i % 17) + 1}`, code: `code-${i}`, detail: 'x'.repeat(200) }));
    const served = servedReason(`gate_reasons ${JSON.stringify(many)}`);
    expect(served.length).toBeLessThanOrEqual(500);
    const back = JSON.parse(served.slice('gate_reasons '.length)) as { gate: string; code: string }[];
    expect(back.length).toBeGreaterThan(5);
    expect(back).toEqual(many.slice(0, back.length).map(({ gate, code }) => ({ gate, code })));
    expect(servedReason('x'.repeat(600))).toHaveLength(500);
    expect(servedReason('short')).toBe('short');
  });

  it('an exit trigger price is dollars per token with 4 significant digits (APP-WORDS a)', () => {
    // 666,666,667 scaled = 6.67e-4 lamports per raw unit = 666.7 lamports per token; at $150 per SOL, $0.0001.
    expect(triggerPrice(666_666_667n, 150_000_000n as never)).toBe('$0.0001');
    expect(triggerPrice(123_456_789_000n, 150_000_000n as never)).toBe('$0.01852');
    expect(triggerPrice(1n, null)).toBeNull();
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
    // Inside the minute the heartbeat writes no count; once the minute is over it does, though no refusal follows.
    await h.worker.heartbeat();
    const count = () => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l.includes('more commands refused')).length;
    expect(count()).toBe(0);
    h.timers.set(h.timers.now() + 60_000);
    await h.worker.heartbeat();
    expect(count()).toBe(1);
    // The next refusal starts a new minute; a command name is cut to 32 characters on its line.
    expect((await post('x'.repeat(5_000))).status).toBe(404);
    await h.worker.stop();
    const refused = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['action'] === 'command_refused').map((l) => (l['reasons'] as string[])[0]);
    expect(refused).toEqual([...Array<string>(COMMAND_LINES_PER_MINUTE).fill('command pause refused'), `${50 - COMMAND_LINES_PER_MINUTE} more commands refused`, `command ${'x'.repeat(32)} refused`]);
  });
});
