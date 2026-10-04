// RESTART-ALERT, worker side: each heartbeat says how the previous process ended, read from the journal's last line, so
// the watchdog can name the cause of an unplanned restart (a kill or an OOM leaves no stop line).
import { describe, expect, it, vi } from 'vitest';
import { crashSite, eventKind } from '../src/run/crash-site.ts';
import { RESTARTS_MAX, restartsAfterBoot } from '../src/run/state.ts';
import { buildSummary, emptySummaryState, foldText, parseCrashSite, summaryBody } from '../src/run/summary.ts';
import { checkSummary } from '../../ops/src/watchdog/summary.ts';
import { melbourneDate } from '../src/run/api.ts';
import { heartbeatBody } from '../src/run/heartbeat.ts';
import { EXIT, STATE_FILES } from '../../runner/src/contract.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_HANDOFF, PLANNED_RESTART_MS, takeHandoff } from '../src/run/worker.ts';
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

  it('no frame is read when the head no longer matches, or from a line that is not an "at" frame', () => {
    // The message changed after .stack was read: the head no longer matches, so nothing after it is trusted.
    const changed = new Error('x\n    at (packages/k.ts:1)');
    void changed.stack;
    changed.message = 'changed';
    expect(crashSite(changed)).toBe('Error at no frame in packages/');
    // A head that matches, then only a "Caused by:" line holding a packages path: not a frame.
    const caused = new Error('m');
    caused.stack = 'Error: m\nCaused by: packages/z.ts:2';
    expect(crashSite(caused)).toBe('Error at no frame in packages/');
  });

  it('a crash site is split into fields that each fit the watchdog\'s pattern, or are left out', () => {
    expect(parseCrashSite('TypeError at packages/core/src/engine/engine.ts:151 during logs:pump:CreateEvent')).toEqual({ error: 'TypeError', file: 'packages/core/src/engine/engine.ts', line: 151, event: 'logs:pump:CreateEvent' });
    expect(parseCrashSite('non-error at no frame in packages/')).toEqual({ error: 'non-error', file: null, line: null, event: null });
    expect(parseCrashSite('RangeError at packages/X/src/a.ts:3 during seen:rpc.example')).toEqual({ error: 'RangeError', file: null, line: null, event: null });
    expect(parseCrashSite('Error at packages/worker/src/evil.com.ts:3')).toEqual({ error: 'Error', file: null, line: null, event: null });
    for (const bad of ['', 'Error', 'fetch failed: https://x.example/?api-key=1', 'Bad Name at no frame in packages/', `${'E'.repeat(41)} at no frame in packages/`]) expect(parseCrashSite(bad), bad).toBeNull();
  });

  it('an event key keeps its kind: ids and long segments are left out', () => {
    expect(eventKind(`logs:pump:CreateEvent:${'M'.repeat(44)}`)).toBe('logs:pump:CreateEvent');
    expect(eventKind(`pool:${'a'.repeat(30)}:state`)).toBe('pool:state');
    expect(eventKind(`chain:slot`)).toBe('chain:slot');
  });
});

