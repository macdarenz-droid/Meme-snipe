// APP-WIRE: the app's own client, every endpoint it calls, in all three modes, against the real worker's route():
// paper answers data that passes the strict schemas, live and backtest answer "Not running", and the backtest report
// is empty. live-server.test.ts serves fixtures only and could not catch a path the real worker does not serve.
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { httpApi } from '../src/api/client.ts';
import { MODES, type DashboardApi, type Mode } from '../src/api/contract.ts';
import { schemaFor, type Endpoint } from '../src/api/schemas.ts';
import { settle } from '../src/api/useEndpoint.ts';
import { reportData } from '../src/api/reportSchema.ts';
import { PauseButton } from '../src/shell/Status.tsx';
import { route } from '../../../packages/worker/src/run/api.ts';
import { makeWorker, passingMarket } from '../../../packages/worker/test/worker-harness.ts';

const CALLS: Record<Endpoint, (api: DashboardApi, m: Mode, month: string) => Promise<unknown>> = {
  status: (a, m) => a.status(m),
  funnel: (a, m) => a.funnel(m),
  decisions: (a, m) => a.decisions(m),
  position: (a, m) => a.position(m),
  calendar: (a, m, month) => a.calendar(m, month),
  trades: (a, m) => a.trades(m),
  charts: (a, m) => a.charts(m),
  stats: (a, m) => a.stats(m),
  discovered: (a, m) => a.discovered(m),
};

describe('the app\'s client against the real worker, every endpoint and mode (APP-WIRE)', () => {
  it('paper serves every endpoint; live and backtest answer "Not running" on each; the report is empty', async () => {
    const w = makeWorker();
    await w.worker.reconcile();
    const m = await passingMarket(w, { heldPoolFacts: true });
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => { m.slot(); m.pool(); });
    const asked: string[] = [];
    const api = httpApi('https://zeroed.example', async (url) => {
      const path = new URL(url).pathname;
      asked.push(path);
      const r = route(path, () => w.worker.apiInputs());
      return { status: r.status, body: JSON.stringify(r.body) };
    });
    const now = w.timers.now();
    const month = new Date(now).toISOString().slice(0, 7);
    for (const mode of MODES) {
      for (const [endpoint, call] of Object.entries(CALLS) as [Endpoint, (typeof CALLS)[Endpoint]][]) {
        const loaded = settle(mode, schemaFor(endpoint, mode), { ok: true, value: await call(api, mode, month) }, now);
        if (mode === 'paper') expect(loaded.state, `${mode} ${endpoint}`).toBe('ready');
        else expect(loaded, `${mode} ${endpoint}`).toEqual({ state: 'not-running' });
      }
    }
    const report = settle('backtest', reportData, { ok: true, value: await api.backtestReport() }, now);
    expect(report).toMatchObject({ state: 'ready', data: null });
    // Every path the app asked for was answered by the worker with 200: none fell through to a 404.
    expect(asked.length).toBe(MODES.length * Object.keys(CALLS).length + 1);
    for (const path of asked) expect(route(path, () => w.worker.apiInputs()).status, path).toBe(200);
    await w.worker.stop();
  });
});

describe('the pause control (APP-WIRE)', () => {
  const html = (p: Parameters<typeof PauseButton>[0]) => renderToStaticMarkup(h(PauseButton, p));
  it('stays disabled (the app sends no commands), names where pausing happens, and reads "Paused" while paused', () => {
    for (const compact of [false, true]) {
      const out = html({ compact });
      expect(out).toContain('disabled');
      expect(out).toContain('Telegram /pause');
      expect(out).not.toContain('Worker not connected');
      expect(html({ compact, paused: true })).toMatch(/>Paused</);
    }
  });

  it('the shell passes the worker\'s pause to it', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain("<PauseButton paused={paper.view.state === 'paused'} />");
    expect(app).toContain("<PauseButton compact paused={paper.view.state === 'paused'} />");
  });
});
