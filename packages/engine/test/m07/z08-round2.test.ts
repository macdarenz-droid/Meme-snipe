// Card Z08 round 2 (#327 red team at 0f7a4450): the red team's probes for Z08-23 to Z08-25, each a test that fails on
// 0f7a4450 and passes after (DECISIONS "Z08 round 2").
import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { DEFAULT_DISK_POLICY, DiskManager } from '../../src/m07/disk.ts';
import { FRAME_CAPS, scanGzipFrames } from '../../src/m07/frames.ts';
import { decodedLines, runPull, type PullTransport } from '../../src/m07/md-pull.ts';
import { ed25519Key } from '../../src/m07/receipt-sig.ts';
import { SegmentWriter, type WriterFs } from '../../src/m07/segments.ts';
import { RecorderQueue } from '../../src/recorder/queue.ts';
import { tempDir } from '../helpers.ts';
import { startedQueue } from '../recorder/helpers.ts';

const H0 = Date.UTC(2026, 9, 15, 10, 0, 0);
const ms = (n: number): UnixMs => n as UnixMs;
const noLog = (): void => undefined;
const HOUR = 3_600_000;                                                  // RESUME_BACKOFF_MAX_MS
const line = (seq: number, payload: string): string =>
  `{"commitment":null,"payload":{"s":${JSON.stringify(payload)}},"recvMs":${H0 - 3_600_000 + seq},"seq":"${seq}","slot":null,"source":"t","stream":"decision"}\n`;
function start(dir: string, now: { t: number }, f?: WriterFs) {
  const rec = SegmentWriter.recover({ dataDir: dir, nowMs: ms(now.t), log: noLog, ...(f === undefined ? {} : { fs: f }) });
  const q = startedQueue({ firstSeq: rec.nextSeq });
  const lines: Array<{ level: string; code: string; at: number }> = [];
  const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', queue: q, nowMs: () => ms(now.t), log: (level, code) => lines.push({ level, code, at: now.t }), ...(f === undefined ? {} : { fs: f }) }, rec);
  return { q, w, lines };
}
const append = (q: RecorderQueue, at: number, i: number): void => {
  q.append({ stream: 'decision', recvMs: ms(at), slot: null, commitment: null, source: 't', payload: { i } });
};
/** Signs every segment md-pull verifies in `host` (a local transport) and returns the verified and mismatched paths. */
function pull(host: string): { verified: string[]; mismatched: string[] } {
  const key = generateKeyPairSync('ed25519');
  const transport: PullTransport = { listDays: () => fs.readdirSync(host).filter((d) => /^\d{4}-/.test(d)), fetchDay: (d, root) => fs.cpSync(join(host, d), join(root, d), { recursive: true }), putReceipts: () => undefined };
  const r = runPull({ transport, localRoot: tempDir('r2-local'), since: '2026-10-01', privateKey: ed25519Key(key.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'private'), verifier: 'ops', nowMs: () => ms(0), log: noLog });
  return { verified: r.verified.map((v) => v.path), mismatched: r.mismatched };
}

