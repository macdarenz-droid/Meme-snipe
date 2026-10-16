// Card Z10 (plan Q1): pda.ts, the PDA derivation with Node built-ins only, against @solana/kit 8.3.0 (the function it
// replaces at runtime). Seeds are deterministic (a sha256 chain), so every run checks the same 10,000 cases.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { getProgramDerivedAddress, isOffCurveAddress, type Address } from '@solana/kit';
import { base58 } from '@bot/decoders';
import type { Pubkey } from '@bot/types';
import { ACCOUNTS, PDAS, PROGRAMS, REFERENCE_PDAS, derivePda } from '../src/constants.ts';
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
  }, 60_000);

  it('refuses seeds the runtime refuses: more than 15 before the bump, or one longer than 32 bytes', () => {
    assert.throws(() => findProgramAddress(PROGRAMS.pumpSwap as Pubkey, Array.from({ length: 16 }, () => 'a')), /at most 15/);
    assert.throws(() => findProgramAddress(PROGRAMS.pumpSwap as Pubkey, [new Uint8Array(33)]), /at most 32/);
  });

  it('ruling Z10-4: every EX-01 PDA from pda.ts itself equals its literal, with bumps 255, 255, 253, 255', () => {
    assert.deepEqual(PDAS.map((p) => findProgramAddress(p.program, p.seeds())), PDAS.map((p) => ({ address: ACCOUNTS[p.name], bump: p.bump })));
    assert.deepEqual(PDAS.map((p) => p.bump), [255, 255, 253, 255]);
  });

  it('ruling Z10-4, bump search edges: a deep search (bump 250 or lower), no seeds, and the most seeds the runtime takes (15 of 32 bytes)', async () => {
    const kit = async (program: Pubkey, seeds: Array<string | Uint8Array>) => {
      const [address, bump] = await getProgramDerivedAddress({ programAddress: program as Address, seeds });
      return { address, bump };
    };
    // The first seeds of a fixed chain whose search runs past 5 on-curve hashes (probability about 1/64 each).
    const next = chain('z10-deep');
    let deep: Uint8Array | null = null;
    for (let i = 0; i < 2_000 && deep === null; i++) {
      const s = new Uint8Array(next());
      if (findProgramAddress(PROGRAMS.pumpSwap as Pubkey, [s]).bump <= 250) deep = s;
    }
    assert.ok(deep !== null, 'no deep search in 2,000 tries');
    assert.deepEqual(findProgramAddress(PROGRAMS.pumpSwap as Pubkey, [deep]), await kit(PROGRAMS.pumpSwap as Pubkey, [deep]));
    assert.deepEqual(findProgramAddress(PROGRAMS.pumpSwap as Pubkey, []), await kit(PROGRAMS.pumpSwap as Pubkey, []));
    const full = Array.from({ length: 15 }, () => new Uint8Array(next()));
    assert.deepEqual(findProgramAddress(PROGRAMS.pumpCurve as Pubkey, full), await kit(PROGRAMS.pumpCurve as Pubkey, full));
    assert.deepEqual(findProgramAddress(PROGRAMS.pumpCurve as Pubkey, [new Uint8Array(32), '']), await kit(PROGRAMS.pumpCurve as Pubkey, [new Uint8Array(32), '']));
  });

  it('ruling Z10-4, mutation: each mutant of the curve check (flipped, the zero case, the sign bit) is caught by the kit cross-check', async () => {
    const src = readFileSync(fileURLToPath(new URL('../src/pda.ts', import.meta.url)), 'utf8');
    const mutants: Array<[string, string, string]> = [
      ['flipped', 'return pow(w, (P - 1n) / 2n) === 1n;', 'return pow(w, (P - 1n) / 2n) !== 1n;'],
      ['zero case', 'if (w === 0n) return true;', 'if (w === 0n) return false;'],
      ['sign bit kept', 'y &= (1n << 255n) - 1n;', 'y &= (1n << 256n) - 1n;'],
    ];
    for (const [name, from, to] of mutants) {
      assert.equal(src.split(from).length, 2, `${name}: the line is in pda.ts once`);
      const file = fileURLToPath(new URL(`./.mutant-${name.replace(/ /g, '-')}.ts`, import.meta.url));
      writeFileSync(file, src.replace(from, to));
      try {
        const m = (await import(file)) as typeof import('../src/pda.ts');
        const next = chain('z10-mutant');
        let caught = 0;
        for (let i = 0; i < 2_000; i++) {
          const b = new Uint8Array(next());
          if (i % 4 === 0) b[31] = (b[31] as number) | 0x80;                 // half of the checks with the sign bit set
          if (i === 0) b.fill(0).set([1]);                                      // y = 1: x² = 0, the zero case
          if (m.isOnCurve(b) !== !isOffCurveAddress(base58.encode(b) as Address)) caught++;
        }
        assert.ok(caught > 0, `${name}: the mutant was not caught`);
      } finally {
        rmSync(file, { force: true });
      }
    }
  }, 60_000);
});
