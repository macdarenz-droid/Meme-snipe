// Unsigned instructions as plain data, and the little-endian writer that encodes their arguments. No Solana SDK:
// every byte here is written by this module and read back by the DEC-1 decoder in the tests.
import { type Address, addressBytes } from '../chain/index.ts';

export interface AccountMeta {
  readonly address: Address;
  readonly signer: boolean;
  readonly writable: boolean;
}

export interface Instruction {
  readonly programId: Address;
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
}

export const w = (address: Address): AccountMeta => ({ address, signer: false, writable: true });
export const ro = (address: Address): AccountMeta => ({ address, signer: false, writable: false });
export const signerW = (address: Address): AccountMeta => ({ address, signer: true, writable: true });

/** True when `v` survives a round trip through the typed array: an integer in range (no fractions, NaN or negatives). */
const fitsU16 = (v: number) => Uint16Array.of(v)[0] === v;
const fitsU32 = (v: number) => Uint32Array.of(v)[0] === v;
const U64_MAX = (1n << 64n) - 1n;

/** Little-endian byte writer. Integers are range-checked: a value that does not fit is an error, never truncated. */
export class Writer {
  private readonly parts: number[] = [];

  bytes(b: Uint8Array): this {
    for (const x of b) this.parts.push(x);
    return this;
  }

  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`u8 out of range: ${v}`);
    this.parts.push(v);
    return this;
  }

  u16(v: number): this {
    if (!fitsU16(v)) throw new RangeError(`u16 out of range: ${v}`);
    this.parts.push(v & 0xff, v >> 8);
    return this;
  }

  u32(v: number): this {
    if (!fitsU32(v)) throw new RangeError(`u32 out of range: ${v}`);
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
    return this;
  }

  u64(v: bigint): this {
    if (v < 0n || v > U64_MAX) throw new RangeError(`u64 out of range: ${v}`);
    for (let i = 0n; i < 8n; i++) this.parts.push(Number((v >> (8n * i)) & 0xffn));
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  pubkey(a: Address): this {
    return this.bytes(addressBytes(a));
  }

  /** Solana compact-u16 (shortvec), minimal encoding. */
  shortU16(v: number): this {
    if (!fitsU16(v)) throw new RangeError(`compact-u16 out of range: ${v}`);
    let rest = v;
    for (;;) {
      const low = rest & 0x7f;
      rest >>= 7;
      if (rest === 0) {
        this.parts.push(low);
        return this;
      }
      this.parts.push(low | 0x80);
    }
  }

  get length(): number {
    return this.parts.length;
  }

  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** An 8-byte Anchor discriminator from its hex form (as listed in the pinned IDLs). */
export const discriminator = (hex: string): Uint8Array => {
  if (!/^[0-9a-f]{16}$/.test(hex)) throw new RangeError(`discriminator must be 16 lowercase hex digits, got ${hex}`);
  return Uint8Array.from({ length: 8 }, (_, i) => parseInt(hex.slice(2 * i, 2 * i + 2), 16));
};
