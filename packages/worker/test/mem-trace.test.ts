// MEM-TRACE: a death with no stop line just after a memory sample near a limit is told apart from another kill.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEATH_SPACES_MAX, MEM_EVERY_MS, MEM_FILE, PROBE_FILE, REPORTS_DIR, REPORT_FRESH_MS, cgroupMax, deathMem, fatalReport, nearLimit, parseDeathMem, readMem, type MemSample } from '../src/run/mem-trace.ts';
import { emptySummaryState, foldText, buildSummary, summaryBody } from '../src/run/summary.ts';
import { checkSummary } from '../../ops/src/watchdog/summary.ts';
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

/** A report with the heap section `--report-on-fatalerror` writes at a heap death, plus noise that must never be read. */
const heapReport = (dumpMs: number) => JSON.stringify({
  header: { reportVersion: 3, event: 'Allocation failed - JavaScript heap out of memory', trigger: 'FatalError', dumpEventTimeStamp: String(dumpMs), commandLine: ['node', `--x=${SECRET}`], cwd: '/var/lib/zeroed' },
  javascriptStack: { message: `Error: ${SECRET}`, stack: ['at y (packages/worker/src/run/worker.ts:900:5)'] },
  javascriptHeap: {
    usedMemory: 590 * MB, memoryLimit: 600 * MB, totalMemory: 610 * MB,
    heapSpaces: {
      old_space: { used: 500 * MB, capacity: 510 * MB }, new_space: { used: 16 * MB }, large_object_space: { used: 60 * MB }, code_space: { used: 4 * MB },
      read_only_space: { used: 'many' }, 'Evil Space!': { used: 1 }, [`sk_live_${'a'.repeat(50)}`]: { used: 1 },
    },
  },
  environmentVariables: { HELIUS_API_KEY: 'sk-live-0123456789abcdef' },
});

