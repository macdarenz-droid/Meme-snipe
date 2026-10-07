import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { canonicalJson } from '@bot/types';

describe('canonicalJson', () => {
  it('sorts keys at every level and writes no whitespace', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('writes bigint as a decimal string, including u64 max and negatives', () => {
    assert.equal(canonicalJson({ v: 18446744073709551615n, n: -5n, z: 0n }), '{"n":"-5","v":"18446744073709551615","z":"0"}');
  });

  it('writes null explicitly, booleans and finite numbers as JSON does', () => {
    assert.equal(canonicalJson({ a: null, b: true, c: false, d: 1.5, e: -0, f: 1e21 }), '{"a":null,"b":true,"c":false,"d":1.5,"e":0,"f":1e+21}');
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson('x'), '"x"');
  });

  it('escapes strings as JSON.stringify does', () => {
    assert.equal(canonicalJson({ 'k"\n': 'é\u0001\ud800' }), '{"k\\"\\n":"é\\u0001\\ud800"}');
  });

  it('orders keys by UTF-16 code unit', () => {
    assert.equal(canonicalJson({ b: 1, B: 2, 'é': 3, a: 4, '10': 5, '9': 6 }), '{"10":5,"9":6,"B":2,"a":4,"b":1,"é":3}');
  });

  it('omits object properties whose value is undefined', () => {
    assert.equal(canonicalJson({ a: undefined, b: 1 }), canonicalJson({ b: 1 }));
  });

  it('accepts null-prototype objects and shared (non-cyclic) references', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o['k'] = 1;
    const shared = { x: 1 };
    assert.equal(canonicalJson({ o, p: [shared, shared] }), '{"o":{"k":1},"p":[{"x":1},{"x":1}]}');
  });

  it('throws on values without one exact JSON meaning, naming the path', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const cases: Array<[unknown, RegExp]> = [
      [undefined, /unsupported undefined at \$$/],
      [{ a: [1, undefined] }, /unsupported undefined at \$\.a\[1\]/],
      [[1, , 3], /unsupported undefined at \$\[1\]/],
      [{ a: Number.NaN }, /non-finite number at \$\.a/],
      [{ a: Number.POSITIVE_INFINITY }, /non-finite number/],
      [{ f: () => 1 }, /unsupported function at \$\.f/],
      [{ s: Symbol('s') }, /unsupported symbol/],
      [{ m: new Map() }, /not a plain object at \$\.m/],
      [{ d: new Date(0) }, /not a plain object/],
      [{ u: new Uint8Array(1) }, /not a plain object/],
      [cyclic, /cycle at \$\.self/],
    ];
    for (const [value, message] of cases) assert.throws(() => canonicalJson(value), (e: unknown) => e instanceof TypeError && message.test(e.message));
  });

  it('throws on symbol keys, accessors, non-enumerable and non-index array properties, and Array subclasses (C01 red-team m6)', () => {
    const arr: unknown[] & { extra?: number } = [1];
    arr.extra = 2;
    const big = [1];
    Object.defineProperty(big, '4294967295', { value: 1, enumerable: true });
    let reads = 0;
    const getter = { get v() { reads++; return reads; } };
    const hidden = Object.defineProperty({ a: 1 }, 'h', { value: 2, enumerable: false });
    const indexGetter = Object.defineProperty([0], '0', { get: () => 1, enumerable: true });
    const hiddenIndex = Object.defineProperty([0, 1], '1', { value: 2, enumerable: false });
    const holeAndExtra: unknown[] & { x?: number } = [1, , ];               // own keys: 0, length, x — as many as a full array
    holeAndExtra.x = 1;
    class List extends Array<number> {}
    const cases: Array<[unknown, RegExp]> = [
      [{ [Symbol('s')]: 1, a: 1 }, /symbol key at \$$/],
      [{ a: [Object.assign([1], { [Symbol('t')]: 2 })] }, /symbol key at \$\.a\[0\]/],
      [arr, /array property that is not an index at \$$/],
      [big, /array property that is not an index/],
      [getter, /accessor property at \$$/],
      [{ o: Object.defineProperty({}, 's', { set: () => undefined, enumerable: true }) }, /accessor property at \$\.o/],
      [indexGetter, /accessor property/],
      [hiddenIndex, /non-enumerable property at \$$/],
      [holeAndExtra, /array property that is not an index at \$$/],
      [hidden, /non-enumerable property/],
      [List.from([1]), /not a plain array/],
    ];
    for (const [value, message] of cases) assert.throws(() => canonicalJson(value), (e: unknown) => e instanceof TypeError && message.test(e.message), String(message));
    assert.equal(reads, 0, 'no getter runs');
    assert.equal(canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":1}')), '{"__proto__":{"x":1},"a":1}');
    assert.equal(canonicalJson(Object.assign(Object.create(null) as object, { b: [1, [2]], a: 0 })), '{"a":0,"b":[1,[2]]}');
  });

  it('reads each property through its own descriptor, never a bulk copy of every descriptor (C01 review R7)', () => {
    const bulk = Object.getOwnPropertyDescriptors;
    let calls = 0;
    Object.getOwnPropertyDescriptors = ((o: object) => { calls++; return bulk(o); }) as typeof bulk;
    try {
      assert.equal(canonicalJson({ b: [1, [2, { c: 3 }]], a: Object.assign(Object.create(null) as object, { d: 'x' }) }), '{"a":{"d":"x"},"b":[1,[2,{"c":3}]]}');
    } finally {
      Object.getOwnPropertyDescriptors = bulk;
    }
    assert.equal(calls, 0);
  });

  it('never echoes a value in an error', () => {
    assert.throws(() => canonicalJson({ secretish: [Number.NaN] }), (e: Error) => !e.message.includes('NaN'));
  });

  it('is independent of key insertion order and parses back to the same data (property)', () => {
    const leaf = fc.oneof(fc.string(), fc.boolean(), fc.constant(null), fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.bigInt());
    const tree = fc.letrec((tie) => ({
      node: fc.oneof({ depthSize: 'small' }, leaf, fc.array(tie('node')), fc.dictionary(fc.string(), tie('node'))),
    })).node;
    fc.assert(fc.property(tree, (value) => {
      const text = canonicalJson(value);
      assert.equal(canonicalJson(reverseKeys(value)), text);
      assert.deepEqual(JSON.parse(text), toJsonData(value));
      assert.ok(!/\s/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '')), 'no whitespace outside strings');
    }), { seed: 20261006, numRuns: 500 });
  });
});

function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).reverse()) Object.defineProperty(out, k, { value: reverseKeys((v as Record<string, unknown>)[k]), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}

function toJsonData(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Object.is(v, -0) ? 0 : v;
  if (Array.isArray(v)) return v.map(toJsonData);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) Object.defineProperty(out, k, { value: toJsonData((v as Record<string, unknown>)[k]), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}
