import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import {
  baseUnits, blockHeight, bps, cu, CU_MAX_PER_TX, fromI128Str, fromI64Str, fromU64Str, I128_MAX, I128_MIN, I64_MAX,
  I64_MIN, lamports, microLamportsPerCu, priorityFeeLamports, signedLamports, slot, toI128Str, toI64Str, toU64Str,
  U64_MAX, unixMs,
} from '@bot/types';

const ok = (value: bigint) => ({ ok: true, value });
const err = (code: 'E_FORMAT' | 'E_RANGE') => ({ ok: false, error: { code } });

describe('bounds', () => {
  it('match the integer widths', () => {
    assert.equal(U64_MAX, 2n ** 64n - 1n);
    assert.equal(I64_MIN, -(2n ** 63n));
    assert.equal(I64_MAX, 2n ** 63n - 1n);
    assert.equal(I128_MIN, -(2n ** 127n));
    assert.equal(I128_MAX, 2n ** 127n - 1n);
    assert.equal(CU_MAX_PER_TX, 1_400_000);
  });
});

describe('unsigned 64-bit unit guards', () => {
  for (const [name, guard] of [['lamports', lamports], ['baseUnits', baseUnits], ['microLamportsPerCu', microLamportsPerCu],
    ['slot', slot], ['blockHeight', blockHeight]] as const) {
    it(`${name} accepts 0 and u64 max and rejects the rest`, () => {
      assert.equal(guard(0n), 0n);
      assert.equal(guard(U64_MAX), U64_MAX);
      assert.throws(() => guard(-1n), RangeError);
      assert.throws(() => guard(U64_MAX + 1n), RangeError);
      assert.throws(() => guard(1 as unknown as bigint), TypeError);
    });
  }
  it('error messages never echo the value', () => {
    assert.throws(() => lamports(U64_MAX + 1n), (e: Error) => !e.message.includes('18446744073709551616'));
  });
});

describe('signedLamports', () => {
  it('accepts the i64 range only', () => {
    assert.equal(signedLamports(I64_MIN), I64_MIN);
    assert.equal(signedLamports(I64_MAX), I64_MAX);
    assert.throws(() => signedLamports(I64_MIN - 1n), RangeError);
    assert.throws(() => signedLamports(I64_MAX + 1n), RangeError);
  });
});

