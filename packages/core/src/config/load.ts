// Policy files: stored as canonical text (bigint as decimal strings) and loaded back with every check applied.
import { canonicalPolicy, policyHash } from './hash.ts';
import { TRIAL_POLICY, type Policy } from './policy.ts';
import { PolicyError, assertValidPolicy } from './validate.ts';

/** Keys that change an object's behaviour rather than hold a value. Never allowed in a policy file. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A strict JSON reader. Unlike JSON.parse it refuses duplicate keys (the last one would silently win) and unsafe keys, and it
 * builds objects with defineProperty so a key can never reach the prototype.
 */
const parseStrict = (text: string): unknown => {
  let i = 0;
  const fail = (message: string): never => { throw new PolicyError([`policy text: ${message} (at character ${i})`]); };
  const space = (): void => { while (i < text.length && ' \t\n\r'.includes(text[i] as string)) i++; };
  const string = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail('unterminated string');
    i++;
    try { return JSON.parse(text.slice(start, i)) as string; } catch { return fail('bad string'); }
  };
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = (depth: number): unknown => {
    if (depth > 20) fail('nested too deeply');
    space();
    const c = text[i];
    if (c === '{') {
      i++;
      const out: Record<string, unknown> = {};
      space();
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        space();
        if (text[i] !== '"') fail('expected a key');
        const key = string();
        if (UNSAFE_KEYS.has(key)) fail(`the key "${key}" is not allowed`);
        if (Object.hasOwn(out, key)) fail(`duplicate key "${key}"`);
        space();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        space();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return out; }
        return fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const out: unknown[] = [];
      space();
      if (text[i] === ']') { i++; return out; }
      for (;;) {
        out.push(value(depth + 1));
        space();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return out; }
        return fail('expected "," or "]"');
      }
    }
    if (c === '"') return string();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, i)) { i += word.length; return v; }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return fail('unexpected character');
    i += m[0].length;
    return Number(m[0]);
  };
  const result = value(0);
  space();
  if (i < text.length) fail('unexpected text after the policy');
  return result;
};

/** Revives bigint fields (stored as decimal strings) using the trial policy as the template for field types. */
const revive = (template: unknown, value: unknown, path: string): unknown => {
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) throw new PolicyError([`${path}: must be a list`]);
    return value.map((v, i) => revive(template[0], v, `${path}[${i}]`));
  }
  if (typeof template === 'object' && template !== null) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PolicyError([`${path}: must be an object`]);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Object.hasOwn(template, k) ? revive((template as Record<string, unknown>)[k], v, `${path}.${k}`) : v]));
  }
  if (typeof template === 'bigint') {
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new PolicyError([`${path}: must be a whole number written as text`]);
    return BigInt(value);
  }
  return value;
};

/** The text a policy is saved as. The same text always hashes to the same version. */
export const savePolicy = (policy: Policy): string => canonicalPolicy(assertValidPolicy(structuredClone(policy)));

/** Parses and validates saved policy text, with the same checks as a policy built in code. Throws PolicyError on anything wrong. */
export const loadPolicy = (text: string): { readonly policy: Policy; readonly versionHash: string } => {
  const policy = assertValidPolicy(revive(TRIAL_POLICY, parseStrict(text), 'policy'));
  return { policy, versionHash: policyHash(policy) };
};
