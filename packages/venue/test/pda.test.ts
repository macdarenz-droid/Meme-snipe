// Card Z10 (plan Q1): pda.ts, the PDA derivation with Node built-ins only, against @solana/kit 8.3.0 (the function it
// replaces at runtime). Seeds are deterministic (a sha256 chain), so every run checks the same 10,000 cases.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'vitest';
import { getProgramDerivedAddress, isOffCurveAddress, type Address } from '@solana/kit';
import { base58 } from '@bot/decoders';
import type { Pubkey } from '@bot/types';
import { PDAS, PROGRAMS, REFERENCE_PDAS, derivePda } from '../src/constants.ts';
import { findProgramAddress, isOnCurve } from '../src/pda.ts';

const chain = (label: string) => {
  let h = createHash('sha256').update(label).digest();
  return (): Buffer => { h = createHash('sha256').update(h).digest(); return h; };
};

describe('pda.ts against @solana/kit', () => {
  it('every PDA of constants.ts: the same address and bump as @solana/kit', async () => {
    for (const p of [...PDAS, ...REFERENCE_PDAS]) {
      const [kitAddress, kitBump] = await getProgramDerivedAddress({ programAddress: p.program as Address, seeds: [...p.seeds()] });
      const ours = await derivePda(p.program, p.seeds());
      assert.deepEqual(ours, { address: kitAddress, bump: kitBump }, p.name);
      assert.equal(ours.bump, p.bump, p.name);
    }
  });

  it('10,000 seed sets (1-4 seeds of 0-32 bytes, strings and bytes, four programs): the same address and bump', async () => {
    const next = chain('z10-pda');
    const programs = [PROGRAMS.pumpCurve, PROGRAMS.pumpSwap, PROGRAMS.orcaWhirlpools, PROGRAMS.splToken] as Pubkey[];
    let lowBumps = 0;
    for (let i = 0; i < 10_000; i++) {
      const r = next();
      const n = 1 + ((r[0] as number) % 4);
      const seeds: Array<string | Uint8Array> = [];
      for (let k = 0; k < n; k++) {
        const b = next();
        const len = (b[0] as number) % 33;
        seeds.push((b[1] as number) % 4 === 0 ? b.subarray(2, 2 + Math.min(len, 30)).toString('hex').slice(0, len) : new Uint8Array(b.subarray(0, len)));
      }
      const program = programs[i % programs.length] as Pubkey;
      const [kitAddress, kitBump] = await getProgramDerivedAddress({ programAddress: program as Address, seeds });
      const ours = findProgramAddress(program, seeds);
      if (ours.address !== kitAddress || ours.bump !== kitBump) assert.fail(`case ${i}: ${JSON.stringify({ ours, kitAddress, kitBump })}`);
      if (kitBump < 255) lowBumps++;
    }
    // About half of all hashes are on the curve, so bumps below 255 must have been exercised many times.
    assert.ok(lowBumps > 3_000, `bumps below 255: ${lowBumps}`);
  }, 120_000);

  it('the on-curve test agrees with @solana/kit on 10,000 random 32-byte strings and on known points', () => {
    const next = chain('z10-curve');
    let on = 0;
    for (let i = 0; i < 10_000; i++) {
      const b = new Uint8Array(next());
      const kit = !isOffCurveAddress(base58.encode(b) as Address);
      assert.equal(isOnCurve(b), kit, `case ${i}`);
      if (kit) on++;
    }
    assert.ok(on > 4_000 && on < 6_000, `on curve ${on}`);
    // A real wallet key is a curve point; a PDA never is.
    assert.equal(isOnCurve(new Uint8Array(32)), true, 'y = 0 decompresses (x² = 1)');
    assert.equal(isOnCurve(new Uint8Array(31)), false);
  });

  it('refuses seeds the runtime refuses: more than 15 before the bump, or one longer than 32 bytes', () => {
    assert.throws(() => findProgramAddress(PROGRAMS.pumpSwap as Pubkey, Array.from({ length: 16 }, () => 'a')), /at most 15/);
    assert.throws(() => findProgramAddress(PROGRAMS.pumpSwap as Pubkey, [new Uint8Array(33)]), /at most 32/);
  });
});
