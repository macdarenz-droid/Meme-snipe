// Test fixtures only: Borsh bytes for the fields of a DEC-1 layout, from each codec's IDL type (the decoder's inverse).
import { decodeBase58 } from '../../src/chain/index.ts';

const le = (v: bigint, n: number): number[] => {
  const out: number[] = [];
  let x = BigInt.asUintN(n * 8, v);
  for (let i = 0; i < n; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
};

/** Borsh-encodes `values` for the fields of a layout, from each codec's IDL type. */
export const encode = (fields: readonly (readonly [string, { idl: unknown }])[], values: Record<string, unknown>): number[] =>
  fields.flatMap(([name, c]) => {
    const v = values[name];
    switch (c.idl) {
      case 'pubkey':
        return [...decodeBase58(v as string)];
      case 'u64':
      case 'i64':
        return le(BigInt(v as bigint), 8);
      case 'i128':
        return le(BigInt(v as bigint), 16);
      case 'u16':
        return le(BigInt(v as number), 2);
      case 'u8':
        return [v as number];
      case 'bool':
        return [v ? 1 : 0];
      case 'string': {
        const b = new TextEncoder().encode(v as string);
        return [...le(BigInt(b.length), 4), ...b];
      }
      default:
        throw new Error(`fixture encoder: unsupported type ${JSON.stringify(c.idl)} of ${name}`);
    }
  });
