// LOG-ORDER (Z02 follow-up, ruling LOG-1): a clock step back never reorders a day's log lines. Run 38817404562 read the
// 10-07 log back as "again, first": rotating back to 10-07 opened a second append stream on the same plain file while
// the first was still flushing, and the two streams' writes ran in either order. Here the first stream's flush is held
// by the test (an injected stream), so the old order fails every time, not by timing.
import { strict as assert } from 'node:assert';
import { closeSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import { FileLogSink } from '../../src/m27/logfile.ts';
import { fakeClock, tempDir } from '../helpers.ts';

/** Day files' streams; the first one created holds every write until `release()`. */
function heldStreams() {
  const held: Array<() => void> = [];
  let holding = true;
  let n = 0;
  const createStream = (_path: string, fd: number): Writable => {
    const hold = n === 0;
    n += 1;
    return new Writable({
      write(chunk: Buffer, _enc, cb) {
        const go = (): void => { writeSync(fd, chunk); cb(); };
        if (hold && holding) held.push(go);
        else go();
      },
      final(cb) { closeSync(fd); cb(); },
    });
  };
  const release = (): void => { holding = false; for (const go of held.splice(0)) go(); };
  return { createStream, release, held: () => held.length };
}

const at = (d: number, h: number, m: number, s = 0): number => Date.UTC(2026, 9, d, h, m, s);
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

function setup(over: { queueBytes?: number } = {}) {
  const dir = tempDir('log-order');
  const clock = fakeClock(at(7, 23, 59));
  const errors: string[] = [];
  const h = heldStreams();
  const s = new FileLogSink({ dir, clock, retentionDays: 14, maxBytesPerDay: 1_000_000, queueBytes: over.queueBytes ?? 1_000_000,
    onError: (e) => errors.push(`${e.op}:${e.message}`), createStream: h.createStream });
  return { dir, clock, errors, s, ...h };
}

describe('LOG-1: a day\'s lines reach its file in write order across a clock step back', () => {
  it('the CI case: back to a day whose first stream is still flushing, its new line waits; the .gz reads first, again', async () => {
    const t = setup();
    t.s.write('{"first":1}', 'info');                                    // held in the first stream
    t.clock.set(at(8, 0, 1));
    t.s.write('{"next":1}', 'info');
    t.clock.set(at(7, 23, 59, 30));                                      // back across midnight
    t.s.write('{"again":1}', 'info');
    await settle();
    // Nothing of 10-07 is on disk yet: "again" waits behind the held "first".
    assert.equal(readFileSync(join(t.dir, 'engine-2026-10-07.ndjson'), 'utf8'), '');
    assert.equal(t.held(), 1);
    t.release();
    t.clock.set(at(8, 0, 2));
    t.s.write('{"later":1}', 'info');
    await t.s.close();
    assert.deepEqual([t.errors, readdirSync(t.dir).sort()], [[], ['engine-2026-10-07.ndjson.gz', 'engine-2026-10-08.ndjson']]);
    assert.equal(gunzipSync(readFileSync(join(t.dir, 'engine-2026-10-07.ndjson.gz'))).toString(), '{"first":1}\n{"again":1}\n');
    assert.equal(readFileSync(join(t.dir, 'engine-2026-10-08.ndjson'), 'utf8'), '{"next":1}\n{"later":1}\n');
  });

  it('a waiting stream rotated away again, and back a third time, still keeps the order (end() never uncorks it early)', async () => {
    const t = setup();
    t.s.write('{"n":1}', 'info');
    for (const [k, d] of [[2, 8], [3, 7], [4, 8], [5, 7], [6, 8]] as const) {
      t.clock.set(d === 7 ? at(7, 23, 59, k) : at(8, 0, k));
      t.s.write(`{"n":${k}}`, 'info');
    }
    await settle();
    assert.equal(readFileSync(join(t.dir, 'engine-2026-10-07.ndjson'), 'utf8'), '');
    t.release();
    await t.s.close();
    assert.deepEqual(t.errors, []);
    assert.equal(gunzipSync(readFileSync(join(t.dir, 'engine-2026-10-07.ndjson.gz'))).toString(), '{"n":1}\n{"n":3}\n{"n":5}\n');
    assert.equal(readFileSync(join(t.dir, 'engine-2026-10-08.ndjson'), 'utf8'), '{"n":2}\n{"n":4}\n{"n":6}\n');
  });

  it('close() while a stream waits: it ends that stream only after the earlier one, and loses nothing', async () => {
    const t = setup();
    t.s.write('{"first":1}', 'info');
    t.clock.set(at(8, 0, 1));
    t.s.write('{"next":1}', 'info');
    t.clock.set(at(7, 23, 59, 30));
    t.s.write('{"again":1}', 'info');
    let closed = false;
    const c = t.s.close().then(() => { closed = true; });
    await settle();
    assert.equal(closed, false);                                          // waits for the held stream
    t.release();
    await c;
    // 10-07 is the current day at close: its file stays plain (never compressed while the sink still names it).
    const plain = readdirSync(t.dir).includes('engine-2026-10-07.ndjson') ? readFileSync(join(t.dir, 'engine-2026-10-07.ndjson'), 'utf8') : gunzipSync(readFileSync(join(t.dir, 'engine-2026-10-07.ndjson.gz'))).toString();
    assert.equal(plain, '{"first":1}\n{"again":1}\n');
  });

  it('lines held behind an earlier stream still count toward the write queue: debug is shed at half of queueBytes', async () => {
    const t = setup({ queueBytes: 40 });
    t.s.write('{"first":1}', 'info');
    t.clock.set(at(8, 0, 1));
    t.s.write('{"next":1}', 'info');
    t.clock.set(at(7, 23, 59, 30));
    assert.equal(t.s.write('{"again":"xxxxxxxxxx"}', 'info'), 'written');   // 24 bytes held
    assert.equal(t.s.write('{"d":1}', 'debug'), 'shed');
    t.release();
    await t.s.close();
  });

  it('LOG-2: a clock flapping across midnight while the first stream is held never lets held bytes pass the queue caps', async () => {
    const queueBytes = 2_000;
    const t = setup({ queueBytes });
    const line = (k: number, level: string): string => `{"k":${k},"level":"${level}","pad":"${'x'.repeat(60)}"}`;
    const bytes = (l: string): number => Buffer.byteLength(`${l}\n`);
    const size = bytes(line(9_999, 'error'));                            // the longest line written here
    let info = 0;
    let warn = 0;
    const results: string[] = [];
    for (let k = 0; k < 100; k += 1) {
      t.clock.set(k % 2 === 0 ? at(7, 23, 59, k % 60) : at(8, 0, 1, k % 60));      // 50 flaps across midnight
      const r = t.s.write(line(k, 'info'), 'info');
      if (r === 'written') info += bytes(line(k, 'info'));
      results.push(r);
    }
    // Bytes accepted but not yet on disk are held in memory. Info stops at queueBytes over every unfinished stream (one
    // line may cross it), not per stream (101,610 bytes before).
    const onDisk = (): number => ['07', '08'].reduce((n, d) => { try { return n + statSync(join(t.dir, `engine-2026-10-${d}.ndjson`)).size; } catch { return n; } }, 0);
    const heldInfo = info - onDisk();
    assert.ok(heldInfo <= queueBytes + size, `${heldInfo} info bytes held`);
    assert.ok(results.includes('shed'));
    // Warn and error still follow the rule: written up to twice queueBytes in total, then lost.
    for (let k = 0; k < 60; k += 1) {
      const level = k % 2 === 0 ? 'warn' : 'error';
      const r = t.s.write(line(1_000 + k, level), level);
      if (r === 'written') warn += bytes(line(1_000 + k, level));
      else assert.equal(r, 'lost');
    }
    const held = info + warn - onDisk();
    assert.ok(held <= 2 * queueBytes + size, `${held} bytes held`);
    assert.ok(warn > 0);
    assert.equal(t.s.write(line(9_999, 'warn'), 'warn'), 'lost');
    t.release();
    await t.s.close();
    assert.deepEqual(t.errors, []);
  });
});
