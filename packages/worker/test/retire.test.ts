// OOM-MINT: the strategy lets a mint and its pool go (`Strategy.retired`) only when it is no candidate, holds no exit plan
// and has no tail; the engine then forgets their keys and the producer their state.
import { describe, expect, it } from 'vitest';
import { blockNetwork } from './helpers.ts';
import { MIGRATED_AT, MINT, POOL_ADDRESS, makeWorker, passingMarket, type Harness } from './worker-harness.ts';

blockNetwork();

/** The worker's first entry moment on the passing market with the default window (rec-same-event.test.ts pins it). */
const FIRST_PASS = Date.parse('2026-10-03T15:00:01.800Z');

const watch = (h: Harness): string[] => {
  const s = h.worker.strategy;
  const got: string[] = [];
  const own = s.retired.bind(s);
  s.retired = () => {
    const r = own();
    got.push(...r);
    return r;
  };
  return got;
};

const run = async (windowToMs: number | undefined, after?: (h: Harness, m: Awaited<ReturnType<typeof passingMarket>>, got: string[]) => Promise<void>) => {
  const h = makeWorker(windowToMs === undefined ? {} : { strategy: { windowToMs } });
  const got = watch(h);
  await h.worker.reconcile();
  const m = await passingMarket(h, { heldPoolFacts: true });
  await m.run(4_000, 100, () => m.pool());
  await m.run(10_000, 400, () => {
    m.slot();
    m.pool();
  });
  await after?.(h, m, got);
  await h.worker.stop();
  return got;
};

describe('a mint and its pool are let go only when nothing watches them', () => {
  it('a candidate whose window ends before it is judged (no tail) is let go with its pool at once', async () => {
    const got = await run(60_000);
    expect(got).toEqual(expect.arrayContaining([MINT, POOL_ADDRESS]));
  });

  it('a candidate judged and rejected keeps its tail: let go only when the tail ends', async () => {
    const got = await run(FIRST_PASS - MIGRATED_AT, async (h, m, seen) => {
      expect(seen).not.toContain(MINT);
      // Past the window end and the tail's maximum hold (EXIT-1 tMax, two hours).
      h.timers.set(m.now + 121 * 60_000);
      await m.run(2_000, 400, () => m.slot());
    });
    expect(got).toEqual(expect.arrayContaining([MINT, POOL_ADDRESS]));
  });

  it('a held position keeps its mint: never let go while the position is open', async () => {
    const got = await run(undefined, async (h, m, seen) => {
      expect(h.worker.book.positions).not.toEqual({});
      expect(seen).not.toContain(MINT);
    });
    expect(got).not.toContain(MINT);
  });
});
