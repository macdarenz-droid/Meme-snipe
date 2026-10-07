// Property tests (B-M19-01 "Tests"; ARCH 16.2): codec round trip for random u64/i64/i128 values and strings.
// Fixed seed so a run is reproducible for the exact commit it ran on.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  fromI128Str, fromI64Str, fromU64Str, I128_MAX, I128_MIN, I64_MAX, I64_MIN, toI128Str, toI64Str, toU64Str, U64_MAX,
} from '@bot/types';

const params = { seed: 20261006, numRuns: 2000 };

const codecs = [
  { name: 'u64', min: 0n, max: U64_MAX, to: toU64Str, from: fromU64Str },
  { name: 'i64', min: I64_MIN, max: I64_MAX, to: toI64Str, from: fromI64Str },
  { name: 'i128', min: I128_MIN, max: I128_MAX, to: toI128Str, from: fromI128Str },
] as const;

// Digit strings of every length up to 41, signed or not, with and without leading zeros: the shapes near the
// format and range boundaries, which uniform random text would almost never produce.
const numberLikeText = fc.stringMatching(/^-?[0-9]{1,41}$/);

describe('codec properties', () => {
  for (const c of codecs) {
    it(`${c.name}: every value in range encodes and decodes to itself`, () => {
      fc.assert(fc.property(fc.bigInt({ min: c.min, max: c.max }), (x) => {
        const decoded = c.from(c.to(x));
        assert.deepEqual(decoded, { ok: true, value: x });
      }), params);
    });

    it(`${c.name}: any accepted text is the canonical text of its value`, () => {
      fc.assert(fc.property(fc.oneof(numberLikeText, fc.string()), (s) => {
        const decoded = c.from(s);
        if (decoded.ok) {
          assert.ok(decoded.value >= c.min && decoded.value <= c.max);
          assert.equal(c.to(decoded.value), s);
        } else {
          assert.ok(decoded.error.code === 'E_FORMAT' || decoded.error.code === 'E_RANGE');
        }
      }), params);
    });

    it(`${c.name}: values just outside the range never encode`, () => {
      fc.assert(fc.property(fc.bigInt({ min: 1n, max: 2n ** 130n }), (d) => {
        assert.throws(() => c.to(c.max + d), RangeError);
        assert.throws(() => c.to(c.min - d), RangeError);
      }), params);
    });
  }
});
