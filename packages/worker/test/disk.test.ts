// DISK-GUARD's pure parts: the step order as free space falls and rises, the slope's days to full, the history, and the
// recorder's bytes from its manifests and open files.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_DISK_POLICY, DISK_OK, addPoint, daysToFull, nextDiskState, parseHistory, readDisk, recorderBytes, validDiskPolicy, type DiskSample, type DiskState } from '../src/run/disk.ts';
import { parseConfig } from '../src/run/config.ts';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const P = DEFAULT_DISK_POLICY;
const at = (freeBytes: number, atMs = 0): DiskSample => ({ atMs, freeBytes, totalBytes: 25 * GiB, recorderBytes: 0 });
const tmp = mkdtempSync(join(tmpdir(), 'zeroed-disk-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('disk steps', () => {
  it('the defaults keep their order and leave room for a worst-case recorder day above the entry floor', () => {
    expect(validDiskPolicy(P)).toBe(true);
    expect(P.recorderPauseBytes - P.entryFloorBytes).toBeGreaterThanOrEqual(GiB);
    expect(P.recorderPauseBytes).toBeGreaterThanOrEqual(384 * MiB + GiB);
    expect(validDiskPolicy({ ...P, entryFloorBytes: P.recorderPauseBytes })).toBe(false);
    expect(validDiskPolicy({ ...P, entryResumeBytes: P.entryFloorBytes })).toBe(false);
    expect(validDiskPolicy({ ...P, recorderResumeBytes: P.recorderPauseBytes })).toBe(false);
    expect(validDiskPolicy({ ...P, entryFloorBytes: 0 })).toBe(false);
  });

  it('as free space falls: the recorder pauses first, then entries are refused; exits are not a step at all', () => {
    let s: DiskState = DISK_OK;
    const walk = (free: number) => (s = nextDiskState(s, at(free), P));
    expect(walk(P.recorderPauseBytes)).toEqual({ recorderPaused: false, entriesRefused: false });
    expect(walk(P.recorderPauseBytes - 1)).toEqual({ recorderPaused: true, entriesRefused: false });
    expect(walk(P.entryFloorBytes)).toEqual({ recorderPaused: true, entriesRefused: false });
    expect(walk(P.entryFloorBytes - 1)).toEqual({ recorderPaused: true, entriesRefused: true });
    expect(walk(0)).toEqual({ recorderPaused: true, entriesRefused: true });
  });

  it('as it rises: each step comes back only at its resume line, not at the line it stopped at', () => {
    let s: DiskState = { recorderPaused: true, entriesRefused: true };
    const walk = (free: number) => (s = nextDiskState(s, at(free), P));
    expect(walk(P.entryFloorBytes + 1)).toEqual({ recorderPaused: true, entriesRefused: true });
    expect(walk(P.entryResumeBytes - 1)).toEqual({ recorderPaused: true, entriesRefused: true });
    expect(walk(P.entryResumeBytes)).toEqual({ recorderPaused: true, entriesRefused: false });
    expect(walk(P.recorderPauseBytes)).toEqual({ recorderPaused: true, entriesRefused: false });
    expect(walk(P.recorderResumeBytes - 1)).toEqual({ recorderPaused: true, entriesRefused: false });
    expect(walk(P.recorderResumeBytes)).toEqual(DISK_OK);
  });

  it('with no reading, entries are refused and the recorder keeps what it was doing', () => {
    expect(nextDiskState(DISK_OK, null, P)).toEqual({ recorderPaused: false, entriesRefused: true });
    expect(nextDiskState({ recorderPaused: true, entriesRefused: false }, null, P)).toEqual({ recorderPaused: true, entriesRefused: true });
  });
});

