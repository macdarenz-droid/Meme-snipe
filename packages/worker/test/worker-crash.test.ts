// WORKER-CRASH (read-audit at fff0017): faults that used to crash the paper worker, or leave it crashed without exiting.
// (a) a transaction DEC-1 cannot decode is a fact gap, never a crash; (b) a crash of the engine loop exits with the crash
// code, also during the seed; (c) a recorder that cannot write (ENOSPC) halts entries and alerts, without a crash loop,
// and exits go on; (d) a delay sample that cannot be recorded never stops the probe.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT } from '../../runner/src/contract.ts';
import { DEFAULT_LIVE_FEED, LiveFeed, decodable, frameEvents, rpcHandler, scriptedHttp, type Frame } from '../src/providers/index.ts';
import { ManualTimers } from '../src/scheduler/index.ts';
import { DelayProbe } from '../src/run/delay-probe.ts';
import { Recorder } from '../src/run/recorder.ts';
import { PERSIST_FILE } from '../src/run/worker.ts';
import { CreditBook, LiveProviders } from '../src/run/sources.ts';
import { blockNetwork, recordOf, settle, testSecrets, tx } from './helpers.ts';
import { Market, T, makeWorker, passingMarket, slotAt, tempState, virtualTimers } from './worker-harness.ts';
import { runSeed } from '../src/run/seed-start.ts';

blockNetwork();

const lines = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const kinds = (dir: string, kind: string) => lines(dir).filter((l) => l['kind'] === kind);

/** A real transaction whose record lost its inner instructions: DEC-1's `transactionEvents` throws a DecodeError on it. */
const MIG = tx('migration CreatePoolEvent');
const GOOD = recordOf(MIG);
const BAD = { ...GOOD, innerInstructions: null };

/** What a write to a full disk throws. */
const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });

afterEach(() => {
  vi.restoreAllMocks();
  // The loop's crash path marks the process; the test runner's own exit code must not inherit it.
  process.exitCode = undefined;
});

describe('(a) an undecodable transaction is a fact gap, never a crash', () => {
  const frame = (record: typeof GOOD, seq = 0): Frame => ({ seq, receivedAt: 1_000, source: 'helius', backfilled: false, place: { at: 'chain', slot: record.slot }, duplicate: false, body: { type: 'tx', record } });

  it('frameEvents gives one tx:undecodable event and no ev: event (a cut log it was fetched for stays a hole)', () => {
    const events = frameEvents([frame(BAD)]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'market', id: `txerr:${GOOD.signature}`, key: 'tx:undecodable', value: { signature: GOOD.signature, error: expect.stringMatching(/inner instructions/) } });
    expect(events.some((e) => e.id.startsWith('ev:'))).toBe(false);
    // The decodable record still decodes as before.
    expect(frameEvents([frame(GOOD)]).every((e) => e.id.startsWith(`ev:${GOOD.signature}:`))).toBe(true);
    expect(decodable(GOOD)).toBe(true);
    expect(decodable(BAD)).toBe(false);
  });

  it('the live feed releases it without throwing, in its place', () => {
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED });
    feed.ingest('helius', { type: 'slot', slot: BAD.slot, parent: BAD.slot - 1n, root: null }, { receivedAt: 1_000 });
    feed.ingest('helius', { type: 'tx', record: BAD }, { receivedAt: 1_001 });
    feed.ingest('helius', { type: 'slot', slot: BAD.slot + 100n, parent: BAD.slot + 99n, root: null }, { receivedAt: 2_000 });
    expect(() => feed.advance(2_000)).not.toThrow();
    const out: string[] = [];
    for (let e = feed.next(); e !== null; e = feed.next()) out.push(e.id);
    expect(out).toContain(`txerr:${GOOD.signature}`);
  });

  it('a worker step over it does not throw, and the worker keeps running', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = new Market(h);
    m.slot();
    h.worker.feed.ingest('helius', { type: 'tx', record: BAD }, { receivedAt: m.now, lookup: true });
    await m.run(2_000, 400, () => m.slot());
    expect(h.worker.health().reconciled).toBe(true);
    expect(await h.worker.stop()).toBe(EXIT.clean);
  });

  it('fetchTx reads an undecodable transaction as not found, so a cut trade log still becomes a rugs gap', async () => {
    const timers = new ManualTimers(Date.parse('2026-10-04T00:00:00Z'));
    const answer = { value: MIG.base64 as unknown };
    const http = scriptedHttp(rpcHandler((m) => (m === 'getTransaction' ? answer.value : null)));
    const providers = new LiveProviders({ tradeStreams: false, secrets: testSecrets, http, factory: () => { throw new Error('no sockets in this test'); }, credits: new CreditBook(tempState(), timers) });
    providers.feeds({ feed: new LiveFeed({ ...DEFAULT_LIVE_FEED }), timers, pools: () => new Map() });
    const base = MIG.base64 as { meta: Record<string, unknown> };
    answer.value = { ...base, meta: { ...base.meta, innerInstructions: null } };
    expect(await providers.fetchTx(MIG.signature)).toBe(false);
  });
});

