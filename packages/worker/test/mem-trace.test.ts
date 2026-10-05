// MEM-TRACE: a death with no stop line just after a memory sample near a limit is told apart from another kill.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEM_EVERY_MS, MEM_FILE, REPORTS_DIR, REPORT_FRESH_MS, cgroupMax, fatalReport, nearLimit, readMem, type MemSample } from '../src/run/mem-trace.ts';
import { emptySummaryState, foldText, buildSummary } from '../src/run/summary.ts';
import { melbourneDate } from '../src/run/api.ts';
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

  it('a sample that cannot be written never stops the worker; the next tick writes again (review B1)', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    // mem.json is a directory holding a file: the atomic write's rename fails.
    mkdirSync(join(stateDir, MEM_FILE, 'x'), { recursive: true });
    const h = makeWorker({ stateDir, timers, seedWaitMs: 0 });
    const m = new Market(h);
    const started = h.worker.start();
    while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
    m.slot();
    expect(await started).toEqual({ ok: true });
    await m.run(MEM_EVERY_MS + 1_000, 500, () => m.slot());
    expect(process.exitCode ?? 0).toBe(0);
    expect(readMem(stateDir)).toBeNull();
    // Writable again: the timer kept re-arming, so the next tick writes.
    rmSync(join(stateDir, MEM_FILE), { recursive: true });
    await m.run(MEM_EVERY_MS + 1_000, 500, () => m.slot());
    expect(readMem(stateDir)).not.toBeNull();
    expect(await h.worker.stop()).toBe(0);
  });

  it('a fresh fatal report is read only after "no clean stop": a clean stop stays a clean stop (review a)', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const a = makeWorker({ stateDir, timers });
    await a.worker.reconcile();
    await a.worker.stop();
    plant(stateDir, report('Allocation failed - JavaScript heap out of memory', ['at y (packages/worker/src/run/worker.ts:900:5)']), timers.now());
    const b = makeWorker({ stateDir, timers });
    expect(b.worker.health().last_exit).toBe('stop: signal');
    await b.worker.stop();
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
    // HEAP-GUARD (supervisor ruling): a death just after a sample near a limit is its own exit kind.
    expect(exitKind(exit)).toBe('oom');
    await b.worker.kill();
    // The same kill, but the sample is old (the process lived on long after it): plain.
    writeFileSync(join(stateDir, MEM_FILE), JSON.stringify(sample({ at: 0, heap_used: 470 * MB })));
    const c = makeWorker({ stateDir, timers });
    expect(c.worker.health().last_exit).toBe('no clean stop');
    await c.worker.stop();
    expect(existsSync(join(stateDir, MEM_FILE))).toBe(true);
  });
});

const SECRET = 'https://mainnet.helius-rpc.com/?api-key=sk-live-0123456789abcdef';
/** A compact node report as `--report-on-fatalerror` writes it (only the fields read here, plus noise). */
const report = (event: string, stack: string[]) => JSON.stringify({
  header: { reportVersion: 3, event, trigger: 'FatalError', filename: 'report.20261005.124501.1234.0.001.json', commandLine: ['node', `--x=${SECRET}`] },
  javascriptStack: { message: `Error: fetch ${SECRET}\n    at packages/worker/src/evil.ts:1:1`, stack },
  environmentVariables: { HELIUS_API_KEY: 'sk-live-0123456789abcdef' },
});
const plant = (dir: string, text: string, mtimeMs: number, name = 'report.20261005.124501.1234.0.001.json') => {
  mkdirSync(join(dir, REPORTS_DIR), { recursive: true });
  const p = join(dir, REPORTS_DIR, name);
  writeFileSync(p, text);
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
};

