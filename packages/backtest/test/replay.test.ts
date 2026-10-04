import { describe, expect, test } from 'vitest';
import { type FeedEvent, type Moment } from '../../core/src/engine/index.ts';
import { BLOCK_TX, LANDING_TX } from '../src/sim/market.ts';
import { StreamReplay } from '../src/sim/replay.ts';
import { parseCsv } from '../src/dataset/csv.ts';

const m = (slot: number, txIndex: number, ixIndex = 0): Moment => ({ slot: BigInt(slot), txIndex, ixIndex, receivedAt: slot * 400 });

describe('StreamReplay', () => {
  const rows = [m(1, 0), m(1, 3), m(1, BLOCK_TX), m(2, 0), m(2, 7), m(2, BLOCK_TX), m(3, 0)];
  const setup = () => {
    let i = 0;
    const log: string[] = [];
    const r = new StreamReplay<Moment>({ next: () => (i < rows.length ? { moment: rows[i]!, item: rows[i++]! } : null) },
      (x) => [{ kind: 'market', id: `r:${x.slot}:${x.txIndex}`, moment: x, key: 'k', value: null }]);
    const drain = () => {
      for (let e = r.feed.next(); e !== null; e = r.feed.next()) log.push(e.id);
    };
    return { r, log, drain };
  };

  test('a landing hook in a slot runs after every transaction and the block of that slot, before the next slot', () => {
    const { r, log, drain } = setup();
    r.hook({ id: 'land', moment: m(2, LANDING_TX), run: () => log.push('LAND') });
    for (let s = r.advance(); s !== 'done'; s = r.advance()) if (s === 'events') drain();
    expect(log).toEqual(['r:1:0', 'r:1:3', `r:1:${BLOCK_TX}`, 'r:2:0', 'r:2:7', `r:2:${BLOCK_TX}`, 'LAND', 'r:3:0']);
  });

  test('the feed never releases a row or report before the clock reaches it', () => {
    const { r } = setup();
    expect(r.feed.next()).toBeNull();
    r.advance();
    expect(r.feed.next()?.id).toBe('r:1:0');
    expect(r.feed.next()).toBeNull();
  });

  test('world reports are ordered with rows; scheduling at or before now is refused', () => {
    const { r, log, drain } = setup();
    r.advance();
    drain();
    const w = (id: string, at: Moment): FeedEvent => ({ kind: 'world', id, moment: at, event: { type: 'tick', blockHeight: 1n } });
    r.schedule(w('w:b', m(2, 5)));
    r.schedule(w('w:a', m(2, 5)));
    expect(() => r.schedule(w('w:c', m(1, 0)))).toThrow(/after now/);
    expect(() => r.schedule(w('w:a', m(3, 5)))).toThrow(/duplicate/);
    for (let s = r.advance(); s !== 'done'; s = r.advance()) if (s === 'events') drain();
    expect(log.slice(3, 7)).toEqual(['r:2:0', 'w:a', 'w:b', 'r:2:7']);
  });

  test('released events are frozen', () => {
    const { r } = setup();
    r.advance();
    const e = r.feed.next()!;
    expect(Object.isFrozen(e)).toBe(true);
  });
});

describe('CSV', () => {
  test('quoted fields with commas, quotes and newlines (Go encoding/csv)', () => {
    const out: string[][] = [];
    parseCsv('a,b,c\n1,"x, ""y""\nz",3\r\n4,,6\n', (f) => out.push(f));
    expect(out).toEqual([['a', 'b', 'c'], ['1', 'x, "y"\nz', '3'], ['4', '', '6']]);
  });
});

describe('regime boundaries', () => {
  test('the engine sees a regime event at the first block at or after the boundary slot, never before (released after the observation delay)', async () => {
    const { Market } = await import('../src/sim/market.ts');
    const hooks: { slot: bigint; run: () => void }[] = [];
    const scheduled: { key: string; slot: bigint }[] = [];
    const market = new Market({ heartbeatBlocks: 1_000, discoveryLag: () => 1, active: () => false, observe: { slots: 2, providerMs: 0, blackouts: [], seed: 's' },
      volumeWindowSlots: 150, hook: (h) => hooks.push({ slot: h.moment.slot, run: h.run }), hasRows: () => true,
      schedule: (x) => { if (x.kind === 'market') scheduled.push({ key: x.key, slot: x.moment.slot }); }, regimeBoundaries: [{ slot: 12n, label: 'pump-2026-10-02' }] });
    const at = (slot: number) => {
      expect(market.release({ kind: 'block', slot: BigInt(slot), blockTime: slot, parentSlot: BigInt(slot - 1) })).toEqual([]);
      // Driver work due at this block runs after it.
      for (const h of hooks.splice(0)) if (h.slot === BigInt(slot)) h.run(); else hooks.push(h);
      return scheduled.splice(0);
    };
    expect(at(10)).toEqual([]);
    expect(at(11)).toEqual([]);
    expect(at(13)).toEqual([]);
    expect(market.regime).toBe('pump-2026-10-02');
    expect(at(14)).toEqual([]);
    expect(at(15)).toEqual([{ key: 'regime', slot: 15n }]);
  });
});

