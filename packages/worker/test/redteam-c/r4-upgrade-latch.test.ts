// RED TEAM C round 4 (PR B #280, claude/rc-state): the start-time state check treats "ledger there, control.json
// missing" as lost owner controls and starts with the kill switch latched and entries paused. Before PR B (959d801 and
// every release before it), control.json was written only when a latch tripped or the owner paused (worker.ts:2187,
// :2901), so a host that ran normally has a ledger and no control.json. The first start of the new code on such a host
// (the RESUME-WORKER deploy) latches the kill switch with nothing lost: the bot does not trade until the owner re-arms.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOL_PRICE_KEY } from '../../src/engine/strategy.ts';
import { controlFile, NO_CONTROL } from '../../src/run/state.ts';
import { Market, SOL_PRICE, makeWorker } from '../worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const priced = (h: H, m: Market): void => {
  m.slot();
  m.fact(SOL_PRICE_KEY, { value: SOL_PRICE, atMs: m.now - 50 });
  h.worker.step();
};

describe('red team C: upgrade from a release that never wrote control.json', () => {
  it('a state dir with a ledger and no control.json (as every release before PR B leaves it) starts unlatched and unpaused', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    await m.run(2_000, 400, () => priced(h, m));
    await h.worker.stop();
    // What the old code leaves: it never wrote control.json without a trip or a pause.
    rmSync(join(h.stateDir, 'control.json'), { force: true });
    expect(existsSync(join(h.stateDir, 'control.json'))).toBe(false);

    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const c = controlFile(h2.stateDir).read(NO_CONTROL);
    await h2.worker.stop();
    expect({ paused: c.paused, killTrippedAtMs: c.latches.killTrippedAtMs }).toEqual({ paused: false, killTrippedAtMs: null });
  });
});
