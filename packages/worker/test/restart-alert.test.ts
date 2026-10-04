// RESTART-ALERT, worker side: each heartbeat says how the previous process ended, read from the journal's last line, so
// the watchdog can name the cause of an unplanned restart (a kill or an OOM leaves no stop line).
import { describe, expect, it } from 'vitest';
import { heartbeatBody } from '../src/run/heartbeat.ts';
import { EXIT, STATE_FILES } from '../../runner/src/contract.ts';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLANNED_RESTART_MS } from '../src/run/worker.ts';
import { makeWorker, tempState, virtualTimers, T } from './worker-harness.ts';

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