describe('number unit guards', () => {
  it('cu accepts integers 0..1,400,000 [LD-02]', () => {
    assert.equal(cu(0), 0);
    assert.equal(cu(1_400_000), 1_400_000);
    assert.throws(() => cu(1_400_001), RangeError);
    assert.throws(() => cu(-1), RangeError);
    assert.throws(() => cu(1.5), TypeError);
    assert.throws(() => cu(Number.NaN), TypeError);
    assert.throws(() => cu(10n as unknown as number), TypeError);
  });
  it('bps accepts signed int32 integers', () => {
    assert.equal(bps(-400), -400);
    assert.equal(bps(2_147_483_647), 2_147_483_647);
    assert.equal(bps(-2_147_483_648), -2_147_483_648);
    assert.throws(() => bps(2_147_483_648), RangeError);
    assert.throws(() => bps(-2_147_483_649), RangeError);
    assert.throws(() => bps(0.5), TypeError);
  });
  it('unixMs accepts non-negative safe integers', () => {
    assert.equal(unixMs(0), 0);
    assert.equal(unixMs(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    assert.throws(() => unixMs(-1), RangeError);
    assert.throws(() => unixMs(Number.MAX_SAFE_INTEGER + 2), RangeError);
    assert.throws(() => unixMs(Number.POSITIVE_INFINITY), TypeError);
  });
});

describe('priorityFeeLamports = ceil(cuPrice × cuLimit / 1,000,000) [LD-02]', () => {
  it('matches the B-M16-01 vector: 25,000 µL/CU × 220,000 CU = 5,500 lamports', () => {
    assert.equal(priorityFeeLamports(25_000n, 220_000), 5_500n);
  });
  it('rounds up any fraction of a lamport', () => {
    assert.equal(priorityFeeLamports(1n, 1), 1n);
    assert.equal(priorityFeeLamports(1n, 999_999), 1n);
    assert.equal(priorityFeeLamports(2n, 1_000_000), 2n);
    assert.equal(priorityFeeLamports(1_000_001n, 1), 2n);
    assert.equal(priorityFeeLamports(1_000_000n, 1), 1n);
  });
  it('is zero when price or limit is zero', () => {
    assert.equal(priorityFeeLamports(0n, 1_400_000), 0n);
    assert.equal(priorityFeeLamports(5n, 0), 0n);
  });
  it('rejects invalid inputs and a fee beyond u64', () => {
    assert.throws(() => priorityFeeLamports(-1n, 1), RangeError);
    assert.throws(() => priorityFeeLamports(1n, 1_400_001), RangeError);
    assert.throws(() => priorityFeeLamports(U64_MAX, 1_400_000), RangeError);
  });
});

describe('U64Str codec (UI.md convention 5)', () => {
  it('round-trips 18446744073709551615 and 0', () => {
    assert.equal(toU64Str(U64_MAX), '18446744073709551615');
    assert.deepEqual(fromU64Str('18446744073709551615'), ok(U64_MAX));
    assert.equal(toU64Str(0n), '0');
    assert.deepEqual(fromU64Str('0'), ok(0n));
  });
  it('rejects text outside the pattern', () => {
    for (const s of ['', '01', '+1', '-1', '1e3', ' 1', '1 ', '1.0', '0x10', '123456789012345678901', '١']) {
      assert.deepEqual(fromU64Str(s), err('E_FORMAT'), s);
    }
    for (const v of [1, 1n, null, undefined, {}]) assert.deepEqual(fromU64Str(v), err('E_FORMAT'));
  });
  it('rejects values above u64 max that fit the pattern', () => {
    assert.deepEqual(fromU64Str('18446744073709551616'), err('E_RANGE'));
    assert.deepEqual(fromU64Str('99999999999999999999'), err('E_RANGE'));
  });
  it('refuses to encode out-of-range values', () => {
    assert.throws(() => toU64Str(-1n), RangeError);
    assert.throws(() => toU64Str(U64_MAX + 1n), RangeError);
  });
});

describe('I64Str codec', () => {
  it('round-trips both bounds and negative values', () => {
    assert.equal(toI64Str(I64_MIN), '-9223372036854775808');
    assert.deepEqual(fromI64Str('-9223372036854775808'), ok(I64_MIN));
    assert.equal(toI64Str(I64_MAX), '9223372036854775807');
    assert.deepEqual(fromI64Str('9223372036854775807'), ok(I64_MAX));
    assert.deepEqual(fromI64Str('-1'), ok(-1n));
    assert.equal(toI64Str(-1n), '-1');
  });
  it('rejects -0, leading zeros and out-of-range values', () => {
    assert.deepEqual(fromI64Str('-0'), err('E_FORMAT'));
    assert.deepEqual(fromI64Str('-01'), err('E_FORMAT'));
    assert.deepEqual(fromI64Str('9223372036854775808'), err('E_RANGE'));
    assert.deepEqual(fromI64Str('-9223372036854775809'), err('E_RANGE'));
    assert.deepEqual(fromI64Str('18446744073709551615'), err('E_FORMAT'));
    assert.throws(() => toI64Str(I64_MAX + 1n), RangeError);
  });
});

describe('I128Str codec', () => {
  it('round-trips both bounds and negative values', () => {
    assert.equal(toI128Str(I128_MIN), '-170141183460469231731687303715884105728');
    assert.deepEqual(fromI128Str('-170141183460469231731687303715884105728'), ok(I128_MIN));
    assert.deepEqual(fromI128Str(I128_MAX.toString()), ok(I128_MAX));
    assert.deepEqual(fromI128Str('-18446744073709551615'), ok(-U64_MAX));
  });
  it('rejects -0 and values beyond i128', () => {
    assert.deepEqual(fromI128Str('-0'), err('E_FORMAT'));
    assert.deepEqual(fromI128Str('170141183460469231731687303715884105728'), err('E_RANGE'));
    assert.deepEqual(fromI128Str('-999999999999999999999999999999999999999'), err('E_RANGE'));
    assert.deepEqual(fromI128Str('1000000000000000000000000000000000000000'), err('E_FORMAT'));
    assert.throws(() => toI128Str(I128_MIN - 1n), RangeError);
  });
});
