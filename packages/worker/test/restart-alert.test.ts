// RESTART-ALERT, worker side: each heartbeat says how the previous process ended, read from the journal's last line, so
// the watchdog can name the cause of an unplanned restart (a kill or an OOM leaves no stop line).
import { describe, expect, it, vi } from 'vitest';
import { crashSite, eventKind } from '../src/run/crash-site.ts';
import { RESTARTS_MAX, restartsAfterBoot } from '../src/run/state.ts';
import { heartbeatBody } from '../src/run/heartbeat.ts';
import { EXIT, STATE_FILES } from '../../runner/src/contract.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLANNED_RESTART_MS } from '../src/run/worker.ts';
import { Market, makeWorker, tempState, virtualTimers, T } from './worker-harness.ts';

describe('the previous exit, in /health and the heartbeat', () => {
  it('null on a first start; "stop: signal" after a clean stop; "stop: crash" after a caught failure; "no clean stop" after a kill', async () => {
    const stateDir = tempState();
    const first = makeWorker({ stateDir });
    expect(first.worker.health().last_exit).toBeNull();
    await first.worker.reconcile();
    await first.worker.stop();
    const second = makeWorker({ stateDir });
    expect(second.worker.health().last_exit).toBe('stop: signal');
    await second.worker.reconcile();
    await second.worker.stop(EXIT.crash);
    const third = makeWorker({ stateDir });
    expect(third.worker.health().last_exit).toBe('stop: crash');
    await third.worker.reconcile();
    await third.worker.kill();
    const fourth = makeWorker({ stateDir });
    const h = fourth.worker.health();
    expect(h.last_exit).toBe('no clean stop');
    // The heartbeat carries it, with the boot, uptime and memory the watchdog reports.
    expect(JSON.parse(heartbeatBody(h, null, null))).toMatchObject({ last_exit: 'no clean stop', boot: fourth.worker.boot, uptime_s: expect.any(Number), rss_bytes: expect.any(Number) });
    await fourth.worker.stop();
  });

  it('a drill\'s marker from the runner makes the kill "planned: …", once; a stale marker is ignored and removed', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const first = makeWorker({ stateDir, timers });
    await first.worker.reconcile();
    await first.worker.kill();
    const marker = join(stateDir, STATE_FILES.plannedRestart);
    writeFileSync(marker, JSON.stringify({ cause: 'drill restart-1 (crash)', at: timers.now() - 5_000 }));
    const second = makeWorker({ stateDir, timers });
    expect(second.worker.health().last_exit).toBe('planned: drill restart-1 (crash)');
    expect(existsSync(marker)).toBe(false);
    await second.worker.reconcile();
    await second.worker.kill();
    writeFileSync(marker, JSON.stringify({ cause: 'drill restart-2 (crash)', at: timers.now() - PLANNED_RESTART_MS }));
    const third = makeWorker({ stateDir, timers });
    expect(third.worker.health().last_exit).toBe('no clean stop');
    expect(existsSync(marker)).toBe(false);
    await third.worker.stop();
  });
});


describe('where a crash happened, never what it said (RESTART-ALERT)', () => {
  const SECRET_URL = 'https://mainnet.helius-rpc.com/?api-key=sk-live-0123456789abcdef&cluster=mainnet';
  const secretError = (): Error => new TypeError(`fetch failed for ${SECRET_URL}`);
  const clean = (s: string): void => {
    expect(s).not.toMatch(/api-key|sk-live|https?:|helius-rpc|\?|fetch failed/);
  };

  it('crashSite keeps the name, the first frame in packages/ and the event kind; the message, URL and key never', () => {
    const site = crashSite(secretError(), `logs:pump:CreateEvent:${'M'.repeat(44)}`);
    expect(site).toMatch(/^TypeError at packages\/worker\/test\/restart-alert\.test\.ts:\d+ during logs:pump:CreateEvent$/);
    clean(site);
    expect(crashSite('a string with https://x/?api-key=1')).toBe('non-error at no frame in packages/');
    const odd = new Error(SECRET_URL);
    odd.name = `Bad ${SECRET_URL}`;
    clean(crashSite(odd));
  });

  it('an engine step that throws: the next boot and its heartbeat name the place, not the URL or key', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const h = makeWorker({ stateDir, timers, seedWaitMs: 0 });
    const m = new Market(h);
    const started = h.worker.start();
    while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
    m.slot();
    expect(await started).toEqual({ ok: true });
    await m.run(1_000, 200, () => m.slot());
    vi.spyOn(h.worker, 'step').mockImplementation(() => {
      throw secretError();
    });
    // The worker's own loop (not the test) calls step on its timer: the failure stops it with a crash.
    const journal = join(stateDir, STATE_FILES.journal);
    for (let k = 0; k < 2_000 && !readFileSync(journal, 'utf8').trimEnd().split('\n').at(-1)!.includes('"kind":"stop"'); k++) await new Promise<void>((r) => setImmediate(r));
    expect(process.exitCode).toBe(EXIT.crash);
    process.exitCode = 0;
    const next = makeWorker({ stateDir, timers });
    const health = next.worker.health();
    expect(health.last_exit).toMatch(/^stop: crash \(TypeError at packages\/worker\/test\/restart-alert\.test\.ts:\d+ during [A-Za-z0-9_.:\/-]+\)$/);
    const body = heartbeatBody(health, null, null);
    clean(String(health.last_exit));
    expect(body).not.toMatch(/api-key|sk-live|helius-rpc\.com\/\?/);
    await next.worker.stop();
  });

  it('an uncaught exception (main\'s fatal handler): the stop line names the place, not the URL or key', async () => {
    const stateDir = tempState();
    const h = makeWorker({ stateDir });
    await h.worker.reconcile();
    h.worker.crashed(secretError());
    await h.worker.kill();
    const next = makeWorker({ stateDir });
    expect(next.worker.health().last_exit).toMatch(/^stop: crash \(TypeError at packages\/worker\/test\/restart-alert\.test\.ts:\d+\)$/);
    clean(String(next.worker.health().last_exit));
    await next.worker.stop();
  });
});

