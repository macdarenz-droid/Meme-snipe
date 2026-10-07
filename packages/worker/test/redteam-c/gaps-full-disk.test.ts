// RC-H3 (S1 on #271): an append of the gaps file that fails part-way (a full disk) must not leave a repeated or torn gap
// line once the next flush succeeds.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({ half: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const appendFileSync = ((path: string, data: string) => {
    if (fault.half && /gaps-\d{3}\.jsonl$/.test(String(path))) {
      fault.half = false;
      fs.appendFileSync(path, data.slice(0, Math.floor(data.length / 2)));
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    }
    return fs.appendFileSync(path, data);
  }) as typeof fs.appendFileSync;
  return { ...fs, appendFileSync, default: { ...fs, appendFileSync } };
});
const { Recorder, recordedGaps } = await import('../../src/run/recorder.ts');

const root = mkdtempSync(join(tmpdir(), 'rc-gaps-disk-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const gap = (i: number) => ({ key: 'coverage:rugs:gap', value: { fromSlot: String(i), toSlot: String(i), reason: `cut ${i}`, via: 'logs:P' }, receivedAt: i });

describe('RC-H3: a gaps append that fails part-way', () => {
  it('is cut back, kept buffered, and written once by the next flush', () => {
    const r = new Recorder({ root, boot: 'b1', gitSha: 'x', rotateBytes: 1 << 20 });
    r.gap(gap(0));
    r.flush();
    r.gap(gap(1));
    r.gap(gap(2));
    fault.half = true;
    expect(() => r.flush()).toThrow(/no space left/);
    r.gap(gap(3));
    r.flush();
    expect(recordedGaps(join(root, 'b1'))).toEqual([gap(0), gap(1), gap(2), gap(3)]);
  });
});
