// DISK-GUARD: the recorder stops writing when told (free space is low) or when a write fails for lack of space, marks
// the stop in its manifest with what was not written, and writes again when resumed. A failed write never reaches the
// worker as an error: its state, ledger and journal come first.
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Frame } from '../src/providers/index.ts';
import { Recorder } from '../src/run/recorder.ts';

const tmp = mkdtempSync(join(tmpdir(), 'zeroed-recpause-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const DAY_MS = Date.parse('2026-10-05T00:00:00Z');
const frame = (seq: number, slot: number): Frame =>
  ({ seq, receivedAt: DAY_MS + seq, source: 'helius', backfilled: false, place: { at: 'chain', slot: BigInt(slot) }, duplicate: false, body: { type: 'slot', slot: BigInt(slot), parent: BigInt(slot - 1), root: null } }) as unknown as Frame;
const manifest = (r: Recorder) => JSON.parse(readFileSync(join(r.dir, 'manifest.json'), 'utf8')) as { coverage_gaps: Record<string, unknown>[]; days: { files: { path: string }[] }[] };
const plainLines = (r: Recorder): number => {
  const dir = join(r.dir, 'days', '2026-10-05');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).reduce((n, f) => n + readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).length, 0);
};

describe('recorder pause (DISK-GUARD)', () => {
  it('a pause seals what it had, writes nothing while it lasts, and lists the gap with its start, end and dropped rows', () => {
    const r = new Recorder({ root: join(tmp, 'a'), boot: 'b1', gitSha: 'g', rotateBytes: 1 << 20 });
    r.frame(frame(1, 100));
    r.frame(frame(2, 101));
    r.flush();
    expect(plainLines(r)).toBe(2);
    r.pause(DAY_MS + 10, 'free space below 1.5 GiB');
    expect(r.paused).toBe(true);
    // Sealed: the plain file became a listed .zst.
    expect(plainLines(r)).toBe(0);
    expect(manifest(r).days.flatMap((d) => d.files.map((f) => f.path)).some((p) => p.endsWith('.jsonl.zst'))).toBe(true);
    expect(manifest(r).coverage_gaps).toEqual([{ reason: 'recorder paused: free space below 1.5 GiB', from_ms: DAY_MS + 10, to_ms: null, dropped: { frames: 0, releases: 0, delays: 0 } }]);
    r.frame(frame(3, 102));
    r.frame(frame(4, 103));
    r.delay({ x: 1 }, DAY_MS + 12);
    r.flush();
    expect(plainLines(r)).toBe(0);
    r.pause(DAY_MS + 13, 'again');
    r.resume(DAY_MS + 20);
    expect(r.paused).toBe(false);
    expect(manifest(r).coverage_gaps).toEqual([{ reason: 'recorder paused: free space below 1.5 GiB', from_ms: DAY_MS + 10, to_ms: DAY_MS + 20, dropped: { frames: 2, releases: 0, delays: 1 } }]);
    r.frame(frame(5, 104));
    r.flush();
    expect(plainLines(r)).toBe(1);
    expect(r.counts.frames).toBe(3);
    r.close();
  });

  it('a write that fails for lack of space pauses it instead of throwing; any other failure still throws', () => {
    let full = false;
    let told = 0;
    const append = (path: string, text: string) => {
      if (full) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      appendFileSync(path, text);
    };
    const r = new Recorder({ root: join(tmp, 'b'), boot: 'b2', gitSha: 'g', rotateBytes: 1 << 20, now: () => DAY_MS + 50, onNoSpace: () => (told += 1), append });
    r.frame(frame(1, 100));
    r.flush();
    full = true;
    r.frame(frame(2, 101));
    r.frame(frame(3, 102));
    expect(() => r.flush()).not.toThrow();
    expect(r.paused).toBe(true);
    expect(told).toBe(1);
    expect(manifest(r).coverage_gaps).toEqual([{ reason: 'recorder paused: a write failed (no space left on the device)', from_ms: DAY_MS + 50, to_ms: null, dropped: { frames: 0, releases: 0, delays: 0 }, unwritten_rows: 2 }]);
    const other = new Recorder({ root: join(tmp, 'c'), boot: 'b3', gitSha: 'g', rotateBytes: 1 << 20, append: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } });
    other.frame(frame(1, 100));
    expect(() => other.flush()).toThrow('EIO');
  });
});
