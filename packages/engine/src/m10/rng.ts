// The one random generator of simulation and research code (A-M10-01 logic 1; ARCH 5.0a `Rng`). PCG32
// (PCG-XSH-RR 64/32, M. E. O'Neill), exactly as the official reference `pcg_basic.c` of github.com/imneme/pcg-c-basic
// (Apache-2.0): step `state = oldstate × 6364136223846793005 + inc` (mod 2^64); output `((oldstate >> 18) ^ oldstate)
// >> 27` rotated right by `oldstate >> 59`; seeding `pcg32_srandom_r(initstate, initseq)`: state 0, `inc = (initseq <<
// 1) | 1`, one step, `state += initstate`, one step. `createRng(seed)` is `pcg32_srandom_r(seed, 54)`: 54 is the
// stream of the reference demo (`pcg32-demo.c`), so `createRng(42)` prints the demo's first line (0xa15c02b7 ...).
// The golden test pins the first 1,000 outputs for seed 1, printed by the reference C code (VERIFY V4, settled in the
// Z06 pull request). 64-bit arithmetic is done in two 32-bit halves (no BigInt on the hot path).
import type { Rng } from '@bot/types';

/** The PCG stream every `createRng` uses (the reference demo's `initseq`). */
export const PCG_STREAM = 54;
// 6364136223846793005 = 0x5851F42D_4C957F2D, PCG's 64-bit LCG multiplier, as two 32-bit halves.
const MUL_HI = 0x5851f42d;
const MUL_LO = 0x4c957f2d;
const TWO_POW_32 = 4_294_967_296;

/** A PCG32 generator for `seed`, a safe integer ≥ 0 (the reference's `initstate`). */
export function createRng(seed: number): Rng {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new RangeError('seed must be a safe integer >= 0');
  // inc = (54 << 1) | 1 = 109, as two 32-bit halves.
  const incHi = Math.floor(PCG_STREAM / 2_147_483_648) >>> 0;
  const incLo = ((PCG_STREAM * 2) % TWO_POW_32 | 1) >>> 0;
  // The 64-bit state as [hi, lo] in a typed array: closure variables above 2^31 would be boxed on every step.
  const st = new Uint32Array(2);
  const step = (): number => {
    const oldHi = st[0] as number, oldLo = st[1] as number;
    // state = old × MUL + inc (mod 2^64). oldLo × MUL_LO as a full 64-bit product, from 16-bit pieces.
    const a0 = oldLo & 0xffff, a1 = oldLo >>> 16;
    const p00 = a0 * 0x7f2d, p01 = a0 * 0x4c95, p10 = a1 * 0x7f2d, p11 = a1 * 0x4c95;   // MUL_LO = 0x4c95_7f2d
    const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);            // < 3 × 2^16
    const prodLo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
    const prodHi = p11 + (p01 >>> 16) + (p10 >>> 16) + Math.floor(mid / 65_536);
    const sumLo = prodLo + incLo;                                            // < 2^33
    // The cross terms reach only the high word (mod 2^32).
    st[0] = prodHi + Math.imul(oldHi, MUL_LO) + Math.imul(oldLo, MUL_HI) + incHi + (sumLo >= TWO_POW_32 ? 1 : 0);   // stored mod 2^32
    st[1] = sumLo;
    // xorshifted = ((old >> 18) ^ old) >> 27, truncated to 32 bits: bits 27..58 of (old >> 18) ^ old.
    const xHi = ((oldHi >>> 18) ^ oldHi) >>> 0, xLo = (((oldLo >>> 18) | (oldHi << 14)) ^ oldLo) >>> 0;
    const xorshifted = ((xLo >>> 27) | (xHi << 5)) >>> 0;
    const rot = oldHi >>> 27;                                                // old >> 59
    return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0;
  };
  // pcg32_srandom_r: state 0, one step, state += initstate, one step.
  step();
  const sum = (st[1] as number) + (seed % TWO_POW_32);
  st[1] = sum;
  st[0] = (st[0] as number) + Math.floor(seed / TWO_POW_32) + (sum >= TWO_POW_32 ? 1 : 0);
  step();
  return {
    seed,
    nextU32: step,
    nextFloat: () => step() / TWO_POW_32,
  };
}

/** A uniform integer in [0, n), n a positive integer ≤ 2^32, without modulo bias (the reference's bounded draw). */
export function nextBelow(rng: Rng, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > TWO_POW_32) throw new RangeError('n must be an integer in 1..2^32');
  const threshold = (TWO_POW_32 - n) % n;
  for (;;) {
    const r = rng.nextU32();
    if (r >= threshold) return r % n;
  }
}
