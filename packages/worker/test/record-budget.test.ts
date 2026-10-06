// RECORD-BUDGET: the recordings stay under a byte cap and above a free-disk floor, whether or not they were uploaded.
// A pass deletes sealed recording files oldest first and never touches the running boot's open files, temporary files,
// symlinks, anything outside the recorder folder or the rest of the state dir.
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/run/config.ts';
import { Recorder, sealLeftovers } from '../src/run/recorder.ts';
import { DISK_PRUNE_FREE_BYTES, FLOOR_HEADROOM, RECORDER_MAX_BYTES, pruneRecordings, type PruneOptions } from '../src/run/recorder-budget.ts';
import { tempState } from './worker-harness.ts';

const GiB = 1024 ** 3;
const DAY1 = '2026-10-01';
const DAY2 = '2026-10-02';
/** A boot id as the worker makes it: start time in base 36, then the pid. */
const bootId = (ms: number): string => `${ms.toString(36)}-7`;
const B1 = bootId(1_790_000_000_000);
const B2 = bootId(1_790_000_100_000);
const B3 = bootId(1_790_000_200_000);

const put = (path: string, bytes: number | string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof bytes === 'string' ? bytes : Buffer.alloc(bytes, 7));
};
/** Seal times: each file made is sealed a second after the one before, unless a test says when. */
let clock = 1_790_000_000;
const data = (root: string, boot: string, day: string, name: string, bytes = 1000, sealedAt = ++clock): string => {
  const p = join(root, boot, 'days', day, name);
  put(p, bytes);
  utimesSync(p, sealedAt, sealedAt);
  return p;
};
type Listed = { path: string; bytes: number; sha256: string };
type Manifest = { boot: string; git_sha: string; coverage_gaps: unknown[]; attachments: unknown[]; days: { day: string; files: Listed[] }[]; pruned: (Listed & { reason: string })[] };
/** A manifest for each boot folder that has none, listing its sealed files as a clean stop would. */
const manifests = (root: string): void => {
  for (const boot of readdirSync(root)) {
    const dir = join(root, boot);
    if (boot === 'saved-state' || lstatSync(dir).isSymbolicLink() || existsSync(join(dir, 'manifest.json'))) continue;
    const daysDir = join(dir, 'days');
    const days = existsSync(daysDir) ? readdirSync(daysDir).filter((d) => lstatSync(join(daysDir, d)).isDirectory()).sort().map((day) => ({
      day, files: readdirSync(join(daysDir, day)).filter((f) => f.endsWith('.jsonl.zst') && lstatSync(join(daysDir, day, f)).isFile()).sort().map((f) => {
        const p = join(daysDir, day, f);
        return { path: `days/${day}/${f}`, bytes: statSync(p).size, sha256: sha(p) };
      }),
    })) : [];
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 2, boot, git_sha: 'abc', coverage: null, coverage_gaps: [{ reason: 'kept' }], attachments: [], units: [{ frames: 3, raw: 1, releases: 2 }], days }));
  }
};
const manifestOf = (root: string, boot: string): Manifest => JSON.parse(readFileSync(join(root, boot, 'manifest.json'), 'utf8')) as Manifest;
const MANIFEST_BYTES = (root: string, ...boots: string[]): number => boots.reduce((n, b) => n + statSync(join(root, b, 'manifest.json')).size, 0);
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const opts = (root: string, o: Partial<PruneOptions> = {}): PruneOptions => ({
  root, current: B3, maxBytes: 100 * GiB, floorBytes: DISK_PRUNE_FREE_BYTES, freeBytes: () => 100 * GiB, packing: () => false, ...o,
});

