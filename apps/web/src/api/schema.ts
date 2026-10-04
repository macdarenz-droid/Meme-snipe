import { isDec, isUsd } from '../lib/money.ts';
import type { Mode } from './contract.ts';

export class DataError extends Error {
  readonly kind: 'mixed-modes' | 'bad-money' | 'bad-shape';
  constructor(kind: DataError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Small strict schema checkers for everything the app reads. An object must
 * have exactly the listed fields; any unknown, missing or mistyped field throws
 * DataError, so a response is used whole or not at all.
 */

export type Check = (v: unknown, path: string) => void;

export const fail = (path: string, why: string, kind: DataError['kind'] = 'bad-shape'): never => {
  throw new DataError(kind, `${path}: ${why}`);
};

export const str: Check = (v, p) => {
  if (typeof v !== 'string' || v.length === 0 || v.length > 500) fail(p, 'expected text');
};
export const int: Check = (v, p) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(p, 'expected a whole number ≥ 0');
};
export const bool: Check = (v, p) => {
  if (typeof v !== 'boolean') fail(p, 'expected true or false');
};
export const usd: Check = (v, p) => {
  if (!isUsd(v)) fail(p, 'expected an exact dollar amount as text', 'bad-money');
};
/** Lamports: an exact integer as text, "-180000000" (no leading zeros, no fraction). */
export const lamports: Check = (v, p) => {
  if (typeof v !== 'string' || !/^-?(0|[1-9]\d*)$/.test(v) || v === '-0') fail(p, 'expected an exact lamport amount as text', 'bad-money');
};
export const dec: Check = (v, p) => {
  if (!isDec(v)) fail(p, 'expected an exact decimal as text', 'bad-money');
};
export const iso: Check = (v, p) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(v) || Number.isNaN(Date.parse(v))) fail(p, 'expected a UTC time');
};
export const day: Check = (v, p) => {
  if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v)) fail(p, 'expected a YYYY-MM-DD day');
};
export const re =
  (pattern: RegExp, what: string): Check =>
  (v, p) => {
    if (typeof v !== 'string' || !pattern.test(v)) fail(p, `expected ${what}`);
  };
export const oneOf =
  (...values: readonly unknown[]): Check =>
  (v, p) => {
    if (!values.includes(v)) fail(p, `expected one of ${values.join(', ')}`);
  };
export const nullable =
  (c: Check): Check =>
  (v, p) => {
    if (v !== null) c(v, p);
  };
export const arr =
  (c: Check, max = 200_000): Check =>
  (v, p) => {
    if (!Array.isArray(v)) return fail(p, 'expected a list');
    if (v.length > max) fail(p, `more than ${max} items`);
    v.forEach((x, i) => c(x, `${p}[${i}]`));
  };
const OPTIONAL = Symbol('optional');
/** A field that may be absent (a worker older than the field); when present it must pass `c`. */
export const optional = (c: Check): Check => Object.assign((v: unknown, p: string) => c(v, p), { [OPTIONAL]: true });
const isOptional = (c: Check): boolean => (c as Check & { [OPTIONAL]?: boolean })[OPTIONAL] === true;

export const obj =
  (shape: Record<string, Check>): Check =>
  (v, p) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(p, 'expected an object');
    const o = v as Record<string, unknown>;
    // Own keys only: `in` would also match Object.prototype names such as constructor or toString.
    for (const k of Object.keys(o)) if (!Object.hasOwn(shape, k)) fail(`${p}.${k}`, 'unknown field');
    for (const [k, c] of Object.entries(shape)) {
      if (!Object.hasOwn(o, k)) {
        if (isOptional(c)) continue;
        fail(`${p}.${k}`, 'missing');
      }
      c(o[k], `${p}.${k}`);
    }
  };

/** A record's mode: a wrong mode is a mixed-mode error, not a shape error. */
export const modeIs =
  (m: Mode): Check =>
  (v, p) => {
    if (v !== m) fail(p, `mode is ${String(v)}, expected ${m}`, 'mixed-modes');
  };

