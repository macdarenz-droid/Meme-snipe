import { describe, expect, it } from 'vitest';
import { fixtureWallet } from '../src/dev/fixtures.ts';
import { codewords, encodeQr, formatBits, generator, reedSolomon } from '../src/funding/qr.ts';

/** Remainder of a polynomial (highest term first) divided by the generator, in GF(256). Zero for a valid codeword. */
function remainder(poly: number[], degree: number): number[] {
  const gen = generator(degree);
  const exp: number[] = [];
  const log: number[] = [];
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  const mul = (a: number, b: number) => (a && b ? exp[(log[a]! + log[b]!) % 255]! : 0);
  const r = [...poly];
  for (let i = 0; i + degree < r.length; i++) {
    const f = r[i]!;
    if (!f) continue;
    gen.forEach((g, j) => (r[i + j] = r[i + j]! ^ mul(g, f)));
  }
  return r.slice(r.length - degree);
}

describe('QR encoder', () => {
  it('matches the ISO example for Reed-Solomon (version 1-M, "01234567")', () => {
    // ISO/IEC 18004 Annex I, numeric example data codewords with 10 error codewords at level M (version 1).
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    expect(reedSolomon(data, 10)).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });

  it('writes the format bits of the standard (level M)', () => {
    expect(formatBits(0).toString(2).padStart(15, '0')).toBe('101010000010010');
    expect(formatBits(5).toString(2).padStart(15, '0')).toBe('100000011001110');
  });

  it('gives every block a valid Reed-Solomon codeword', () => {
    const bytes = [...new TextEncoder().encode(fixtureWallet.botAddress!)];
    const words = codewords(bytes, 4);
    // Version 4-M: 2 blocks of 32 data and 18 error codewords, interleaved.
    expect(words).toHaveLength(2 * (32 + 18));
    for (let b = 0; b < 2; b++) {
      const data = Array.from({ length: 32 }, (_, i) => words[i * 2 + b]!);
      const ec = Array.from({ length: 18 }, (_, i) => words[64 + i * 2 + b]!);
      expect(remainder([...data, ...ec], 18).every((v) => v === 0)).toBe(true);
    }
  });

  it('draws a 33 by 33 grid for a 44 character address, with the three finder patterns', () => {
    const m = encodeQr(fixtureWallet.botAddress!);
    expect(m).toHaveLength(33);
    const finder = (x: number, y: number) =>
      [0, 6].every((d) => m[y]![x + d] && m[y + 6]![x + d] && m[y + d]![x] && m[y + d]![x + 6]) && !m[y + 1]![x + 1] && m[y + 3]![x + 3];
    expect(finder(0, 0) && finder(26, 0) && finder(0, 26)).toBe(true);
    expect(m[25]![8]).toBe(true); // the dark module
  });

  it('is deterministic and changes with the text', () => {
    expect(encodeQr('abc')).toEqual(encodeQr('abc'));
    expect(encodeQr('abc')).not.toEqual(encodeQr('abd'));
  });

  it('refuses text longer than version 6 holds', () => {
    expect(() => encodeQr('x'.repeat(107))).toThrow(/too long/);
    expect(encodeQr('x'.repeat(106))).toHaveLength(41);
  });
});
