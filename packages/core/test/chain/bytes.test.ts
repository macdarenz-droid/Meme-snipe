// Byte-level vectors for the Reader and the schema codecs. Every expected value is written out by hand, not
// produced by the code under test.
import { describe, expect, it } from 'vitest';
import { DecodeError, Reader, fromHex } from '../../src/chain/bytes.ts';
import { bpsU64, readLayout, layout, u8, vec } from '../../src/chain/schema.ts';

const r = (hex: string) => new Reader(fromHex(hex));

describe('Reader integers', () => {
  it('reads i64 -1 and the i64 extremes', () => {
    expect(r('ffffffffffffffff').i64()).toBe(-1n);
    expect(r('0000000000000080').i64()).toBe(-(2n ** 63n));
    expect(r('ffffffffffffff7f').i64()).toBe(2n ** 63n - 1n);
    expect(r('ffffffffffffffff').u64()).toBe(2n ** 64n - 1n);
  });

  it('reads i128 -1, min, max, a value above 2^64 and a large negative value', () => {
    expect(r('ff'.repeat(16)).i128()).toBe(-1n);
    expect(r('00'.repeat(15) + '80').i128()).toBe(-(2n ** 127n));
    expect(r('ff'.repeat(15) + '7f').i128()).toBe(2n ** 127n - 1n);
    // 2^64 + 5: low word 5, high word 1.
    expect(r('0500000000000000' + '0100000000000000').i128()).toBe(2n ** 64n + 5n);
    // -(2^64 + 5) in two's complement: low word 0xfffffffffffffffb, high word 0xfffffffffffffffe.
    expect(r('fbffffffffffffff' + 'feffffffffffffff').i128()).toBe(-(2n ** 64n + 5n));
    // -184915875 (the mainnet fixture; bytes from Node's writeBigInt64LE): the high word is all ones.
    expect(r('5d68faf4ffffffff' + 'ffffffffffffffff').i128()).toBe(-184915875n);
  });

  it('reads u128 above 2^64 and u16, i16, u32', () => {
    expect(r('0000000000000000' + '0200000000000000').u128()).toBe(2n ** 65n);
    expect(r('ff'.repeat(16)).u128()).toBe(2n ** 128n - 1n);
    expect(r('3412').u16()).toBe(0x1234);
    expect(r('ffff').i16()).toBe(-1);
    expect(r('ffffffff').u32()).toBe(0xffffffff);
  });

  it('refuses a bool byte other than 0 or 1, and reads past the end', () => {
    expect(r('00').bool()).toBe(false);
    expect(r('01').bool()).toBe(true);
    expect(() => r('02').bool()).toThrow(DecodeError);
    expect(() => r('0102').u32()).toThrow(DecodeError);
  });

  it('reads compact-u16 and refuses non-minimal, overlong and overflowing encodings', () => {
    expect(r('00').shortU16()).toBe(0);
    expect(r('7f').shortU16()).toBe(127);
    expect(r('8001').shortU16()).toBe(128);
    expect(r('ffff03').shortU16()).toBe(0xffff);
    expect(() => r('8000').shortU16()).toThrow(DecodeError);
    expect(() => r('808000').shortU16()).toThrow(DecodeError);
    expect(() => r('ffff07').shortU16()).toThrow(DecodeError);
    expect(() => r('80808001').shortU16()).toThrow(DecodeError);
  });

  it('refuses invalid UTF-8 in a string', () => {
    expect(() => r('02000000c328').string()).toThrow();
  });
});

describe('schema codecs', () => {
  it('bounds a vec length by the bytes left (0xffffffff cannot allocate)', () => {
    expect(() => vec(u8).read(r('ffffffff00'))).toThrow(/exceeds the 1 bytes left/);
    expect(vec(u8).read(r('020000000709'))).toEqual([7, 9]);
  });

  it('caps basis points at 10,000', () => {
    expect(Number(bpsU64.read(r('1027000000000000')))).toBe(10_000);
    expect(() => bpsU64.read(r('1127000000000000'))).toThrow(DecodeError);
  });

  it('marks non-zero trailing bytes separately from zero padding', () => {
    const l = layout('T', [], [['a', u8]] as const, [] as const);
    expect(readLayout(l, r('010000'))).toMatchObject({ trailing: 2, trailingNonZero: false });
    expect(readLayout(l, r('010007'))).toMatchObject({ trailing: 2, trailingNonZero: true });
  });
});
