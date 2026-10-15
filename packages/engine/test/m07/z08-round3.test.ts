// Card Z08 round 3 (#327 red team at c6f29374): the red team's probes for Z08-26 to Z08-28, each a test that fails on
// c6f29374 and passes after (DECISIONS "Z08 round 3").
import { strict as assert } from 'node:assert';
import { createHash, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { scanGzipFrames } from '../../src/m07/frames.ts';
import { decodedLines, runPull, type PullTransport } from '../../src/m07/md-pull.ts';
import { ed25519Key } from '../../src/m07/receipt-sig.ts';
import { compressorFor, frameOf, SegmentWriter } from '../../src/m07/segments.ts';
import { DEFAULT_CONFIG, RecorderQueue } from '../../src/recorder/queue.ts';
import { tempDir } from '../helpers.ts';

const H0 = Date.UTC(2026, 9, 15, 10, 0, 0);
const ms = (n: number): UnixMs => n as UnixMs;
const noLog = (): void => undefined;
const REL = '2026-10-15/09/decision.ndjson.gz';
const line = (seq: number, payload: string): string =>
  `{"commitment":null,"payload":{"s":${JSON.stringify(payload)}},"recvMs":${H0 - 3_600_000 + seq},"seq":"${seq}","slot":null,"source":"t","stream":"decision"}\n`;
const good = gzipSync(Buffer.from(`${line(0, 'x')}${line(1, 'y')}`));

/** Writes `bytes` as an unmanifested segment, runs recovery, and returns the manifest, the kept bytes and the log. */
function recover(bytes: Buffer): { m: { records: number; bytes: number; lastSeq: string | null }; kept: Buffer; logs: Array<Record<string, string | number>>; dir: string } {
  const dir = tempDir('r3');
  fs.mkdirSync(join(dir, '2026-10-15/09'), { recursive: true });
  fs.writeFileSync(join(dir, REL), bytes);
  const logs: Array<Record<string, string | number>> = [];
  SegmentWriter.recover({ dataDir: dir, nowMs: ms(H0), log: (_l, code, f) => { if (code === 'M07.crash_recovered') logs.push(f); } });
  const m = JSON.parse(fs.readFileSync(join(dir, '2026-10-15/09/decision.manifest.json'), 'utf8')) as { records: number; bytes: number; lastSeq: string | null };
  return { m, kept: fs.readFileSync(join(dir, REL)), logs, dir };
}
/** md-pull over a host folder holding `bytes` at REL with a manifest claiming `records` and the bytes' own hash. */
function pullOf(dir: string): { verified: number; mismatched: string[] } {
  const key = generateKeyPairSync('ed25519');
  const transport: PullTransport = { listDays: () => ['2026-10-15'], fetchDay: (d, root) => fs.cpSync(join(dir, d), join(root, d), { recursive: true }), putReceipts: () => undefined };
  const r = runPull({ transport, localRoot: tempDir('r3-local'), since: '2026-10-01', privateKey: ed25519Key(key.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'private'), verifier: 'ops', nowMs: () => ms(0), log: noLog });
  return { verified: r.verified.length, mismatched: r.mismatched };
}

describe('Z08-26 a torn header after the last good frame cuts only the torn bytes', () => {
  for (const tail of [[0x1f], [0x1f, 0x8b], [0x1f, 0x8b, 0x08, 0x00, 0x00]]) {
    it(`a good frame followed by ${tail.length} byte(s) of a header keeps the frame`, () => {
      const scan = scanGzipFrames(Buffer.concat([good, Buffer.from(tail)]), noLog);
      assert.deepEqual([scan.goodEnd, scan.frames, scan.complete, scan.stop], [good.length, 1, false, 'torn']);
      const r = recover(Buffer.concat([good, Buffer.from(tail)]));
      assert.deepEqual([r.m.records, r.m.bytes, r.m.lastSeq], [2, good.length, '1']);
      assert.deepEqual(r.kept, good);
      assert.equal(r.logs[0]?.cut_reason, 'torn');
    });
  }
});

describe('Z08-27 a frame ends exactly where the next starts or where the file ends', () => {
  for (const [name, tail] of [['zero bytes', Buffer.alloc(4)], ['text', Buffer.from('garbage')], ['a second footer', good.subarray(good.length - 8)]] as const) {
    it(`trailing ${name} make the file incomplete: md-pull signs nothing, recovery cuts them and keeps the frame`, () => {
      const bytes = Buffer.concat([good, tail]);
      assert.equal(decodedLines(bytes, 'gzip'), -1);
      assert.equal(scanGzipFrames(bytes, noLog).goodEnd, good.length);
      // The host's file with a manifest that matches its hash, size and two records: md-pull still refuses it.
      const dir = tempDir('r3-27');
      fs.mkdirSync(join(dir, '2026-10-15/09'), { recursive: true });
      fs.writeFileSync(join(dir, REL), bytes);
      fs.writeFileSync(join(dir, '2026-10-15/09/decision.manifest.json'), JSON.stringify({
        path: REL, stream: 'decision', firstSlot: null, lastSlot: null, records: 2, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), gaps: [],
        codec: 'gzip', firstSeq: '0', lastSeq: '1', hourUtc: '2026-10-15T09', keyframes: 0, firstRecvMs: 1, lastRecvMs: 2,
      }));
      assert.deepEqual(pullOf(dir), { verified: 0, mismatched: [REL] });
      const r = recover(bytes);
      assert.deepEqual([r.m.records, r.m.bytes], [2, good.length]);
    });
  }

  it('a footer whose CRC or length does not match what was decoded stops the walk there', () => {
    for (const at of [good.length - 8, good.length - 1]) {
      const bad = Buffer.from(good);
      bad[at] = (bad[at] as number) ^ 0xff;
      const scan = scanGzipFrames(Buffer.concat([good, bad]), noLog);
      assert.deepEqual([scan.goodEnd, scan.stop], [good.length, 'bad_footer']);
    }
    const flags = Buffer.from(good);
    flags[3] = 0x08;                                                      // FNAME set: never written by the recorder
    assert.equal(scanGzipFrames(flags, noLog).stop, 'bad_header');
    assert.equal(scanGzipFrames(Buffer.concat([good, good.subarray(0, 20)]), noLog).stop, 'torn');   // deflate data cut short
    assert.equal(scanGzipFrames(Buffer.concat([good, good.subarray(0, good.length - 3)]), noLog).stop, 'torn');   // footer cut short
  });
});

