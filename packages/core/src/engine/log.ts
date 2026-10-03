import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted, bigints written as {"$n":"<digits>"}, undefined fields dropped.
 * The same value always gives the same text, so logs can be hashed and compared byte for byte.
 */
export const canonical = (value: unknown): string => {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'bigint':
      return `{"$n":"${value.toString()}"}`;
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError('non-finite numbers have no canonical form');
      return JSON.stringify(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
      const entries = Object.keys(value)
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
      return `{${entries.join(',')}}`;
    }
    default:
      throw new TypeError(`${typeof value} has no canonical form`);
  }
};

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
