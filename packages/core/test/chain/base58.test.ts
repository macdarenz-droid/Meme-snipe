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