describe('(b) a crash of the engine loop exits with the crash code', () => {
  /** From `armed()` on, every engine step throws (the reconcile's own steps run before it). */
  const failingStep = (h: ReturnType<typeof makeWorker>, armed: () => boolean = () => true) => {
    const step = h.worker.step.bind(h.worker);
    vi.spyOn(h.worker, 'step').mockImplementation(() => {
      if (armed()) throw new Error('step failed (test)');
      step();
    });
  };

  it('during the seed: the start reports the crash code (it used to report 0), and the stop finishes with it', async () => {
    let placeSeed: () => void = () => {};
    let seeding = false;
    // The seed is asked for once the loop runs; it answers only after the loop has crashed.
    const h = makeWorker({ seed: () => new Promise((r) => {
      seeding = true;
      placeSeed = () => r({ mode: 'none', creates: [], coverage: [], report: 'test: late' });
    }) });
    failingStep(h, () => seeding);
    const started = h.worker.start();
    expect(await h.worker.stopping).toBe(EXIT.crash);
    placeSeed();
    expect(await started).toMatchObject({ ok: false, code: EXIT.crash });
    expect(await h.worker.stopped).toBe(EXIT.crash);
    expect(await h.worker.stop(EXIT.clean)).toBe(EXIT.crash);
    // RESTART-CAUSE: the stop line names where (the throwing frame and the event kind), never the message.
    expect(kinds(h.stateDir, 'stop').at(-1)!['reasons']).toEqual(['crash', expect.stringMatching(/^Error at packages\/worker\/test\/worker-crash\.test\.ts:\d+ during [A-Za-z0-9_.:\/-]+$/)]);
    expect(h.logs.some((l) => l.startsWith('Engine step failed: Error: step failed (test)'))).toBe(true);
  });

  it('after a good start: `stopped` resolves with the crash code, which the entry exits with', async () => {
    const h = makeWorker();
    expect(await h.worker.start()).toEqual({ ok: true });
    failingStep(h);
    expect(await h.worker.stopped).toBe(EXIT.crash);
  });

  it('a stop after a kill (the restart drills) returns at once with the crash code, never hangs', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    await h.worker.kill();
    expect(await h.worker.stop()).toBe(EXIT.crash);
    expect(await h.worker.stopped).toBe(EXIT.crash);
  });

  it('a stop that throws half way (a full disk at the stop line) ends as a crash, even a signal\'s clean stop (review B2)', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const write = h.worker.journal.write.bind(h.worker.journal);
    vi.spyOn(h.worker.journal, 'write').mockImplementation(((kind: string, fields: Record<string, unknown>) => {
      if (kind === 'stop') throw enospc();
      return write(kind as never, fields);
    }) as never);
    expect(await h.worker.stop(EXIT.clean)).toBe(EXIT.crash);
    expect(await h.worker.stopped).toBe(EXIT.crash);
    expect(h.logs.some((l) => l.startsWith('Stop failed: Error: ENOSPC'))).toBe(true);
  });

  it('the entry, as a process: a refused start (the health port is taken) exits with the start\'s code 1, never 0 (review B2)', async () => {
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(18786, '127.0.0.1', r));
    try {
      const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ['--no-warnings', 'packages/worker/src/main.ts'], {
          cwd: join(import.meta.dirname, '..', '..', '..'),
          env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: tempState(), ZEROED_MODE: 'paper', ZEROED_HEALTH_ADDR: '127.0.0.1:18786', ZEROED_API_ADDR: '127.0.0.1:18789' },
        });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => void (stderr += d.toString()));
        const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('exit', (status) => {
          clearTimeout(kill);
          resolve({ status, stderr });
        });
      });
      expect(r.stderr).toContain('health server: listen EADDRINUSE');
      expect(r.status).toBe(EXIT.crash);
    } finally {
      busy.close();
    }
  }, 70_000);

  it('the entry exits on every stop of the worker, with its code (nothing is left lingering after a loop crash)', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(src).toMatch(/w\.stopped\.then\(\(code\) => \{\s*credits\.flush\(\);\s*process\.exit\(code\);/);
    expect(src).toMatch(/w\.stopping\.then\(\(\) => setTimeout\(\(\) => process\.exit\(EXIT\.crash\), 25_000\)\.unref\(\)\)/);
  });
});

