// One JSON form for everything the worker writes (journal, state, recorder): bigints as decimal strings, bytes as
// base64. Readers that need bigints back convert the fields they know.
import { fromBase64, toBase64 } from '../../../core/src/chain/index.ts';

export const jsonText = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toBase64(v) : v));

/** A decimal string back to a bigint; anything else is an error (stored state is never guessed). */
export const big = (v: unknown, what: string): bigint => {
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new RangeError(`${what}: expected an integer string, got ${typeof v}`);
};

/**
 * Lossless JSON for state and recorded frames: a bigint is `{"$n":"<decimal>"}` and bytes are `{"$b":"<base64>"}`, so
 * a reader gets back exactly the values that were written, whatever their shape.
 */
export const typedText = (value: unknown): string =>
  JSON.stringify(value, function (this: unknown, k: string, v: unknown) {
    // JSON.stringify calls toJSON first; read the raw value from the holder so Uint8Array is seen as bytes.
    const raw = (this as Record<string, unknown>)[k];
    if (typeof raw === 'bigint') return { $n: raw.toString() };
    if (raw instanceof Uint8Array) return { $b: toBase64(raw) };
    return v;
  });

export const parseTyped = (text: string): unknown =>
  JSON.parse(text, (_k, v: unknown) => {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && typeof o['$n'] === 'string' && /^-?\d+$/.test(o['$n'])) return BigInt(o['$n']);
      if (keys.length === 1 && typeof o['$b'] === 'string') return fromBase64(o['$b']);
    }
    return v;
  });
