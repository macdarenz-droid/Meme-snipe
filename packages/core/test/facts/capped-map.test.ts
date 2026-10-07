// POOL-FIRST-READ: the capped map (moved from the worker) gains `delete` and an eviction hook; the cap holds whatever
// is deleted, and a deleted key frees its place once the ring comes round to it.
import { describe, expect, it } from 'vitest';
import { CappedMap } from '../../src/facts/index.ts';

describe('CappedMap delete and eviction hook', () => {
  it('a deleted key frees its place; set again, it is the newest', () => {
    const gone: string[] = [];
    const m = new CappedMap<string, number>(3, (k) => gone.push(k));
    m.set('a', 1).set('b', 2).set('c', 3);
    expect(m.delete('a')).toBe(true);
    expect(m.delete('a')).toBe(false);
    m.set('d', 4); // takes a's freed place: nothing evicted
    expect([m.size, gone]).toEqual([3, []]);
    m.set('a', 5); // a is new now: b, the oldest, goes
    expect([m.has('b'), m.get('a'), gone]).toEqual([false, 5, ['b']]);
    m.set('e', 6);
    expect([m.has('c'), gone]).toEqual([false, ['b', 'c']]);
    expect([m.get('d'), m.get('a'), m.get('e'), m.size]).toEqual([4, 5, 6, 3]);
  });

  it('on a long run of sets and deletes it never exceeds its cap and keeps the newest keys a trimmed Map keeps', () => {
    const m = new CappedMap<string, number>(40);
    const ref = new Map<string, number>();
    for (let i = 0; i < 20_000; i++) {
      const k = `k${(i * 7919) % 300}`;
      if (i % 3 === 0) {
        expect(m.delete(k)).toBe(ref.delete(k));
      } else {
        m.set(k, i);
        ref.set(k, i);
        while (ref.size > 40) ref.delete(ref.keys().next().value!);
      }
      expect(m.size).toBeLessThanOrEqual(40);
      for (const [key, v] of [...ref].slice(-10)) expect(m.get(key)).toBe(v);
    }
  });
});
