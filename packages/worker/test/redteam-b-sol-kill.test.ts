// RED TEAM B, RB-1 at worker level: the owner counts success in SOL (CLAUDE.md 2026-10-05). An idle paper wallet (no
// candidate, no position, SOL quantity unchanged) must latch nothing when only SOL/USD falls. FAILS at 959d801.
import { describe, expect, it } from 'vitest';
import { SOL_PRICE_KEY } from '../src/engine/strategy.ts';
import { controlFile, NO_CONTROL } from '../src/run/state.ts';
import { Market, SOL_PRICE, makeWorker } from './worker-harness.ts';

describe('RB-1 worker: SOL/USD fall alone', () => {
  it('RB-1w a 31% SOL/USD fall with no trade latches the R10 kill switch (owner re-arm only)', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    const priced = (ppm: bigint) => { m.slot(); m.fact(SOL_PRICE_KEY, { value: (SOL_PRICE * ppm) / 1_000_000n, atMs: m.now - 50 }); h.worker.step(); };
    await m.run(4_000, 400, () => priced(1_000_000n));
    await m.run(4_000, 400, () => priced(690_000n));
    expect(Object.keys(h.worker.book.positions)).toHaveLength(0);
    expect(controlFile(h.stateDir).read(NO_CONTROL).latches.killTrippedAtMs).toBeNull();
    await h.worker.stop();
  });
});
