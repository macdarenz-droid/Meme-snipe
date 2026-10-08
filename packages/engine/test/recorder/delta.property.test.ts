// A-M07-01 "property test: decoding the keyframe and deltas reproduces every written state exactly". Random pools,
// random field sets (added, changed and removed fields, odd keys such as __proto__ and toString), repeated states,
// stream moves, hour changes, clock steps back and a small queue that drops records, all through the real queue.
// Fixed seed so a run is reproducible for the exact commit it ran on.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { canonicalJson, type UnixMs } from '@bot/types';
import { RecorderQueue, SnapshotDecoder, SNAPSHOT_STREAMS, type EncodedSnapshot, type PoolSnapshotPayload, type StreamName } from '../../src/index.ts';
import { SEG, T0 } from './helpers.ts';

const params = { seed: 20261007, numRuns: 300 };

// -0 and bigint (review round 1, red team m2): canonicalJson writes -0 as 0 and a bigint as its decimal string, so the
// decoded state matches the appended one in canonical form, which is what the comparison below uses.
const fieldValue = fc.oneof(
  fc.string({ maxLength: 8 }), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(-0), fc.constant(0),
  fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }), fc.array(fc.oneof(fc.integer(), fc.constant(-0), fc.bigInt()), { maxLength: 3 }),
  fc.dictionary(fc.string({ maxLength: 3 }), fc.integer(), { maxKeys: 2 }),
);
const fieldKey = fc.oneof(fc.constantFrom('baseReserve', 'quoteReserve', 'lpSupply', '__proto__', 'hasOwnProperty', 'toString', ''), fc.string({ maxLength: 4 }));
const fields = fc.dictionary(fieldKey, fieldValue, { maxKeys: 6 });
const streams = [...SNAPSHOT_STREAMS] as StreamName[];

const step = fc.record({
  pool: fc.integer({ min: 0, max: 3 }),
  // A small state space, so states repeat (unchanged polls) and come back (A, B, A).
  state: fc.integer({ min: 0, max: 7 }),
  stream: fc.constantFrom(...streams),
  dtMs: fc.oneof(fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: -4_000_000, max: 4_000_000 })),
  take: fc.integer({ min: 0, max: 40 }),
});

describe('snapshot keyframe and delta round trip', () => {
  it('every written record decodes, per stream, to exactly the state appended for it', () => {
    fc.assert(fc.property(fc.array(fields, { minLength: 8, maxLength: 8 }), fc.array(step, { minLength: 1, maxLength: 400 }), (states, steps) => {
      const q = new RecorderQueue({ config: { queueMax: 1_000, queueMaxBytes: 1_000 * 300 + 65_536 } });
      // Each (pool, state) has one rawHash and one payload; the decoder must give that payload back.
      const truth = new Map<string, string>();
      const payloadOf = (pool: number, state: number): PoolSnapshotPayload => {
        const p: PoolSnapshotPayload = { poolId: `pool${pool}`, rawHash: `p${pool}s${state}`, priorityClass: `c${state % 2}`, fields: states[state] as Record<string, unknown> };
        truth.set(p.rawHash, canonicalJson(p));
        return p;
      };
      const decoders = new Map<string, SnapshotDecoder>();
      let written = 0;
      const check = (n: number): void => {
        for (const r of q.take(n, SEG)) {
          let d = decoders.get(r.stream);
          if (d === undefined) {
            d = new SnapshotDecoder();
            decoders.set(r.stream, d);
          }
          const enc = JSON.parse(r.payloadJson) as EncodedSnapshot;
          assert.equal(canonicalJson(d.apply(enc)), truth.get(enc.rawHash));
          written++;
        }
      };
      let t: number = T0;
      for (const s of steps) {
        t += s.dtMs;
        q.append({ stream: s.stream, recvMs: t as UnixMs, slot: null, commitment: 'processed', source: 'prop', payload: payloadOf(s.pool, s.state) });
        // Bursts of appends, then some taken: the queue (1,000) overflows only with long bursts, so also force
        // overflow by flooding pool_snapshot_tail now and then.
        if (s.take === 0) {
          for (let k = 0; k < 1_100; k++) q.append({ stream: 'pool_snapshot_tail', recvMs: t as UnixMs, slot: null, commitment: null, source: 'prop', payload: payloadOf(s.pool, (s.state + k) % 8) });
        }
        check(s.take);
      }
      check(Number.MAX_SAFE_INTEGER);
      return written > 0;
    }), params);
  });
});
