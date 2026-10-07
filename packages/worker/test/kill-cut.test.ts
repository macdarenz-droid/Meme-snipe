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

const line = (action: string, event: string) => `{"kind":"decision","action":"${action}","event":"${event}"}`;
const LIVE = [line('propose', 'e1'), line('prepare', 'e2'), line('sign', 'e2')];
const boot = (stopped: boolean | undefined): BootInput => ({ boot: 'b', missing: null, seed: 's', frames: [], releases: [], live: LIVE, excluded: {}, redactions: 0, ...(stopped === undefined ? {} : { stopped }) });

describe('RC-FIXES: parity forgives only a kill inside the last event', () => {
  it('cutAtKill: extras of the last live event are cut; any other extra, or a shorter replay, is left to differ', () => {
    expect(cutAtKill(LIVE, [...LIVE, line('submit', 'e2')])).toEqual(LIVE);
    expect(cutAtKill(LIVE, [...LIVE, line('submit', 'e2'), line('propose', 'e3')])).toHaveLength(5);
    expect(cutAtKill(LIVE, [...LIVE, line('propose', 'e3')])).toHaveLength(4);
    expect(cutAtKill(LIVE, LIVE.slice(0, 2))).toHaveLength(2);
    expect(cutAtKill([], [line('submit', 'e2')])).toHaveLength(1);
  });

  it('checkBoot: a killed boot (no stop line) passes with the cut; a stopped boot or one not known still diverges', () => {
    const h = makeWorker();
    const deps: ParityDeps = { session: h.session, rugs: RUG_CONFIG, strategy: h.worker.strategyConfig };
    const replay = () => [...LIVE, line('submit', 'e2')];
    expect(checkBoot(boot(false), deps, 2, replay).divergence).toBeNull();
    expect(checkBoot(boot(true), deps, 2, replay).divergence).toMatchObject({ index: 3, live: null });
    expect(checkBoot(boot(undefined), deps, 2, replay).divergence).toMatchObject({ index: 3, live: null });
    // A line before the end that differs is never forgiven.
    expect(checkBoot(boot(false), deps, 2, () => [LIVE[0]!, line('prepare', 'eX'), LIVE[2]!, line('submit', 'e2')]).divergence).toMatchObject({ index: 1 });
  });

  it('loadSession: a boot with its stop line is stopped (compared strictly)', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true });
    await m.run(4_000, 100, () => m.pool());
    await h.worker.stop();
    const boots = loadSession(h.stateDir);
    expect(boots.length).toBeGreaterThan(0);
    expect(boots.every((b) => b.stopped === true)).toBe(true);
  });
});

describe('RC-FIXES: Recorder.durable', () => {
  it('writes every buffered line and fsyncs each open file; a failing fsync throws (the worker then refuses the entry)', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-'));
    const rec = new Recorder({ root, boot: 'b1', gitSha: 'abc', rotateBytes: 1 << 20 });
    rec.delay({ n: 1 }, Date.UTC(2026, 9, 7));
    const synced: number[] = [];
    rec.durable((fd) => void synced.push(fd));
    expect(synced).toHaveLength(1);
    const day = readdirSync(join(root, 'b1', 'days'))[0]!;
    const file = readdirSync(join(root, 'b1', 'days', day))[0]!;
    expect(readFileSync(join(root, 'b1', 'days', day, file), 'utf8')).toContain('"n":1');
    expect(() => rec.durable(() => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); })).toThrow('no space');
  });
});
