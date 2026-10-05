import { describe, expect, it } from 'vitest';
import { decodeAddressBytes, decodeBase58, encodeBase58 } from '../../src/chain/base58.ts';
import { DecodeError, fromHex, toHex } from '../../src/chain/bytes.ts';

// bitcoin/bitcoin src/test/data/base58_encode_decode.json
const VECTORS: [string, string][] = [
  ['', ''],
  ['61', '2g'],
  ['626262', 'a3gV'],
  ['636363', 'aPEr'],
  ['73696d706c792061206c6f6e6720737472696e67', '2cFupjhnEsSn59qHXstmK2ffpLv2'],
  ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
  ['516b6fcd0f', 'ABnLTmg'],
  ['bf4f89001e670274dd', '3SEo3LWLoPntC'],
  ['572e4794', '3EFU7m'],
  ['ecac89cad93923c02321', 'EJDM8drfXA6uyA'],
  ['10c8511e', 'Rt5zm'],
  ['00000000000000000000', '1111111111'],
  ['000111d38e5fc9071ffcd20b4a763cc9ae4f252bb4e48fd66a835e252ada93ff480d6dd43dc62a641155a5', '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'],
];

describe('base58', () => {
  it.each(VECTORS)('encodes and decodes %s', (hex, text) => {
    expect(encodeBase58(fromHex(hex))).toBe(text);
    expect(toHex(decodeBase58(text))).toBe(hex);
  });

  it('round-trips random bytes, including leading zeros', () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) & 0xff;
    for (let n = 0; n < 300; n++) {
      const len = n % 70;
      const b = Uint8Array.from({ length: len }, (_, i) => (i < n % 4 ? 0 : next()));
      expect(toHex(decodeBase58(encodeBase58(b)))).toBe(toHex(b));
    }
  });

  it('maps the system program to 32 zero bytes', () => {
    expect(toHex(decodeAddressBytes('11111111111111111111111111111111'))).toBe('00'.repeat(32));
  });

  it('rejects characters outside the alphabet and wrong address lengths', () => {
    for (const bad of ['0', 'O', 'I', 'l', '+', ' abc', 'é']) expect(() => decodeBase58(bad)).toThrow(DecodeError);
    expect(() => decodeAddressBytes('2g')).toThrow(DecodeError);
  });
});

/** The encoder as it was before OOM-SWAPS (one character appended at a time): the reference for byte-identical output. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const encodeBefore = (bytes: Uint8Array): string => {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
};

describe('the flat encoder gives the old output exactly (OOM-SWAPS)', () => {
  it('over 20,000 random inputs of 0 to 80 bytes, many with leading zeros', () => {
    let x = 0x9e3779b9;
    const next = (n: number): number => {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      return x % n;
    };
    for (let k = 0; k < 20_000; k++) {
      const len = next(81);
      const lead = next(4) === 0 ? next(len + 1) : 0;
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i < lead ? 0 : next(256)));
      expect(encodeBase58(bytes), `input ${toHex(bytes)}`).toBe(encodeBefore(bytes));
    }
  });
});

describe('encoded strings are flat (heap at boot: OOM-SWAPS)', () => {
  it('20,000 encoded addresses, held, take well under 5 MB of heap (a rope of one node per character took about 25 MB)', async () => {
    // Every swap keeps its six addresses in the engine's store; a string built one character at a time stays a rope of
    // about 30 nodes per address. Measured after a full collection, holding exactly the encoded strings.
    const { setFlagsFromString } = await import('node:v8');
    const { runInNewContext } = await import('node:vm');
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const bytes = Array.from({ length: 20_000 }, (_, k) => Uint8Array.from({ length: 32 }, (_, j) => (k * 31 + j * 7 + 1) % 256));
    gc();
    const before = process.memoryUsage().heapUsed;
    const held = bytes.map(encodeBase58);
    gc();
    const used = process.memoryUsage().heapUsed - before;
    expect(held.every((s) => s.length >= 43 && s.length <= 44)).toBe(true);
    expect(used).toBeLessThan(5 * 1024 * 1024);
    // Output unchanged: each round-trips.
    expect(toHex(decodeBase58(held[123]!))).toBe(toHex(bytes[123]!));
  });
});