describe('restarts in the last 24 h, planned and not, in the heartbeat', () => {
  it('counts each restart after the first start, a drill\'s as planned; older than 24 h drops out', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const boot = async (): Promise<ReturnType<typeof makeWorker>> => makeWorker({ stateDir, timers });
    const a = await boot();
    expect(a.worker.health().restarts_24h).toEqual({ planned: 0, deploy: 0, unplanned: 0 });
    await a.worker.reconcile();
    await a.worker.kill();
    const b = await boot(); // an unplanned restart
    expect(b.worker.health().restarts_24h).toEqual({ planned: 0, deploy: 0, unplanned: 1 });
    await b.worker.reconcile();
    await b.worker.kill();
    writeFileSync(join(stateDir, STATE_FILES.plannedRestart), JSON.stringify({ cause: 'drill restart-1 (crash)', at: timers.now() }));
    const c = await boot(); // a planned one
    expect(c.worker.health().restarts_24h).toEqual({ planned: 1, deploy: 0, unplanned: 1 });
    expect(JSON.parse(heartbeatBody(c.worker.health(), null, null))).toMatchObject({ restarts_24h: { planned: 1, deploy: 0, unplanned: 1 } });
    await c.worker.reconcile();
    await c.worker.stop();
    timers.set(timers.now() + 86_400_000);
    // A clean restart a day later onto a new release: a deploy, and only it is in the window.
    const d = makeWorker({ stateDir, timers, config: { ZEROED_GIT_SHA: 'newsha' } });
    expect(d.worker.health().restarts_24h).toEqual({ planned: 0, deploy: 1, unplanned: 0 });
    // The saved list keeps only the window: it never grows past a day of restarts.
    expect((JSON.parse(readFileSync(join(stateDir, 'restarts.json'), 'utf8')) as unknown[]).length).toBe(1);
    await d.worker.stop();
  });
});

describe('restart records (review of #209)', () => {
  it('a clean restart on the same release is unplanned; onto another release, a deploy; with no record to compare, unplanned', () => {
    const first = restartsAfterBoot([], 1_000, null, 'A');
    expect(first.map((r) => r.kind)).toEqual(['first']);
    expect(restartsAfterBoot(first, 2_000, 'stop: signal', 'B').at(-1)!.kind).toBe('deploy');
    expect(restartsAfterBoot(first, 2_000, 'stop: signal', 'A').at(-1)!.kind).toBe('unplanned');
    expect(restartsAfterBoot(first, 2_000, 'planned: drill restart-1 (crash)', 'B').at(-1)!.kind).toBe('planned');
    expect(restartsAfterBoot([], 2_000, 'stop: signal', 'A').at(-1)!.kind).toBe('unplanned');
  });

  it('keeps at most RESTARTS_MAX, the newest', () => {
    const saved = Array.from({ length: RESTARTS_MAX + 500 }, (_, k) => ({ at: 10_000 + k, kind: 'unplanned' as const, git_sha: 'A' }));
    const kept = restartsAfterBoot(saved, 20_000, 'no clean stop', 'A');
    expect(kept).toHaveLength(RESTARTS_MAX);
    expect(kept.at(-1)!.at).toBe(20_000);
    expect(kept[0]!.at).toBe(10_000 + 501);
  });

  it('a damaged restarts.json never blocks a boot: the counts start again from this boot', async () => {
    const stateDir = tempState();
    const a = makeWorker({ stateDir });
    await a.worker.reconcile();
    await a.worker.kill();
    writeFileSync(join(stateDir, 'restarts.json'), 'not json {');
    const b = makeWorker({ stateDir });
    expect(b.worker.health().restarts_24h).toEqual({ planned: 0, deploy: 0, unplanned: 1 });
    expect(b.logs.some((l) => l.startsWith('Restart counts unreadable'))).toBe(true);
    await b.worker.stop();
  });
});

describe('crash-site guarantees (review of #209)', () => {
  it('a frame planted in the message is never read: the secret is absent and the real frame is picked', () => {
    const e = new Error('x\n    at (https://h/packages/k.ts:1?api-key=SECRET)');
    const site = crashSite(e);
    expect(site).not.toMatch(/SECRET|k\.ts|https/);
    expect(site).toMatch(/^Error at packages\/worker\/test\/restart-alert\.test\.ts:\d+$/);
  });

  it('an event key keeps its kind: ids and long segments are left out', () => {
    expect(eventKind(`logs:pump:CreateEvent:${'M'.repeat(44)}`)).toBe('logs:pump:CreateEvent');
    expect(eventKind(`pool:${'a'.repeat(30)}:state`)).toBe('pool:state');
    expect(eventKind(`chain:slot`)).toBe('chain:slot');
  });
});

