// Ported from Snipe-solana card C03 (#6 @ 6ae4d62); runner moved from node:test to Vitest.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { base58, DecodeError, decodePubkey, Reader, toHex } from '../src/index.ts';

const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof DecodeError ? e.code : 'other';
  }
  return 'none';
};

describe('A-M02-01 base58', () => {
  it('round-trips random 32-byte arrays (property)', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (b) => {
      const s = base58.encode(b);
      assert.ok(s.length >= 32 && s.length <= 44);
      assert.deepEqual(base58.decode(s), b);
      assert.deepEqual(decodePubkey(s), b);
    }), { numRuns: 500 });
  });

  it('round-trips any byte string, leading zeros included (property)', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 80 }), (b) => assert.deepEqual(base58.decode(base58.encode(b)), b)), { numRuns: 300 });
  });

  it('matches known vectors', () => {
    assert.equal(base58.encode(new Uint8Array(32)), '1'.repeat(32));      // Pubkey::default()
    assert.equal(base58.encode(new Uint8Array(0)), '');
    assert.equal(base58.encode(Uint8Array.from([0, 0, 1])), '112');
    assert.equal(base58.encode(new TextEncoder().encode('hello world')), 'StV1DL6CwTryKyV');
    assert.deepEqual(base58.decode('StV1DL6CwTryKyV'), new TextEncoder().encode('hello world'));
    assert.deepEqual(base58.decode(''), new Uint8Array(0));
  });

  it('rejects characters outside the alphabet and keys that are not 32 bytes (E_BASE58)', () => {
    for (const bad of ['0', 'O', 'I', 'l', '1 1', 'é', '+/']) assert.equal(code(() => base58.decode(bad)), 'E_BASE58', bad);
    assert.equal(code(() => base58.decode(7 as unknown as string)), 'E_BASE58');
    assert.equal(code(() => decodePubkey('StV1DL6CwTryKyV')), 'E_BASE58');
    assert.equal(code(() => decodePubkey(base58.encode(new Uint8Array(33).fill(9)))), 'E_BASE58');
  });
});

describe('A-M02-01 base58 on long input (review C03 R2)', () => {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  /** The previous digit-by-digit decoder, O(n²): the reference the bigint decoder must match. */
  const reference = (s: string): Uint8Array => {
    let zeros = 0;
    while (zeros < s.length && s[zeros] === '1') zeros++;
    const bytes: number[] = [];
    for (let i = zeros; i < s.length; i++) {
      let carry = ALPHABET.indexOf(s[i] as string);
      for (let j = 0; j < bytes.length; j++) {
        carry += (bytes[j] as number) * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
  };
  const text = fc.tuple(fc.nat({ max: 5 }), fc.array(fc.constantFrom(...ALPHABET), { maxLength: 400 })).map(([z, cs]) => '1'.repeat(z) + cs.join(''));

  it('matches the digit-by-digit decoder on any base58 text (property)', () => {
    fc.assert(fc.property(text, (s) => assert.deepEqual(base58.decode(s), reference(s))), { numRuns: 500 });
    fc.assert(fc.property(fc.uint8Array({ minLength: 100, maxLength: 3_000 }), (b) => assert.deepEqual(base58.decode(base58.encode(b)), b)), { numRuns: 20 });
  });

  it('decodes 10 KiB of instruction data 40 times within the time budget (the O(n²) loop took about 5 s)', { timeout: 2_000 }, async () => {
    const long = ALPHABET.repeat(242).slice(0, 13_985);                       // about 10 KiB, the CPI data limit
    let last: Uint8Array = new Uint8Array(0);
    for (let i = 0; i < 40; i++) last = base58.decode(long);
    assert.equal(last.length, 10_241);
    assert.deepEqual(last, reference(long));
    assert.equal(code(() => base58.decode(`${long.slice(0, 9_000)}0${long.slice(9_000)}`)), 'E_BASE58');   // a bad character deep inside
    await new Promise<void>((r) => { setTimeout(r, 1); });                     // lets the runner's timeout fire if overrun
  });
});

describe('A-M02-01 Reader', () => {
  it('reads little-endian integers, bools, keys, bytes and strings', () => {
    const b = new Uint8Array([
      0xff, 0xfe, 0x01, 0x02, 0xfe, 0xff, 0x01, 0x02, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff,
      ...new Array<number>(8).fill(0xff), ...new Array<number>(8).fill(0xff),
      ...new Array<number>(16).fill(0xff), ...new Array<number>(16).fill(0xff),
      1, 0, 3, 0, 0, 0, 0x61, 0x62, 0x63, 9, 8,
    ]);
    const r = new Reader(b);
    assert.equal(r.u8(), 255);
    assert.equal(r.i8(), -2);
    assert.equal(r.u16(), 0x0201);
    assert.equal(r.i16(), -2);
    assert.equal(r.u32(), 0x04030201);
    assert.equal(r.i32(), -1);
    assert.equal(r.u64(), 2n ** 64n - 1n);
    assert.equal(r.i64(), -1n);
    assert.equal(r.u128(), 2n ** 128n - 1n);
    assert.equal(r.i128(), -1n);
    assert.equal(r.bool(), true);
    assert.equal(r.bool(), false);
    assert.equal(r.string(), 'abc');
    assert.equal(r.offset(), b.length - 2);
    assert.deepEqual(r.bytes(2), Uint8Array.from([9, 8]));
    assert.equal(r.remaining(), 0);
    const k = new Reader(new Uint8Array(32));
    assert.equal(k.pubkey(), '1'.repeat(32));
  });

  it('reads i128 with the high bit set as a negative bigint', () => {
    const b = new Uint8Array(16);
    b[15] = 0x80;
    assert.equal(new Reader(b).i128(), -(2n ** 127n));
  });

  it('throws E_SHORT past the end, for every width', () => {
    const reads: Array<(r: Reader) => unknown> = [
      (r) => r.u8(), (r) => r.i8(), (r) => r.u16(), (r) => r.i16(), (r) => r.u32(), (r) => r.i32(), (r) => r.u64(), (r) => r.i64(),
      (r) => r.u128(), (r) => r.i128(), (r) => r.bool(), (r) => r.pubkey(), (r) => r.bytes(1), (r) => r.string(),
    ];
    for (const read of reads) assert.equal(code(() => read(new Reader(new Uint8Array(0)))), 'E_SHORT');
    assert.equal(code(() => new Reader(Uint8Array.from([5, 0, 0, 0, 0x61])).string()), 'E_SHORT');
    assert.equal(code(() => new Reader(new Uint8Array(15)).u128()), 'E_SHORT');
  });

  it('refuses invalid encodings (E_BAD_VALUE)', () => {
    assert.equal(code(() => new Reader(Uint8Array.from([2])).bool()), 'E_BAD_VALUE');
    assert.equal(code(() => new Reader(new Uint8Array(4)).bytes(-1)), 'E_BAD_VALUE');
    assert.equal(code(() => new Reader(new Uint8Array(4)).bytes(1.5)), 'E_BAD_VALUE');
    assert.equal(code(() => new Reader(Uint8Array.from([2, 0, 0, 0, 0xc3, 0x28])).string()), 'E_BAD_VALUE');
  });

  it('reads from a view inside a larger buffer', () => {
    const big = Uint8Array.from([9, 9, 1, 0, 9]);
    const r = new Reader(big.subarray(2, 4));
    assert.equal(r.u16(), 1);
    assert.equal(toHex(big.subarray(2, 4)), '0100');
  });
});
