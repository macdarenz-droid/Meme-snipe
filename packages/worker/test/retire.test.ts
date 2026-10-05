// OOM-MINT: the strategy lets a mint and its pool go (`Strategy.retired`) only when it is no candidate, holds no exit plan
// and has no tail; the engine then forgets their keys and the producer their state.
import { describe, expect, it, vi } from 'vitest';
import { FactProducer, STREAMS } from '../../core/src/facts/index.ts';
import { blockNetwork } from './helpers.ts';
import { LANDS, MIGRATED_AT, MINT, POOL_ADDRESS, makeWorker, passingMarket, type Harness } from './worker-harness.ts';

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

const run = async (windowToMs: number | undefined, after?: (h: Harness, m: Awaited<ReturnType<typeof passingMarket>>, got: string[]) => Promise<void>, maxTails?: number, scenario?: typeof LANDS) => {
  const h = makeWorker({ strategy: { ...(windowToMs === undefined ? {} : { windowToMs }), ...(maxTails === undefined ? {} : { maxTails }) }, ...(scenario === undefined ? {} : { scenario }) });
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

  it('review B2: the let-go reaches the worker\'s fact producer, which drops the pool\'s trade stream and tombstones both', async () => {
    const seen: { ids: string[]; before: ReturnType<FactProducer['sizes']>; after: ReturnType<FactProducer['sizes']> }[] = [];
    const own = FactProducer.prototype.retire;
    const spy = vi.spyOn(FactProducer.prototype, 'retire').mockImplementation(function (this: FactProducer, ids: readonly string[]) {
      const before = this.sizes();
      own.call(this, ids);
      seen.push({ ids: [...ids], before, after: this.sizes() });
    });
    try {
      const h = makeWorker({ strategy: { windowToMs: 60_000 } });
      await h.worker.reconcile();
      // The pool's trade stream starts (as the pool watch opens it), so the producer holds state for the pool.
      const m = await passingMarket(h, { heldPoolFacts: true, before: { atMs: MIGRATED_AT + 1_000, run: (mk) => mk.offchain(`coverage:${STREAMS.trades(POOL_ADDRESS)}:start`, { fromSlot: h.worker.feed.openSlot, via: `logs:${POOL_ADDRESS}` }) } });
      await m.run(4_000, 100, () => m.pool());
      await m.run(10_000, 400, () => {
        m.slot();
        m.pool();
      });
      await h.worker.stop();
    } finally {
      spy.mockRestore();
    }
    const hit = seen.find((x) => x.ids.includes(MINT) && x.ids.includes(POOL_ADDRESS));
    expect(hit).toBeDefined();
    expect(hit!.before.streams).toBeGreaterThan(0);
    expect(hit!.after.streams).toBe(hit!.before.streams - 1);
    // Both ids are tombstoned in both lists, built state or not.
    expect([hit!.after.retiredPools, hit!.after.retiredMints]).toEqual([hit!.before.retiredPools + 2, hit!.before.retiredMints + 2]);
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

  it('review B1: an entry proposed on the window\'s last event and filled after the window ends (no tail to keep it) keeps its mint and pool', async () => {
    let status = '';
    let pool: unknown = null;
    const got = await run(FIRST_PASS + 1 - MIGRATED_AT, async (h, m) => {
      await m.run(5_000, 400, () => m.slot());
      const p = Object.values(h.worker.book.positions).find((x) => String(x.mint) === MINT);
      status = p?.status ?? 'none';
      pool = h.worker.strategy.watchedPools().get(POOL_ADDRESS) ?? null;
    }, 0);
    expect(status).not.toBe('none');
    expect(status).not.toBe('closed');
    // The strategy still knows the position's pool and watches it as held (its exit's pool facts, carry and triggers).
    expect(pool).toEqual(expect.objectContaining({ mint: MINT, held: true }));
    expect(got).not.toContain(MINT);
    expect(got).not.toContain(POOL_ADDRESS);
  });

  it('review B2: a position still open at the window end and past its tail\'s reach is never let go', async () => {
    let status = '';
    const got = await run(undefined, async (h, m) => {
      // Past the window end (four hours after migrating) and a further two hours: no pool read after the entry (live).
      h.timers.set(MIGRATED_AT + 4 * 3_600_000 + 121 * 60_000);
      await m.run(2_000, 400, () => m.slot());
      status = Object.values(h.worker.book.positions).find((x) => String(x.mint) === MINT)?.status ?? 'none';
    });
    expect(status).toBe('open');
    expect(got).not.toContain(MINT);
    expect(got).not.toContain(POOL_ADDRESS);
  });

  it('an entry that never lands lets its mint go once its seed ends without a fill (the window ended meanwhile)', async () => {
    const got = await run(FIRST_PASS + 1 - MIGRATED_AT, async (h, m) => {
      await m.run(120_000, 400, () => m.slot());
      expect(Object.values(h.worker.book.positions).filter((p) => String(p.mint) === MINT && p.status !== 'closed')).toEqual([]);
    }, 0, { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n } });
    expect(got).toEqual(expect.arrayContaining([MINT, POOL_ADDRESS]));
  });
});

