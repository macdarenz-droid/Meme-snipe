// MEM-TRACE: a death with no stop line just after a memory sample near a limit is told apart from another kill.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEM_EVERY_MS, MEM_FILE, cgroupMax, nearLimit, readMem, type MemSample } from '../src/run/mem-trace.ts';
import { exitKind } from '../src/run/state.ts';
import { STATE_FILES } from '../../runner/src/contract.ts';
import { Market, makeWorker, tempState, virtualTimers, T } from './worker-harness.ts';

const MB = 1_048_576;
const sample = (over: Partial<MemSample> = {}): MemSample => ({ at: 1_000_000, heap_used: 100 * MB, heap_limit: 500 * MB, rss: 300 * MB, external: 1, array_buffers: 1, cgroup_max: 800 * MB, ...over });

describe('the near-limit reading', () => {
  it('names the heap limit or the memory limit at 90% or more; says nothing below, without a sample, or for an old one', () => {
    expect(nearLimit(sample({ heap_used: 450 * MB }), 1_000_000)).toBe('near the heap limit: heap 450 of 500 MB, rss 300 of 800 MB');
    expect(nearLimit(sample({ rss: 720 * MB }), 1_000_000)).toBe('near the memory limit: heap 100 of 500 MB, rss 720 of 800 MB');
    expect(nearLimit(sample({ heap_used: 449 * MB, rss: 719 * MB }), 1_000_000)).toBeNull();
    expect(nearLimit(sample({ heap_used: 450 * MB, cgroup_max: null }), 1_000_000)).toBe('near the heap limit: heap 450 of 500 MB, rss 300 MB');
    expect(nearLimit(null, 1_000_000)).toBeNull();
    expect(nearLimit(sample({ heap_used: 450 * MB }), null)).toBeNull();
    // Taken more than two periods before the process's last journal line: not about its death.
    expect(nearLimit(sample({ heap_used: 450 * MB }), 1_000_000 + 2 * MEM_EVERY_MS)).not.toBeNull();
    expect(nearLimit(sample({ heap_used: 450 * MB }), 1_000_001 + 2 * MEM_EVERY_MS)).toBeNull();
  });

  it('reads only a well-formed sample, and the cgroup limit only as a number', () => {
    const dir = tempState();
    expect(readMem(dir)).toBeNull();
    writeFileSync(join(dir, MEM_FILE), JSON.stringify({ ...sample(), rss: 'x' }));
    expect(readMem(dir)).toBeNull();
    writeFileSync(join(dir, MEM_FILE), 'not json');
    expect(readMem(dir)).toBeNull();
    writeFileSync(join(dir, MEM_FILE), JSON.stringify(sample()));
    expect(readMem(dir)).toEqual(sample());
    const f = join(dir, 'memory.max');
    writeFileSync(f, 'max\n');
    expect(cgroupMax(f)).toBeNull();
    writeFileSync(f, '838860800\n');
    expect(cgroupMax(f)).toBe(838_860_800);
    expect(cgroupMax(join(dir, 'none'))).toBeNull();
  });
});

describe('in the worker', () => {
  it('a started worker samples every 10 s; a stop stops it', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const h = makeWorker({ stateDir, timers, seedWaitMs: 0 });
    const m = new Market(h);
    const started = h.worker.start();
    while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
    m.slot();
    expect(await started).toEqual({ ok: true });
    const first = readMem(stateDir)!;
    expect(first.heap_limit).toBeGreaterThan(first.heap_used);
    expect(first.rss).toBeGreaterThan(0);
    await m.run(MEM_EVERY_MS + 1_000, 500, () => m.slot());
    expect(readMem(stateDir)!.at).toBeGreaterThan(first.at);
    await h.worker.stop();
    const last = readMem(stateDir)!.at;
    timers.set(timers.now() + 5 * MEM_EVERY_MS);
    await new Promise<void>((r) => setImmediate(r));
    expect(readMem(stateDir)!.at).toBe(last);
  });

  it('the pre-step names a death near the heap limit in last_exit; a kill with no such sample stays "no clean stop"', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const a = makeWorker({ stateDir, timers });
    await a.worker.reconcile();
    await a.worker.kill();
    const lastLine = readFileSync(join(stateDir, STATE_FILES.journal), 'utf8').trimEnd().split('\n').at(-1)!;
    const lastMs = Date.parse((JSON.parse(lastLine) as { ts: string }).ts);
    writeFileSync(join(stateDir, MEM_FILE), JSON.stringify(sample({ at: lastMs - 3_000, heap_used: 470 * MB, heap_limit: 500 * MB })));
    const pre = makeWorker({ stateDir, timers, phase: 'reconcile' });
    expect(await pre.worker.reconcileOnly()).toEqual({ ok: true });
    const b = makeWorker({ stateDir, timers });
    const exit = b.worker.health().last_exit!;
    expect(exit).toBe('no clean stop (near the heap limit: heap 470 of 500 MB, rss 300 of 800 MB)');
    expect(exitKind(exit)).toBe('killed');
    await b.worker.kill();
    // The same kill, but the sample is old (the process lived on long after it): plain.
    writeFileSync(join(stateDir, MEM_FILE), JSON.stringify(sample({ at: 0, heap_used: 470 * MB })));
    const c = makeWorker({ stateDir, timers });
    expect(c.worker.health().last_exit).toBe('no clean stop');
    await c.worker.stop();
    expect(existsSync(join(stateDir, MEM_FILE))).toBe(true);
  });
});
