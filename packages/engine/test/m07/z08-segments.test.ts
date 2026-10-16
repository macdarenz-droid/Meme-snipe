// A-M07-02 (card Z08): segment writer, manifests and crash recovery. Acceptance bullets of SPEC-A A-M07-02, its
// failure injections (kill during write, fsync error, disk full) and the Zeroed bug of MIGRATION's A-M07-02 row (OOM/RTC:
// a kill mid-segment left no partial manifest and could duplicate records; fail-before run on Zeroed's recorder recorded in DECISIONS Z08-29).
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import type { Slot, UnixMs } from '@bot/types';
import {
  addRecord, buildManifest, emptyStats, frameStarts, hourOf, isManifest, manifestNameOf, parseSegmentName, segmentPaths, statsOfLine,
} from '../../src/m07/manifest.ts';
import { compressorFor, resolveCodec, SegmentWriter, type WriterFs, type WriterLog } from '../../src/m07/segments.ts';
import { RecorderQueue } from '../../src/recorder/queue.ts';
import { tempDir, waitFor } from '../helpers.ts';
import { startedQueue } from '../recorder/helpers.ts';

const H0 = Date.UTC(2026, 9, 15, 10, 0, 0);
type LogLine = { level: string; code: string; fields: Record<string, string | number> };
const logger = (): { lines: LogLine[]; log: WriterLog } => {
  const lines: LogLine[] = [];
  return { lines, log: (level, code, fields) => { lines.push({ level, code, fields }); } };
};
const append = (q: RecorderQueue, recvMs: number, i: number, stream = 'decision', slot: bigint | null = BigInt(1_000 + i)): void => {
  const r = q.append({ stream, recvMs: recvMs as UnixMs, slot: slot as Slot | null, commitment: 'confirmed', source: 'test', payload: { i } });
  assert.equal(r, 'queued');
};
const readLines = (dir: string, rel: string): string[] =>
  gunzipSync(fs.readFileSync(join(dir, rel))).toString('utf8').split('\n').filter((l) => l !== '');
const manifestOf = (dir: string, rel: string): unknown => JSON.parse(fs.readFileSync(join(dir, rel), 'utf8'));

function writer(dir: string, now: { t: number }, over: { fs?: WriterFs } = {}) {
  const l = logger();
  const recovery = SegmentWriter.recover({ dataDir: dir, nowMs: now.t as UnixMs, log: l.log, ...(over.fs === undefined ? {} : { fs: over.fs }) });
  const q = startedQueue({ firstSeq: recovery.nextSeq });
  const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', queue: q, nowMs: () => now.t as UnixMs, log: l.log, ...(over.fs === undefined ? {} : { fs: over.fs }) }, recovery);
  return { q, w, recovery, ...l };
}