describe('the recorder budget (RECORD-BUDGET)', () => {
  it('T1: over the cap, the oldest go first (UTC day, then boot start, then seal time) until the total is at or below it', () => {
    const root = join(tempState(), 'recorder');
    // Made out of order on purpose: the order comes from the day, the boot's start and the seal, not the names.
    data(root, B2, DAY1, 'frames-000.jsonl.zst');
    data(root, B1, DAY1, 'frames-000.jsonl.zst');
    data(root, B1, DAY1, 'raw-001.jsonl.zst');
    data(root, B1, DAY2, 'frames-000.jsonl.zst');
    data(root, B3, DAY2, 'frames-000.jsonl.zst');
    data(root, B3, DAY2, 'frames-001.jsonl.zst');
    manifests(root);
    const before = { b1: manifestOf(root, B1), b2: manifestOf(root, B2) };
    const kept = MANIFEST_BYTES(root, B1, B2, B3);
    const r = pruneRecordings(opts(root, { maxBytes: 2_500 + kept }));
    expect(r.reason).toBe('cap');
    expect(r.errors).toEqual([]);
    expect(r.deleted.map((d) => `${d.boot === B1 ? 'b1' : d.boot === B2 ? 'b2' : 'b3'}/${d.path}`)).toEqual([
      `b1/days/${DAY1}/frames-000.jsonl.zst`, `b1/days/${DAY1}/raw-001.jsonl.zst`, `b2/days/${DAY1}/frames-000.jsonl.zst`, `b1/days/${DAY2}/frames-000.jsonl.zst`,
    ]);
    expect(r.recorderBytes).toBeLessThanOrEqual(2_500 + MANIFEST_BYTES(root, B1, B2, B3));
    expect(r.short).toBe(false);
    // Ended boots keep their folders and manifests (B2: an upload finds a boot by its manifest); empty days go.
    expect(r.boots).toEqual([]);
    expect(readdirSync(root).sort()).toEqual([B1, B2, B3].sort());
    expect(readdirSync(join(root, B1))).toEqual(['manifest.json']);
    expect(readdirSync(join(root, B3, 'days', DAY2)).sort()).toEqual(['frames-000.jsonl.zst', 'frames-001.jsonl.zst']);
    // Within the cap: the next pass deletes nothing.
    expect(pruneRecordings(opts(root, { maxBytes: 2_500 + MANIFEST_BYTES(root, B1, B2, B3) }))).toMatchObject({ reason: null, deleted: [], short: false });
    // B1: each ended boot's manifest names what went, with the size and sha256 it listed, and lists only what is left.
    const b1 = manifestOf(root, B1);
    expect(b1.days).toEqual([]);
    const listedB1 = new Map(before.b1.days.flatMap((d) => d.files).map((f) => [f.path, f] as const));
    expect(b1.pruned).toEqual(r.deleted.filter((d) => d.boot === B1).map((d) => ({ ...listedB1.get(d.path)!, reason: 'cap' })));
    expect(b1.pruned).toHaveLength(3);
    expect(manifestOf(root, B2).pruned).toEqual([{ ...before.b2.days[0]!.files[0]!, reason: 'cap' }]);
    // Every other field stays.
    expect(b1).toMatchObject({ boot: B1, git_sha: 'abc', coverage_gaps: [{ reason: 'kept' }], attachments: [] });
  });

  it('B1: a partly pruned ended boot lists only the files on disk, and the deleted one under pruned with its seal-time sha256', () => {
    const root = join(tempState(), 'recorder');
    const at = Date.parse(`${DAY1}T00:00:00Z`);
    const rec = new Recorder({ root, boot: B1, gitSha: 'abc', rotateBytes: 1 });
    for (let n = 0; n < 20; n++) rec.delay({ n }, at);
    rec.close();
    const listed = manifestOf(root, B1).days[0]!.files;
    expect(listed).toHaveLength(20);
    const total = pruneRecordings(opts(root, { current: B3, maxBytes: 100 * GiB })).recorderBytes;
    const r = pruneRecordings(opts(root, { current: B3, maxBytes: total - 1 }));
    expect(r.deleted).toHaveLength(1);
    const m = manifestOf(root, B1);
    const files = m.days[0]!.files;
    expect(files).toHaveLength(19);
    for (const f of files) expect(existsSync(join(root, B1, f.path))).toBe(true);
    const gone = listed.find((f) => !files.some((g) => g.path === f.path))!;
    expect(m.pruned).toEqual([{ path: gone.path, bytes: gone.bytes, sha256: gone.sha256, reason: 'cap' }]);
    // A later pass appends; the first entry stays.
    pruneRecordings(opts(root, { current: B3, maxBytes: total - 1_000_000 }));
    expect(manifestOf(root, B1).pruned[0]).toEqual(m.pruned[0]);
    expect(manifestOf(root, B1).pruned.length).toBeGreaterThan(1);
  });

  it('B2: an ended boot keeps its manifest and attachments; only a folder that never recorded goes whole, named', () => {
    const root = join(tempState(), 'recorder');
    data(root, B1, DAY1, 'frames-000.jsonl.zst');
    put(join(root, B1, 'deployer-state.json.zst'), 'saved state');
    put(join(root, B2, 'deployer-state.json.zst'), 'pre-step state');
    put(join(root, B2, 'manifest.json'), JSON.stringify({ boot: B2, days: [], pruned: [] }));
    // A folder whose manifest cannot be read is kept (it may list files).
    put(join(root, bootId(1_789_000_000_000), 'manifest.json'), '{ torn');
    manifests(root);
    const r = pruneRecordings(opts(root, { maxBytes: 1 }));
    expect(r.boots).toEqual([B2]);
    expect(readdirSync(join(root, B1)).sort()).toEqual(['deployer-state.json.zst', 'manifest.json']);
    expect(readFileSync(join(root, B1, 'deployer-state.json.zst'), 'utf8')).toBe('saved state');
    expect(existsSync(join(root, bootId(1_789_000_000_000), 'manifest.json'))).toBe(true);
    expect(manifestOf(root, B1).pruned.map((p) => p.path)).toEqual([`days/${DAY1}/frames-000.jsonl.zst`]);
    // B1, pruned and now without recording, is not a never-recorded folder: a later pass keeps it.
    expect(pruneRecordings(opts(root, { maxBytes: 1 })).boots).toEqual([]);
    expect(existsSync(join(root, B1, 'manifest.json'))).toBe(true);
  });

  it('B3: within a day and boot the order is the seal, so a period\'s tables go together', () => {
    const root = join(tempState(), 'recorder');
    // releases-000 was sealed after frames-001 (each table rotates on its own): it outlives both frames files.
    data(root, B1, DAY1, 'frames-000.jsonl.zst', 1000, 1_790_000_010);
    data(root, B1, DAY1, 'frames-001.jsonl.zst', 1000, 1_790_000_020);
    data(root, B1, DAY1, 'releases-000.jsonl.zst', 1000, 1_790_000_030);
    data(root, B1, DAY1, 'frames-002.jsonl.zst', 1000, 1_790_000_040);
    manifests(root);
    const r = pruneRecordings(opts(root, { maxBytes: 2_000 + MANIFEST_BYTES(root, B1) }));
    expect(r.deleted.map((d) => d.path)).toEqual([`days/${DAY1}/frames-000.jsonl.zst`, `days/${DAY1}/frames-001.jsonl.zst`]);
    // By name, frames-002 would go next; by seal, releases-000 does.
    const r2 = pruneRecordings(opts(root, { maxBytes: 1_000 + MANIFEST_BYTES(root, B1) }));
    expect(r2.deleted.map((d) => d.path)).toEqual([`days/${DAY1}/releases-000.jsonl.zst`]);
  });

  it('T1: bytes count once per inode (the saved-state store is hard-linked into the boot folders)', () => {
    const root = join(tempState(), 'recorder');
    const store = join(root, 'saved-state', `${'a'.repeat(64)}.zst`);
    put(store, 5_000);
    mkdirSync(join(root, B1), { recursive: true });
    linkSync(store, join(root, B1, 'deployer-state.json.zst'));
    data(root, B1, DAY1, 'frames-000.jsonl.zst');
    expect(pruneRecordings(opts(root, { maxBytes: 6_000 }))).toMatchObject({ reason: null, recorderBytes: 6_000 });
  });

  it('T2: under the floor, the oldest go until free space is the floor plus 0.5 GiB', () => {
    const root = join(tempState(), 'recorder');
    for (let n = 0; n < 5; n++) data(root, B1, DAY1, `frames-00${n}.jsonl.zst`);
    data(root, B3, DAY2, 'frames-000.jsonl.zst');
    const free = DISK_PRUNE_FREE_BYTES + FLOOR_HEADROOM - 2_500;
    // Above the floor: within it, nothing goes, whatever the headroom.
    expect(pruneRecordings(opts(root, { freeBytes: () => free })).deleted).toEqual([]);
    const r = pruneRecordings(opts(root, { freeBytes: () => DISK_PRUNE_FREE_BYTES - 1 }));
    expect(r.reason).toBe('floor');
    // 3 GiB - 1 free needs 0.5 GiB + 1 back: everything this pass may delete goes, and that is not enough.
    expect(r.deleted).toHaveLength(6);
    expect(r.short).toBe(true);
    expect(r.freeBytes).toBe(DISK_PRUNE_FREE_BYTES - 1 + 6_000);
  });

  it('T2: the floor target is the floor plus the headroom, exactly', () => {
    const root = join(tempState(), 'recorder');
    // Sparse files: their size is an eighth of a GiB each, with no blocks written.
    for (let n = 0; n < 6; n++) {
      const p = join(root, B1, 'days', DAY1, `frames-00${n}.jsonl.zst`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, '');
      truncateSync(p, FLOOR_HEADROOM / 4);
    }
    // At the floor exactly: not under it, nothing goes.
    expect(pruneRecordings(opts(root, { freeBytes: () => DISK_PRUNE_FREE_BYTES })).deleted).toEqual([]);
    // One byte under: 0.5 GiB + 1 back is needed. Four files are 0.5 GiB, so a fifth goes and the sixth stays.
    const r = pruneRecordings(opts(root, { freeBytes: () => DISK_PRUNE_FREE_BYTES - 1 }));
    expect(r.deleted).toHaveLength(5);
    expect(r.short).toBe(false);
    expect(r.freeBytes).toBe(DISK_PRUNE_FREE_BYTES - 1 + 5 * (FLOOR_HEADROOM / 4));
    expect(readdirSync(join(root, B1, 'days', DAY1))).toEqual(['frames-005.jsonl.zst']);
  });

  it('T3: the state files, the open .jsonl, a .tmp, the manifest and symlinks out of the folder stay byte-identical at free = 0', () => {
    const state = tempState();
    const root = join(state, 'recorder');
    const outside = join(tempState(), 'elsewhere');
    put(join(outside, 'precious.jsonl.zst'), 'outside, never deleted');
    put(join(outside, 'day', 'frames-009.jsonl.zst'), 'outside day');
    put(join(outside, 'boot', 'days', DAY1, 'frames-008.jsonl.zst'), 'outside boot');
    const keep: string[] = [];
    for (const f of ['ledger.sqlite', 'ledger.sqlite-wal', 'journal.jsonl', 'journal.jsonl.reserve', 'deployers.jsonl', 'deployer-state.json', 'open_intents.json', 'exits.json', 'entry-seeds.json', 'account.json', 'paper.json', 'control.json']) {
      put(join(state, f), `state ${f}`);
      keep.push(join(state, f));
    }
    // The running boot: its open file, a seal in progress, its manifest and attachment.
    for (const f of [`days/${DAY2}/frames-002.jsonl`, `days/${DAY2}/frames-001.jsonl.zst.tmp`, 'manifest.json', 'manifest.json.tmp', 'deployer-state.json.zst', 'deployer-state.json']) {
      put(join(root, B3, f), `running ${f}`);
      keep.push(join(root, B3, f));
    }
    // A past boot's leftover plain file (sealed at the next start, never deleted) keeps its folder too.
    put(join(root, B2, 'days', DAY1, 'raw-000.jsonl'), 'past plain');
    keep.push(join(root, B2, 'days', DAY1, 'raw-000.jsonl'));
    // Symlinks: a recording-named file, a day folder and a whole boot folder pointing out of the recorder folder.
    mkdirSync(join(root, B1, 'days', DAY1), { recursive: true });
    symlinkSync(join(outside, 'precious.jsonl.zst'), join(root, B1, 'days', DAY1, 'frames-000.jsonl.zst'));
    symlinkSync(join(outside, 'day'), join(root, B1, 'days', DAY2));
    symlinkSync(join(outside, 'boot'), join(root, bootId(1_780_000_000_000)));
    // And one pointing inside the folder, at a sealed file: the link is not a recording file of its own.
    const target = data(root, B2, DAY1, 'frames-000.jsonl.zst');
    symlinkSync(target, join(root, B1, 'days', DAY1, 'frames-001.jsonl.zst'));
    const links = [join(root, B1, 'days', DAY1, 'frames-000.jsonl.zst'), join(root, B1, 'days', DAY1, 'frames-001.jsonl.zst'), join(root, B1, 'days', DAY2), join(root, bootId(1_780_000_000_000))];
    const sealed = data(root, B3, DAY2, 'frames-000.jsonl.zst');
    keep.push(join(outside, 'precious.jsonl.zst'), join(outside, 'day', 'frames-009.jsonl.zst'), join(outside, 'boot', 'days', DAY1, 'frames-008.jsonl.zst'));
    manifests(root);
    const before = keep.map(sha);
    for (let k = 0; k < 20; k++) {
      const r = pruneRecordings(opts(root, { freeBytes: () => 0, maxBytes: 1 }));
      expect(r.errors).toEqual([]);
    }
    expect(keep.map(sha)).toEqual(before);
    for (const l of links) expect(lstatSync(l).isSymbolicLink()).toBe(true);
    // Only the running boot's sealed file went; the past boot holding a symlink stays.
    expect(existsSync(sealed)).toBe(false);
    expect(existsSync(join(root, B1))).toBe(true);
  });

  it('T3: the real-path check alone stops a day folder swapped for a symlink between the walk and the delete', () => {
    const root = join(tempState(), 'recorder');
    const outside = join(tempState(), 'elsewhere');
    put(join(outside, 'frames-000.jsonl.zst'), 'outside, never deleted');
    data(root, B1, DAY1, 'frames-000.jsonl.zst');
    manifests(root);
    const day = join(root, B1, 'days', DAY1);
    const r = pruneRecordings(opts(root, {
      maxBytes: 1,
      afterWalk: () => {
        renameSync(day, join(root, B1, 'days', 'moved'));
        symlinkSync(outside, day);
      },
    }));
    // lstat of the file sees a regular file (its folder is the link): only the real path says it left the recorder.
    expect(r.deleted).toEqual([]);
    expect(readFileSync(join(outside, 'frames-000.jsonl.zst'), 'utf8')).toBe('outside, never deleted');
  });

  it('T3: a boot folder that is a symlink inside the recorder is never walked as a boot (the boot-name check alone)', () => {
    const root = join(tempState(), 'recorder');
    data(root, B1, DAY1, 'frames-000.jsonl.zst');
    data(root, B1, DAY1, 'frames-001.jsonl.zst');
    manifests(root);
    // An older boot id pointing at B1: inside the recorder, so the real-path check lets its files through.
    const alias = bootId(1_780_000_000_000);
    symlinkSync(join(root, B1), join(root, alias));
    const r = pruneRecordings(opts(root, { maxBytes: 1_000 + MANIFEST_BYTES(root, B1) }));
    expect(r.deleted).toEqual([{ boot: B1, path: `days/${DAY1}/frames-000.jsonl.zst`, bytes: 1_000 }]);
    expect(lstatSync(join(root, alias)).isSymbolicLink()).toBe(true);
    expect(manifestOf(root, B1).pruned.map((p) => p.path)).toEqual([`days/${DAY1}/frames-000.jsonl.zst`]);
  });

  it('T4: the running boot\'s deleted file leaves days[].files and is listed under pruned with its seal-time hash; the recorder goes on', () => {
    const root = tempState();
    const at = Date.parse(`${DAY2}T00:00:00Z`);
    const rec = new Recorder({ root, boot: B3, gitSha: 'abc', rotateBytes: 1 });
    rec.delay({ n: 1 }, at);
    rec.flush();
    rec.delay({ n: 2 }, at); // seals -000
    rec.flush();
    const man = (): { days: { files: { path: string }[] }[]; pruned: { path: string; bytes: number; sha256: string | null; reason: string }[] } => JSON.parse(readFileSync(join(rec.dir, 'manifest.json'), 'utf8'));
    const listed = man().days[0]!.files[0]! as { path: string; bytes: number; sha256: string };
    const r = pruneRecordings(opts(root, { maxBytes: 1 }));
    expect(r.deleted.map((d) => d.path)).toEqual([`days/${DAY2}/delays-000.jsonl.zst`]);
    for (const d of r.deleted) rec.pruned(d.path, d.bytes, 'cap');
    expect(man().days[0]!.files).toEqual([]);
    expect(man().pruned).toEqual([{ path: listed.path, bytes: listed.bytes, sha256: listed.sha256, reason: 'cap' }]);
    rec.delay({ n: 3 }, at); // seals -001: recording goes on
    rec.close();
    expect(man().days[0]!.files.map((f) => f.path)).toEqual([`days/${DAY2}/delays-001.jsonl.zst`, `days/${DAY2}/delays-002.jsonl.zst`]);
    expect(man().pruned).toHaveLength(1);
  });

  it('the running boot keeps an emptied day folder: its next file there may be buffered only (persist delta B1)', () => {
    const root = tempState();
    const at = Date.parse(`${DAY2}T00:00:00Z`);
    const rec = new Recorder({ root, boot: B3, gitSha: 'abc', rotateBytes: 1 });
    rec.delay({ n: 1 }, at);
    rec.flush();
    rec.delay({ n: 2 }, at); // seals -000; -001 is opened and buffered, not yet on disk
    const r = pruneRecordings(opts(root, { maxBytes: 1 }));
    expect(r.deleted.map((d) => d.path)).toEqual([`days/${DAY2}/delays-000.jsonl.zst`]);
    for (const d of r.deleted) rec.pruned(d.path, d.bytes, 'cap');
    expect(existsSync(join(rec.dir, 'days', DAY2))).toBe(true);
    expect(() => rec.flush()).not.toThrow();
    rec.close();
    expect(readdirSync(join(rec.dir, 'days', DAY2))).toEqual(['delays-001.jsonl.zst']);
  });

  it('T5: after the newest sealed file is deleted, the next file is -003, never a reused -002', () => {
    const root = tempState();
    const at = Date.parse(`${DAY2}T00:00:00Z`);
    const rec = new Recorder({ root, boot: B3, gitSha: 'abc', rotateBytes: 1 << 20 });
    for (let n = 0; n < 3; n++) {
      rec.delay({ n }, at);
      rec.close(); // seals -00n
    }
    const dir = join(rec.dir, 'days', DAY2);
    expect(readdirSync(dir).sort()).toEqual(['delays-000.jsonl.zst', 'delays-001.jsonl.zst', 'delays-002.jsonl.zst']);
    const r = pruneRecordings(opts(root, { freeBytes: () => 0 }));
    expect(r.deleted).toHaveLength(3);
    for (const d of r.deleted) rec.pruned(d.path, d.bytes, 'floor');
    rec.delay({ n: 9 }, at);
    rec.close();
    expect(readdirSync(dir)).toEqual(['delays-003.jsonl.zst']);
  });

  it('T6: a folder that goes while the leftovers are sealed is no fault (sealLeftovers skips it)', () => {
    const root = tempState();
    // A day folder that is gone by the time it is read (a dangling link reads as ENOENT, as a removed folder does).
    mkdirSync(join(root, B1, 'days'), { recursive: true });
    symlinkSync(join(root, 'removed'), join(root, B1, 'days', DAY1));
    put(join(root, B2, 'days', DAY1, 'frames-000.jsonl'), '{"a":1}\n');
    expect(sealLeftovers(root, B3)).toEqual([B2]);
    expect(existsSync(join(root, B2, 'days', DAY1, 'frames-000.jsonl.zst'))).toBe(true);
  });

  it('T7: a stored saved state goes only at link count 1, and never while a pack runs', () => {
    const root = join(tempState(), 'recorder');
    const linked = join(root, 'saved-state', `${'a'.repeat(64)}.zst`);
    const orphan = join(root, 'saved-state', `${'b'.repeat(64)}.zst`);
    put(linked, 100);
    put(orphan, 100);
    put(join(root, 'saved-state', 'notes.txt'), 'not a store file');
    mkdirSync(join(root, B3), { recursive: true });
    linkSync(linked, join(root, B3, 'deployer-state.json.zst'));
    let packing = true;
    expect(pruneRecordings(opts(root, { freeBytes: () => 0, packing: () => packing })).deleted).toEqual([]);
    expect(existsSync(orphan)).toBe(true);
    packing = false;
    expect(pruneRecordings(opts(root, { freeBytes: () => 0, packing: () => packing })).deleted.map((d) => d.path)).toEqual([`saved-state/${'b'.repeat(64)}.zst`]);
    expect(existsSync(linked)).toBe(true);
    expect(statSync(linked).nlink).toBe(2);
    expect(existsSync(join(root, 'saved-state', 'notes.txt'))).toBe(true);
  });

  it('T7: a never-recorded folder removed whole leaves its stored saved state at link count 1, which then goes', () => {
    const root = join(tempState(), 'recorder');
    const store = join(root, 'saved-state', `${'c'.repeat(64)}.zst`);
    put(store, 100);
    put(join(root, B1, 'manifest.json'), JSON.stringify({ boot: B1, days: [] }));
    linkSync(store, join(root, B1, 'deployer-state.json.zst'));
    data(root, B3, DAY2, 'frames-000.jsonl.zst');
    const r = pruneRecordings(opts(root, { maxBytes: 1_000 }));
    expect(r.boots).toEqual([B1]);
    expect(existsSync(store)).toBe(false);
    expect(r.deleted.map((d) => d.path)).toEqual([`saved-state/${'c'.repeat(64)}.zst`]);
    expect(r.recorderBytes).toBe(1_000);
  });

  it('N1: a removed link frees nothing while another link holds the bytes (floor mode)', () => {
    const root = join(tempState(), 'recorder');
    // A never-recorded folder whose saved state (0.5 GiB, sparse) is linked from the store; the pack holds the store.
    const store = join(root, 'saved-state', `${'f'.repeat(64)}.zst`);
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, '');
    truncateSync(store, FLOOR_HEADROOM);
    // No manifest (a missing one counts as never recorded), so the folder frees nothing but its link.
    mkdirSync(join(root, B1), { recursive: true });
    linkSync(store, join(root, B1, 'deployer-state.json.zst'));
    for (let n = 0; n < 6; n++) {
      const p = data(root, B2, DAY1, `frames-00${n}.jsonl.zst`, 0);
      truncateSync(p, FLOOR_HEADROOM / 4);
    }
    const r = pruneRecordings(opts(root, { freeBytes: () => DISK_PRUNE_FREE_BYTES - 1, packing: () => true }));
    expect(r.boots).toEqual([B1]);
    expect(existsSync(store)).toBe(true);
    // The folder's link freed nothing: 0.5 GiB + 1 still had to come from recordings, five eighth-GiB files.
    expect(r.deleted.filter((d) => d.boot === B2)).toHaveLength(5);
    expect(r.freeBytes).toBe(DISK_PRUNE_FREE_BYTES - 1 + 5 * (FLOOR_HEADROOM / 4));
  });

  it('config: the cap and the floor are settings; a floor under 2 GiB is refused (exit 2)', () => {
    const base = { ZEROED_STATE_DIR: '/tmp/x', ZEROED_MODE: 'paper' };
    const ok = parseConfig(base, () => null);
    expect(ok.ok && ok.config.recorderBudget).toEqual({ maxBytes: RECORDER_MAX_BYTES, floorBytes: DISK_PRUNE_FREE_BYTES });
    expect(RECORDER_MAX_BYTES).toBe(8 * GiB);
    expect(DISK_PRUNE_FREE_BYTES).toBe(3 * GiB);
    const set = parseConfig({ ...base, ZEROED_RECORDER_MAX_BYTES: String(4 * GiB), ZEROED_DISK_PRUNE_FREE_BYTES: String(5 * GiB) }, () => null);
    expect(set.ok && set.config.recorderBudget).toEqual({ maxBytes: 4 * GiB, floorBytes: 5 * GiB });
    for (const bad of [{ ZEROED_DISK_PRUNE_FREE_BYTES: String(2 * GiB - 1) }, { ZEROED_DISK_PRUNE_FREE_BYTES: 'lots' }, { ZEROED_RECORDER_MAX_BYTES: '0' }, { ZEROED_RECORDER_MAX_BYTES: '-1' }, { ZEROED_RECORDER_MAX_BYTES: '1.5' }]) {
      const p = parseConfig({ ...base, ...bad }, () => null);
      expect(p).toMatchObject({ ok: false, code: 2 });
    }
    expect(parseConfig({ ...base, ZEROED_DISK_PRUNE_FREE_BYTES: String(2 * GiB) }, () => null).ok).toBe(true);
    // Exact whole numbers only: past 2^53 - 1 a value would be rounded (persist review note 4).
    for (const bad of [{ ZEROED_RECORDER_MAX_BYTES: '9007199254740992' }, { ZEROED_DISK_PRUNE_FREE_BYTES: '9007199254740993' }, { ZEROED_RECORDER_MAX_BYTES: '9999999999999999' }]) {
      expect(parseConfig({ ...base, ...bad }, () => null)).toMatchObject({ ok: false, code: 2 });
    }
    const top = parseConfig({ ...base, ZEROED_RECORDER_MAX_BYTES: '9007199254740991', ZEROED_DISK_PRUNE_FREE_BYTES: '9007199254740991' }, () => null);
    expect(top.ok && top.config.recorderBudget).toEqual({ maxBytes: Number.MAX_SAFE_INTEGER, floorBytes: Number.MAX_SAFE_INTEGER });
  });
});