describe('the unit\'s --reconcile pre-step (RESTART-CAUSE)', () => {
  /** The unit's two processes for one start: the `--reconcile` pre-step, then the main worker. */
  const unitStart = async (stateDir: string, timers: ReturnType<typeof virtualTimers>, config: Record<string, string> = {}) => {
    const pre = makeWorker({ stateDir, timers, phase: 'reconcile', config });
    expect(await pre.worker.reconcileOnly()).toEqual({ ok: true });
    return makeWorker({ stateDir, timers, config });
  };

  it('the main boot names the crash before the pre-step, not the pre-step; the restart is recorded once', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const first = await unitStart(stateDir, timers);
    await first.worker.reconcile();
    first.worker.crashed(new RangeError('boom'));
    await first.worker.kill();
    const second = await unitStart(stateDir, timers);
    expect(second.worker.health().last_exit).toMatch(/^stop: crash \(RangeError at packages\/worker\/test\/restart-alert\.test\.ts:\d+\)$/);
    expect(second.worker.health().restarts_24h).toEqual({ planned: 0, deploy: 0, unplanned: 1 });
    expect(existsSync(join(stateDir, 'last_exit.json'))).toBe(false);
    await second.worker.stop();
  });

  it('the handoff is believed for 10 minutes only: a stale or future one is ignored and removed (review of #209)', async () => {
    const dir = tempState();
    const path = join(dir, EXIT_HANDOFF);
    const now = 1_000_000_000;
    const put = (at: number, exit: string | null = 'stop: crash') => writeFileSync(path, JSON.stringify({ exit, at }));
    put(now - PLANNED_RESTART_MS + 1);
    expect(takeHandoff(path, now)).toBe('stop: crash');
    put(now - PLANNED_RESTART_MS + 1, null);
    expect(takeHandoff(path, now)).toBeNull();
    for (const at of [now - PLANNED_RESTART_MS, now + 1]) {
      put(at);
      expect(takeHandoff(path, now), String(at)).toBeUndefined();
      expect(existsSync(path)).toBe(false);
    }
    expect(takeHandoff(path, now)).toBeUndefined();
    // At boot: a pre-step's handoff older than the bound is not the main boot's reading of the previous exit.
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const a = makeWorker({ stateDir, timers });
    await a.worker.reconcile();
    a.worker.crashed(new RangeError('boom'));
    await a.worker.kill();
    const pre = makeWorker({ stateDir, timers, phase: 'reconcile' });
    expect(await pre.worker.reconcileOnly()).toEqual({ ok: true });
    timers.set(timers.now() + PLANNED_RESTART_MS);
    const b = makeWorker({ stateDir, timers });
    expect(b.worker.health().last_exit).not.toMatch(/^stop: crash/);
    expect(existsSync(join(stateDir, EXIT_HANDOFF))).toBe(false);
    await b.worker.stop();
  });

  it('a drill\'s marker survives the pre-step: the main boot reports it as planned', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const first = await unitStart(stateDir, timers);
    await first.worker.reconcile();
    await first.worker.kill();
    writeFileSync(join(stateDir, STATE_FILES.plannedRestart), JSON.stringify({ cause: 'drill restart-1 (crash)', at: timers.now() }));
    const second = await unitStart(stateDir, timers);
    expect(second.worker.health().last_exit).toBe('planned: drill restart-1 (crash)');
    expect(second.worker.health().restarts_24h).toEqual({ planned: 1, deploy: 0, unplanned: 0 });
    await second.worker.stop();
  });

  it('the pre-step\'s start line is marked and the daily summary counts real boots only', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const a = await unitStart(stateDir, timers);
    await a.worker.reconcile();
    await a.worker.stop();
    const b = await unitStart(stateDir, timers);
    await b.worker.reconcile();
    await b.worker.stop();
    const text = readFileSync(join(stateDir, STATE_FILES.journal), 'utf8');
    const starts = text.split('\n').filter((l) => l.includes('"kind":"start"'));
    expect(starts).toHaveLength(4);
    expect(starts.filter((l) => l.includes('"phase":"reconcile"'))).toHaveLength(2);
    const s = emptySummaryState();
    for (const l of text.split('\n')) foldText(s, l, new Date(T - 30 * 86_400_000).toISOString());
    expect(Object.values(s.days).reduce((n, d) => n + d.starts, 0)).toBe(2);
  });

  it('the daily summary counts restarts and previous exits by kind, and crashes by site, never the message', async () => {
    const SECRET = 'https://mainnet.helius-rpc.com/?api-key=sk-live-0123456789abcdef';
    // One throw site, so two crashes share a frame.
    const boom = (): Error => new TypeError(`fetch failed for ${SECRET}`);
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const a = await unitStart(stateDir, timers);
    await a.worker.reconcile();
    a.worker.crashed(boom());
    await a.worker.kill();
    const b = await unitStart(stateDir, timers);
    await b.worker.reconcile();
    b.worker.crashed(boom());
    await b.worker.kill();
    const c = await unitStart(stateDir, timers);
    await c.worker.reconcile();
    await c.worker.kill();
    writeFileSync(join(stateDir, STATE_FILES.plannedRestart), JSON.stringify({ cause: 'drill restart-1 (crash)', at: timers.now() }));
    const d = await unitStart(stateDir, timers);
    await d.worker.reconcile();
    await d.worker.stop();
    const e = await unitStart(stateDir, timers);
    await e.worker.reconcile();
    await e.worker.kill();
    const f = await unitStart(stateDir, timers);
    await f.worker.reconcile();
    await f.worker.stop();
    const text = readFileSync(join(stateDir, STATE_FILES.journal), 'utf8');
    const s = emptySummaryState();
    for (const l of text.split('\n')) foldText(s, l, new Date(T - 30 * 86_400_000).toISOString());
    const day = melbourneDate(timers.now());
    const summary = buildSummary({
      day, final: false, nowMs: timers.now(), fold: s.days[day], gitSha: 'a'.repeat(40), entryRule: 'S0', recorder: 'off', uptimeS: 1,
      trades: [], openPositions: 0, solPrice: null, credits: [],
    });
    expect(summary.worker.starts).toBe(6);
    // a is the first boot; b and c follow crashes, d a drill's kill (planned), e a clean stop, f a kill.
    expect(summary.worker.restarts).toEqual({ planned: 1, deploy: 0, unplanned: 4 });
    expect(summary.worker.exits).toEqual([{ code: 'crash', count: 2 }, { code: 'clean', count: 1 }, { code: 'killed', count: 1 }, { code: 'planned', count: 1 }]);
    expect(summary.worker.crash_sites).toEqual([{ error: 'TypeError', file: 'packages/worker/test/restart-alert.test.ts', line: expect.any(Number), event: null, count: 2 }]);
    const body = summaryBody(summary);
    expect('body' in body && checkSummary(body.body).ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/api-key|sk-live|helius|fetch failed/);
  });

  it('the counts are read at report time: a day later with no restart, they are back to zero', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const a = makeWorker({ stateDir, timers });
    await a.worker.reconcile();
    await a.worker.kill();
    const b = makeWorker({ stateDir, timers });
    expect(b.worker.health().restarts_24h).toEqual({ planned: 0, deploy: 0, unplanned: 1 });
    timers.set(timers.now() + 86_400_000 + 1);
    expect(b.worker.health().restarts_24h).toEqual({ planned: 0, deploy: 0, unplanned: 0 });
    await b.worker.stop();
  });
});

