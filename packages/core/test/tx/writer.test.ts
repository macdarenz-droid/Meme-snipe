// The byte writer against the DEC-1 reader: every width round-trips, and out-of-range values are errors, not wraps.
import { describe, expect, test } from 'vitest';
import { Reader } from '../../src/chain/index.ts';
import { Writer, discriminator } from '../../src/tx/index.ts';

describe('Writer', () => {
  test('little-endian integers and compact-u16 read back through DEC-1', () => {
    const lengths = [0, 1, 127, 128, 255, 16_383, 16_384, 65_535];
    const w = new Writer().u8(255).u16(65_535).u32(4_294_967_295).u64(18_446_744_073_709_551_615n).bool(true);
    for (const n of lengths) w.shortU16(n);
    const r = new Reader(w.done());
    expect([r.u8(), r.u16(), r.u32(), r.u64(), r.bool()]).toEqual([255, 65_535, 4_294_967_295, 18_446_744_073_709_551_615n, true]);
    for (const n of lengths) expect(r.shortU16()).toBe(n);
    expect(r.remaining).toBe(0);
  });

  test('compact-u16 uses the minimal number of bytes', () => {
    expect([...new Writer().shortU16(127).done()]).toEqual([0x7f]);
    expect([...new Writer().shortU16(128).done()]).toEqual([0x80, 0x01]);
    expect([...new Writer().shortU16(65_535).done()]).toEqual([0xff, 0xff, 0x03]);
  });

  test('out-of-range and non-integer values throw', () => {
    expect(() => new Writer().u8(256)).toThrow(RangeError);
    expect(() => new Writer().u16(65_536)).toThrow(RangeError);
    expect(() => new Writer().u16(-1)).toThrow(RangeError);
    expect(() => new Writer().u32(4_294_967_296)).toThrow(RangeError);
    expect(() => new Writer().u32(1.5)).toThrow(RangeError);
    expect(() => new Writer().u64(-1n)).toThrow(RangeError);
    expect(() => new Writer().u64(1n << 64n)).toThrow(RangeError);
    expect(() => new Writer().shortU16(65_536)).toThrow(RangeError);
    expect(() => discriminator('C2AB1C46684D5B2F')).toThrow(RangeError);
    expect([...discriminator('c2ab1c46684d5b2f')]).toEqual([0xc2, 0xab, 0x1c, 0x46, 0x68, 0x4d, 0x5b, 0x2f]);
  });
});