describe('a fatal-error report (HEAP-GUARD)', () => {
  it('names the heap limit at the first packages/ frame of the JS stack; never the message, an argument or the environment', () => {
    const dir = tempState();
    // A line that is not a V8 frame cannot plant one, whatever it holds.
    const stack = ['packages/worker/src/evil.ts:1', 'at Map.set (<anonymous>)', `at fetch (${SECRET})`, 'at TxFetcher.run (file:///opt/zeroed/current/packages/worker/src/providers/tx-fetcher.ts:71:21)', 'at x (packages/core/src/engine/asof.ts:80:3)'];
    plant(dir, report('Allocation failed - JavaScript heap out of memory', stack), 1_000_000);
    const site = fatalReport(dir, 1_000_000);
    expect(site).toBe('HeapOutOfMemory at packages/worker/src/providers/tx-fetcher.ts:71');
    expect(site).not.toMatch(/api-key|sk-live|helius-rpc|fetch \(|evil/);
    // Another fatal error, and a stack with no frame in packages/.
    plant(dir, report('Some other fatal', ['Unavailable.']), 1_000_001, 'report.20261005.124502.1234.0.002.json');
    expect(fatalReport(dir, 1_000_000)).toBe('FatalError at no frame in packages/');
  });

  it('only a fresh, readable report counts', () => {
    const dir = tempState();
    expect(fatalReport(dir, 1_000_000)).toBeNull();
    plant(dir, report('Reached heap limit', []), 1_000_000 - REPORT_FRESH_MS - 1);
    expect(fatalReport(dir, 1_000_000)).toBeNull();
    expect(fatalReport(dir, null)).toBeNull();
    plant(dir, 'not json', 1_000_000, 'report.20261005.124503.1234.0.003.json');
    expect(fatalReport(dir, 1_000_000)).toBeNull();
    plant(dir, report('Reached heap limit', []), 1_000_000 - REPORT_FRESH_MS, 'report.20261005.124504.1234.0.004.json');
    utimesSync(join(dir, REPORTS_DIR, 'report.20261005.124503.1234.0.003.json'), 0, 0);
    expect(fatalReport(dir, 1_000_000)).toBe('HeapOutOfMemory at no frame in packages/');
  });

  it('the pre-step records it as a crash at that site; the start line and the daily summary carry the site; near the cap with no report: oom', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const lastMs = async (h: ReturnType<typeof makeWorker>) => {
      await h.worker.kill();
      const last = readFileSync(join(stateDir, STATE_FILES.journal), 'utf8').trimEnd().split('\n').at(-1)!;
      return Date.parse((JSON.parse(last) as { ts: string }).ts);
    };
    const a = makeWorker({ stateDir, timers });
    await a.worker.reconcile();
    const deathA = await lastMs(a);
    plant(stateDir, report('Allocation failed - JavaScript heap out of memory', ['at y (packages/worker/src/run/worker.ts:900:5)']), deathA + 500);
    const pre = makeWorker({ stateDir, timers, phase: 'reconcile' });
    expect(await pre.worker.reconcileOnly()).toEqual({ ok: true });
    const b = makeWorker({ stateDir, timers });
    expect(b.worker.health().last_exit).toBe('fatal error (HeapOutOfMemory at packages/worker/src/run/worker.ts:900)');
    expect(exitKind(b.worker.health().last_exit ?? null)).toBe('crash');
    // B dies two minutes later, with no report of its own: the old report is not this death's.
    timers.set(timers.now() + 2 * REPORT_FRESH_MS);
    await b.worker.reconcile();
    const deathB = await lastMs(b);
    // The last sample at the cgroup cap: oom.
    writeFileSync(join(stateDir, MEM_FILE), JSON.stringify(sample({ at: deathB, rss: 780 * MB })));
    const c = makeWorker({ stateDir, timers });
    expect(c.worker.health().last_exit).toBe('no clean stop (near the memory limit: heap 100 of 500 MB, rss 780 of 800 MB)');
    expect(exitKind(c.worker.health().last_exit ?? null)).toBe('oom');
    await c.worker.stop();
    const text = readFileSync(join(stateDir, STATE_FILES.journal), 'utf8');
    const starts = text.split('\n').filter((l) => l.includes('"kind":"start"') && !l.includes('"phase":"reconcile"'));
    expect(starts.filter((l) => l.includes('"crash_site":"HeapOutOfMemory at packages/worker/src/run/worker.ts:900"'))).toHaveLength(1);
    const st = emptySummaryState();
    for (const l of text.split('\n')) foldText(st, l, new Date(T - 30 * 86_400_000).toISOString());
    const day = melbourneDate(timers.now());
    const sum = buildSummary({ day, final: false, nowMs: timers.now(), fold: st.days[day], gitSha: 'a'.repeat(40), entryRule: 'S0', recorder: 'off', uptimeS: 1, trades: [], openPositions: 0, solPrice: null, credits: [] });
    expect(sum.worker.crash_sites).toEqual([{ error: 'HeapOutOfMemory', file: 'packages/worker/src/run/worker.ts', line: 900, event: null, count: 1 }]);
    expect(sum.worker.exits).toEqual(expect.arrayContaining([{ code: 'crash', count: 1 }, { code: 'oom', count: 1 }]));
  });
});
