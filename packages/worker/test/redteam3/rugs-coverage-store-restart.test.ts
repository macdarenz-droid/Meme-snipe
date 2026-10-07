// RED TEAM 3 / R3-2: the rug half of H14 reads covered across a restart's downtime when the restart is seeded from the
// deployer store alone (state file missing or discarded: version or rug-config change after an upgrade, corruption,
// a kill before the first save).
//
// worker.ts:2478-2481 adds the downtime as an open gap only on the creates stream (`coverage:creates:gap`, via the
// creates watch). `loadState` (persist path) adds an open `restart` gap for every started via, rugs included
// (DECISIONS 2026-10-04 "The rug half after a restart": the rug half must stay not covered after any restart until the
// on-demand check covers it). The store path (deployers.jsonl, which keeps `coverage:rugs:*` too) has no such gap: the
// old process's `coverage:rugs:start` and the new process's start on the same via read as one continuous coverage
// (`createsCoverage`: a new start settles only open gaps). The labeller missed every trade of the downtime, so a
// deployer's rug in it is never labelled and H14's prior-rug rule passes on missing data.
// Realism: needs rug-stream coverage (`tradeStreams` on, the paid plan; off in main.ts today) and a boot without a
// usable state file. The creates half of the same boot is the control: it reads not covered.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Coverage, History } from '../../../core/src/gates/index.ts';
import type { Moment } from '../../../core/src/engine/index.ts';

const seen: { rugs: Coverage | null } = { rugs: null };
vi.mock('../../../core/src/gates/index.ts', async (orig) => {
  const m = await orig<typeof import('../../../core/src/gates/index.ts')>();
  return {
    ...m,
    // Probe only: whenever the strategy judges the creates coverage, the rugs coverage is judged on the same history.
    createsCoverage: (h: History, now: Moment, from: number, stream = 'creates') => {
      if (stream === 'creates') seen.rugs = m.createsCoverage(h, now, from, 'rugs');
      return m.createsCoverage(h, now, from, stream);
    },
  };
});

const { PERSIST_FILE } = await import('../../src/run/worker.ts');
const { Market, T, makeWorker, slotAt, tempState, virtualTimers } = await import('../worker-harness.ts');

const CREATES_VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const RUGS_VIA = 'logs:6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const DAY = 86_400_000;

const boot = async (h: ReturnType<typeof makeWorker>) => {
  const m = new Market(h);
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
  m.slot();
  m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: CREATES_VIA });
  m.offchain('coverage:rugs:start', { fromSlot: slotAt(m.now), via: RUGS_VIA });
  expect(await started).toEqual({ ok: true });
  await m.run(2_000, 400, () => m.slot());
  return m;
};

describe('R3-2 rug coverage after a restart seeded from the deployer store', () => {
  it('the downtime is a rug-stream gap: H14\'s rug half is not covered after the restart', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T - 16 * DAY);
    const seed = async () => ({ mode: 'none' as const, creates: [], coverage: [], report: 'test' });
    const h1 = makeWorker({ stateDir, timers, seed });
    const m1 = await boot(h1);
    // 15 days of gap-free running on both streams.
    await m1.run(15 * DAY, 3_600_000, () => m1.slot());
    await h1.worker.kill();
    // The state file is gone (discarded at load: a version or rug-config change, corruption); the store stays.
    rmSync(join(stateDir, PERSIST_FILE), { force: true });
    // Two hours down; every rug of those two hours is unseen by the labeller.
    timers.set(timers.now() + 2 * 3_600_000);
    const h2 = makeWorker({ stateDir, timers, seed });
    expect(h2.logs.some((l) => l.startsWith('Saved state restored'))).toBe(false);
    seen.rugs = null;
    const m2 = await boot(h2);
    await m2.run(60_000, 400, () => m2.slot());
    // Control: the creates half reads the downtime as a gap.
    expect(h2.worker.strategy.coverage?.covered, JSON.stringify(h2.worker.strategy.coverage)).toBe(false);
    // The rug half must too.
    expect(seen.rugs, 'probe ran').not.toBeNull();
    expect(seen.rugs?.covered, JSON.stringify(seen.rugs)).toBe(false);
    await h2.worker.kill();
  }, 600_000);
});
