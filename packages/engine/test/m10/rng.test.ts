// A-M10-01 logic 1: the golden test of the RNG. The expected values were printed by the official PCG32 reference C
// code (fixture provenance in fixtures/pcg32-golden.json; VERIFY V4 settled by building the reference once).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { createRng, nextBelow, PCG_STREAM } from '../../src/m10/rng.ts';

const G = JSON.parse(readFileSync(new URL('./fixtures/pcg32-golden.json', import.meta.url), 'utf8')) as {
  seed: number; stream: number; outputs: number[]; demo42: { u32: string[]; coins: string; rolls: number[] }; largeSeeds: Record<string, number[]>;
};

describe('A-M10-01 RNG (PCG32, reference pcg_basic.c)', () => {
  it('given seed 1, the first 1,000 outputs equal the golden list', () => {
    assert.equal(G.seed, 1);
    assert.equal(G.stream, PCG_STREAM);
    assert.equal(G.outputs.length, 1_000);
    const r = createRng(1);
    assert.equal(r.seed, 1);
    assert.deepEqual(Array.from({ length: 1_000 }, () => r.nextU32()), G.outputs);
  });

  it("reproduces the reference demo's fixed-seed line (42, 54), coin tosses and dice rolls", () => {
    const r = createRng(42);
    assert.deepEqual(Array.from({ length: 6 }, () => `0x${r.nextU32().toString(16).padStart(8, '0')}`), G.demo42.u32);
    assert.equal(Array.from({ length: 65 }, () => (nextBelow(r, 2) ? 'H' : 'T')).join(''), G.demo42.coins);
    assert.deepEqual(Array.from({ length: 33 }, () => nextBelow(r, 6) + 1), G.demo42.rolls);
  });

  it('seeds above 2^32 use the full 64-bit initial state', () => {
    for (const [seed, want] of Object.entries(G.largeSeeds)) {
      const r = createRng(Number(seed));
      assert.deepEqual([r.nextU32(), r.nextU32(), r.nextU32()], want);
    }
  });

  it('nextFloat is nextU32 / 2^32, in [0, 1)', () => {
    const a = createRng(9), b = createRng(9);
    for (let i = 0; i < 10_000; i++) {
      const f = a.nextFloat();
      assert.equal(f, b.nextU32() / 4_294_967_296);
      assert.ok(f >= 0 && f < 1);
    }
  });

  it('refuses a seed that is not a safe integer >= 0, and a bound outside 1..2^32', () => {
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 53]) assert.throws(() => createRng(bad), /seed/);
    assert.throws(() => nextBelow(createRng(1), 0), /1\.\.2\^32/);
    assert.throws(() => nextBelow(createRng(1), 2 ** 32 + 1), /1\.\.2\^32/);
    assert.equal(nextBelow(createRng(1), 1), 0);
  });
});
