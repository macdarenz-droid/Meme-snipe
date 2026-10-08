// Ported from Snipe-solana card C03 (#6 @ 6ae4d62); runner moved from node:test to Vitest.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { DeadlineHeap, FifoList, type QueueEntry } from '../../src/m14/queue.ts';

interface E extends QueueEntry { id: number }
const entry = (id: number, deadline: number): E => ({ id, seq: id, deadline, list: null, prev: null, next: null, heapAt: -1 });
const ids = (l: FifoList<E>): number[] => {
  const out: number[] = [];
  for (let e = l.head; e !== null; e = e.next) out.push(e.id);
  return out;
};

describe('A-M14-02 waiting-call structures (review C03 R1)', () => {
  it('FIFO list: push at the tail, remove anywhere, ignore an entry it does not hold', () => {
    const l = new FifoList<E>();
    const other = new FifoList<E>();
    const es = [0, 1, 2, 3].map((i) => entry(i, 0));
    for (const e of es) l.push(e);
    assert.deepEqual(ids(l), [0, 1, 2, 3]);
    l.remove(es[1] as E);                                     // middle
    l.remove(es[0] as E);                                     // head
    l.remove(es[3] as E);                                     // tail
    assert.deepEqual(ids(l), [2]);
    other.remove(es[2] as E);                                 // not in `other`: no change
    l.remove(es[0] as E);                                     // already removed: no change
    assert.deepEqual(ids(l), [2]);
    l.remove(es[2] as E);
    assert.equal(l.head, null);
    l.push(es[3] as E);
    assert.deepEqual(ids(l), [3]);
  });

  it('deadline heap: always yields the earliest (deadline, seq) under random pushes and removals (property)', () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 20 }), fc.nat()), { maxLength: 200 }), (ops) => {
      const h = new DeadlineHeap<E>();
      const live: E[] = [];
      let id = 0;
      for (const [push, deadline, pick] of ops) {
        if (push || live.length === 0) {
          const e = entry(id++, deadline);
          h.push(e);
          live.push(e);
        } else {
          const [e] = live.splice(pick % live.length, 1) as [E];
          h.remove(e);
          h.remove(e);                                        // a second removal is a no-op
          assert.equal(e.heapAt, -1);
        }
        const want = [...live].sort((a, b) => a.deadline - b.deadline || a.seq - b.seq)[0];
        assert.equal(h.peek(), want);
      }
      h.remove(entry(999, 0));                                // never pushed: no change
      while (live.length > 0) {
        const top = h.peek() as E;
        h.remove(top);
        live.splice(live.indexOf(top), 1);
      }
      assert.equal(h.peek(), undefined);
    }), { numRuns: 300 });
  });
});