describe('projector facts through the observation delay (supervisor ruling)', () => {
  test('facts, checks and landings are seen after the delay with their chain slots unchanged, the observed tip first', async () => {
    const { Market, OBSERVED_TIP_KEY } = await import('../src/sim/market.ts');
    const hooks: { slot: bigint; run: () => void }[] = [];
    const scheduled: { key: string; slot: bigint; value: unknown }[] = [];
    // A stand-in projector: at each block, one chain-state fact as of that block and one check.
    const facts = {
      observe: (row: { slot: bigint }, m: { slot: bigint; txIndex: number; ixIndex: number; receivedAt: number }) => [
        { kind: 'market' as const, id: `f:${row.slot}`, moment: m, key: 'holders:m', value: { obs: { slot: row.slot } } },
        { kind: 'market' as const, id: `f:${row.slot}:~check`, moment: m, key: 'check:m', value: { n: Number(row.slot) } },
      ],
    } as unknown as NonNullable<ConstructorParameters<typeof Market>[0]['facts']>;
    const market = new Market({ heartbeatBlocks: 1_000, discoveryLag: () => 1, active: () => false, observe: { slots: 3, providerMs: 400, blackouts: [], seed: 's' },
      volumeWindowSlots: 150, hook: (h) => hooks.push({ slot: h.moment.slot, run: h.run }), hasRows: () => true,
      schedule: (x) => { if (x.kind === 'market') scheduled.push({ key: x.key, slot: x.moment.slot, value: x.value }); }, facts });
    // Driver work runs in moment order: hooks of earlier slots before the row, hooks of its own slot after it.
    const runHooks = (upTo: bigint, inclusive: boolean) => {
      for (let h = hooks.findIndex((x) => (inclusive ? x.slot <= upTo : x.slot < upTo)); h >= 0; h = hooks.findIndex((x) => (inclusive ? x.slot <= upTo : x.slot < upTo))) hooks.splice(h, 1)[0]!.run();
    };
    const at = (slot: number) => {
      runHooks(BigInt(slot), false);
      // Nothing from the projector at the row's own moment.
      expect(market.release({ kind: 'block', slot: BigInt(slot), blockTime: slot, parentSlot: BigInt(slot - 1) })).toEqual([]);
      runHooks(BigInt(slot), true);
      return scheduled.splice(0);
    };
    expect(at(10)).toEqual([]);
    expect(at(12)).toEqual([]);
    // Due at 13; the next block row is 20: released there, re-stamped only in the engine's order.
    const out = at(20);
    expect(out.map((x) => [x.key, x.slot])).toEqual([[OBSERVED_TIP_KEY, 20n], ['holders:m', 20n], ['check:m', 20n], [OBSERVED_TIP_KEY, 20n], ['holders:m', 20n], ['check:m', 20n]]);
    // The tip is the newest chain slot seen when each event arrives (10, then 12; never the release block's 20, nor a
    // later slot of the same batch), so a uniform delay makes nothing stale.
    expect([out[0]!.value, out[3]!.value]).toEqual([{ slot: 10n }, { slot: 12n }]);
    // Values go as built: the chain slots stay 10 and 12, and nothing is added.
    expect([out[1], out[2], out[4], out[5]].map((x) => x!.value)).toEqual([{ obs: { slot: 10n } }, { n: 10 }, { obs: { slot: 12n } }, { n: 12 }]);
  });
});

describe('market volume per window (BT-1c A1)', () => {
  test('a window\'s volume reads the same at its boundary and long after, so the network chain never walks over zeros', async () => {
    const { Market } = await import('../src/sim/market.ts');
    const { syntheticRows } = await import('./synthetic.ts');
    const market = new Market({ heartbeatBlocks: 1_000, discoveryLag: () => 1, active: () => false, observe: null, volumeWindowSlots: 150, hook: () => {}, hasRows: () => true, schedule: () => {} });
    const atBoundary = new Map<bigint, bigint>();
    for (const r of syntheticRows({ mints: 4, slots: 2.5 * 3600 })) {
      const win = r.slot / 150n;
      if (!atBoundary.has(win)) atBoundary.set(win, market.volumeBefore(win));
      market.release(r);
    }
    expect([...atBoundary.values()].filter((v) => v > 0n).length).toBeGreaterThan(10);
    for (const [win, v] of atBoundary) expect(market.volumeBefore(win)).toBe(v);
  });
});

describe('registry remote pin (BT-1d)', () => {
  test('only the project\'s GitHub repository, in https or ssh form', async () => {
    const { isRepoUrl } = await import('../src/registry-git.ts');
    const repo = 'macdarenz-droid/Meme-snipe';
    for (const u of ['https://github.com/macdarenz-droid/Meme-snipe', 'https://github.com/macdarenz-droid/Meme-snipe.git', 'https://x@github.com/macdarenz-droid/meme-snipe/', 'git@github.com:macdarenz-droid/Meme-snipe.git', 'ssh://git@github.com/macdarenz-droid/Meme-snipe']) expect(isRepoUrl(u, repo)).toBe(true);
    for (const u of ['', '/tmp/origin.git', 'https://github.com/other/Meme-snipe', 'https://github.com/macdarenz-droid/Meme-snipe-fork', 'https://evil.com/macdarenz-droid/Meme-snipe', 'https://github.com.evil.com/macdarenz-droid/Meme-snipe']) expect(isRepoUrl(u, repo)).toBe(false);
  });
});
