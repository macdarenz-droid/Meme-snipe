// Little-endian byte reading for Solana account, instruction and event data. Every integer wider than
// 32 bits comes back as a bigint; nothing is read through a float.
import { encodeBase58 } from './base58.ts';
import { DecodeError } from './errors.ts';

export { DecodeError };

/** A base58 public key. Branded so a random string cannot be passed where an address is expected. */
declare const address: unique symbol;
export type Address = string & { readonly [address]: true };

export class Reader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.offset + n > this.bytes.length) {
      throw new DecodeError(`read of ${n} bytes at offset ${this.offset} runs past the end (${this.bytes.length} bytes)`);
    }
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  private le(n: number): bigint {
    const s = this.take(n);
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(s[i]!);
    return v;
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  u16(): number {
    const s = this.take(2);
    return s[0]! | (s[1]! << 8);
  }

  i16(): number {
    const v = this.u16();
    return v >= 0x8000 ? v - 0x10000 : v;
  }

  u32(): number {
    const s = this.take(4);
    return (s[0]! | (s[1]! << 8) | (s[2]! << 16)) + s[3]! * 0x1000000;
  }

  u64(): bigint {
    return this.le(8);
  }

  i64(): bigint {
    return BigInt.asIntN(64, this.le(8));
  }

  u128(): bigint {
    return this.le(16);
  }

  i128(): bigint {
    return BigInt.asIntN(128, this.le(16));
  }

  f64(): number {
    return new DataView(this.take(8).slice().buffer).getFloat64(0, true);
  }

  /** Borsh bool: exactly 0 or 1; anything else is corrupt data, not "true". */
  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new DecodeError(`bool byte must be 0 or 1, got ${v} at offset ${this.offset - 1}`);
    return v === 1;
  }

  pubkey(): Address {
    return encodeBase58(this.take(32)) as Address;
  }

  /** Borsh string: u32 byte length, then UTF-8. Invalid UTF-8 is an error, never replaced. */
  string(): string {
    const len = this.u32();
    return utf8.decode(this.take(len));
  }

  /** Solana's compact-u16 (shortvec) length prefix: 1–3 bytes, minimal encoding only. */
  shortU16(): number {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.u8();
      value |= (b & 0x7f) << (7 * i);
      if ((b & 0x80) === 0) {
        if (i > 0 && b === 0) throw new DecodeError('compact-u16 is not minimally encoded');
        if (value > 0xffff) throw new DecodeError('compact-u16 overflows u16');
        return value;
      }
    }
    throw new DecodeError('compact-u16 longer than 3 bytes');
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export const toHex = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
};

export const fromHex = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new DecodeError('invalid hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};

export const fromBase64 = (b64: string): Uint8Array => {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new DecodeError('invalid base64 string');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const toBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
