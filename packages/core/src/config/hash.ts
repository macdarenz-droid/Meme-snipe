// Stable version hash. Same policy, same hash: keys sorted, bigint as decimal strings, no whitespace.
import { createHash } from 'node:crypto';

const canonical = (value: unknown, path: string): string => {
  switch (typeof value) {
    case 'bigint': return JSON.stringify(value.toString(10));
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError(`${path}: not a finite number`);
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object': {
      if (value === null) throw new TypeError(`${path}: null is not allowed in a policy`);
      if (Array.isArray(value)) return `[${value.map((v, i) => canonical(v, `${path}[${i}]`)).join(',')}]`;
      const keys = Object.keys(value).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], `${path}.${k}`)}`).join(',')}}`;
    }
    default: throw new TypeError(`${path}: ${typeof value} is not allowed in a policy`);
  }
};

/** The canonical text a policy is hashed and stored as. */
export const canonicalPolicy = (policy: unknown): string => canonical(policy, 'policy');

/** SHA-256 of the canonical text, lower-case hex. */
export const policyHash = (policy: unknown): string => createHash('sha256').update(canonicalPolicy(policy), 'utf8').digest('hex');
