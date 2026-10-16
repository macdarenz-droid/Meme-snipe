// Card Z10 (found by the ops e2e's md-pull run over the pull account): M07's writer cleared the setgid bit that its
// folders inherit from the host's /var/lib/zeroed-md (2750, group zeroed-pull), so hour folders and segments got the
// worker's group and the chrooted pull account could read none of them. The inherited bit, and so the group, is kept.
import { strict as assert } from 'node:assert';
import { chmodSync, chownSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { SegmentWriter } from '../../src/m07/segments.ts';
import { tempDir } from '../helpers.ts';
import { startedQueue } from '../recorder/helpers.ts';

const AT = Date.UTC(2026, 9, 15, 10, 0, 0);

describe('Z10: M07 folders keep the md folder group', () => {
  it('in a setgid md folder, day and hour folders keep the bit, the group, and 0750 otherwise (fails before: 0750, no setgid)', () => {
    const dir = tempDir('z10-md-group');
    chmodSync(dir, 0o2750);
    const root = process.getuid?.() === 0;
    if (root) chownSync(dir, 0, 65_534);                                   // another group, as zeroed-pull is on the host
    const rec = SegmentWriter.recover({ dataDir: dir, nowMs: AT as UnixMs, log: () => undefined });
    const q = startedQueue({ firstSeq: rec.nextSeq });
    const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', queue: q, nowMs: () => AT as UnixMs, log: () => undefined }, rec);
    q.append({ stream: 'universe_manifest', recvMs: AT as UnixMs, slot: null, commitment: null, source: 'test', payload: { n: 1 } });
    w.pump();
    const [m] = w.rotate();
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
});