describe('A-M07-02 manifests (pure, manifest.ts)', () => {
  it('hours, paths and names', () => {
    const h = hourOf((H0 + 59 * 60_000) as UnixMs);
    assert.deepEqual(h, { day: '2026-10-15', hour: '10', hourUtc: '2026-10-15T10', startMs: H0, endMs: H0 + 3_600_000 });
    assert.deepEqual(segmentPaths('2026-10-15', '10', 'fill', 'gzip'), { dir: '2026-10-15/10', segment: '2026-10-15/10/fill.ndjson.gz', manifest: '2026-10-15/10/fill.manifest.json' });
    assert.equal(segmentPaths('d', 'h', 's', 'zstd').segment, 'd/h/s.ndjson.zst');
    assert.deepEqual(parseSegmentName('pool_snapshot.ndjson.gz'), { stream: 'pool_snapshot', part: 0, codec: 'gzip' });
    assert.deepEqual(parseSegmentName('fill.ndjson.zst'), { stream: 'fill', part: 0, codec: 'zstd' });
    assert.deepEqual(parseSegmentName('fill.p12.ndjson.gz'), { stream: 'fill', part: 12, codec: 'gzip' });
    assert.equal(parseSegmentName('fill.p0.ndjson.gz'), null);
    assert.equal(manifestNameOf('fill.p3.ndjson.gz'), 'fill.p3.manifest.json');
    assert.equal(manifestNameOf('fill.ndjson.gz'), 'fill.manifest.json');
    assert.equal(manifestNameOf('notes.txt'), null);
    assert.equal(segmentPaths('d', 'h', 's', 'gzip', 2).manifest, 'd/h/s.p2.manifest.json');
    assert.equal(parseSegmentName('.ndjson.gz'), null);
    assert.equal(parseSegmentName('Bad-Name.ndjson.gz'), null);
    assert.equal(parseSegmentName('fill.manifest.json'), null);
  });

  it('stats: slot range by value, keyframes counted, seq first/last; gaps merged by reason and pool', () => {
    const s = emptyStats();
    addRecord(s, { seq: 5n, slot: 30n, recvMs: 20 as UnixMs, keyframe: true });
    addRecord(s, { seq: 6n, slot: 10n, recvMs: 10 as UnixMs, keyframe: false });
    addRecord(s, { seq: 7n, slot: null, recvMs: 30 as UnixMs, keyframe: false });
    const m = buildManifest({ path: 'p', stream: 's', codec: 'gzip', hourUtc: 'h', bytes: 1, sha256: 'a'.repeat(64), stats: s, gaps: [
      { fromMs: 5 as UnixMs, toMs: 9 as UnixMs, reason: 'crash' }, { fromMs: 1 as UnixMs, toMs: 5 as UnixMs, reason: 'crash' },
      { fromMs: 2 as UnixMs, toMs: 3 as UnixMs, reason: 'moved', poolId: 'A' }, { fromMs: 2 as UnixMs, toMs: 4 as UnixMs, reason: 'moved', poolId: 'B' },
      { fromMs: 7 as UnixMs, toMs: 7 as UnixMs, reason: 'crash' }, { fromMs: 1 as UnixMs, toMs: 3 as UnixMs, reason: 'backpressure' },
      { fromMs: 1 as UnixMs, toMs: 2 as UnixMs, reason: 'backpressure' },
    ] });
    assert.deepEqual([m.firstSlot, m.lastSlot, m.firstSeq, m.lastSeq, m.records, m.keyframes, m.firstRecvMs, m.lastRecvMs], ['10', '30', '5', '7', 3, 1, 10, 30]);
    assert.deepEqual(m.gaps, [
      { fromMs: 1, toMs: 3, reason: 'backpressure' }, { fromMs: 1, toMs: 9, reason: 'crash' },
      { fromMs: 2, toMs: 3, reason: 'moved', poolId: 'A' }, { fromMs: 2, toMs: 4, reason: 'moved', poolId: 'B' },
    ]);
    assert.ok(isManifest(m));
    const empty = buildManifest({ path: 'p', stream: 's', codec: 'zstd', hourUtc: 'h', bytes: 0, sha256: 'b'.repeat(64), stats: emptyStats(), gaps: [] });
    assert.deepEqual([empty.firstSlot, empty.lastSlot, empty.firstSeq, empty.lastSeq], [null, null, null, null]);
    for (const bad of [null, 1, { ...m, sha256: 'x' }, { ...m, codec: 'lz4' }, { ...m, records: 1.5 }, { ...m, firstSeq: 1 }, { ...m, lastRecvMs: 'x' }, { ...m, gaps: {} }]) {
      assert.equal(isManifest(bad), false);
    }
    assert.deepEqual(statsOfLine('{"payload":{"kind":"keyframe"},"recvMs":1,"seq":"2","slot":null}'), { seq: 2n, slot: null, recvMs: 1, keyframe: true });
    assert.equal(statsOfLine('{"payload":null,"recvMs":1,"seq":"2","slot":"9"}').keyframe, false);
  });

  it('frame starts: every gzip member and zstd frame boundary is found', () => {
    const a = gzipSync(Buffer.from('a\n'));
    const b = gzipSync(Buffer.from('b\n'));
    assert.deepEqual(frameStarts(Buffer.concat([a, b]), 'gzip'), [a.length]);
    assert.deepEqual(frameStarts(Uint8Array.from([0, 0x28, 0xb5, 0x2f, 0xfd, 0x28, 0xb5]), 'zstd'), [1]);
    assert.deepEqual(frameStarts(Uint8Array.from([0x1f, 0x8b]), 'gzip'), []);
  });
});

