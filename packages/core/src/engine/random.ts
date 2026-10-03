// The engine's only randomness: a seeded generator, so a recorded seed replays the same draws.
// sfc32 (Chris Doty-Humphrey's Small Fast Counter), seeded through the cyrb128 string hash.

export interface Rng {
  /** Uniform integer in [0, 2^32). */
  nextU32(): number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n), n a positive safe integer. */
  int(n: number): number;
}

const cyrb128 = (text: string): [number, number, number, number] => {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
};

export const createRng = (seed: string): Rng => {
  if (typeof seed !== 'string' || seed.length === 0) throw new TypeError('seed must be a non-empty string');
  let [a, b, c, d] = cyrb128(seed);
  const nextU32 = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  // Discard the first draws, as the sfc32 reference does, so similar seeds diverge.
  for (let i = 0; i < 12; i++) nextU32();
  return {
    nextU32,
    next: () => nextU32() / 4294967296,
    int: (n) => {
      if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`n must be a positive integer, got ${n}`);
      // Two draws give 53 bits; rejection keeps the result unbiased.
      const limit = Math.floor(Number.MAX_SAFE_INTEGER / n) * n;
      for (;;) {
        const x = (nextU32() >>> 11) * 4294967296 + nextU32();
        if (x < limit) return x % n;
      }
    },
  };
};
