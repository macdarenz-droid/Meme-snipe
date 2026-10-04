// APP-HOME: the app's own client, run against the real worker's route(), shows a running paper worker as "Running"
// and lists the tokens it watches; the other modes answer "Not running" on the same path.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { httpApi } from '../src/api/client.ts';
import type { DiscoveredView, WorkerStatus } from '../src/api/contract.ts';
import { schemaFor } from '../src/api/schemas.ts';
import { settle } from '../src/api/useEndpoint.ts';
import { shortAddress } from '../src/lib/format.ts';
import { DiscoveredBody } from '../src/screens/Home.tsx';
import { SessionCard } from '../src/screens/Snipe.tsx';
import { sessionView, shellSession } from '../src/shell/Status.tsx';
import { checksOf, route } from '../../../packages/worker/src/run/api.ts';
import { MINT, makeWorker, passingMarket } from '../../../packages/worker/test/worker-harness.ts';

const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the app against the real worker (APP-HOME)', () => {
  it('a running paper worker reads Running and Home lists its candidate; live and backtest answer Not running', async () => {
    const w = makeWorker();
    await w.worker.reconcile();
    const m = await passingMarket(w, { heldPoolFacts: true });
    await m.run(4_000, 100, () => m.pool());
    const api = httpApi('https://zeroed.tail1.ts.net', async (url) => {
      const r = route(new URL(url).pathname, () => w.worker.apiInputs());
      return { status: r.status, body: JSON.stringify(r.body) };
    });
    const now = w.timers.now();
    const status = settle<WorkerStatus>('paper', schemaFor('status', 'paper'), { ok: true, value: await api.status('paper') }, now);
    expect(shellSession(status, { state: 'online' })).toEqual({ label: 'Running', on: true });
    // The Session card: the worker's own session on its policy's limits, with no start button.
    expect(status.state === 'ready' && status.data.session).toMatchObject({ state: 'running', startable: false, sessionLossLimitUsd: null });
    const card = text(renderToStaticMarkup(h(SessionCard, { session: sessionView(status), label: shellSession(status, { state: 'online' }).label })));
    expect(card).toContain('Session Running');
    expect(card).not.toMatch(/Start paper session|Worker not connected|Not started/);
    expect(card).toMatch(/Bankroll \$[\d,]+\.\d\d/);
    const discovered = settle<DiscoveredView>('paper', schemaFor('discovered', 'paper'), { ok: true, value: await api.discovered('paper') }, now);
    expect(discovered.state).toBe('ready');
    const out = text(renderToStaticMarkup(h(DiscoveredBody, { loaded: discovered })));
    expect(out).toContain(shortAddress(MINT));
    expect(out).toMatch(/\b1 tokens\b/);
    expect(out).not.toMatch(/No tokens discovered|Waiting for the data feed/);
    for (const mode of ['live', 'backtest'] as const) {
      expect(settle(mode, schemaFor('discovered', mode), { ok: true, value: await api.discovered(mode) }, now)).toEqual({ state: 'not-running' });
      expect(shellSession(settle(mode, schemaFor('status', mode), { ok: true, value: await api.status(mode) }, now), { state: 'online' }).label).toBe('Not running');
    }
    await w.worker.stop();
  });

  it('token checks: failed only on a hard gate, missing before an evaluation or while evidence or inputs are missing', () => {
    expect(checksOf(null)).toBe('missing');
    expect(checksOf([])).toBe('passed');
    expect(checksOf([{ gate: 'H3', code: 'freeze-authority' }])).toBe('failed');
    expect(checksOf([{ gate: 'H17', code: 'x' }, { gate: 'H16', code: 'missing' }])).toBe('failed');
    expect(checksOf([{ gate: 'H16', code: 'missing' }])).toBe('missing');
    expect(checksOf([{ gate: 'regime', code: 'regime-off' }])).toBe('missing');
    expect(checksOf([{ gate: 'worker', code: 'no-sol-price' }])).toBe('missing');
    // Past the hard gates (costs, risk, stop): the token's checks passed.
    expect(checksOf([{ gate: 'R7', code: 'daily_loss' }])).toBe('passed');
  });
});
