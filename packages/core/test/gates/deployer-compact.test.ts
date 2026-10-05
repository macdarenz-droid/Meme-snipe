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
import { MintIndex } from '../../src/gates/mint-index.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'deployer-index-v1.json'), 'utf8'), (_k, v) => (v !== null && typeof v === 'object' && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v)) as {
  asOf: DeployerIndexState['asOf']; snapshot: DeployerIndexState; pruned: DeployerIndexState; facts: Record<string, unknown>; mintRows: unknown[];
};
const key = (...p: (string | number)[]) => encodeBase58(createHash('sha256').update(p.join('|')).digest());

describe('DEPLOYER-COMPACT', () => {
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

  it('a bad saved file is refused whole (fail closed): a bad row, a bad entry, a bad time, a future entry', () => {
    const s = FIXTURE.snapshot;
    const row = s.mints[0]!;
    for (const mints of [[['creator', 'not-a-list']], [[row[0], [['m']]]], [[row[0], [['m', 1.5]]]], [[row[0], [['m', FIXTURE.asOf.receivedAt + 1]]]]]) {
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

  it('creators whose tags collide are kept apart by their bytes', () => {
    const m = new MintIndex();
    // Many creators: some share a 30-bit tag; every one reads back only its own mints.
    const creators = Array.from({ length: 5_000 }, (_, i) => key('cc', i));
    creators.forEach((c, i) => m.add(c, key('mm', i), i));
    creators.forEach((c, i) => expect([...m.entries(c)]).toEqual([[key('mm', i), i]]));
  });

  it('holds a create in under 125 B (the Map-of-Maps index took about 316 B)', () => {
    gc();
    const before = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    const m = new MintIndex();
    const n = 100_000;
    for (let i = 0; i < n; i++) m.add(key('c', i % 80_000), key('m', i), 1.79e12 + i * 800);
    gc();
    const per = (process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - before) / n;
    expect(m.size).toBe(n);
    expect(per).toBeLessThan(125);
  }, 60_000);
});
