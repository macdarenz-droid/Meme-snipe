// Runtime trap: while engine code runs, every way to read the clock, draw unseeded randomness, schedule work,
// format by locale or load a module throws. The static purity guard cannot be complete; this catches what it
// misses on every code path the tests run.
const TIMERS = ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] as const;

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
  return () => {
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
