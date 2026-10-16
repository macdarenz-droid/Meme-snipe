// Card Z10 (found by the ops e2e's md-pull run over the pull account): M07's writer cleared the setgid bit that its
// folders inherit from the host's /var/lib/zeroed-md (2750, group zeroed-pull), so hour folders and segments got the
// worker's group and the chrooted pull account could read none of them. The inherited bit, and so the group, is kept.
import { strict as assert } from 'node:assert';
import * as nodeFs from 'node:fs';
import { chmodSync, chownSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { generateKeyPairSync } from 'node:crypto';
import { DEFAULT_DISK_POLICY, DiskManager } from '../../src/m07/disk.ts';
import { SegmentWriter } from '../../src/m07/segments.ts';
import { WatchLog } from '../../src/m07/watch-log.ts';
import { tempDir } from '../helpers.ts';
import { startedQueue } from '../recorder/helpers.ts';

const AT = Date.UTC(2026, 9, 15, 10, 0, 0);

describe('Z10: M07 folders keep the md folder group', () => {
  it('in a setgid md folder, day and hour folders keep the bit, the group, and 0750 otherwise (fails before: 0750, no setgid)', () => {
    const dir = tempDir('z10-md-group');
    chmodSync(dir, 0o2750);
    const root = process.getuid?.() === 0;
    if (root) chownSync(dir, 0, 65_534);                                   // another group, as zeroed-pull is on the host
    // As under the worker's unit: UMask=0077, and RestrictSUIDSGID=yes refuses a chmod that sets setgid (EPERM).
    const chmods: number[] = [];
    const fs = { ...nodeFs, chmodSync: (p: nodeFs.PathLike, mode: nodeFs.Mode) => { chmods.push(Number(mode)); if ((Number(mode) & 0o6000) !== 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); nodeFs.chmodSync(p, mode); } };
    const umask = process.umask(0o077);
    let m;
    try {
      const rec = SegmentWriter.recover({ dataDir: dir, nowMs: AT as UnixMs, log: () => undefined, fs } as never);
      const q = startedQueue({ firstSeq: rec.nextSeq });
      const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', queue: q, nowMs: () => AT as UnixMs, log: () => undefined, fs } as never, rec);
      q.append({ stream: 'universe_manifest', recvMs: AT as UnixMs, slot: null, commitment: null, source: 'test', payload: { n: 1 } });
      w.pump();
      [m] = w.rotate();
    } finally {
      process.umask(umask);
    }
    assert.ok(chmods.every((x) => (x & 0o6000) === 0), 'never a chmod that sets setgid');
    assert.ok(m !== undefined);
    for (const d of ['2026-10-15', '2026-10-15/10']) {
      const st = statSync(join(dir, d));
      assert.equal(st.mode & 0o7777, 0o2750, d);
      if (root) assert.equal(st.gid, 65_534, `${d} group`);
    }
    if (root) assert.equal(statSync(join(dir, m.path)).gid, 65_534, 'segment group');
    assert.equal(statSync(join(dir, m.path)).mode & 0o777, 0o640);
  });

  it('outside a setgid folder nothing changes: 0750', () => {
    const dir = tempDir('z10-md-plain');
    chmodSync(dir, 0o750);
    const rec = SegmentWriter.recover({ dataDir: dir, nowMs: AT as UnixMs, log: () => undefined });
    const q = startedQueue({ firstSeq: rec.nextSeq });
    const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', queue: q, nowMs: () => AT as UnixMs, log: () => undefined }, rec);
    q.append({ stream: 'universe_manifest', recvMs: AT as UnixMs, slot: null, commitment: null, source: 'test', payload: { n: 1 } });
    w.pump();
    w.rotate();
    assert.equal(statSync(join(dir, '2026-10-15')).mode & 0o7777, 0o750);
  });

  it('ruling Z10-26: under umask 077 in a 2750 md folder, watch/ keeps the setgid group and its day file is 0640 (fails before: 0750 without setgid, 0600)', () => {
    const dir = tempDir('z10-watch-group');
    chmodSync(dir, 0o2750);
    const root = process.getuid?.() === 0;
    if (root) chownSync(dir, 0, 65_534);
    const umask = process.umask(0o077);
    try {
      const wl = new WatchLog(dir, (e) => { throw e; });
      wl.watch('A', 'candidate', AT as UnixMs);
    } finally {
      process.umask(umask);
    }
    const w = statSync(join(dir, 'watch'));
    assert.equal(w.mode & 0o7777, 0o2750);
    if (root) assert.equal(w.gid, 65_534);
    const f = statSync(join(dir, 'watch', '2026-10-15.ndjson'));
    assert.equal(f.mode & 0o777, 0o640);
    if (root) assert.equal(f.gid, 65_534);
  });

  it('ruling Z10-26: DiskManager counts watch/ files in the recorder bytes and deletes a day past retention once none of its segments is left', () => {
    const dir = tempDir('z10-watch-disk');
    nodeFs.mkdirSync(join(dir, 'watch'));
    nodeFs.mkdirSync(join(dir, 'receipts'));
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-15']) nodeFs.writeFileSync(join(dir, 'watch', `${d}.ndjson`), 'x'.repeat(100));
    nodeFs.mkdirSync(join(dir, '2026-10-02', '05'), { recursive: true });        // a day with a segment folder left
    nodeFs.writeFileSync(join(dir, '2026-10-02', '05', 'pool_snapshot.ndjson.gz'), 'y'.repeat(10));
    const logs: string[] = [];
    const m = new DiskManager({
      dataDir: dir, receiptsDir: join(dir, 'receipts'), publicKey: generateKeyPairSync('ed25519').publicKey, policy: DEFAULT_DISK_POLICY,
      usage: () => ({ totalBytes: 55e9, freeBytes: 50e9 }), nowMs: () => Date.parse('2026-10-15T12:00:00Z') as UnixMs, log: (_l, code) => { logs.push(code); },
      writer: { halt() {}, resume() {}, isHalted: () => false, haltReason: () => null, openPaths: () => [] },
    });
    const r = m.check();
    assert.deepEqual(r.deleted, ['watch/2026-10-01.ndjson']);
    assert.deepEqual(nodeFs.readdirSync(join(dir, 'watch')).sort(), ['2026-10-02.ndjson', '2026-10-15.ndjson']);
    assert.equal(r.recorderBytes, 10 + 200, 'the segment plus the two kept watch files');
    assert.ok(logs.includes('M07.watch_deleted'));
  });
});
