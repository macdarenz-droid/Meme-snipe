// Runtime trap: while engine code runs, every way to read the clock, draw unseeded randomness, schedule work,
// format by locale or load a module throws. The static purity guard cannot be complete; this catches what it
// misses on every code path the tests run.
const TIMERS = ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] as const;

/** Prototype methods whose result depends on the machine's locale or time zone; computed keys reach them past the scanner. */
const LOCALE_METHODS: readonly (readonly [object, string, readonly string[]])[] = [
  [Number.prototype, 'Number', ['toLocaleString']],
  [BigInt.prototype, 'BigInt', ['toLocaleString']],
  [Array.prototype, 'Array', ['toLocaleString']],
  [String.prototype, 'String', ['localeCompare', 'toLocaleUpperCase', 'toLocaleLowerCase']],
  [Date.prototype, 'Date', [
    'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'toString', 'toDateString', 'toTimeString', 'getTimezoneOffset',
    'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds',
    'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds',
  ]],
];

const fail = (name: string) => () => { throw new Error(`trap: ${name} called while engine code runs`); };

let depth = 0;
let restore: (() => void) | null = null;

const install = (): (() => void) => {
  const g = globalThis as Record<string, unknown>;
  const proc = process as unknown as Record<string, unknown>;
  const perf = performance as unknown as Record<string, unknown>;
  const webCrypto = globalThis.crypto as unknown as Record<string, unknown>;
  const RealDate = Date;
  const saved = {
    Date: g.Date, Intl: g.Intl, random: Math.random, perfNow: perf.now, nextTick: proc.nextTick, hrtime: proc.hrtime,
    getBuiltinModule: proc.getBuiltinModule, getRandomValues: webCrypto.getRandomValues, randomUUID: webCrypto.randomUUID,
    timers: TIMERS.map((t) => g[t]),
  };
  class TrapDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) throw new Error('trap: new Date() without an argument called while engine code runs');
      super(...(args as [number]));
    }
    static override now(): number { throw new Error('trap: Date.now called while engine code runs'); }
  }
  g.Date = TrapDate;
  g.Intl = new Proxy({}, { get: (_t, p) => fail(`Intl.${String(p)}`)() });
  Math.random = fail('Math.random');
  perf.now = fail('performance.now');
  proc.nextTick = fail('process.nextTick');
  proc.hrtime = Object.assign(fail('process.hrtime'), { bigint: fail('process.hrtime.bigint') });
  proc.getBuiltinModule = fail('process.getBuiltinModule');
  webCrypto.getRandomValues = fail('crypto.getRandomValues');
  webCrypto.randomUUID = fail('crypto.randomUUID');
  for (const t of TIMERS) g[t] = fail(t);
  const savedEnv = proc.env;
  proc.env = new Proxy({}, { get: (_t, p) => fail(`process.env.${String(p)}`)(), has: (_t, p) => fail(`process.env.${String(p)}`)(), ownKeys: () => fail('process.env')() });
  const savedMethods: (readonly [Record<string, unknown>, string, unknown])[] = [];
  for (const [proto, owner, names] of LOCALE_METHODS) {
    const target = proto as Record<string, unknown>;
    for (const name of names) {
      savedMethods.push([target, name, target[name]]);
      target[name] = fail(`${owner}.prototype.${name}`);
    }
  }
  return () => {
    proc.env = savedEnv;
    for (const [target, name, original] of savedMethods) target[name] = original;
    g.Date = saved.Date;
    g.Intl = saved.Intl;
    Math.random = saved.random;
    perf.now = saved.perfNow;
    proc.nextTick = saved.nextTick;
    proc.hrtime = saved.hrtime;
    proc.getBuiltinModule = saved.getBuiltinModule;
    webCrypto.getRandomValues = saved.getRandomValues;
    webCrypto.randomUUID = saved.randomUUID;
    TIMERS.forEach((t, k) => { g[t] = saved.timers[k]; });
  };
};

/** Runs `fn` with the traps set. Nested calls share one installation. */
export const trapped = <T>(fn: () => T): T => {
  if (depth++ === 0) restore = install();
  try {
    return fn();
  } finally {
    if (--depth === 0) {
      restore?.();
      restore = null;
    }
  }
};

/** Wraps each named method of a class prototype so every call runs inside the trap. */
export const trapMethods = (proto: object, names: readonly string[]): void => {
  const target = proto as Record<string, unknown>;
  for (const name of names) {
    const original = target[name];
    if (typeof original !== 'function') throw new TypeError(`no method ${name} to trap`);
    target[name] = function (this: unknown, ...args: unknown[]) {
      return trapped(() => (original as (...a: unknown[]) => unknown).apply(this, args));
    };
  }
};

/**
 * The Function constructor, reached as `fn.constructor` (also through a computed key such as
 * `fn['con' + 'structor']`), compiles any string, so it is closed for the whole test run, config and
 * every other module included, not only inside the trap. The async, generator and async-generator
 * function constructors too.
 */
export const closeFunctionConstructors = (): void => {
  const prototypes = [
    Function.prototype,
    Object.getPrototypeOf(async () => {}) as object,
    Object.getPrototypeOf(function* () {}) as object,
    Object.getPrototypeOf(async function* () {}) as object,
  ];
  for (const proto of prototypes) {
    Object.defineProperty(proto, 'constructor', { value: fail('the Function constructor'), writable: false, configurable: false });
  }
};
