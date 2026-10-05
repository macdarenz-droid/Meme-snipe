// G4c: a recording's saved-state copy is packed by streaming, checked to decompress to exactly the plain bytes, and only
// then is the plain copy removed; any failure keeps the plain copy and leaves no partial file.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { packFile, zstdContentHash } from '../src/persist/index.ts';
import { tempState } from './worker-harness.ts';

const hashOf = (b: Buffer) => ({ bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') });

describe('packing the saved-state copy (G4c)', () => {
  const plain = Buffer.from(Array.from({ length: 50_000 }, (_, i) => `{"row":${i},"creator":"C${i % 977}"}`).join('\n'));

  it('writes <file>.zst that decompresses to the same bytes, removes the plain copy, and reports both hashes', async () => {
    const dir = tempState();
    const p = join(dir, 'deployer-state.json');
    writeFileSync(p, plain);
    const r = await packFile(p, hashOf(plain));
    const packed = readFileSync(`${p}.zst`);
    expect(zstdDecompressSync(packed).equals(plain)).toBe(true);
    expect(r).toEqual({ packed: hashOf(packed), content: hashOf(plain) });
    expect(packed.length).toBeLessThan(plain.length / 4);
    expect(readdirSync(dir)).toEqual(['deployer-state.json.zst']);
    expect(await zstdContentHash(`${p}.zst`)).toEqual(hashOf(plain));
  });

  it('a copy that does not decompress to the bytes the seed names is not packed: the plain copy stays, no partial file', async () => {
    const dir = tempState();
    const p = join(dir, 'deployer-state.json');
    writeFileSync(p, plain);
    const other = hashOf(Buffer.concat([plain, Buffer.from('x')]));
    await expect(packFile(p, other)).rejects.toThrow(/packed copy decompresses to sha256 [0-9a-f]{64} \(\d+ bytes\), not/);
    expect(readdirSync(dir)).toEqual(['deployer-state.json']);
    expect(readFileSync(p).equals(plain)).toBe(true);
    await expect(packFile(join(dir, 'missing.json'), hashOf(plain))).rejects.toThrow(/ENOENT/);
    expect(existsSync(join(dir, 'missing.json.zst.tmp'))).toBe(false);
  });
});
