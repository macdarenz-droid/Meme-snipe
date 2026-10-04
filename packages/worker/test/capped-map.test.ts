// The worker's capped maps (create signatures, token symbols) forget the oldest key in O(1), however many keys were
// forgotten before (review of #179: `keys().next()` after many deletes walks V8's deleted slots).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CappedMap } from '../src/run/capped-map.ts';

describe('CappedMap', () => {
  it('keeps the newest `max` keys, forgets the oldest-inserted first, and an update keeps its place', () => {
    const m = new CappedMap<string, number>(3);
    m.set('a', 1).set('b', 2).set('c', 3);
    m.set('a', 10); // an update: 'a' stays the oldest
    m.set('d', 4);
    expect([m.size, m.has('a'), m.get('b'), m.get('c'), m.get('d')]).toEqual([3, false, 2, 3, 4]);
    m.set('e', 5).set('f', 6);
    expect([m.has('b'), m.has('c'), m.get('d'), m.get('e'), m.get('f')]).toEqual([false, false, 4, 5, 6]);
    expect(() => new CappedMap(0)).toThrow(RangeError);
  });

  it('matches a Map trimmed oldest-first on a long mixed run', () => {
    const m = new CappedMap<string, number>(50);
    const ref = new Map<string, number>();
    for (let i = 0; i < 5_000; i++) {
      const k = `k${(i * 7919) % 400}`;
      m.set(k, i);
      ref.set(k, i);
      if (ref.size > 50) ref.delete(ref.keys().next().value!);
      if (i % 97 === 0) expect([...ref].every(([key, v]) => m.get(key) === v) && m.size === ref.size).toBe(true);
    }
  });

  it('eviction cost does not grow with the keys forgotten: 600,000 inserts at a cap of 50,000 well under the old 17 s', () => {
    const m = new CappedMap<string, number>(50_000);
    const t = performance.now();
    for (let i = 0; i < 600_000; i++) m.set(`k${i}`, i);
    expect(m.size).toBe(50_000);
    expect(m.has('k549999')).toBe(false);
    expect(m.get('k599999')).toBe(599_999);
    expect(performance.now() - t).toBeLessThan(5_000);
  });
});

describe('no oldest-key eviction by iteration in the worker (guard)', () => {
  it('worker.ts trims no map with keys().next()', () => {
    expect(readFileSync(join(import.meta.dirname, '..', 'src', 'run', 'worker.ts'), 'utf8')).not.toMatch(/keys\(\)\.next\(\)/);
  });
});