describe('A-M07-02 segment writer', () => {
  it('acceptance: every segment and its manifest agree: sha256(file) == manifest.sha256 and records == decoded lines; slot range and seqs; the day index lists it', () => {
    const dir = tempDir('z08-seg');
    const now = { t: H0 + 60_000 };
    const { q, w } = writer(dir, now);
    for (let i = 0; i < 25; i += 1) append(q, now.t + i, i);
    assert.equal(w.pump(), 25);
    w.flush();
    for (let i = 25; i < 40; i += 1) append(q, now.t + i, i);
    w.pump();
    w.flush();
    const [m] = w.rotate();
    assert.ok(m !== undefined);
    const file = fs.readFileSync(join(dir, m.path));
    assert.equal(createHash('sha256').update(file).digest('hex'), m.sha256);
    assert.equal(readLines(dir, m.path).length, m.records);
    assert.equal(m.records, 40);
    assert.deepEqual([m.firstSeq, m.lastSeq, m.firstSlot, m.lastSlot, m.codec, m.hourUtc, m.bytes], ['0', '39', '1000', '1039', 'gzip', '2026-10-15T10', file.length]);
    assert.deepEqual(manifestOf(dir, '2026-10-15/10/decision.manifest.json'), m);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, '2026-10-15/index.json'), 'utf8')), [m]);
    assert.equal(fs.statSync(join(dir, m.path)).mode & 0o777, 0o640);
    assert.equal(fs.statSync(join(dir, '2026-10-15')).mode & 0o777, 0o750);
  });

  it('rotates at the UTC hour: a record belongs to the segment open when it is dequeued; snapshots restart with keyframes', () => {
    const dir = tempDir('z08-hour');
    const now = { t: H0 + 3_599_000 };
    const { q, w } = writer(dir, now);
    const snap = (recvMs: number, hash: string): void => {
      assert.equal(q.append({ stream: 'pool_snapshot', recvMs: recvMs as UnixMs, slot: 1n as Slot, commitment: 'confirmed', source: 't', payload: { poolId: 'P', rawHash: hash, priorityClass: 'candidate', fields: { a: hash } } }), 'queued');
    };
    snap(now.t, 'h1');
    w.pump();
    snap(now.t + 500, 'h2');                                              // stamped in hour 10, dequeued in hour 11
    now.t = H0 + 3_600_500;
    w.pump();
    w.flush();
    const [m11] = w.rotate();
    assert.equal(m11?.path, '2026-10-15/11/pool_snapshot.ndjson.gz');
    const m10 = manifestOf(dir, '2026-10-15/10/pool_snapshot.manifest.json') as { records: number; keyframes: number };
    assert.deepEqual([m10.records, m10.keyframes, m11?.records, m11?.keyframes], [1, 1, 1, 1]);
    assert.equal(JSON.parse(readLines(dir, '2026-10-15/11/pool_snapshot.ndjson.gz')[0] as string).payload.kind, 'keyframe');
  });

  it('acceptance and Zeroed OOM/RTC: a kill -9 mid-hour leaves a segment that decodes to its last flushed frame, gets a manifest with a crash gap, and no record is duplicated across the restart', async () => {
    const dir = tempDir('z08-kill');
    const src = (p: string): string => JSON.stringify(new URL(p, import.meta.url).href);
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import { SegmentWriter } from ${src('../../src/m07/segments.ts')};
      import { RecorderQueue } from ${src('../../src/recorder/queue.ts')};
      const dir = ${JSON.stringify(dir)};
      const now = () => ${H0} + 120000;
      const log = () => {};
      const rec = SegmentWriter.recover({ dataDir: dir, nowMs: now(), log });
      const q = new RecorderQueue({ firstSeq: rec.nextSeq });
      q.markProcessStart('child', now());
      const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', queue: q, nowMs: now, log }, rec);
      let i = 0;
      let flushes = 0;
      const t = setInterval(() => {
        for (let k = 0; k < 200; k += 1) { q.append({ stream: 'decision', recvMs: now() + i, slot: BigInt(i), commitment: 'confirmed', source: 't', payload: { i, pad: 'x'.repeat(200) } }); i += 1; }
        w.pump(); w.flush(); process.stdout.write('f' + i + '\\n');
        // Ruling Z10-40: after 5 flushes the child stops writing and says so, so the kill below never lands inside a
        // write (on a loaded machine it could, and the read-back would end in a torn frame). The torn write itself is
        // made by the test, below, at a known place. The segment stays open and unrotated, as in a crash mid-hour.
        if (++flushes === 5) { clearInterval(t); process.stdout.write('idle\\n'); setInterval(() => {}, 1000); }
      }, 5);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    await waitFor(() => out.includes('idle'));
    assert.equal((out.match(/f\d+/g) ?? []).length, 5);
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    // The kill may land between frames; also cut the file inside a frame, as a kill during write would.
    const rel = '2026-10-15/10/decision.ndjson.gz';
    const full = fs.readFileSync(join(dir, rel));
    const half = gzipSync(Buffer.from('{"never":"complete"}\n'));
    fs.writeFileSync(join(dir, rel), Buffer.concat([full, half.subarray(0, half.length - 7)]));
    assert.equal(fs.existsSync(join(dir, '2026-10-15/10/decision.manifest.json')), false);
    const now = { t: H0 + 600_000 };
    const { q, w, recovery, lines } = writer(dir, now);
    // The child's open segments: its decisions and its process_start marker (Z09-49).
    assert.deepEqual(recovery.recovered.map((x) => x.stream).sort(), ['decision', 'process_start']);
    const m = recovery.recovered.find((x) => x.stream === 'decision');
    assert.ok(m !== undefined);
    assert.equal(m.bytes, full.length);                                   // cut after the last complete frame
    const decoded = readLines(dir, rel);
    assert.equal(decoded.length, m.records);
    assert.deepEqual(m.gaps, [{ fromMs: m.lastRecvMs, toMs: now.t, reason: 'crash' }]);
    assert.ok(lines.some((x) => x.code === 'M07.crash_recovered'));
    assert.equal(createHash('sha256').update(fs.readFileSync(join(dir, rel))).digest('hex'), m.sha256);
    // After the restart: seqs continue, no seq or record appears twice.
    append(q, now.t, 99_999);
    w.pump();
    w.flush();
    const [after] = w.rotate();
    assert.equal(after?.firstSeq, (BigInt(m.lastSeq as string) + 1n).toString());
    // Review on b55a3394: the restart writes a new part, never the recovered one, and the counts hold on both sides.
    assert.equal(after?.path, '2026-10-15/10/decision.p1.ndjson.gz');
    assert.equal(after?.records, 1);
    const afterLines = readLines(dir, after.path);
    assert.equal(afterLines.length, after.records);
    assert.equal(createHash('sha256').update(fs.readFileSync(join(dir, rel))).digest('hex'), m.sha256);   // part 0 untouched
    const index = (JSON.parse(fs.readFileSync(join(dir, '2026-10-15/index.json'), 'utf8')) as Array<{ path: string }>).map((x) => x.path).filter((x) => x.includes('/decision.'));
    assert.deepEqual(index, [rel, after.path]);                           // one index entry per part
    const seqs = [...decoded, ...afterLines].map((l) => JSON.parse(l).seq as string);
    assert.equal(seqs.length, m.records + after.records);
    assert.equal(new Set(seqs).size, seqs.length);
    // The time since the newest record is a process_down gap on every stream that wrote after the restart.
    assert.deepEqual(after?.gaps, [{ fromMs: m.lastRecvMs, toMs: now.t, reason: 'process_down' }]);
  }, 30_000);

  it('a segment whose every byte is a broken frame recovers as empty (0 records) and is still given a manifest', () => {
    const dir = tempDir('z08-broken');
    fs.mkdirSync(join(dir, '2026-10-15/10'), { recursive: true });
    fs.writeFileSync(join(dir, '2026-10-15/10/fill.ndjson.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0, 1, 2]));
    fs.writeFileSync(join(dir, '2026-10-15/10/notes.txt'), 'x');
    fs.mkdirSync(join(dir, 'not-a-day'));
    const r = SegmentWriter.recover({ dataDir: dir, nowMs: (H0 + 5_000) as UnixMs, log: () => undefined });
    assert.equal(r.recovered[0]?.records, 0);
    assert.equal(r.recovered[0]?.bytes, 0);
    assert.deepEqual(r.recovered[0]?.gaps, [{ fromMs: H0, toMs: H0 + 5_000, reason: 'crash' }]);
    assert.equal(r.lastRecordMs, null);
    // A second start finds the manifest and recovers nothing.
    assert.equal(SegmentWriter.recover({ dataDir: dir, nowMs: (H0 + 6_000) as UnixMs, log: () => undefined }).recovered.length, 0);
    assert.deepEqual(SegmentWriter.recover({ dataDir: join(dir, 'absent'), nowMs: H0 as UnixMs, log: () => undefined }), { nextSeq: {}, lastRecordMs: null, recovered: [] });
  });

  it('seq continues per stream from the newest manifest that has one, across days', () => {
    const dir = tempDir('z08-seq');
    const now = { t: H0 };
    const a = writer(dir, now);
    for (let i = 0; i < 3; i += 1) append(a.q, now.t, i, 'fill');
    append(a.q, now.t, 0, 'decision');
    a.w.pump();
    a.w.rotate();
    now.t = H0 + 86_400_000;                                             // next day: only decision writes
    const b = writer(dir, now);
    assert.deepEqual(b.recovery.nextSeq, { fill: 3n, decision: 1n });
    append(b.q, now.t, 1, 'decision');
    b.w.pump();
    b.w.rotate();
    const c = writer(dir, { t: now.t + 1 });
    assert.deepEqual(c.recovery.nextSeq, { fill: 3n, decision: 2n });    // fill found on the older day
  });

  it('fsync error: critical alert, market streams halt into `halted` gaps, universe_manifest and coverage keep recording; resume closes the gap', () => {
    const dir = tempDir('z08-fsync');
    let failFsync = false;
    const faulty: WriterFs = { ...fs, fsyncSync: (fd: number) => { if (failFsync) throw Object.assign(new Error('EIO'), { code: 'EIO' }); fs.fsyncSync(fd); } };
    const now = { t: H0 + 1_000 };
    const { q, w, lines } = writer(dir, now, { fs: faulty });
    append(q, now.t, 1);
    w.pump();
    failFsync = true;
    w.flush();
    assert.ok(w.isHalted());
    assert.ok(lines.some((l) => l.level === 'critical' && l.code === 'M07.write_failed' && l.fields.code === 'EIO'));
    assert.ok(lines.some((l) => l.level === 'critical' && l.code === 'M07.recording_halted'));
    now.t += 1_000;
    append(q, now.t, 2);
    append(q, now.t, 3, 'coverage');
    assert.equal(w.pump(), 1);                                            // only coverage was written
    failFsync = false;
    now.t += 60_000;                                                      // resumes wait 60 s after a failed write (Z08-25)
    w.resume();
    w.resume();                                                           // a second resume is a no-op
    append(q, now.t, 4);
    w.pump();
    w.flush();
    const ms = w.rotate();
    const decision = ms.find((m) => m.stream === 'decision');
    assert.deepEqual(decision?.gaps, [{ fromMs: H0 + 1_000, toMs: now.t, reason: 'halted' }]);
    assert.equal(ms.find((m) => m.stream === 'coverage')?.records, 1);
    w.halt('again');
    w.halt('twice');                                                      // logged once
    assert.equal(lines.filter((l) => l.code === 'M07.recording_halted').length, 2);
  });

  it('disk full while opening a segment or writing its manifest: halt with a critical alert; the next start recovers the segment', () => {
    const dir = tempDir('z08-full');
    let full = false;
    const enospc = (): never => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
    const faulty: WriterFs = {
      ...fs,
      openSync: ((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => (full && String(p).endsWith('.tmp') ? enospc() : fs.openSync(p, flags ?? 'r', mode))) as typeof fs.openSync,
      mkdirSync: ((p: fs.PathLike, o?: fs.MakeDirectoryOptions) => (full ? enospc() : fs.mkdirSync(p, o))) as typeof fs.mkdirSync,
    };
    const now = { t: H0 + 1_000 };
    const { q, w, lines } = writer(dir, now, { fs: faulty });
    append(q, now.t, 1);
    w.pump();
    full = true;
    assert.deepEqual(w.rotate(), []);                                     // the manifest could not be written
    assert.ok(lines.some((l) => l.code === 'M07.write_failed' && l.fields.op === 'rotate' && l.fields.code === 'ENOSPC'));
    now.t += 60_000;
    w.resume();
    now.t = H0 + 3_600_000;                                              // a new hour needs a new folder: also full
    append(q, now.t, 2, 'coverage');
    w.pump();
    // Same failed-write episode (no write went through in between): no second critical alert (ruling Z08-25).
    assert.equal(lines.filter((l) => l.code === 'M07.write_failed').length, 1);
    assert.ok(lines.some((l) => l.code === 'M07.recording_halted_again' && l.level === 'warning'));
    const failures = lines.filter((l) => l.code === 'M07.write_failed').length;
    for (let i = 0; i < 5; i += 1) append(q, now.t + i, 3 + i, 'coverage');
    w.pump();
    assert.equal(lines.filter((l) => l.code === 'M07.write_failed').length, failures);   // once per halt, no flood
    full = false;
    const r = SegmentWriter.recover({ dataDir: dir, nowMs: (now.t + 1) as UnixMs, log: () => undefined });
    assert.equal(r.recovered.find((m) => m.stream === 'decision')?.records, 1);
  });

  it('a gap with no records still gets a segment and a manifest; an unknown codec is refused', () => {
    const dir = tempDir('z08-gaponly');
    const now = { t: H0 + 1_000 };
    const l = logger();
    const gaps = { poll_counts: [{ fromMs: H0 as UnixMs, toMs: (H0 + 60_000) as UnixMs, reason: 'moved' as const, poolId: 'P' }] };
    let drained = false;
    const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', nowMs: () => now.t as UnixMs, log: l.log,
      queue: { take: () => [], drainGaps: () => { if (drained) return {}; drained = true; return gaps; } } }, { nextSeq: {}, lastRecordMs: null, recovered: [] });
    w.pump();
    w.flush();
    const [m] = w.rotate();
    assert.deepEqual([m?.stream, m?.records, m?.bytes, m?.gaps], ['poll_counts', 0, 0, gaps.poll_counts]);
    assert.ok(compressorFor('gzip') !== null);
    assert.throws(() => new SegmentWriter({ dataDir: dir, codec: 'lz4' as 'gzip', nowMs: () => H0 as UnixMs, log: l.log, queue: { take: () => [], drainGaps: () => ({}) } },
      { nextSeq: {}, lastRecordMs: null, recovered: [] }));
  });

  it('zstd is not used: node:zlib on this Node decodes only the first frame of a multi-frame file (pinned); a zstd preference falls back to gzip', () => {
    const z = zlib as unknown as { zstdCompressSync?: (b: Uint8Array) => Buffer; zstdDecompressSync?: (b: Uint8Array) => Buffer };
    if (typeof z.zstdCompressSync === 'function' && typeof z.zstdDecompressSync === 'function') {
      const two = Buffer.concat([z.zstdCompressSync(Buffer.from('a\n')), z.zstdCompressSync(Buffer.from('b\n'))]);
      // If this ever reads 'a\nb\n', zstd can be reconsidered in a reviewed change.
      assert.equal(z.zstdDecompressSync(two).toString(), 'a\n');
    }
    assert.equal(compressorFor('zstd'), null);
    const l = logger();
    assert.equal(resolveCodec('zstd', l.log), 'gzip');
    assert.equal(resolveCodec('gzip', l.log), 'gzip');
    assert.deepEqual(l.lines.map((x) => x.code), ['M07.codec_fallback']);
    // A zstd segment found on disk is still given a manifest (empty: it cannot be read here), never deleted.
    const dir = tempDir('z08-zstd');
    fs.mkdirSync(join(dir, '2026-10-15/10'), { recursive: true });
    fs.writeFileSync(join(dir, '2026-10-15/10/fill.ndjson.zst'), Buffer.from([1, 2, 3]));
    const r = SegmentWriter.recover({ dataDir: dir, nowMs: (H0 + 1) as UnixMs, log: () => undefined });
    assert.deepEqual([r.recovered[0]?.codec, r.recovered[0]?.records, r.recovered[0]?.bytes], ['zstd', 0, 3]);
    assert.equal(fs.readFileSync(join(dir, '2026-10-15/10/fill.ndjson.zst')).length, 3);
  });
});