describe('Z08-23 a segment is read frame by frame, never as one string', () => {
  it('an intact segment that decodes to more than 512 MiB is not cut by recovery, and md-pull signs it [timing]', { timeout: 300_000 }, () => {
    const dir = tempDir('r2-23-big');
    const rel = '2026-10-15/09/decision.ndjson.gz';
    fs.mkdirSync(join(dir, '2026-10-15/09'), { recursive: true });
    const payload = 'a'.repeat(65_000);
    const perFrame = 16;                                                  // about 1 MiB decoded per frame
    const frames = 560;                                                   // about 587 MB decoded, past V8's string limit
    const fd = fs.openSync(join(dir, rel), 'w');
    for (let f = 0; f < frames; f += 1) {
      let text = '';
      for (let i = 0; i < perFrame; i += 1) text += line(f * perFrame + i, payload);
      fs.writeSync(fd, gzipSync(Buffer.from(text), { level: 1 }));
    }
    fs.closeSync(fd);
    const size = fs.statSync(join(dir, rel)).size;
    const rec = SegmentWriter.recover({ dataDir: dir, nowMs: ms(H0 + 1_000), log: noLog });
    assert.equal(rec.recovered.length, 1);
    const m = JSON.parse(fs.readFileSync(join(dir, '2026-10-15/09/decision.manifest.json'), 'utf8')) as { records: number; bytes: number; lastSeq: string };
    assert.deepEqual([m.records, m.bytes, m.lastSeq, fs.statSync(join(dir, rel)).size], [frames * perFrame, size, String(frames * perFrame - 1), size]);
    assert.deepEqual(pull(dir), { verified: [rel], mismatched: [] });
  });

  it('the streaming path: each frame is read on its own and split line by line, across frames and multi-byte characters (round 3: caps replace chunks)', () => {
    const text1 = `${line(0, 'héllo €')}${line(1, '日本語')}`;
    const text2 = line(2, '😀'.repeat(5));
    const buf = Buffer.concat([gzipSync(Buffer.from(text1)), gzipSync(Buffer.from(text2))]);
    const want = [...text1.split('\n').slice(0, 2), text2.slice(0, -1)];
    const longest = Math.max(...want.map((l) => Buffer.byteLength(l)));
    for (const caps of [FRAME_CAPS, { memberBytes: Buffer.byteLength(text1), lineBytes: longest }]) {
      const got: string[] = [];
      const scan = scanGzipFrames(buf, (l) => got.push(l), caps);
      assert.deepEqual(got, want, JSON.stringify(caps));
      assert.deepEqual(scan, { goodEnd: buf.length, frames: 2, lines: 3, complete: true, unterminated: false, stop: null });
      assert.equal(decodedLines(buf, 'gzip', caps), 3);
    }
  });

  it('a false gzip magic inside a frame is not taken for a frame end; a torn or non-UTF-8 frame stops the scan before it', () => {
    // A frame whose trailer (ISIZE = 0x00088b1f) carries the bytes 1f 8b 08 four bytes before its end.
    const big = Buffer.alloc(0x88b1f, 0x61);
    big[big.length - 1] = 0x0a;
    const f1 = gzipSync(big);
    assert.deepEqual([...f1.subarray(f1.length - 4, f1.length - 1)], [0x1f, 0x8b, 0x08]);
    const f2 = gzipSync(Buffer.from('{"b":2}\n'));
    const whole = Buffer.concat([f1, f2]);
    assert.deepEqual(scanGzipFrames(whole, noLog), { goodEnd: whole.length, frames: 2, lines: 2, complete: true, unterminated: false, stop: null });
    const torn = Buffer.concat([f1, f2.subarray(0, f2.length - 3)]);
    assert.deepEqual(scanGzipFrames(torn, noLog), { goodEnd: f1.length, frames: 1, lines: 1, complete: false, unterminated: false, stop: 'torn' });
    const latin1 = gzipSync(Buffer.from([0x7b, 0x7d, 0xe9, 0x0a]));     // valid gzip, not UTF-8
    const got: string[] = [];
    assert.deepEqual(scanGzipFrames(Buffer.concat([f2, latin1]), (l) => got.push(l)), { goodEnd: f2.length, frames: 1, lines: 1, complete: false, unterminated: false, stop: 'not_utf8' });
    assert.deepEqual(got, ['{"b":2}']);                                  // nothing of the bad frame is handed on
    assert.equal(decodedLines(Buffer.concat([f2, latin1]), 'gzip'), -1);
    assert.deepEqual(scanGzipFrames(gzipSync(Buffer.from('x')), noLog), { goodEnd: 21, frames: 1, lines: 1, complete: true, unterminated: true, stop: null });
    assert.deepEqual(scanGzipFrames(Buffer.alloc(0), noLog), { goodEnd: 0, frames: 0, lines: 0, complete: true, unterminated: false, stop: null });
  });

  it('recovery keeps every intact frame, counts its records, and cuts only the torn one', () => {
    const dir = tempDir('r2-23-cut');
    const rel = '2026-10-15/09/decision.ndjson.gz';
    fs.mkdirSync(join(dir, '2026-10-15/09'), { recursive: true });
    const a = gzipSync(Buffer.from(`${line(0, 'x')}${line(1, 'y')}`));
    const b = gzipSync(Buffer.from(line(2, 'z')));
    fs.writeFileSync(join(dir, rel), Buffer.concat([a, b, b.subarray(0, 9)]));
    SegmentWriter.recover({ dataDir: dir, nowMs: ms(H0), log: noLog });
    const m = JSON.parse(fs.readFileSync(join(dir, '2026-10-15/09/decision.manifest.json'), 'utf8')) as { records: number; bytes: number; lastSeq: string };
    assert.deepEqual([m.records, m.bytes, m.lastSeq], [3, a.length + b.length, '2']);
    assert.deepEqual(pull(dir), { verified: [rel], mismatched: [] });
  });
});

