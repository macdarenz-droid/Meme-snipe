// RED TEAM C round 4 (PR B #280): checkBoot's cutAtKill is documented to forgive only the decision a kill can cut off:
// an entry's `submit`, logged after its buy is sent. The code forgives ANY replay lines past the journal's end, so long
// as they belong to the journal's last event. On a killed boot (restart drills kill on purpose), a replay that enters
// where live did not, at the last event, therefore passes TEST-1 parity. These assert the documented rule.
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../../core/src/config/index.ts';
import { type BootInput, checkBoot, type ParityDeps } from '../../src/run/parity.ts';
import { makeWorker } from '../worker-harness.ts';

const line = (action: string, event: string) => `{"kind":"decision","action":"${action}","event":"${event}"}`;
const boot = (live: string[]): BootInput => ({ boot: 'b', missing: null, seed: 's', frames: [], releases: [], live, excluded: {}, redactions: 0, stopped: false });

describe('red team C: cutAtKill forgives only a cut-off submit', () => {
  const deps = (): ParityDeps => {
    const h = makeWorker();
    return { session: h.session, rugs: RUG_CONFIG, strategy: h.worker.strategyConfig };
  };

  it('live rejected at its last event; the replay enters there (prepare, sign, submit): a divergence', () => {
    const live = [line('propose', 'e1'), line('reject', 'e2')];
    const replay = [...live, line('prepare', 'e2'), line('sign', 'e2'), line('submit', 'e2')];
    expect(checkBoot(boot(live), deps(), 2, () => replay).divergence).not.toBeNull();
  });

  it('live stopped at prepare; the replay adds sign AND submit (more than the one line a kill after the send cuts): a divergence', () => {
    const live = [line('propose', 'e1'), line('prepare', 'e2')];
    const replay = [...live, line('sign', 'e2'), line('submit', 'e2')];
    expect(checkBoot(boot(live), deps(), 2, () => replay).divergence).not.toBeNull();
  });
});
