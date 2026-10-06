// The runner hashes each recorded file it lists in chunks (review of #192): a large day file never sits in memory whole,
// and the size and sha256 are the same as from the whole file.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileHash } from '../src/lines.ts';

describe('the streamed file hash', () => {
  it('gives the whole-file size and sha256 at any chunk size, empty file included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hash-'));
    for (const size of [0, 1, 7, 64, 1000, 3 * 1024 + 5]) {
      const p = join(dir, `f${size}`);
      const data = randomBytes(size);
      writeFileSync(p, data);
      const whole = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
      for (const chunk of [1, 3, 64, 1024, 1 << 20]) expect(fileHash(p, chunk), `size ${size} chunk ${chunk}`).toEqual(whole);
      expect(fileHash(p)).toEqual(whole);
    }
  });
});

describe('no whole-file read of a recorded file (guard)', () => {
  it('collectRecorded hashes through fileHash', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'runner.ts'), 'utf8');
    const body = src.slice(src.indexOf('function collectRecorded'), src.indexOf('export const recordedFiles'));
    expect(body).toContain('fileHash(src)');
    expect(body).not.toMatch(/readFileSync/);
  });
});
