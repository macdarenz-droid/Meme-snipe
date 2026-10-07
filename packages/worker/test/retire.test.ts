// OOM-MINT: the strategy lets a mint and its pool go (`Strategy.retired`) only when it is no candidate, holds no exit plan
// and has no tail; the engine then forgets their keys and the producer their state.
import { describe, expect, it, vi } from 'vitest';
import { FactProducer, STREAMS } from '../../core/src/facts/index.ts';
import { blockNetwork } from './helpers.ts';
import { LANDS, MIGRATED_AT, MINT, POOL_ADDRESS, makeWorker, passingMarket, until, type Harness } from './worker-harness.ts';
import { isTerminal } from '../../core/src/lifecycle/index.ts';
import type { Fill } from '../../core/src/domain/index.ts';
import { seedsFile } from '../src/run/state.ts';
import { Market } from './worker-harness.ts';
import { passingFacts } from '../../core/test/gates/world.ts';
import { migrationKey } from '../../core/src/gates/index.ts';

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

  describe('facts review B3: a dropped entry whose attempts may still land', () => {
    // Every attempt never reaches a block, so the entry ends unfilled after its window (ending 1 ms after the first pass).
    const scenario = { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 1_000_000n };
    const setup = async () => {
      // No tail (maxTails 0), so only the guards under test hold the mint.
      const h = makeWorker({ scenario, strategy: { windowToMs: FIRST_PASS + 1 - MIGRATED_AT, maxTails: 0 } });
      const got = watch(h);
      await h.worker.reconcile();
      const m = await passingMarket(h, { heldPoolFacts: true });
      await m.run(4_000, 100, () => m.pool());
      const ended = () => Object.values(h.worker.book.intents).find((i) => i.intent.purpose === 'entry' && isTerminal(i) && i.fills.length === 0);
      expect(await until(m, 120_000, () => ended() !== undefined, () => {
        m.slot();
        m.pool();
      })).toBe(true);
      return { h, m, got, i: ended()! };
    };

    it('the mint is not let go while an attempt may land; an orphan fill then opens a position on a coin still watched, whose swaps still reach it', async () => {
      const { h, m, got, i } = await setup();
      await m.run(2_000, 400, () => { m.slot(); m.pool(); });
      expect(got).not.toContain(MINT);
      const fill = { intentId: i.intent.id, signature: i.attempts[0]!.signature, slot: 1n, commitment: 'confirmed', tokens: 1_000_000n, sol: 20_000_000n, fees: 0n } as Fill;
      h.worker.feed.ingest('worker', { type: 'world', event: { type: 'orphan_fill', fill } }, { receivedAt: m.now });
      await m.run(2_000, 400, () => { m.slot(); m.pool(); });
      const pid = `${i.intent.positionId}.o1`;
      expect(h.worker.book.positions[pid]).toBeDefined();
      // Past every attempt's validity and the margin: the open position alone holds the mint (the book-position guard).
      await m.run(5 * 60_000, 400, () => { m.slot(); m.pool(); });
      expect(h.worker.book.positions[pid]!.status).not.toBe('closed');
      expect(got).not.toContain(MINT);
      expect([...h.worker.strategy.watchedPools().keys()]).toContain(POOL_ADDRESS);
      // A swap on its pool still reaches the mint (fee context and the deployer and flow triggers read it).
      m.swap('SellEvent', 'someone', 1_000n, 1_000n);
      await m.run(800, 100, () => m.slot());
      expect(h.worker.strategy.observedFees(MINT)).toBeDefined();
      await h.worker.stop();
    }, 120_000);

    it('a landing found but not yet booked (an orphan) holds the mint past every attempt\'s validity', async () => {
      const { h, m, got, i } = await setup();
      // A status read finds the ended entry's attempt landed: the book records an orphan; no fill for it ever comes.
      h.worker.feed.ingest('worker', { type: 'world', event: { type: 'intent', intentId: i.intent.id, event: { type: 'status', signature: i.attempts[0]!.signature, result: 'succeeded', commitment: 'finalized', blockHeight: i.attempts[0]!.lastValidBlockHeight, searchedHistory: true } } }, { receivedAt: m.now });
      await m.run(1_000, 400, () => { m.slot(); m.pool(); });
      expect(Object.keys(h.worker.book.orphans)).toHaveLength(1);
      await m.run(5 * 60_000, 400, () => { m.slot(); m.pool(); });
      expect(Object.keys(h.worker.book.orphans)).toHaveLength(1);
      expect(got).not.toContain(MINT);
      await h.worker.stop();
    }, 120_000);

    it('after a restart, before the first slot, an attempt\'s age is unknown: the mint is held', async () => {
      // The seed as saved while the entry was in flight, put back after the stop: the restart drops it at once.
      const h = makeWorker({ scenario, strategy: { windowToMs: FIRST_PASS + 1 - MIGRATED_AT, maxTails: 0 } });
      await h.worker.reconcile();
      const m = await passingMarket(h, { heldPoolFacts: true });
      let saved: Record<string, unknown> = {};
      await m.run(4_000, 100, () => {
        m.pool();
        const now = seedsFile(h.stateDir).read({}) as Record<string, unknown>;
        if (Object.keys(now).length > 0) saved = now;
      });
      expect(await until(m, 120_000, () => Object.values(h.worker.book.intents).some((x) => x.intent.purpose === 'entry' && isTerminal(x) && x.fills.length === 0), () => { m.slot(); m.pool(); })).toBe(true);
      expect(Object.keys(saved)).toHaveLength(1);
      await h.worker.stop();
      seedsFile(h.stateDir).write(saved as never);
      const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario, strategy: { windowToMs: FIRST_PASS + 1 - MIGRATED_AT, maxTails: 0 } });
      const got = watch(h2);
      expect(await h2.worker.reconcile()).toEqual({ ok: true });
      const m2 = new Market(h2);
      // No slot notice: only off-chain prices move the engine.
      await m2.run(3_000, 100, () => m2.solPrice());
      expect(Object.keys(seedsFile(h.stateDir).read({}))).toEqual([]);
      expect(got).not.toContain(MINT);
      await h2.worker.stop();
    }, 120_000);

    it('with no landing, the mint is let go once every attempt is past its validity and the margin', async () => {
      const { h, m, got } = await setup();
      await m.run(5 * 60_000, 400, () => { m.slot(); m.pool(); });
      expect(got).toEqual(expect.arrayContaining([MINT, POOL_ADDRESS]));
      await h.worker.stop();
    }, 120_000);
  });
});

