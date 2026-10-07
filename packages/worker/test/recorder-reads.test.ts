// G4c-1: a live seal keeps the hash of the bytes it wrote; no sealed file is read back to list it in the manifest.
import { describe, expect, it, vi } from 'vitest';

const reads: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readFileSync: ((p: unknown, ...rest: unknown[]) => (reads.push(String(p)), (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest))) as typeof fs.readFileSync };
});

const { Recorder } = await import('../src/run/recorder.ts');
const { tempState } = await import('./worker-harness.ts');

describe('the recorder never reads a sealed file back', () => {
  it('ten seals and a close read no .zst file', () => {
    const rec = new Recorder({ root: tempState(), boot: 'b1', gitSha: 'abc', rotateBytes: 1 });
    const at = Date.parse('2026-10-04T00:00:00Z');
    reads.length = 0;
    for (let n = 0; n < 10; n++) {
      rec.delay({ n }, at);
      rec.flush();
    }
    rec.close();
    expect(reads.filter((p) => p.endsWith('.zst'))).toEqual([]);
    expect(reads.filter((p) => p.endsWith('.jsonl')).length).toBe(10); // each plain file read once, to compress it
  });
});