describe('days to full', () => {
  const H = 3_600_000;
  it('needs 6 hours of history and a falling free space', () => {
    const h = addPoint([], at(10 * GiB, 0));
    expect(daysToFull(h, at(9 * GiB, 5 * H))).toBeNull();
    expect(daysToFull(h, at(10 * GiB, 12 * H))).toBeNull();
    expect(daysToFull(h, at(11 * GiB, 12 * H))).toBeNull();
    // 1 GiB in 12 h is 2 GiB a day: 9 GiB left is 4.5 days; 5 GiB lost in 24 h with 5 GiB left is 1 day.
    expect(daysToFull(h, at(9 * GiB, 12 * H))).toBe(4.5);
    expect(daysToFull(h, at(5 * GiB, 24 * H))).toBe(1);
  });

  it('keeps one reading an hour for 7 days, oldest first', () => {
    let h = addPoint([], at(10 * GiB, 0));
    h = addPoint(h, at(9 * GiB, H - 1));
    expect(h).toHaveLength(1);
    h = addPoint(h, at(9 * GiB, H));
    expect(h.map((x) => x.atMs)).toEqual([0, H]);
    h = addPoint(h, at(8 * GiB, 7 * 24 * H + H));
    // The reading at 0 is now more than 7 days old and dropped; the one at 1 h is exactly 7 days old and kept.
    expect(h.map((x) => x.atMs)).toEqual([H, 7 * 24 * H + H]);
    expect(addPoint(h, at(8 * GiB, 7 * 24 * H + 2 * H + 1)).map((x) => x.atMs)).toEqual([7 * 24 * H + H, 7 * 24 * H + 2 * H + 1]);
    expect(parseHistory(JSON.stringify(h))).toEqual(h);
    expect(parseHistory('not json')).toEqual([]);
    expect(parseHistory('[{"atMs":1,"freeBytes":"x"},{"atMs":2,"freeBytes":3}]')).toEqual([{ atMs: 2, freeBytes: 3 }]);
  });
});

describe('recorder bytes', () => {
  it('sums every manifest\'s listed files and the plain files still being written; a folder without a manifest counts its open files', () => {
    const root = join(tmp, 'recorder');
    const b1 = join(root, 'boot1');
    mkdirSync(join(b1, 'days', '2026-10-04'), { recursive: true });
    writeFileSync(join(b1, 'manifest.json'), JSON.stringify({ days: [{ day: '2026-10-04', files: [{ path: 'a', bytes: 1000 }, { path: 'b', bytes: 24 }] }] }));
    writeFileSync(join(b1, 'days', '2026-10-04', 'frames-001.jsonl'), 'x'.repeat(300));
    writeFileSync(join(b1, 'days', '2026-10-04', 'frames-000.jsonl.zst'), 'y'.repeat(999));
    const b2 = join(root, 'boot2');
    mkdirSync(join(b2, 'days', '2026-10-05'), { recursive: true });
    writeFileSync(join(b2, 'days', '2026-10-05', 'raw-000.jsonl'), 'z'.repeat(7));
    expect(recorderBytes(root)).toBe(1000 + 24 + 300 + 7);
    expect(recorderBytes(join(tmp, 'none'))).toBe(0);
  });

  it('reads the real filesystem', () => {
    const s = readDisk(tmp, join(tmp, 'recorder'), 42);
    expect(s).not.toBeNull();
    expect(s!.atMs).toBe(42);
    expect(s!.totalBytes).toBeGreaterThan(s!.freeBytes);
    expect(s!.freeBytes).toBeGreaterThan(0);
    expect(readDisk(join(tmp, 'missing'), tmp, 0)).toBeNull();
  });
});

describe('disk settings and wiring', () => {
  const base = { ZEROED_STATE_DIR: tmp, ZEROED_MODE: 'paper', ZEROED_GIT_SHA: 'testsha' };
  it('defaults to DEFAULT_DISK_POLICY; ZEROED_DISK_* set each line, and lines out of order or not whole bytes are refused', () => {
    const ok = parseConfig(base, () => null);
    expect(ok.ok && ok.config.disk).toEqual(P);
    const set = parseConfig({ ...base, ZEROED_DISK_RECORDER_PAUSE_BYTES: String(3 * GiB), ZEROED_DISK_RECORDER_RESUME_BYTES: String(4 * GiB), ZEROED_DISK_ENTRY_FLOOR_BYTES: String(GiB), ZEROED_DISK_ENTRY_RESUME_BYTES: String(2 * GiB) }, () => null);
    expect(set.ok && set.config.disk).toEqual({ recorderPauseBytes: 3 * GiB, recorderResumeBytes: 4 * GiB, entryFloorBytes: GiB, entryResumeBytes: 2 * GiB });
    for (const bad of [{ ZEROED_DISK_ENTRY_FLOOR_BYTES: String(2 * GiB) }, { ZEROED_DISK_RECORDER_RESUME_BYTES: String(GiB) }, { ZEROED_DISK_ENTRY_FLOOR_BYTES: '1.5' }, { ZEROED_DISK_ENTRY_FLOOR_BYTES: '-1' }, { ZEROED_DISK_ENTRY_FLOOR_BYTES: '0' }]) {
      const r = parseConfig({ ...base, ...bad }, () => null);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('the running worker reads the real disk, with the configured lines', () => {
    const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
    expect(main).toContain('disk: (atMs) => readDisk(config.stateDir, join(config.stateDir, STATE_FILES.recorder), atMs),');
    expect(main).toContain('diskPolicy: config.disk,');
  });
});
