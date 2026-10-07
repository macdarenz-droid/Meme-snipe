// The one canonical-JSON serialiser (B-M19-01 logic 1; ARCH 5.0b I-19). Every hash in both groups is computed
// over this output: config versions, manifests, trial keys, bundles and the audit chain.
//
// Rules: object keys sorted at every level (UTF-16 code-unit order, the JavaScript default and RFC 8785's order);
// no insignificant whitespace; bigint written as a JSON string of its decimal digits; null written explicitly;
// strings and finite numbers written as JSON.stringify writes them (so -0 becomes 0).
// An object property whose value is undefined is absent, as in JSON. Anything without one exact JSON meaning
// throws a TypeError (a programmer error): non-finite numbers, undefined in an array or at the top level,
// functions, symbols, cycles, and objects that are not plain objects or arrays (Map, Set, Date, typed arrays,
// class instances, Array subclasses). So do properties JSON.stringify would silently drop or that could read
// differently on each call: symbol keys, non-enumerable properties, array properties that are not indexes, and
// accessor (getter or setter) properties. Error messages name the path, never the value.
//
// Cost (C01 review finding R7): each property is read through its own descriptor, never a bulk copy of all
// descriptors; an array whose own keys are exactly its indexes and `length` (the usual case) is read index by index,
// and a path is only spelled out when it is needed (a nested container or an error).

export function canonicalJson(value: unknown): string {
  return write(value, '$', null, new Set<object>());
}

/** The path of a value from its container's path and its key (a number for an array index). */
function pathOf(parent: string, key: string | number | null): string {
  return key === null ? parent : typeof key === 'number' ? `${parent}[${key}]` : `${parent}.${key}`;
}

function write(value: unknown, parent: string, key: string | number | null, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return `"${value.toString()}"`;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${pathOf(parent, key)}`);
      return JSON.stringify(value);
    case 'object':
      if (value === null) return 'null';
      return writeObject(value, pathOf(parent, key), ancestors);
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${pathOf(parent, key)}`);
  }
}

const INDEX = /^(0|[1-9]\d*)$/;

/** The value of a data property; throws on an accessor (no getter runs) or a non-enumerable property. */
function dataValue(d: PropertyDescriptor, path: string): unknown {
  if (!('value' in d)) throw new TypeError(`canonicalJson: accessor property at ${path}`);
  if (d.enumerable !== true) throw new TypeError(`canonicalJson: non-enumerable property at ${path}`);
  return d.value;
}

/**
 * The items of a plain array, each read once through its descriptor. Throws on a symbol key, an accessor, a
 * non-enumerable property, or a key that is not an index; a hole reads as undefined (which write() refuses).
 */
function arrayItems(value: unknown[], path: string): unknown[] {
  const n = value.length;
  const keys = Reflect.ownKeys(value);
  const items = new Array<unknown>(n);
  if (keys.length === n + 1) {
    // n + 1 own keys and every index present: the keys are exactly the indexes and `length`.
    let i = 0;
    for (; i < n; i++) {
      const d = Object.getOwnPropertyDescriptor(value, i);
      if (d === undefined) break;
      items[i] = dataValue(d, path);
    }
    if (i === n) return items;
  }
  for (const key of keys) {
    if (typeof key === 'symbol') throw new TypeError(`canonicalJson: symbol key at ${path}`);
    if (key === 'length') continue;
    if (!(INDEX.test(key) && Number(key) < n)) throw new TypeError(`canonicalJson: array property that is not an index at ${path}`);
    items[Number(key)] = dataValue(Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor, path);
  }
  return items;
}

/** The own properties of a plain object as [key, value] pairs, each read once through its descriptor. */
function objectEntries(value: object, path: string): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new TypeError(`canonicalJson: symbol key at ${path}`);
    out.push([key, dataValue(Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor, path)]);
  }
  return out;
}

function writeObject(value: object, path: string, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw new TypeError(`canonicalJson: cycle at ${path}`);
  ancestors.add(value);
  let out: string;
  const proto: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (proto !== Array.prototype) throw new TypeError(`canonicalJson: not a plain array at ${path}`);
    const items = arrayItems(value, path);
    const parts = new Array<string>(items.length);
    for (let i = 0; i < items.length; i++) parts[i] = write(items[i], path, i, ancestors);
    out = `[${parts.join(',')}]`;
  } else {
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`canonicalJson: not a plain object at ${path}`);
    const parts: string[] = [];
    for (const [key, v] of objectEntries(value, path).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${write(v, path, key, ancestors)}`);
    }
    out = `{${parts.join(',')}}`;
  }
  ancestors.delete(value);
  return out;
}
