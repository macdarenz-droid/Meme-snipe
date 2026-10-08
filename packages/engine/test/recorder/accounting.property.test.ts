// Rulings 25 and 26 (docs/reviews/Z04.md): every counted poll ends in exactly one (pool, minute) poll_counts record,
// through random polls, failed polls, unwatches, ticks and forward clock steps on tick() and unwatch(). Fixed seed so
// a run is reproducible for the exact commit it ran on.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { UnixMs } from '@bot/types';
import { RecorderQueue, type EncodedRecord } from '../../src/index.ts';
import { SEG, T0, payloadOf, snap } from './helpers.ts';

const ms = (n: number): UnixMs => n as UnixMs;
const params = { seed: 20261008, numRuns: 300 };

const op = fc.oneof(
  fc.record({ kind: fc.constant('poll' as const), pool: fc.integer({ min: 0, max: 4 }), state: fc.integer({ min: 0, max: 2 }), back: fc.integer({ min: 0, max: 90_000 }), position: fc.boolean() }),
  fc.record({ kind: fc.constant('fail' as const), pool: fc.integer({ min: 0, max: 4 }), position: fc.boolean() }),
  fc.record({ kind: fc.constant('unwatch' as const), pool: fc.integer({ min: 0, max: 4 }), ahead: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 86_400_000 })) }),
  fc.record({ kind: fc.constant('tick' as const), ahead: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 7_200_000 })) }),
  fc.record({ kind: fc.constant('advance' as const), by: fc.integer({ min: 1, max: 150_000 }) }),
);

describe('poll accounting across clock steps and unwatches (rulings 25 and 26)', () => {
  it('the polls counted equal the polls appended, and no (pool, minute) record appears twice', () => {
    fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 300 }), (ops) => {
      const q = new RecorderQueue({ config: { maxWatchedPools: 3 } });
      const out: EncodedRecord[] = [];
      let clock: number = T0;
      let polls = 0;
      let failed = 0;
      for (const o of ops) {
        if (o.kind === 'poll') {
          // recvMs up to 90 s behind the clock: late polls into minutes already written.
          const stream = o.position ? 'pool_snapshot_position' : 'pool_snapshot';
          const r = q.append(snap(`p${o.pool}`, o.state, clock - o.back, stream, o.position ? 'position' : 'normal'));
          if (typeof r !== 'object') polls++;
        } else if (o.kind === 'fail') {
          if (q.notePollFailed(`p${o.pool}`, 'normal', ms(clock), o.position)) failed++;
        } else if (o.kind === 'unwatch') {
          q.unwatch(`p${o.pool}`, ms(clock + o.ahead));
        } else if (o.kind === 'tick') {
          q.tick(ms(clock + o.ahead));
        } else {
          clock += o.by;
        }
        out.push(...q.take(Number.MAX_SAFE_INTEGER, SEG));
      }
      // Close out: the feed reaches a later minute, every pool is unwatched, and a last tick.
      clock += 120_000;
      q.append({ stream: 'decision', recvMs: ms(clock), slot: null, commitment: null, source: 'prop', payload: {} });
      for (let i = 0; i < 5; i++) q.unwatch(`p${i}`, ms(clock));
      q.tick(ms(clock));
      out.push(...q.take(Number.MAX_SAFE_INTEGER, SEG));

      const counts = out.filter((r) => r.stream === 'poll_counts').map(payloadOf);
      const keys = counts.map((p) => `${String(p.poolId)}@${String(p.minuteStartMs)}`);
      assert.equal(new Set(keys).size, keys.length, 'a (pool, minute) record appears twice');
      assert.equal(counts.reduce((a, p) => a + (p.successfulPolls as number), 0), polls, 'successful polls lost or double counted');
      assert.equal(counts.reduce((a, p) => a + (p.failedPolls as number), 0), failed, 'failed polls lost or double counted');
      assert.equal(q.stats().droppedTotal.poll_counts, 0);
    }), params);
  });
});