describe('Z08-28 a frame or line over its cap is corrupt: cut there, never decoded in full', () => {
  it('a frame that decodes past 64 MiB stops at the cap quickly; recovery keeps the frames before it and the writer goes on', () => {
    const bomb = gzipSync(Buffer.alloc(100 * 1_048_576, 0x61), { level: 9 });       // about 100 KB that decodes to 100 MiB
    const bytes = Buffer.concat([good, bomb]);
    const t = process.hrtime.bigint();
    const scan = scanGzipFrames(bytes, noLog);
    assert.ok(process.hrtime.bigint() - t < 5_000_000_000n);
    assert.deepEqual([scan.goodEnd, scan.stop], [good.length, 'member_too_large']);
    assert.equal(decodedLines(bytes, 'gzip'), -1);
    const r = recover(bytes);
    assert.deepEqual([r.m.records, r.m.bytes, r.logs[0]?.cut_reason], [2, good.length, 'member_too_large']);
    // The writer starts and records after the cut (the crash gap is in the recovered manifest).
    const rec = SegmentWriter.recover({ dataDir: r.dir, nowMs: ms(H0), log: noLog });
    const q = new RecorderQueue({ firstSeq: rec.nextSeq });
    const w = new SegmentWriter({ dataDir: r.dir, codec: 'gzip', queue: q, nowMs: () => ms(H0 + 5), log: noLog }, rec);
    q.append({ stream: 'decision', recvMs: ms(H0 + 5), slot: null, commitment: null, source: 't', payload: { i: 1 } });
    w.pump();
    w.flush();
    const [m] = w.rotate();
    assert.deepEqual([m?.records, m?.firstSeq], [1, '2']);
  });

  it('a line past 4 MiB stops the walk at its frame; smaller caps are honoured too', () => {
    const long = gzipSync(Buffer.from(line(2, 'z'.repeat(4_194_304))));
    const bytes = Buffer.concat([good, long]);
    assert.deepEqual([scanGzipFrames(bytes, noLog).goodEnd, scanGzipFrames(bytes, noLog).stop], [good.length, 'line_too_long']);
    assert.equal(decodedLines(bytes, 'gzip'), -1);
    const r = recover(bytes);
    assert.deepEqual([r.m.records, r.m.bytes, r.logs[0]?.cut_reason], [2, good.length, 'line_too_long']);
    const caps = { memberBytes: 64, lineBytes: 1_000 };
    assert.equal(scanGzipFrames(good, noLog, caps).stop, 'member_too_large');
    assert.equal(scanGzipFrames(good, noLog, { memberBytes: 1_000, lineBytes: 10 }).stop, 'line_too_long');
  });

  it('the writer never writes a frame or a line near the caps: flushes split at 16 MiB and a record is at most 1 MiB', () => {
    const comp = compressorFor('gzip');
    assert.ok(comp !== null);
    const lines = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)];
    const split = Buffer.from(frameOf(comp, lines, 22));
    const scan = scanGzipFrames(split, noLog);
    assert.deepEqual([scan.frames, scan.lines, scan.complete], [2, 3, true]);
    assert.equal(gunzipSync(split).toString(), `${lines.join('\n')}\n`);
    assert.equal(scanGzipFrames(Buffer.from(frameOf(comp, lines)), noLog).frames, 1);
    assert.equal(scanGzipFrames(Buffer.from(frameOf(comp, ['x'.repeat(30)], 5)), noLog).frames, 1);   // a line is never split
    assert.throws(() => new RecorderQueue({ config: { ...DEFAULT_CONFIG, recordMaxBytes: 1_048_577 } }), /record_max_bytes/);
    assert.doesNotThrow(() => new RecorderQueue({ config: { ...DEFAULT_CONFIG, recordMaxBytes: 1_048_576 } }));
  });
});