describe('Z08-24 a failed rotate is recovered on resume', () => {
  it('a manifest write that fails closes the file; resume writes its manifest and md-pull can sign it', () => {
    const dir = tempDir('r2-24');
    let failRename = false;
    const f: WriterFs = {
      ...fs,
      renameSync: ((a: fs.PathLike, b: fs.PathLike) => {
        if (failRename) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        fs.renameSync(a, b);
      }) as typeof fs.renameSync,
    };
    const now = { t: H0 + 1_000 };
    const { q, w } = start(dir, now, f);
    append(q, now.t, 1);
    append(q, now.t + 1, 2);
    w.pump();
    w.flush();
    failRename = true;
    assert.deepEqual(w.rotate(), []);
    assert.ok(w.isHalted());
    assert.deepEqual(w.openPaths(), []);
    failRename = false;
    now.t += 60_000;                                                    // the first resume waits 60 s
    assert.equal(w.resume(), true);
    const rel = '2026-10-15/10/decision.ndjson.gz';
    const m = JSON.parse(fs.readFileSync(join(dir, '2026-10-15/10/decision.manifest.json'), 'utf8')) as { records: number; gaps: Array<{ reason: string }> };
    assert.deepEqual([m.records, m.gaps.map((g) => g.reason)], [2, ['crash']]);
    assert.deepEqual(pull(dir).verified, [rel]);
  });
});

describe('Z08-25 a persistent write error raises one critical alert per episode', () => {
  it('EIO on every fsync for an hour with disk checks every 60 s: one write_failed, one recording_halted, resumes back off 60 s → 1 h', () => {
    const dir = tempDir('r2-25');
    let eio = false;
    const f: WriterFs = { ...fs, fsyncSync: (fd: number) => { if (eio) throw Object.assign(new Error('EIO'), { code: 'EIO' }); fs.fsyncSync(fd); } };
    const now = { t: H0 + 1_000 };
    const { q, w, lines } = start(dir, now, f);
    fs.mkdirSync(join(dir, 'receipts'));
    const research = generateKeyPairSync('ed25519');
    const disk = new DiskManager({ dataDir: dir, receiptsDir: join(dir, 'receipts'), publicKey: ed25519Key(research.publicKey.export({ type: 'spki', format: 'pem' }) as string, 'public'),
      policy: DEFAULT_DISK_POLICY, usage: () => ({ totalBytes: 55e9, freeBytes: 40e9 }), writer: w, nowMs: () => ms(now.t), log: (level, code) => lines.push({ level, code, at: now.t }) });
    eio = true;
    const t0 = now.t;
    for (let minute = 0; minute <= 60; minute += 1) {
      now.t = t0 + minute * 60_000;
      disk.check();
      append(q, now.t, minute);
      w.pump();
      w.flush();
    }
    const critical = lines.filter((l) => l.level === 'critical').map((l) => l.code);
    assert.deepEqual(critical, ['M07.write_failed', 'M07.recording_halted']);
    const resumedAt = lines.filter((l) => l.code === 'M07.recording_resumed').map((l) => (l.at - t0) / 1_000);
    assert.deepEqual(resumedAt, [60, 180, 420, 900, 1_860]);            // 60, 120, 240, 480, 960 s apart
    assert.equal(lines.filter((l) => l.code === 'M07.disk_ok_resume').length, resumedAt.length);
    // The back-off stops at 1 h, and the next good write ends the episode (a later failure alerts again).
    for (let k = 0; k < 4; k += 1) {
      now.t += HOUR;
      assert.equal(w.resume(), true);
      append(q, now.t, 100 + k);
      w.pump();
      w.flush();
      assert.ok(w.isHalted());
    }
    assert.equal(w.resume(), false);
    now.t += HOUR - 1;
    assert.equal(w.resume(), false);                                      // capped at exactly 1 h
    now.t += 1;
    eio = false;
    assert.equal(w.resume(), true);
    append(q, now.t, 200);
    w.pump();
    w.flush();
    assert.equal(w.isHalted(), false);
    eio = true;
    append(q, now.t + 1, 201);
    w.pump();
    w.flush();
    assert.deepEqual(lines.filter((l) => l.level === 'critical').map((l) => l.code), ['M07.write_failed', 'M07.recording_halted', 'M07.write_failed', 'M07.recording_halted']);
  });
});
