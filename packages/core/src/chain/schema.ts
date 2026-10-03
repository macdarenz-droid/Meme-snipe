// A small hand-written Borsh schema: each codec reads one value and records the IDL type it stands for, so
// a test can compare every layout here with the pinned pump IDLs field by field (test/chain/idl.test.ts).
import { type Address, DecodeError, Reader } from './bytes.ts';
import { type Bps, bps } from '../units/index.ts';

export type IdlType = string | { readonly array: readonly [IdlType, number] } | { readonly vec: IdlType } | { readonly defined: { readonly name: string } };

export interface Codec<T> {
  readonly idl: IdlType;
  read(r: Reader): T;
}

const codec = <T>(idl: IdlType, read: (r: Reader) => T): Codec<T> => ({ idl, read });

export const u8 = codec('u8', (r) => r.u8());
export const u16 = codec('u16', (r) => r.u16());
export const u64 = codec('u64', (r) => r.u64());
export const i64 = codec('i64', (r) => r.i64());
export const u128 = codec('u128', (r) => r.u128());
export const i128 = codec('i128', (r) => r.i128());
export const bool = codec('bool', (r) => r.bool());
export const pubkey = codec<Address>('pubkey', (r) => r.pubkey());
export const string = codec('string', (r) => r.string());
/** A u64 basis-point rate, checked to be 0..10,000 (an out-of-range rate is corrupt data, not a fee). */
export const bpsU64 = codec<Bps>('u64', (r) => {
  const v = r.u64();
  if (v > 10_000n) throw new DecodeError(`basis points must be <= 10000, got ${v}`);
  return bps(Number(v));
});

export const array = <T>(item: Codec<T>, n: number): Codec<T[]> =>
  codec({ array: [item.idl, n] }, (r) => Array.from({ length: n }, () => item.read(r)));

/** Borsh Vec: u32 length then items. The length is bounded by the bytes left, so corrupt data cannot allocate. */
export const vec = <T>(item: Codec<T>): Codec<T[]> =>
  codec({ vec: item.idl }, (r) => {
    const n = r.u32();
    if (n > r.remaining) throw new DecodeError(`vec length ${n} exceeds the ${r.remaining} bytes left`);
    return Array.from({ length: n }, () => item.read(r));
  });

export type Field = readonly [name: string, codec: Codec<unknown>];
type Value<C> = C extends Codec<infer V> ? V : never;
export type Fields<F extends readonly Field[]> = { [E in F[number] as E[0]]: Value<E[1]> };
export type OptionalFields<F extends readonly Field[]> = { [E in F[number] as E[0]]?: Value<E[1]> };

const readFields = (r: Reader, fields: readonly Field[], out: Record<string, unknown>) => {
  for (const [name, c] of fields) out[name] = c.read(r);
};

/** A nested IDL struct with a fixed field list. */
export const struct = <const F extends readonly Field[]>(name: string, fields: F): Codec<Fields<F>> & { readonly fields: F } => ({
  idl: { defined: { name } },
  fields,
  read: (r) => {
    const out: Record<string, unknown> = {};
    readFields(r, fields, out);
    return out as Fields<F>;
  },
});

/**
 * A top-level account or event layout. Pump only ever appends fields (checked over every IDL in
 * pump-public-docs history), so data written by an older program version is a prefix of the current layout.
 * `base` is the first published layout (2025-04-04, or the type's first IDL); `added` are the later fields in order.
 * When the data ends exactly at a field boundary inside `added`, the rest are absent (never filled with a guess);
 * ending inside a field is corrupt data.
 */
export interface Layout<B extends readonly Field[], A extends readonly Field[]> {
  readonly name: string;
  readonly discriminator: Uint8Array;
  readonly base: B;
  readonly added: A;
}

export type LayoutValue<L> = L extends Layout<infer B, infer A> ? Fields<B> & OptionalFields<A> : never;

export const layout = <const B extends readonly Field[], const A extends readonly Field[]>(
  name: string,
  discriminator: readonly number[],
  base: B,
  added: A,
): Layout<B, A> => ({ name, discriminator: Uint8Array.from(discriminator), base, added });

export interface Decoded<T> {
  readonly value: T;
  /** Bytes left after the last field this decoder knows. Accounts are often zero-padded; for events, non-zero means a newer layout. */
  readonly trailing: number;
  /** True when any trailing byte is non-zero: the program wrote data this layout does not describe (a newer layout). */
  readonly trailingNonZero: boolean;
}

export const readLayout = <B extends readonly Field[], A extends readonly Field[]>(
  l: Layout<B, A>,
  r: Reader,
): Decoded<Fields<B> & OptionalFields<A>> => {
  const out: Record<string, unknown> = {};
  readFields(r, l.base, out);
  for (const [name, c] of l.added) {
    if (r.remaining === 0) break;
    out[name] = c.read(r);
  }
  const rest = r.take(r.remaining);
  return { value: out as Fields<B> & OptionalFields<A>, trailing: rest.length, trailingNonZero: rest.some((b) => b !== 0) };
};

export const hasDiscriminator = (data: Uint8Array, disc: Uint8Array, offset = 0): boolean => {
  if (data.length < offset + disc.length) return false;
  for (let i = 0; i < disc.length; i++) if (data[offset + i] !== disc[i]) return false;
  return true;
};

/** Decodes an Anchor account: 8-byte discriminator, then the layout. A wrong discriminator is an error. */
export const decodeAnchorAccount = <B extends readonly Field[], A extends readonly Field[]>(
  l: Layout<B, A>,
  data: Uint8Array,
): Decoded<Fields<B> & OptionalFields<A>> => {
  if (!hasDiscriminator(data, l.discriminator)) throw new DecodeError(`account data is not a ${l.name} (discriminator mismatch)`);
  return readLayout(l, new Reader(data, 8));
};
