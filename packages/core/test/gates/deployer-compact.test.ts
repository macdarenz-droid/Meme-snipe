// DEPLOYER-COMPACT: the deployer index holds its mints compact (`MintIndex`) and reads, saves and restores exactly as
// before: the fixture is today's saved shape and answers, written by the Map-of-Maps index this replaces.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeBase58 } from '../../src/chain/index.ts';
import { DeployerIndex, type DeployerIndexState } from '../../src/gates/index.ts';
import { MintIndex, RepeatedRowError } from '../../src/gates/mint-index.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'deployer-index-v1.json'), 'utf8'), (_k, v) => (v !== null && typeof v === 'object' && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v)) as {
  asOf: DeployerIndexState['asOf']; snapshot: DeployerIndexState; pruned: DeployerIndexState; facts: Record<string, unknown>; mintRows: unknown[];
};
const key = (...p: (string | number)[]) => encodeBase58(createHash('sha256').update(p.join('|')).digest());

describe('DEPLOYER-COMPACT', () => {
  // First in the file: a measurement after other tests in this worker read high (their garbage outlives a gc).
  it('holds a create in under 125 B (the Map-of-Maps index took about 316 B): measured on the heap, and counted from its arrays', () => {
    gc();
    const before = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    const m = new MintIndex();
    const n = 100_000;
    for (let i = 0; i < n; i++) m.add(key('c', i % 80_000), key('m', i), 1.79e12 + i * 800);
    gc();
    const heap = (process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - before) / n;
    expect(m.size).toBe(n);
    // Its arrays at their growth slack; after a prune (as every hour) they are sized exactly.
    expect(m.heldBytes() / n).toBeLessThan(125);
    m.prune(0);
    expect(m.heldBytes() / n).toBeLessThan(115);
    // The heap figure runs high when this worker's earlier garbage outlives the collection, so it is bounded loosely.
    expect(heap).toBeLessThan(600);
  }, 60_000);

  it('a saved index of today\'s shape restores to the same answers, saves back the same and prunes the same', () => {
    const d = DeployerIndex.restore(FIXTURE.snapshot);
    expect(d.snapshot(FIXTURE.asOf)).toEqual(FIXTURE.snapshot);
    expect(d.snapshot(FIXTURE.asOf, FIXTURE.pruned.first!.receivedAt)).toEqual(FIXTURE.pruned);
    for (const [creator, fact] of Object.entries(FIXTURE.facts)) expect(d.factFor(creator, FIXTURE.asOf, 0), creator).toEqual(fact);
    expect([...d.mintRows(FIXTURE.asOf.receivedAt - 50 * 60_000)]).toEqual(FIXTURE.mintRows);
    // Restored from streamed rows (WORKER-GROW), the same.
    const streamed = DeployerIndex.restore({ ...FIXTURE.snapshot, mints: [] }, FIXTURE.snapshot.mints);
    expect(streamed.snapshot(FIXTURE.asOf)).toEqual(FIXTURE.snapshot);
    // A prune in memory leaves what the pruned save holds.
    d.prune(FIXTURE.pruned.first!.receivedAt);
    expect(d.snapshot(FIXTURE.asOf).mints).toEqual(FIXTURE.pruned.mints);
  });

  it('a bad saved file is refused whole (fail closed): a bad row, a bad entry, a bad time, a future entry, a repeated mint or creator row', () => {
    const s = FIXTURE.snapshot;
    const row = s.mints[0]!;
    const entry = row[1][0]!;
    for (const mints of [[['creator', 'not-a-list']], [[row[0], [['m']]]], [[row[0], [['m', 1.5]]]], [[row[0], [['m', FIXTURE.asOf.receivedAt + 1]]]],
      [[row[0], [entry, entry]]], [row, row], [[row[0], [entry]], [row[0], [[`${entry[0]}x`, entry[1]]]]]]) {
      expect(() => DeployerIndex.restore({ ...s, mints: mints as never })).toThrow(RangeError);
    }
  });

  it('MintIndex keeps each creator\'s mints in order, the earliest time of a repeat, canonical and text mints alike', () => {
    const m = new MintIndex();
    const a = key('a');
    m.add(a, key('m1'), 5);
    m.add(a, 'TextMint', 7);
    m.add(a, key('m1'), 3);
    m.add('TextCreator', key('m2'), 9);
    expect([...m.entries(a)]).toEqual([[key('m1'), 3], ['TextMint', 7]]);
    expect([...m.entries('TextCreator')]).toEqual([[key('m2'), 9]]);
    expect([...m.entries(key('nobody'))]).toEqual([]);
    expect(new Set(m.creators())).toEqual(new Set([a, 'TextCreator']));
    m.prune(6);
    expect([...m.entries(a)]).toEqual([['TextMint', 7]]);
    expect(m.size).toBe(2);
  });

  it('setRow on a creator already held is refused before it adds anything: size and entries unchanged (facts review note b)', () => {
    const m = new MintIndex();
    const a = key('a');
    m.setRow(a, [[key('m1'), 1]]);
    expect(() => m.setRow(a, [[key('m2'), 2], [key('m3'), 3]])).toThrow(RepeatedRowError);
    expect(m.size).toBe(1);
    expect([...m.entries(a)]).toEqual([[key('m1'), 1]]);
    m.prune(0);
    expect(m.size).toBe(1);
  });

  it('the same mint under two creators is two entries, as in the Map-of-Maps index', () => {
    const m = new MintIndex();
    m.add(key('a'), key('shared'), 5);
    m.add(key('b'), key('own'), 1);
    m.add(key('b'), key('shared'), 9);
    expect([...m.entries(key('a'))]).toEqual([[key('shared'), 5]]);
    expect([...m.entries(key('b'))]).toEqual([[key('own'), 1], [key('shared'), 9]]);
    expect(m.size).toBe(3);
  });

  it('creators whose tags collide are kept apart by their bytes', () => {
    const m = new MintIndex();
    // Many creators: some share a 30-bit tag; every one reads back only its own mints.
    const creators = Array.from({ length: 5_000 }, (_, i) => key('cc', i));
    creators.forEach((c, i) => m.add(c, key('mm', i), i));
    creators.forEach((c, i) => expect([...m.entries(c)]).toEqual([[key('mm', i), i]]));
  });

  // Persist review: no hourly prune or boot restore far slower than the Map-of-Maps index, and nothing that grows with
  // the square of one creator's mints. Timed against the replaced layout built here from the same rows.
  const best = (f: () => void): number => {
    let ms = Number.POSITIVE_INFINITY;
    for (let k = 0; k < 2; k++) {
      const t = performance.now();
      f();
      ms = Math.min(ms, performance.now() - t);
    }
    return ms;
  };

  it('restore and prune at the full 1× window (540,000 creates by 400,000 creators) take at most twice the Map-of-Maps index', () => {
    const N = 540_000;
    const C = 400_000;
    const T0 = 1.79e12;
    const creators = Array.from({ length: C }, (_, i) => key('c', i));
    const rows = new Map<string, [string, number][]>();
    for (let i = 0; i < N; i++) {
      const c = creators[i % C]!;
      let r = rows.get(c);
      if (r === undefined) rows.set(c, (r = []));
      r.push([key('m', i), T0 + i * 1_600]);
    }
    const list = [...rows].sort(([x], [y]) => (x < y ? -1 : 1));
    const line = T0 + (N * 1_600) / 2;
    const asOf = { slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T0 + N * 1_600 };
    const state = { asOf, first: null, last: null, seeded: false, mints: list, rugs: [], unjudged: [], createVias: [], lost: [] } as unknown as DeployerIndexState;
    // The replaced restore of the mint table, as it was written (DeployerIndex.restore's `pairs` with its `ms` check).
    const oldBuild = (): Map<string, Map<string, number>> => {
      const into = new Map<string, Map<string, number>>();
      const ms = (v: unknown): number => {
        if (!Number.isSafeInteger(v)) throw new RangeError('bad time');
        return v as number;
      };
      const pairs = <V>(rows: unknown, to: Map<string, Map<string, V>>, value: (v: unknown) => V, at: (v: V) => number): void => {
        if (!Array.isArray(rows) && !(typeof rows === 'object' && rows !== null && Symbol.iterator in rows)) throw new RangeError('bad table');
        for (const row of rows as Iterable<unknown>) {
          if (!Array.isArray(row) || typeof row[0] !== 'string' || !Array.isArray(row[1])) throw new RangeError('bad row');
          const m = new Map<string, V>();
          for (const e of row[1] as unknown[]) {
            if (!Array.isArray(e) || typeof e[0] !== 'string') throw new RangeError('bad entry');
            const v = value(e[1]);
            if (at(v) > asOf.receivedAt) throw new RangeError('an entry is dated after the snapshot moment');
            m.set(e[0], v);
          }
          to.set(row[0], m);
        }
      };
      pairs(list, into, ms, (t) => t);
      return into;
    };
    const oldPruneOf = (m: Map<string, Map<string, number>>): void => {
      for (const [c, inner] of m) {
        for (const [k, v] of inner) if (v < line) inner.delete(k);
        if (inner.size === 0) m.delete(c);
      }
    };
    // Interleaved, best of three each, so a busy runner slows both sides alike.
    let restoreOld = Number.POSITIVE_INFINITY;
    let restoreNew = Number.POSITIVE_INFINITY;
    let pruneOld = Number.POSITIVE_INFINITY;
    let pruneNew = Number.POSITIVE_INFINITY;
    let d = DeployerIndex.restore(state);
    for (let k = 0; k < 3; k++) {
      let t = performance.now();
      const m = oldBuild();
      restoreOld = Math.min(restoreOld, performance.now() - t);
      // Each prune timed after a collection: the collector's work on the restores' garbage is not the prune's.
      gc();
      t = performance.now();
      oldPruneOf(m);
      pruneOld = Math.min(pruneOld, performance.now() - t);
      t = performance.now();
      d = DeployerIndex.restore(state);
      restoreNew = Math.min(restoreNew, performance.now() - t);
      gc();
      t = performance.now();
      d.prune(line);
      pruneNew = Math.min(pruneNew, performance.now() - t);
    }
    process.stderr.write(`DEPLOYER-COMPACT timing: restore ${restoreNew.toFixed(0)} ms (Map-of-Maps ${restoreOld.toFixed(0)}), prune ${pruneNew.toFixed(0)} ms (${pruneOld.toFixed(0)})\n`);
    expect([...d.mintRows()].reduce((n, [, r]) => n + r.length, 0)).toBe(N / 2);
    expect(restoreNew).toBeLessThanOrEqual(2 * restoreOld);
    expect(pruneNew).toBeLessThanOrEqual(2 * pruneOld);
  }, 240_000);

  it('one creator with 50,000 mints: add, restore and prune each under 500 ms (no scan of the creator\'s list)', () => {
    const c = key('big');
    const mints = Array.from({ length: 50_000 }, (_, i) => [key('bm', i), i] as const);
    let m = new MintIndex();
    const add = best(() => {
      m = new MintIndex();
      for (const [x, t] of mints) m.add(c, x, t);
    });
    const restore = best(() => {
      m = new MintIndex();
      m.setRow(c, mints);
    });
    const prune = best(() => m.prune(25_000));
    expect([...m.entries(c)].length).toBe(25_000);
    expect(Math.max(add, restore, prune)).toBeLessThan(500);
  }, 60_000);
});