describe('(c) a recorder that cannot write: entries halt, the alert goes up, no crash, exits go on', () => {

  it('a throw from the recorder inside the feed\'s ingest is caught; the worker halts entries, alerts and still exits a held position', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true });
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    const open = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!;
    expect(open).toBeDefined();
    const frame = vi.spyOn(Recorder.prototype, 'frame').mockImplementation(() => {
      throw enospc();
    });
    // The socket handler's path: an ingest. It used to throw ENOSPC out of the handler (uncaughtException, exit 1).
    expect(() => m.slot()).not.toThrow();
    expect(frame).toHaveBeenCalledTimes(1);
    await m.run(800, 400, () => m.slot());
    // Recording stopped: the recorder is not called again.
    expect(frame).toHaveBeenCalledTimes(1);
    const health = h.worker.health();
    const reason = 'recorder failed (ENOSPC): recording stopped, entries off until a restart';
    expect(health.halt_reasons).toContain(reason);
    expect(health.entries_halted).toBe(true);
    expect(health.critical).toContain(reason);
    expect(health.recorder).toBe('off');
    expect(kinds(h.stateDir, 'alert')).toEqual([expect.objectContaining({ level: 'critical', code: 'recorder_failed', reasons: [reason, 'Error: ENOSPC: no space left on device, write'] })]);
    expect(kinds(h.stateDir, 'halt').some((l) => (l['reasons'] as string[]).includes(reason))).toBe(true);
    // Exits go on: the price falls 30% and the stop exits the position.
    await m.run(6_000, 400, () => {
      m.slot();
      m.pool(700_000n);
    });
    expect(h.worker.book.positions[open.id]!.status).toBe('closed');
    expect(h.worker.health().halt_reasons).toContain(reason);
    expect(await h.worker.stop()).toBe(EXIT.clean);
  });

  /**
   * The entering market, one step at a time (what `Market.run` does), with `before(k)` run ahead of step k's facts and
   * `arm(k)` between the facts and the step. Returns the first step whose journal has an `enter` decision, or null.
   */
  const drive = async (o: { readonly before?: (k: number) => void; readonly arm?: (k: number) => void } = {}) => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true });
    let entered: number | null = null;
    const plan = [...Array<number>(40).fill(100), ...Array<number>(25).fill(400)];
    for (let k = 0; k < plan.length; k++) {
      o.before?.(k);
      if (plan[k] === 400) m.slot();
      m.pool();
      o.arm?.(k);
      h.worker.step();
      h.timers.set(h.timers.now() + plan[k]!);
      await new Promise<void>((r) => setImmediate(r));
      if (entered === null && kinds(h.stateDir, 'decision').some((l) => l['action'] === 'enter')) entered = k;
    }
    // Long enough for an approved entry to land, as the control's does.
    await m.run(8_000, 400, () => {
      m.slot();
      m.pool();
    });
    return { h, entered };
  };

  /** The control run's entering step, found once. */
  let control: Promise<number> | null = null;
  const enteringStep = (): Promise<number> => (control ??= (async () => {
    const run = await drive();
    expect(run.entered).not.toBeNull();
    expect(kinds(run.h.stateDir, 'entry')).toHaveLength(1);
    await run.h.worker.stop();
    return run.entered!;
  })());

  it.each([
    { name: 'a release fails in the entering step (inside feed.advance)', offset: 0, where: 'release' as const },
    { name: 'a frame fails at an ingest just before the entering step', offset: 0, where: 'frame' as const },
    { name: 'a release fails in the step before the entering step', offset: -1, where: 'release' as const },
  ])('no entry decided at or after the fault proceeds: $name (review B1)', async ({ offset, where }) => {
    const at = (await enteringStep()) + offset;
    let armed = false;
    const original = Recorder.prototype[where] as (this: Recorder, ...a: unknown[]) => void;
    vi.spyOn(Recorder.prototype, where).mockImplementation(function (this: Recorder, ...args: unknown[]) {
      if (armed) throw enospc();
      original.call(this, ...args);
    } as never);
    // `frame` fails on the facts ingested ahead of the step; `release` fails inside the step itself.
    const run = await drive(where === 'frame' ? { before: (n) => void (armed ||= n === at) } : { arm: (n) => void (armed ||= n === at) });
    expect(run.h.worker.health().halt_reasons).toContain('recorder failed (ENOSPC): recording stopped, entries off until a restart');
    expect(kinds(run.h.stateDir, 'entry')).toEqual([]);
    expect(Object.values(run.h.worker.book.positions).filter((p) => p.status !== 'closed')).toEqual([]);
    expect(run.h.worker.book.reserved).toBe(0n);
    expect(kinds(run.h.stateDir, 'decision').filter((l) => l['action'] === 'entry_refused').map((l) => l['reasons'])).toEqual([['entries halted: recorder failed (ENOSPC): recording stopped, entries off until a restart', 'no exposure reserved']]);
    await run.h.worker.stop();
  });

  it('a flush that fails in a step (the buffered lines meet the full disk) is the same fault, not a loop crash', async () => {
    vi.spyOn(Recorder.prototype, 'flush').mockImplementation(() => {
      throw enospc();
    });
    const h = makeWorker();
    await h.worker.reconcile();
    const m = new Market(h);
    await m.run(800, 400, () => m.slot());
    expect(h.worker.health().halt_reasons).toContain('recorder failed (ENOSPC): recording stopped, entries off until a restart');
    expect(await h.worker.stop()).toBe(EXIT.clean);
  });

  it('a recorder that cannot attach the restored state at boot (#record) halts entries, never the boot', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const emptyRpc = { getSignaturesForAddress: async () => [{ signature: 'before-the-range', slot: 0n, err: null, blockTime: 0 }], getTransaction: async () => null };
    const first = makeWorker({ stateDir, timers, seed: (r) => runSeed(r, { rpc: emptyRpc, timers }) });
    const m = new Market(first);
    const started = first.worker.start();
    while (!first.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
    m.slot();
    m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM' });
    expect(await started).toEqual({ ok: true });
    await m.run(3_000, 400, () => m.slot());
    await first.worker.stop();
    // A clean stop saved the deployer state: the next boot copies it into its recording and attaches it there.
    expect(existsSync(join(stateDir, PERSIST_FILE))).toBe(true);
    const attach = vi.spyOn(Recorder.prototype, 'attach').mockImplementation(() => {
      throw enospc();
    });
    const h = makeWorker({ stateDir, timers });
    // The boot went on (the constructor returned): the fault is the recorder's, and entries halt from the first check.
    expect(attach).toHaveBeenCalledTimes(1);
    expect(h.worker.health().recorder).toBe('off');
    expect(kinds(stateDir, 'alert').map((l) => l['code'])).toEqual(['recorder_failed']);
    await h.worker.reconcile();
    const m2 = new Market(h);
    await m2.run(800, 400, () => m2.slot());
    expect(h.worker.health().halt_reasons).toContain('recorder failed (ENOSPC): recording stopped, entries off until a restart');
    expect(await h.worker.stop()).toBe(EXIT.clean);
  });

  it('a recorder that cannot start (its folder cannot be made) does not stop the process: entries halt with the alert', async () => {
    const stateDir = tempState();
    writeFileSync(join(stateDir, 'recorder'), 'not a folder');
    const h = makeWorker({ stateDir });
    await h.worker.reconcile();
    const m = new Market(h);
    await m.run(800, 400, () => m.slot());
    const health = h.worker.health();
    expect(health.halt_reasons.some((r) => /^recorder failed \(E[A-Z]+\): recording stopped, entries off until a restart$/.test(r))).toBe(true);
    expect(health.recorder).toBe('off');
    expect(kinds(stateDir, 'alert').map((l) => l['code'])).toEqual(['recorder_failed']);
    expect(await h.worker.stop()).toBe(EXIT.clean);
  });
});

