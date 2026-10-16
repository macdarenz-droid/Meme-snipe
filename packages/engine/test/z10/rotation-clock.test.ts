// Ruling Z10-31: M07's hour rotation on fake time across a forward and a backward wall-clock step (the recorder's wall
// clock can step: NTP corrections, a VM resumed). Whatever the clock does, no record is lost, written twice or
// re-ordered, no closed segment is reopened or overwritten, and every manifest's hash matches its file.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { SegmentWriter } from '../../src/m07/segments.ts';
import { dayManifests } from '../../src/m07/daily.ts';
import { tempDir } from '../helpers.ts';
import { startedQueue } from '../recorder/helpers.ts';

const T0 = Date.UTC(2026, 9, 15, 10, 59, 50);

describe('Z10-31 M07 hour rotation across wall-clock steps', () => {
  it('forward 2 h, then back 90 min: every record once, in order, closed segments untouched, hashes valid', () => {
    const dir = tempDir('z10-rot');
    const now = { t: T0 };
    const rec = SegmentWriter.recover({ dataDir: dir, nowMs: now.t as UnixMs, log: () => undefined });
    const q = startedQueue({ firstSeq: rec.nextSeq });
    const logs: string[] = [];
    const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', queue: q, nowMs: () => now.t as UnixMs, log: (_l, code) => { logs.push(code); } }, rec);
    let n = 0;
    const rotated: string[] = [];
    const put = (): void => {
      q.append({ stream: 'decision', recvMs: now.t as UnixMs, slot: null, commitment: null, source: 'test', payload: { n: n++ } });
      w.pump();
      if (rotated.at(-1) !== w.lastRotatedHourUtc()) rotated.push(w.lastRotatedHourUtc());
    };
    const sealedAt = new Map<string, string>();
    const seal = (): void => { for (const m of dayManifests(dir, '2026-10-15')) if (!sealedAt.has(m.path)) sealedAt.set(m.path, m.sha256); };
    for (let i = 0; i < 20; i++) { now.t += 1_000; put(); }            // 10:59:50 → 11:00:10: one normal rotation
    seal();
    now.t += 2 * 3_600_000;                                            // forward 2 h: 13:00:10
    for (let i = 0; i < 10; i++) { now.t += 1_000; put(); }
    seal();
    now.t -= 90 * 60_000;                                              // back 90 min: 11:30:20 (an hour already closed)
    for (let i = 0; i < 10; i++) { now.t += 1_000; put(); }
    seal();
    now.t += 3 * 3_600_000;                                            // and on past the hour again
    for (let i = 0; i < 5; i++) { now.t += 1_000; put(); }
    w.rotate();
    const manifests = [...dayManifests(dir, '2026-10-15')].filter((m) => m.stream === 'decision');
    // Every manifest's hash matches its file, and a segment sealed earlier was never rewritten.
    for (const m of dayManifests(dir, '2026-10-15')) {
      assert.equal(createHash('sha256').update(fs.readFileSync(join(dir, m.path))).digest('hex'), m.sha256, m.path);
      const before = sealedAt.get(m.path);
      if (before !== undefined) assert.equal(m.sha256, before, `${m.path} was rewritten`);
    }
    // Every record exactly once, in seq order across segments.
    const seen = manifests.sort((a, b) => (BigInt(a.firstSeq) < BigInt(b.firstSeq) ? -1 : 1))
      .flatMap((m) => gunzipSync(fs.readFileSync(join(dir, m.path))).toString('utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { seq: string; payload: { n: number } }));
    assert.deepEqual(seen.map((r) => r.payload.n), Array.from({ length: n }, (_, i) => i));
    for (let i = 1; i < seen.length; i++) assert.ok(BigInt(seen[i]!.seq) > BigInt(seen[i - 1]!.seq));
    // The hour already closed takes the late records in a new part, never in its sealed file.
    assert.deepEqual(manifests.map((m) => m.path), ['2026-10-15/10/decision.ndjson.gz', '2026-10-15/11/decision.ndjson.gz', '2026-10-15/13/decision.ndjson.gz', '2026-10-15/11/decision.p1.ndjson.gz', '2026-10-15/14/decision.ndjson.gz']);
    assert.equal(logs.filter((c) => c === 'M07.segment_rotated').length, 5);
    // The daily job's closedThrough (lastRotatedHourUtc) never moves back with the clock.
    for (let i = 1; i < rotated.length; i++) assert.ok(rotated[i]! > rotated[i - 1]!, JSON.stringify(rotated));
  });
});
