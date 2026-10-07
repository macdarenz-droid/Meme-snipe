// ROUND 4 PARALYSIS PROBE (red team, latches): the sell-only halt outlives the position it was about.
// worker.ts:818-823 fills `#sellOnly` once, at construction, for every restored open position whose universe the loaded
// policy lacks (or has none on record); worker.ts:2307 adds it to every halt, and nothing ever removes it. The reason is
// about ONE position ("no new entries; the positions below are flattened"), yet after that position is flattened the halt
// stays for the life of the process: every candidate is refused (`halted: true`) until someone restarts the worker,
// and nothing restarts it. Trigger: any release that drops/renames a universe while a paper trade is open, or a saved plan
// without a universe (EXIT-1e/1g recovery). Non-paralysed behaviour asserted: once the sell-only position is closed,
// the sell-only reason leaves the halt. FAILS on cd4d7a6.
import { describe, expect, it } from 'vitest';
import { exitsFile } from '../../src/run/state.ts';
import { Market, makeWorker, passingMarket } from '../worker-harness.ts';

const HELD = { heldPoolFacts: true } as const;

describe('round4 latches: sell-only clears once its position is flat', () => {
  it('after the sell-only position closes, entries are no longer halted for sell-only', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m0 = await passingMarket(h, HELD);
    await m0.run(4_000, 100, () => m0.pool());
    await m0.run(10_000, 400, () => {
      m0.slot();
      m0.pool();
    });
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
    await h.worker.kill();
    const file = exitsFile(h.stateDir);
    const saved = file.read({});
    file.write({ ...saved, [pid]: { ...saved[pid]!, plan: { ...saved[pid]!.plan, universe: 'U9' as never } } });
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h2, HELD);
    await m.run(150_000, 1_000, () => {
      m.slot();
      m.pool();
    });
    expect(h2.worker.book.positions[pid]!.status).toBe('closed');
    // Hours later, nothing open: the only reason for the halt is gone.
    await m.run(60_000, 1_000, () => {
      m.slot();
      m.pool();
    });
    const open = Object.values(h2.worker.book.positions).filter((p) => p.status !== 'closed');
    expect(open).toEqual([]);
    expect(h2.worker.health().halt_reasons.filter((r) => r.startsWith('sell-only'))).toEqual([]);
    await h2.worker.stop();
  }, 120_000);
});
