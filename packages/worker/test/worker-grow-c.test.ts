// WORKER-GROW G4c: what a long run writes stays cheap to keep. The recorder hashes each sealed file once, when it is
// sealed, and the manifest lists that hash; it never re-reads the sealed files to rewrite the manifest.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Recorder, sealLeftovers } from '../src/run/recorder.ts';
import { tempState } from './worker-harness.ts';

type Manifest = { days: { files: { path: string; bytes: number; sha256: string }[] }[] };
const manifestOf = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('the recorder manifest (G4c)', () => {
  it('lists each sealed file with the size and sha256 it had when sealed, without re-reading it on later seals', () => {
    const root = tempState();
    const at = Date.parse('2026-10-04T00:00:00Z');
    const rec = new Recorder({ root, boot: 'b1', gitSha: 'abc', rotateBytes: 1 });
    rec.delay({ n: 1 }, at);
    rec.flush();
    rec.delay({ n: 2 }, at); // rotates: the first file is sealed
    rec.flush();
    const first = manifestOf(rec.dir).days[0]!.files;
    expect(first).toHaveLength(1);
    const p = join(rec.dir, first[0]!.path);
    const sealed = readFileSync(p);
    expect(first[0]).toMatchObject({ bytes: sealed.length, sha256: sha(sealed) });
    // A later change on disk is not what was sealed: the manifest keeps the seal-time hash, so a check of the file
    // against it finds the change (a re-hash would hide it, and costs a read of every sealed file at every seal).
    writeFileSync(p, Buffer.concat([sealed, Buffer.from('x')]));
    rec.delay({ n: 3 }, at); // seals the second file and rewrites the manifest
    rec.close();
    const files = manifestOf(rec.dir).days[0]!.files;
    expect(files).toHaveLength(3);
    expect(files[0]).toEqual(first[0]);
    for (const f of files.slice(1)) expect(f.sha256).toBe(sha(readFileSync(join(rec.dir, f.path))));
  });

  it('files a crash left open are sealed at the next start and listed with their hash', () => {
    const root = tempState();
    const rec = new Recorder({ root, boot: 'b1', gitSha: 'abc', rotateBytes: 1 << 20 });
    rec.delay({ n: 1 }, Date.parse('2026-10-04T00:00:00Z'));
    rec.flush(); // killed here: no close
    expect(sealLeftovers(root, 'b2')).toEqual(['b1']);
    const files = manifestOf(rec.dir).days[0]!.files;
    expect(files).toHaveLength(1);
    expect(files[0]!.sha256).toBe(sha(readFileSync(join(rec.dir, files[0]!.path))));
  });

  it('a crashed boot\'s sealed files keep the hash its manifest listed at their seal (review N1)', () => {
    const root = tempState();
    const at = Date.parse('2026-10-04T00:00:00Z');
    const rec = new Recorder({ root, boot: 'b1', gitSha: 'abc', rotateBytes: 1 });
    rec.delay({ n: 1 }, at);
    rec.flush();
    rec.delay({ n: 2 }, at); // seals the first file; the second stays open
    rec.flush(); // killed here: no close
    const sealed = manifestOf(rec.dir).days[0]!.files[0]!;
    const p = join(rec.dir, sealed.path);
    const bytes = readFileSync(p);
    writeFileSync(p, Buffer.concat([bytes, Buffer.from('x')])); // changed between the crash and the restart
    expect(sealLeftovers(root, 'b2')).toEqual(['b1']);
    const files = manifestOf(rec.dir).days[0]!.files;
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual(sealed);
    expect(files[0]!.sha256).not.toBe(sha(readFileSync(p)));
    expect(files[1]!.sha256).toBe(sha(readFileSync(join(rec.dir, files[1]!.path))));
  });
});