describe('(d) the delay probe survives a sample it cannot record', () => {
  it('a throw from record is reported, and the next sample is read and recorded (it used to stay in flight for good)', async () => {
    const timers = new ManualTimers(1_000_000);
    const via = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
    const reads: string[] = [];
    const rows: unknown[] = [];
    const errors: unknown[] = [];
    let full = true;
    const probe = new DelayProbe({
      timers, via, everyMs: 60_000, mono: () => 0, onError: (e) => void errors.push(e),
      record: (row) => {
        if (full) throw new Error('ENOSPC');
        rows.push(row);
      },
      confirmed: async (sig) => {
        reads.push(sig);
        return { slot: GOOD.slot, at: 1_000_200, mono: 1, again: false };
      },
    });
    const seen = (signature: string): Frame => ({ seq: 0, receivedAt: 1_000_100, source: 'helius', backfilled: false, place: { at: 'offchain', slot: 1n }, duplicate: false, body: { type: 'seen', signature, slot: GOOD.slot, err: null, via, detail: null } });
    probe.frame(seen('a'.repeat(64)));
    await expect(probe.sample()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    full = false;
    probe.frame(seen('b'.repeat(64)));
    await probe.sample();
    await settle();
    expect(reads).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(rows).toHaveLength(1);
  });
});
