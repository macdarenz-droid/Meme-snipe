// RC-FIXES: a killed boot's journal may end inside one event's decisions (an entry's `submit` is logged after its buy is
// sent); the replay may go on past the journal's end with that event's lines only, and only for a boot with no stop line.
import { describe, expect, it } from 'vitest';
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
