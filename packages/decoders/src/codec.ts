// Zero-dependency codec core (A-M02-01): base58 and a bounds-checked little-endian reader. Exported for the signer
// (M17, B-M17-04) and the sentinel (M29), which must not carry a second base58 implementation (C-02, CL-18).
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62), review fix C03 R2 (bigint base58 decode) included.
import type { Pubkey } from '@bot/types';

/** A decode failure: `E_BASE58` (bad base58), `E_SHORT` (read past the end), `E_BAD_VALUE` (an invalid encoding). */
export class DecodeError extends Error {
  readonly code: 'E_BASE58' | 'E_SHORT' | 'E_BAD_VALUE';
  constructor(code: 'E_BASE58' | 'E_SHORT' | 'E_BAD_VALUE', message: string) {
    super(message);
    this.code = code;
  }
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET.charCodeAt(i)] = i;

/** Base58 (Bitcoin alphabet), the encoding of Solana addresses and signatures. */
export const base58 = {
  encode(b: Uint8Array): string {
    let zeros = 0;
    while (zeros < b.length && b[zeros] === 0) zeros++;
    const digits: number[] = [];                                  // base-58 digits, least significant first
    for (let i = zeros; i < b.length; i++) {
      let carry = b[i] as number;
      for (let j = 0; j < digits.length; j++) {
        carry += (digits[j] as number) << 8;
        digits[j] = carry % 58;
        carry = Math.floor(carry / 58);
      }
      while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
    }
    let out = '1'.repeat(zeros);
    for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i] as number];
    return out;
  },
  /**
   * Throws `DecodeError('E_BASE58')` on a character outside the alphabet. Divide and conquer on bigint (V8 multiplies
   * large bigints in sub-quadratic time), so 10 KiB of instruction data takes about 1.5 ms where the digit-by-digit
   * loop took about 120 ms (review C03 R2).
   */
  decode(s: string): Uint8Array {
    if (typeof s !== 'string') throw new DecodeError('E_BASE58', 'not a string');
    let zeros = 0;
    while (zeros < s.length && s[zeros] === '1') zeros++;
    if (zeros === s.length) return new Uint8Array(zeros);
    // The first digit after the leading '1's is not zero, so the value is positive and its hex has no leading zero byte.
    const hex = valueOf(s, zeros, s.length).toString(16);
    const body = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex');
    const out = new Uint8Array(zeros + body.length);
    out.set(body, zeros);
    return out;
  },
};

/** Base58 digits per leaf: 58^9 < 2^53, so a leaf is exact in a double. */
const LEAF = 9;
/** POWERS[j] = 58^(LEAF × 2^j), grown by squaring (O(log n) entries). */
const POWERS: bigint[] = [58n ** BigInt(LEAF)];
function power(j: number): bigint {
  while (POWERS.length <= j) {
    const p = POWERS[POWERS.length - 1] as bigint;
    POWERS.push(p * p);
  }
  return POWERS[j] as bigint;
}

/** The value of the base58 digits s[a..b): left part × 58^(right length) + right part, the right part LEAF × 2^j long. */
function valueOf(s: string, a: number, b: number): bigint {
  const n = b - a;
  if (n <= LEAF) {
    let v = 0;
    for (let i = a; i < b; i++) {
      const c = s.charCodeAt(i);
      const d = c < 128 ? INDEX[c] as number : -1;
      if (d < 0) throw new DecodeError('E_BASE58', 'character outside the base58 alphabet');
      v = v * 58 + d;
    }
    return BigInt(v);
  }
  let j = 0;
  while (LEAF * 2 ** (j + 1) < n) j++;
  const m = b - LEAF * 2 ** j;
  return valueOf(s, a, m) * power(j) + valueOf(s, m, b);
}

/** Decodes a base58 public key; anything that is not exactly 32 bytes is `E_BASE58`. */
export function decodePubkey(s: string): Uint8Array {
  const b = base58.decode(s);
  if (b.length !== 32) throw new DecodeError('E_BASE58', 'a public key is 32 bytes');
  return b;
}

/** Bounds-checked little-endian reader over account or event data (Borsh layout). */
export class Reader {
  private readonly b: Uint8Array;
  private readonly view: DataView;
  private at = 0;
  constructor(b: Uint8Array) {
    this.b = b;
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  private need(n: number): number {
    if (this.at + n > this.b.length) throw new DecodeError('E_SHORT', `read of ${n} bytes past the end`);
    const at = this.at;
    this.at += n;
    return at;
  }
  offset(): number { return this.at; }
  remaining(): number { return this.b.length - this.at; }
  u8(): number { return this.view.getUint8(this.need(1)); }
  i8(): number { return this.view.getInt8(this.need(1)); }
  u16(): number { return this.view.getUint16(this.need(2), true); }
  i16(): number { return this.view.getInt16(this.need(2), true); }
  u32(): number { return this.view.getUint32(this.need(4), true); }
  i32(): number { return this.view.getInt32(this.need(4), true); }
  u64(): bigint { return this.view.getBigUint64(this.need(8), true); }
  i64(): bigint { return this.view.getBigInt64(this.need(8), true); }
  u128(): bigint {
    const at = this.need(16);
    return this.view.getBigUint64(at, true) | (this.view.getBigUint64(at + 8, true) << 64n);
  }
  i128(): bigint { return BigInt.asIntN(128, this.u128()); }
  /** Borsh bool: 0 or 1; any other byte is `E_BAD_VALUE`. */
  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new DecodeError('E_BAD_VALUE', 'a bool is 0 or 1');
    return v === 1;
  }
  pubkey(): Pubkey { return base58.encode(this.bytes(32)); }
  bytes(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0) throw new DecodeError('E_BAD_VALUE', 'byte count must be a non-negative integer');
    const at = this.need(n);
    return this.b.slice(at, at + n);
  }
  /** Borsh string: u32 length, then UTF-8 (invalid UTF-8 is `E_BAD_VALUE`). */
  string(): string {
    const n = this.u32();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes(n));
    } catch (e) {
      if (e instanceof DecodeError) throw e;
      throw new DecodeError('E_BAD_VALUE', 'invalid UTF-8');
    }
  }
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
}
