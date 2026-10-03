// Seeded randomness. Every random draw in the stats module comes from an injected Rng, so the same seed
// gives the same result on every run. xoshiro128** (Blackman & Vigna, https://prng.di.unimi.it/xoshiro128starstar.c)
// seeded by splitmix32; two outputs are combined into one 53-bit double.

export interface Rng {
  /** A uniform double in [0, 1). */
  next(): number;
}

const splitmix32 = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
};

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

export const createRng = (seed: number): Rng => {
  if (!Number.isSafeInteger(seed)) throw new RangeError(`seed must be a safe integer, got ${seed}`);
  const init = splitmix32((seed ^ Math.floor(seed / 2 ** 32)) >>> 0);
  let a = init();
  let b = init();
  let c = init();
  let d = init();
  if ((a | b | c | d) === 0) a = 1;
  const nextU32 = (): number => {
    const result = Math.imul(rotl(Math.imul(b, 5) >>> 0, 7), 9) >>> 0;
    const t = (b << 9) >>> 0;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    return result;
  };
  return {
    next: () => ((nextU32() >>> 5) * 67108864 + (nextU32() >>> 6)) / 9007199254740992,
  };
};

/** A uniform integer in [0, n). */
export const nextInt = (rng: Rng, n: number): number => Math.floor(rng.next() * n);

/** A standard normal draw (Box–Muller, one value per call). */
export const nextNormal = (rng: Rng): number => {
  const u = 1 - rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