describe('the memory at a death (MEM-SUMMARY)', () => {
  it('reads only numbers: the dump time, heap used and limit, each space\'s use, the uptime from its boot and a fresh sample', () => {
    const dir = tempState();
    plant(dir, heapReport(1_000_500), 1_000_000);
    writeFileSync(join(dir, MEM_FILE), JSON.stringify(sample({ at: 995_000, heap_used: 580 * MB, heap_limit: 600 * MB, rss: 700 * MB, external: 3 * MB, array_buffers: 2 * MB })));
    const d = deathMem(dir, 1_000_000, 400_000);
    expect(d).toEqual({
      at: 1_000_500, uptime_s: 600, heap_used_mb: 590, heap_limit_mb: 600,
      spaces: [{ space: 'old', used_mb: 500 }, { space: 'large-object', used_mb: 60 }, { space: 'new', used_mb: 16 }, { space: 'code', used_mb: 4 }],
      sample: { at: 995_000, heap_used_mb: 580, heap_limit_mb: 600, rss_mb: 700, external_mb: 3, array_buffers_mb: 2 },
    });
    expect(JSON.stringify(d)).not.toMatch(/sk-live|sk_live|helius|api-key|Evil|zeroed|many/);
    expect(parseDeathMem(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it('without a report the fresh sample stands alone; an old sample or no death line gives nothing; uptime only from an earlier boot', () => {
    const dir = tempState();
    writeFileSync(join(dir, MEM_FILE), JSON.stringify(sample({ at: 995_000 })));
    expect(deathMem(dir, 1_000_000, null)).toEqual({ at: 995_000, uptime_s: null, heap_used_mb: 100, heap_limit_mb: 500, spaces: [], sample: { at: 995_000, heap_used_mb: 100, heap_limit_mb: 500, rss_mb: 300, external_mb: 0, array_buffers_mb: 0 } });
    expect(deathMem(dir, 1_000_000, 996_000)?.uptime_s).toBeNull();
    expect(deathMem(dir, 995_000 + 2 * MEM_EVERY_MS + 1, 0)).toBeNull();
    expect(deathMem(dir, null, 0)).toBeNull();
    expect(deathMem(tempState(), 1_000_000, 0)).toBeNull();
  });

  it('a malformed record is dropped, never guessed', () => {
    const ok = { at: 1, uptime_s: null, heap_used_mb: 1, heap_limit_mb: null, spaces: [{ space: 'old', used_mb: 1 }], sample: null };
    expect(parseDeathMem(ok)).toEqual(ok);
    for (const bad of [
      null, 'x', { ...ok, at: -1 }, { ...ok, at: 1.5 }, { ...ok, uptime_s: '1' }, { ...ok, spaces: [{ space: 'Old Space', used_mb: 1 }] },
      { ...ok, spaces: [{ space: 'old', used_mb: -1 }] }, { ...ok, spaces: Array.from({ length: DEATH_SPACES_MAX + 1 }, () => ({ space: 'old', used_mb: 1 })) },
      { ...ok, sample: { at: 1, heap_used_mb: 1, heap_limit_mb: 1, rss_mb: 1, external_mb: 1 } }, { ...ok, spaces: 'old' },
    ]) expect(parseDeathMem(bad), JSON.stringify(bad)).toBeNull();
  });

  it('a start line whose death_mem is malformed gives no last_death; a later good one replaces an earlier one', () => {
    const st = emptySummaryState();
    const at = T - 60_000;
    const line = (seq: number, death: unknown) => JSON.stringify({ seq, ts: new Date(at + seq).toISOString(), boot: `b${seq}`, kind: 'start', exit: 'crash', restart: 'unplanned', death_mem: death });
    const good = { at: at - 5_000, uptime_s: 600, heap_used_mb: 590, heap_limit_mb: 600, spaces: [{ space: 'old', used_mb: 500 }], sample: null };
    foldText(st, line(1, { ...good, spaces: [{ space: `https://x.example/${SECRET}`, used_mb: 1 }] }), new Date(T - 30 * 86_400_000).toISOString());
    const day = melbourneDate(at);
    const build = () => buildSummary({ day, final: false, nowMs: at + 10, fold: st.days[day], gitSha: 'a'.repeat(40), entryRule: 'S0', recorder: 'off', uptimeS: 1, trades: [], openPositions: 0, solPrice: null, credits: [] });
    expect(build().worker.last_death).toBeNull();
    foldText(st, line(2, good), new Date(T - 30 * 86_400_000).toISOString());
    expect(build().worker.last_death?.uptime_s).toBe(600);
    foldText(st, line(3, { ...good, uptime_s: 'long' }), new Date(T - 30 * 86_400_000).toISOString());
    expect(build().worker.last_death?.uptime_s).toBe(600);
  });

  it('the pre-step reads it and hands it on; the main boot\'s start line and the day\'s summary carry it, and the watchdog\'s guard takes the body', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    // Its boot is the moment it was made (restarts.json); it dies after its reconcile.
    const bootA = timers.now();
    const a = makeWorker({ stateDir, timers });
    await a.worker.reconcile();
    await a.worker.kill();
    const last = readFileSync(join(stateDir, STATE_FILES.journal), 'utf8').trimEnd().split('\n').at(-1)!;
    const deathA = Date.parse((JSON.parse(last) as { ts: string }).ts);
    plant(stateDir, heapReport(deathA + 200), deathA + 500);
    writeFileSync(join(stateDir, MEM_FILE), JSON.stringify(sample({ at: deathA - 5_000, heap_used: 580 * MB, heap_limit: 600 * MB })));
    // This death's memory as MEM-SUMMARY reads it: the probe samples worker A left are mem-counts.test.ts's subject.
    rmSync(join(stateDir, PROBE_FILE), { force: true });
    const pre = makeWorker({ stateDir, timers, phase: 'reconcile' });
    expect(await pre.worker.reconcileOnly()).toEqual({ ok: true });
    // The report and the sample are gone before the main boot: it reads the pre-step's handoff, not them.
    rmSync(join(stateDir, REPORTS_DIR), { recursive: true });
    rmSync(join(stateDir, MEM_FILE));
    const b = makeWorker({ stateDir, timers });
    await b.worker.stop();
    const text = readFileSync(join(stateDir, STATE_FILES.journal), 'utf8');
    const starts = text.split('\n').filter((l) => l.includes('"kind":"start"'));
    const main = JSON.parse(starts.at(-1)!) as Record<string, unknown>;
    expect(main['phase']).toBeUndefined();
    const dm = main['death_mem'] as { at: number; uptime_s: number; spaces: unknown[] };
    expect(dm.at).toBe(deathA + 200);
    expect(dm.uptime_s).toBe(Math.floor((deathA + 200 - bootA) / 1000));
    expect(dm.uptime_s).toBeGreaterThan(0);
    expect(dm.spaces).toHaveLength(4);
    expect(text).not.toMatch(/sk-live|api-key/);
    const st = emptySummaryState();
    for (const l of text.split('\n')) foldText(st, l, new Date(T - 30 * 86_400_000).toISOString());
    const day = melbourneDate(timers.now());
    const sum = buildSummary({ day, final: false, nowMs: timers.now(), fold: st.days[day], gitSha: 'a'.repeat(40), entryRule: 'S0', recorder: 'off', uptimeS: 1, trades: [], openPositions: 0, solPrice: null, credits: [] });
    expect(sum.worker.last_death).toEqual({
      at: new Date(deathA + 200).toISOString(), uptime_s: dm.uptime_s, heap_used_mb: 590, heap_limit_mb: 600,
      spaces: [{ space: 'old', used_mb: 500 }, { space: 'large-object', used_mb: 60 }, { space: 'new', used_mb: 16 }, { space: 'code', used_mb: 4 }],
      sample: { at: new Date(deathA - 5_000).toISOString(), heap_used_mb: 580, heap_limit_mb: 600, rss_mb: 300, external_mb: 0, array_buffers_mb: 0 },
    });
    const body = summaryBody(sum);
    expect('body' in body && checkSummary(body.body).ok).toBe(true);
  });
});
