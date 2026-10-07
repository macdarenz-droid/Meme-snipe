// RC-FIXES: a killed boot's journal may end inside one event's decisions (an entry's `submit` is logged after its buy is
// sent); the replay may go on past the journal's end with that event's lines only, and only for a boot with no stop line.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Recorder } from '../src/run/recorder.ts';
import { RUG_CONFIG } from '../../core/src/config/index.ts';
import { type BootInput, checkBoot, cutAtKill, loadSession, type ParityDeps } from '../src/run/parity.ts';
import { makeWorker, passingMarket } from './worker-harness.ts';

const line = (action: string, event: string, intent = 'i1') => `{"kind":"decision","action":"${action}","intent":"${intent}","event":"${event}"}`;
const LIVE = [line('propose', 'e1'), line('prepare', 'e2'), line('sign', 'e2')];
const boot = (stopped: boolean | undefined, dispatched: string | null = 'i1'): BootInput => ({ boot: 'b', missing: null, seed: 's', frames: [], releases: [], live: LIVE, excluded: {}, redactions: 0, dispatched, ...(stopped === undefined ? {} : { stopped }) });

describe('RC-STATE: parity forgives only the one submit a kill after the send cuts off', () => {
  it('cutAtKill: exactly one extra line, the dispatched intent\'s submit after its sign, at the same event; nothing else', () => {
    expect(cutAtKill(LIVE, [...LIVE, line('submit', 'e2')], 'i1')).toEqual(LIVE);
    // More than one extra line, another action, another intent, another event, or not after a sign: left to differ.
    expect(cutAtKill(LIVE, [...LIVE, line('submit', 'e2'), line('propose', 'e3')], 'i1')).toHaveLength(5);
    expect(cutAtKill(LIVE, [...LIVE, line('reject', 'e2')], 'i1')).toHaveLength(4);
    expect(cutAtKill(LIVE, [...LIVE, line('submit', 'e2', 'i2')], 'i1')).toHaveLength(4);
    expect(cutAtKill(LIVE, [...LIVE, line('submit', 'e2')], 'i2')).toHaveLength(4);
    expect(cutAtKill(LIVE, [...LIVE, line('submit', 'e3')], 'i1')).toHaveLength(4);
    // Review of #280: two extra lines ending in the dispatched submit, and a journal whose last sign is another intent's.
    expect(cutAtKill(LIVE, [...LIVE, line('prepare', 'e2'), line('submit', 'e2')], 'i1')).toHaveLength(5);
    const otherSign = [line('propose', 'e1'), line('prepare', 'e2'), line('sign', 'e2', 'i2')];
    expect(cutAtKill(otherSign, [...otherSign, line('submit', 'e2')], 'i1')).toHaveLength(4);
    expect(cutAtKill(LIVE.slice(0, 2), [...LIVE.slice(0, 2), line('submit', 'e2')], 'i1')).toHaveLength(3);
    expect(cutAtKill(LIVE, LIVE.slice(0, 2), 'i1')).toHaveLength(2);
    expect(cutAtKill([], [line('submit', 'e2')], 'i1')).toHaveLength(1);
  });

  it('checkBoot: only a killed boot (no stop line) whose journal ends on a dispatching line is cut', () => {
    const h = makeWorker();
    const deps: ParityDeps = { session: h.session, rugs: RUG_CONFIG, strategy: h.worker.strategyConfig };
    const replay = () => [...LIVE, line('submit', 'e2')];
    expect(checkBoot(boot(false), deps, 2, replay).divergence).toBeNull();
    expect(checkBoot(boot(true), deps, 2, replay).divergence).toMatchObject({ index: 3, live: null });
    expect(checkBoot(boot(undefined), deps, 2, replay).divergence).toMatchObject({ index: 3, live: null });
    expect(checkBoot(boot(false, null), deps, 2, replay).divergence).toMatchObject({ index: 3, live: null });
    // A line before the end that differs is never forgiven.
    expect(checkBoot(boot(false), deps, 2, () => [LIVE[0]!, line('prepare', 'eX'), LIVE[2]!, line('submit', 'e2')]).divergence).toMatchObject({ index: 1 });
  });

  it('loadSession: a boot with its stop line is stopped; its dispatching lines are journaled and closed by later decisions', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true });
    await m.run(4_000, 100, () => m.pool());
    await h.worker.stop();
    const boots = loadSession(h.stateDir);
    expect(boots.length).toBeGreaterThan(0);
    expect(boots.every((b) => b.stopped === true)).toBe(true);
    // Every dispatching line was followed by decisions: none is open.
    expect(boots.every((b) => b.dispatched === null)).toBe(true);
    expect(readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8')).toContain('"kind":"dispatching"');
  });
});

describe('RC-FIXES: Recorder.durable', () => {
  it('writes every buffered line and fsyncs each open file and each folder that gained a file; a failing fsync throws (the worker then refuses the entry)', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-'));
    const rec = new Recorder({ root, boot: 'b1', gitSha: 'abc', rotateBytes: 1 << 20 });
    rec.delay({ n: 1 }, Date.UTC(2026, 9, 7));
    const synced: number[] = [];
    rec.durable((fd) => void synced.push(fd));
    // The open file, the boot's folder, its new day folder and the days folder that gained it.
    expect(synced).toHaveLength(4);
    // No new file since: the open file and the boot's folder.
    rec.delay({ n: 2 }, Date.UTC(2026, 9, 7));
    synced.length = 0;
    rec.durable((fd) => void synced.push(fd));
    expect(synced).toHaveLength(2);
    const day = readdirSync(join(root, 'b1', 'days'))[0]!;
    const file = readdirSync(join(root, 'b1', 'days', day))[0]!;
    expect(readFileSync(join(root, 'b1', 'days', day, file), 'utf8')).toContain('"n":1');
    expect(() => rec.durable(() => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); })).toThrow('no space');
  });
});