describe('MEM-FIXES: a fact released for a let-go mint (#letGoLate)', () => {
  it('a let-go mint brought back as a candidate by a late migration is not let go again: its next pool fact stays and poolOf survives', async () => {
    let after: { got: string[]; watched: boolean; pool: unknown; seen: string[] } | null = null;
    await run(60_000, async (h, m, got) => {
      expect(got).toContain(MINT);
      // A late migration fact for the same mint, fresh: it is a candidate again.
      const v = passingFacts().get(migrationKey(MINT))!.value as { obs: Record<string, unknown> } & Record<string, unknown>;
      m.fact(migrationKey(MINT), { ...v, obs: { ...v.obs, slot: h.worker.feed.openSlot - 1n, receivedAt: m.now - 50 }, graduatedAtMs: m.now - 2_000, migratedAtMs: m.now - 1_000 });
      await m.run(2_000, 100, () => m.slot());
      const watched = h.worker.strategy.watched().has(MINT);
      // From here (a candidate again), its next pool facts (within LATE_LET_GO_MS of the let-go) are kept.
      const from = got.length;
      await m.run(3_000, 100, () => {
        m.slot();
        m.pool();
      });
      after = { got: got.slice(from), watched, pool: h.worker.poolOf(MINT), seen: [...got] };
    });
    expect(after!.watched).toBe(true);
    expect(after!.got).not.toContain(MINT);
    expect(after!.pool).not.toBeNull();
  });

  it('without a candidate, the pool fact released after the let-go is let go again (control)', async () => {
    let after: { got: string[]; pool: unknown } | null = null;
    await run(60_000, async (h, m, got) => {
      const from = got.length;
      await m.run(3_000, 100, () => {
        m.slot();
        m.pool();
      });
      after = { got: got.slice(from), pool: h.worker.poolOf(MINT) };
    });
    expect(after!.got).toContain(MINT);
    expect(after!.pool).toBeNull();
  });
});
