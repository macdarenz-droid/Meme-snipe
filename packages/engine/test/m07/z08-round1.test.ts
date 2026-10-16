// Card Z08 round 1 (#327 red team at b55a3394): the red team's probes for Z08-13 to Z08-16 and Z08-18, Z08-19, each a
// test that fails on b55a3394 and passes after (DECISIONS "Z08 round 1").
import { strict as assert } from 'node:assert';
import { createHash, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { dailyCoverage, runDailyCoverage } from '../../src/m07/daily.ts';
import { DEFAULT_DISK_POLICY, DiskManager } from '../../src/m07/disk.ts';
import { decodedLines, runPull, type PullTransport } from '../../src/m07/md-pull.ts';
import { ed25519Key, receiptText, signReceipt } from '../../src/m07/receipt-sig.ts';
import { receiptFileName } from '../../src/m07/receipts.ts';
import { SegmentWriter, type WriterFs } from '../../src/m07/segments.ts';
import { WatchLog } from '../../src/m07/watch-log.ts';
import { RecorderQueue } from '../../src/recorder/queue.ts';
import { tempDir } from '../helpers.ts';
import { startedQueue } from '../recorder/helpers.ts';

const H0 = Date.UTC(2026, 9, 15, 10, 0, 0);
const ms = (n: number): UnixMs => n as UnixMs;
const noLog = (): void => undefined;
const append = (q: RecorderQueue, at: number, i: number, stream = 'decision'): void => {
  assert.equal(q.append({ stream, recvMs: ms(at), slot: null, commitment: null, source: 't', payload: { i } }), 'queued');
};
function start(dir: string, now: { t: number }, f?: WriterFs) {
  const rec = SegmentWriter.recover({ dataDir: dir, nowMs: ms(now.t), log: noLog, ...(f === undefined ? {} : { fs: f }) });
  const q = startedQueue({ firstSeq: rec.nextSeq });
  const lines: Array<{ level: string; code: string }> = [];
  const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', queue: q, nowMs: () => ms(now.t), log: (level, code) => lines.push({ level, code }), ...(f === undefined ? {} : { fs: f }) }, rec);
  return { q, w, rec, lines };
}
const index = (dir: string, day: string): Array<{ path: string; records: number; gaps: unknown[] }> => JSON.parse(fs.readFileSync(join(dir, day, 'index.json'), 'utf8'));
const decoded = (dir: string, rel: string): number => gunzipSync(fs.readFileSync(join(dir, rel))).toString().split('\n').filter((l) => l !== '').length;

describe('Z08-13 a same-hour restart never reopens a manifested file', () => {
  it('records equal decoded lines in every part, the index lists each part once, and the crash gap is kept', () => {
    const dir = tempDir('r1-13');
    const now = { t: H0 + 60_000 };
    // Run 1: three records, flushed, then a crash (no rotate).
    const a = start(dir, now);
    for (let i = 0; i < 3; i += 1) append(a.q, now.t, i);
    a.w.pump();
    a.w.flush();
    // Run 2, same hour: recovery gives part 0 its manifest with a crash gap; the new run writes part 1.
    now.t += 120_000;
    const b = start(dir, now);
    assert.equal(b.rec.recovered.length, 1);
    for (let i = 3; i < 5; i += 1) append(b.q, now.t, i);
    b.w.pump();
    b.w.flush();
    const [m1] = b.w.rotate();
    assert.equal(m1?.path, '2026-10-15/10/decision.p1.ndjson.gz');
    const idx = index(dir, '2026-10-15').filter((m) => m.path.includes('/decision.'));   // run 2's process_down gap opens every stream
    assert.deepEqual(idx.map((m) => m.path), ['2026-10-15/10/decision.ndjson.gz', '2026-10-15/10/decision.p1.ndjson.gz']);
    for (const m of idx) assert.equal(m.records, decoded(dir, m.path), m.path);
    const m0 = JSON.parse(fs.readFileSync(join(dir, '2026-10-15/10/decision.manifest.json'), 'utf8')) as { gaps: Array<{ reason: string }>; records: number };
    assert.deepEqual([m0.records, m0.gaps.map((g) => g.reason)], [3, ['crash']]);    // part 0's manifest is never rewritten
    assert.deepEqual([m1?.firstSeq, m1?.lastSeq], ['3', '4']);
    // A third start in the same hour continues from the highest seq of all parts.
    const c = start(dir, { t: now.t + 1 });
    assert.equal(c.rec.nextSeq.decision, 5n);
  });
});

describe('Z08-14 a failed flush never leaves a torn frame, a miscount or a signed corrupt file', () => {
  it('EIO on write after half a frame: the file is cut back, the lost records are a halted gap, not counted; later frames decode', () => {
    const dir = tempDir('r1-14');
    let tear = false;
    const f: WriterFs = {
      ...fs,
      writeSync: ((fd: number, data: Uint8Array) => {
        if (!tear) return fs.writeSync(fd, data);
        tear = false;
        fs.writeSync(fd, data.subarray(0, Math.floor(data.length / 2)));   // half a frame reaches the disk
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }) as typeof fs.writeSync,
    };
    const now = { t: H0 + 1_000 };
    const { q, w, lines } = start(dir, now, f);
    append(q, now.t, 1);
    w.pump();
    w.flush();
    append(q, now.t + 10, 2);
    w.pump();
    tear = true;
    w.flush();
    assert.ok(w.isHalted());
    now.t += 60_000;                                                    // Z08-25: resumes back off
    w.resume();
    append(q, now.t + 20, 3);
    w.pump();
    w.flush();
    const [m] = w.rotate();
    assert.ok(m !== undefined, JSON.stringify(lines));
    assert.equal(m.records, 2);                                           // records 1 and 3; 2 was lost
    assert.equal(decoded(dir, m.path), 2);                                // the whole file decodes: no torn frame inside
    assert.deepEqual(m.gaps, [{ fromMs: H0 + 1_010, toMs: H0 + 1_011, reason: 'halted' }]);
  });

  it('a write that cannot be cut back closes the part without a manifest; resume recovers it and the stream goes on in a new part', () => {
    const dir = tempDir('r1-14b');
    let failing = false;
    const f: WriterFs = {
      ...fs,
      writeSync: ((fd: number, data: Uint8Array) => {
        if (!failing) return fs.writeSync(fd, data);
        fs.writeSync(fd, data.subarray(0, 5));
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      }) as typeof fs.writeSync,
      ftruncateSync: ((fd: number, len?: number) => { if (failing) throw Object.assign(new Error('EIO'), { code: 'EIO' }); fs.ftruncateSync(fd, len); }) as typeof fs.ftruncateSync,
    };
    const now = { t: H0 + 1_000 };
    const { q, w } = start(dir, now, f);
    append(q, now.t, 1);
    w.pump();
    w.flush();
    failing = true;
    append(q, now.t + 5, 2);
    w.pump();
    w.flush();
    failing = false;
    now.t += 60_000;                                                    // Z08-25: resumes back off
    w.resume();
    const part0 = JSON.parse(fs.readFileSync(join(dir, '2026-10-15/10/decision.manifest.json'), 'utf8')) as { records: number; gaps: Array<{ reason: string }> };
    assert.deepEqual([part0.records, decoded(dir, '2026-10-15/10/decision.ndjson.gz'), part0.gaps.map((g) => g.reason)], [1, 1, ['crash']]);
    append(q, now.t + 9, 3);
    w.pump();
    w.flush();
    const [m1] = w.rotate();
    assert.equal(m1?.path, '2026-10-15/10/decision.p1.ndjson.gz');
    assert.equal(m1?.records, 1);
    assert.ok(m1?.gaps.some((g) => g.reason === 'halted' && g.fromMs === H0 + 1_005));
  });

  it('md-pull decodes before it signs: a file whose sha256 matches its manifest but does not decode to its record count gets no receipt', () => {
    const host = tempDir('r1-14-host');
    const rel = '2026-10-15/10/decision.ndjson.gz';
    fs.mkdirSync(join(host, '2026-10-15/10'), { recursive: true });
    const good = gzipSync(Buffer.from('{"a":1}\n'));
    const torn = Buffer.concat([good, gzipSync(Buffer.from('{"b":2}\n')).subarray(0, 12)]);
    fs.writeFileSync(join(host, rel), torn);
    const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
    fs.writeFileSync(join(host, '2026-10-15/10/decision.manifest.json'), JSON.stringify({
      path: rel, stream: 'decision', firstSlot: null, lastSlot: null, records: 2, bytes: torn.length, sha256: sha(torn), gaps: [], codec: 'gzip',
      firstSeq: '0', lastSeq: '1', hourUtc: '2026-10-15T10', keyframes: 0, firstRecvMs: 1, lastRecvMs: 2,
    }));
    const local = tempDir('r1-14-local');
    const key = generateKeyPairSync('ed25519');
    const transport: PullTransport = { listDays: () => ['2026-10-15'], fetchDay: (d, root) => fs.cpSync(join(host, d), join(root, d), { recursive: true }), putReceipts: () => assert.fail('no receipt may be sent') };
    const r = runPull({ transport, localRoot: local, since: '2026-10-01', privateKey: ed25519Key(key.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'private'), verifier: 'ops', nowMs: () => ms(0), log: noLog });
    assert.deepEqual([r.verified.length, r.mismatched], [0, [rel]]);
    assert.equal(decodedLines(torn, 'gzip'), -1);
    assert.equal(decodedLines(good, 'gzip'), 1);
    assert.equal(decodedLines(gzipSync(Buffer.from('not json\n')), 'gzip'), -1);
    assert.equal(decodedLines(gzipSync(Buffer.from('{"a":1}')), 'gzip'), -1);    // no final newline
    assert.equal(decodedLines(Buffer.alloc(0), 'gzip'), 0);
    assert.equal(decodedLines(good, 'zstd'), -1);
  });
});

describe('Z08-15 and Z08-16 the disk manager', () => {
  const research = generateKeyPairSync('ed25519');
  const pub = ed25519Key(research.publicKey.export({ type: 'spki', format: 'pem' }) as string, 'public');

  it('Z08-15: a halt from a failed write resumes once every limit is met, and recording goes on', () => {
    const dir = tempDir('r1-15');
    let eio = false;
    const f: WriterFs = { ...fs, fsyncSync: (fd: number) => { if (eio) throw Object.assign(new Error('EIO'), { code: 'EIO' }); fs.fsyncSync(fd); } };
    const now = { t: H0 + 1_000 };
    const { q, w } = start(dir, now, f);
    fs.mkdirSync(join(dir, 'receipts'));
    append(q, now.t, 1);
    w.pump();
    eio = true;
    w.flush();
    assert.ok(w.isHalted());
    eio = false;
    const disk = new DiskManager({ dataDir: dir, receiptsDir: join(dir, 'receipts'), publicKey: pub, policy: DEFAULT_DISK_POLICY,
      usage: () => ({ totalBytes: 55e9, freeBytes: 40e9 }), writer: w, nowMs: () => ms(now.t), log: noLog });
    now.t += 60_000;
    disk.check();
    assert.equal(w.isHalted(), false);
    append(q, now.t + 1, 2);
    assert.equal(w.pump(), 1);
  });

  it('Z08-16: the current hour and any file the writer has open are never deleted, even with a valid receipt and the disk past its limit', () => {
    const dir = tempDir('r1-16');
    const receipts = join(dir, 'receipts');
    fs.mkdirSync(receipts);
    const now = { t: H0 + 1_000 };
    const { q, w } = start(dir, now);
    append(q, now.t, 1);
    w.pump();
    w.flush();
    w.rotate();                                                           // a closed part in the current hour
    append(q, now.t + 1, 2);
    w.pump();
    w.flush();                                                            // part 1 open
    const signer = ed25519Key(research.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'private');
    for (const rel of ['2026-10-15/10/decision.ndjson.gz', '2026-10-15/10/decision.p1.ndjson.gz']) {
      const r = signReceipt({ path: rel, sha256: createHash('sha256').update(fs.readFileSync(join(dir, rel))).digest('hex'), verifiedAtMs: ms(0), verifier: 'ops' }, signer);
      fs.writeFileSync(join(receipts, receiptFileName(rel)), receiptText(r));
    }
    const disk = new DiskManager({ dataDir: dir, receiptsDir: receipts, publicKey: pub, policy: DEFAULT_DISK_POLICY,
      usage: () => ({ totalBytes: 55e9, freeBytes: 1e9 }), writer: w, nowMs: () => ms(now.t), log: noLog });
    assert.deepEqual(disk.check().deleted, []);
    assert.ok(fs.existsSync(join(dir, '2026-10-15/10/decision.ndjson.gz')));
    assert.deepEqual(w.openPaths(), ['2026-10-15/10/decision.p1.ndjson.gz']);
    // An hour later the closed part may go (the open one is still open).
    const later = new DiskManager({ dataDir: dir, receiptsDir: receipts, publicKey: pub, policy: DEFAULT_DISK_POLICY,
      usage: () => ({ totalBytes: 55e9, freeBytes: 1e9 }), writer: w, nowMs: () => ms(now.t + 3_600_000), log: noLog });
    assert.deepEqual(later.check().deleted, ['2026-10-15/10/decision.ndjson.gz']);
  });
});

describe('Z08-18 and Z08-19', () => {
  it('Z08-18: a watch whose write fails is not remembered, so the next watch writes it', () => {
    const dir = tempDir('r1-18');
    let fail = true;
    const errors: unknown[] = [];
    const wl = new WatchLog(dir, (e) => errors.push(e), { ...fs, appendFileSync: ((p: fs.PathOrFileDescriptor, d: string | Uint8Array, o?: fs.WriteFileOptions) => { if (fail) throw new Error('EIO'); fs.appendFileSync(p, d, o); }) as typeof fs.appendFileSync });
    wl.watch('A', 'candidate', ms(Date.UTC(2026, 9, 15, 1)));
    fail = false;
    wl.watch('A', 'candidate', ms(Date.UTC(2026, 9, 15, 2)));
    assert.equal(errors.length, 1);
    assert.deepEqual(WatchLog.readDay(dir, '2026-10-15').map((i) => (i.fromMs - Date.UTC(2026, 9, 15)) / 3_600_000), [2]);
    // An unwatch whose write fails keeps the pool watched (the log still shows it open), and a retry closes it.
    fail = true;
    wl.unwatch('A', ms(Date.UTC(2026, 9, 15, 3)));
    fail = false;
    wl.unwatch('A', ms(Date.UTC(2026, 9, 15, 4)));
    assert.deepEqual(WatchLog.readDay(dir, '2026-10-15').map((i) => (i.toMs - Date.UTC(2026, 9, 15)) / 3_600_000), [4]);
  });

  it('Z08-19: the 00:00 job waits until hour 23 is closed; a full-coverage day then gives missingBps 0', () => {
    const dir = tempDir('r1-19');
    const D0 = Date.UTC(2026, 9, 15);
    const now = { t: D0 + 1_000 };
    const wl = new WatchLog(dir, noLog);
    wl.watch('A', 'candidate', ms(D0));
    const { q, w } = start(dir, now);
    for (let m = 0; m < 1_440; m += 1) {
      now.t = D0 + m * 60_000 + 30_000;
      // One poll_counts record per 15-second bar (ruling Z09-32).
      for (let b = 0; b < 4; b++) {
        const barStartMs = D0 + m * 60_000 + b * 15_000;
        q.append({ stream: 'poll_counts', recvMs: ms(now.t), slot: null, commitment: null, source: 'm07', payload: { poolId: 'A', barStartMs, durationMs: 15_000, minuteStartMs: D0 + m * 60_000, successfulPolls: 15, changedPolls: 0, failedPolls: 0, priorityClass: 'candidate' } });
      }
      w.pump();
    }
    const out: unknown[] = [];
    now.t = D0 + 86_400_000;                                             // 00:00:00, before the writer's pump closes hour 23
    const early = runDailyCoverage({ dataDir: dir, nowMs: ms(now.t), universeManifestSha256: null, closedThrough: () => w.lastRotatedHourUtc(), append: (r) => out.push(r), save: noLog });
    assert.equal(early, null);
    assert.equal(out.length, 0);
    w.pump();                                                             // the hour change closes hour 23
    const c = runDailyCoverage({ dataDir: dir, nowMs: ms(now.t), universeManifestSha256: null, closedThrough: () => w.lastRotatedHourUtc(), append: (r) => out.push(r), save: noLog });
    assert.ok(c !== null);
    assert.equal(c.detail.missingBps, 0);
    assert.equal(c.report.lowCoverage, false);
    assert.equal(dailyCoverage({ dataDir: dir, dayUtc: '2026-10-15', universeManifestSha256: null }).detail.missingBps, 0);
  });
});
