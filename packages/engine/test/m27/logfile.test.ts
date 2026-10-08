import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { FileLogSink, REOPEN_MS } from '../../src/m27/logfile.ts';
import { fakeClock, tempDir, waitFor } from '../helpers.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

function sink(dir: string, over: Partial<{ maxBytesPerDay: number; queueBytes: number; retentionDays: number }> = {}) {
  const clock = fakeClock(T0);
  const errors: string[] = [];
  const lost: string[] = [];
  const s = new FileLogSink({ dir, clock, retentionDays: 14, maxBytesPerDay: 1_000_000, queueBytes: 1_000_000, onError: (e) => errors.push(e.op),
    onLost: (level) => lost.push(level), ...over });
  return { s, clock, errors, lost };
}

describe('FileLogSink: daily files, 0600 in a 0700 directory', () => {
  it('appends JSON lines to the day file and reopens it in append mode', async () => {
    const dir = join(tempDir('log'), 'logs');
    const a = sink(dir);
    assert.equal(a.s.write('{"a":1}', 'info'), 'written');
    await a.s.close();
    assert.equal(a.s.write('{"late":1}', 'error'), 'lost');          // closed: no file takes it
    const b = sink(dir);
    b.s.write('{"b":2}', 'debug');
    await b.s.close();
    assert.equal(readFileSync(join(dir, 'engine-2026-10-07.ndjson'), 'utf8'), '{"a":1}\n{"b":2}\n');
    assert.equal(statSync(join(dir, 'engine-2026-10-07.ndjson')).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it('rotates at the UTC day boundary, gzips the old day and deletes days past the retention', async () => {
    const dir = tempDir('rotate');
    for (let d = 10; d <= 25; d++) writeFileSync(join(dir, `engine-2026-09-${d}.ndjson.gz`), 'old');
    for (let d = 26; d <= 30; d++) writeFileSync(join(dir, `engine-2026-09-${d}.ndjson.gz`), 'kept');
    for (let d = 1; d <= 6; d++) writeFileSync(join(dir, `engine-2026-10-0${d}.ndjson.gz`), 'kept');
    // After rotation to 10-08: 09-25 and older are 13+ days old by date, but 09-25 is still among the 14 newest days
    // (09-26..10-08 are 13 days), so it is kept; 09-24 and older are past both rules and deleted (ruling 8).
    writeFileSync(join(dir, 'engine-2026-10-01.ndjson.gz.tmp'), 'partial');
    writeFileSync(join(dir, 'unrelated.txt'), 'x');
    const { s, clock, errors } = sink(dir);
    s.write('{"day":1}', 'info');
    clock.advance(DAY);
    s.write('{"day":2}', 'info');
    await s.close();
    const kept = [...['25', '26', '27', '28', '29', '30'].map((d) => `engine-2026-09-${d}.ndjson.gz`), ...[1, 2, 3, 4, 5, 6].map((d) => `engine-2026-10-0${d}.ndjson.gz`)];
    assert.deepEqual(readdirSync(dir).sort(), [...kept, 'engine-2026-10-07.ndjson.gz', 'engine-2026-10-08.ndjson', 'unrelated.txt']);
    assert.equal(gunzipSync(readFileSync(join(dir, 'engine-2026-10-07.ndjson.gz'))).toString(), '{"day":1}\n');
    assert.equal(s.path('2026-10-08'), join(dir, 'engine-2026-10-08.ndjson'));
    assert.deepEqual(errors, []);
  });

  it('sheds debug and info at the daily size and never drops warn and above for it (ARCH M27)', async () => {
    const dir = tempDir('cap');
    const { s } = sink(dir, { maxBytesPerDay: 20 });
    assert.equal(s.write('x'.repeat(19), 'info'), 'written');        // 20 bytes with the newline
    assert.equal(s.write('d', 'debug'), 'shed');
    assert.equal(s.write('i', 'info'), 'shed');
    assert.equal(s.write('w'.repeat(9), 'warn'), 'written');
    assert.equal(s.write('e'.repeat(9), 'error'), 'written');
    assert.equal(s.write('c'.repeat(39), 'critical'), 'written');    // 80 bytes: four times the cap, still kept
    assert.equal(s.write('w', 'warn'), 'written');
    await s.close();
    assert.equal(readFileSync(s.path(), 'utf8').split('\n').length - 1, 5);
  });

  it('sheds by write-queue depth: debug from half the queue, info from the queue; warn and above are lost only at the hard bound', async () => {
    const dir = tempDir('queue');
    const { s } = sink(dir, { queueBytes: 1_000 });
    const big = 'q'.repeat(600);
    assert.equal(s.write(big, 'info'), 'written');                     // queued 601 bytes, not yet flushed
    assert.equal(s.write('d', 'debug'), 'shed');
    assert.equal(s.write(big, 'warn'), 'written');
    assert.equal(s.write('i', 'info'), 'shed');
    assert.equal(s.write(big, 'warn'), 'written');
    assert.equal(s.write(big, 'critical'), 'written');                 // 2,404 bytes queued: the hard bound (2 x 1,000)
    assert.equal(s.write('w', 'warn'), 'lost');
    assert.equal(s.write('c', 'critical'), 'lost');
    assert.equal(s.write('d', 'debug'), 'shed');                       // below warn the spec rule applies first
    await s.close();
  });

  it('reports a file that cannot be opened, drops writes, retries every 30 s and recovers the same day (review R3)', async () => {
    const dir = tempDir('broken');
    const file = join(dir, 'engine-2026-10-07.ndjson');
    mkdirSync(file);                                                   // a directory where the file should be
    const { s, clock, errors } = sink(dir);
    assert.deepEqual(errors, ['open']);
    assert.equal(s.write('{"x":1}', 'error'), 'lost');
    assert.equal(s.write('{"x":2}', 'debug'), 'lost');
    clock.advance(REOPEN_MS);
    assert.equal(s.write('{"x":3}', 'critical'), 'lost');             // retried, still failing: next try 30 s later
    clock.advance(REOPEN_MS - 1);
    assert.equal(s.write('{"x":4}', 'warn'), 'lost');                 // no retry before the backoff
    assert.deepEqual(errors, ['open', 'open']);
    rmSync(file, { recursive: true });                                 // the cause is removed
    clock.advance(1);
    assert.equal(s.write('{"x":5}', 'warn'), 'written');
    clock.set(Date.UTC(2026, 9, 7, 23, 59));                          // 23:59 the same day
    assert.equal(s.write('{"x":6}', 'critical'), 'written');
    clock.set(Date.UTC(2026, 9, 8));
    assert.equal(s.write('{"y":1}', 'info'), 'written');               // the next day's file
    await s.close();
    assert.equal(gunzipSync(readFileSync(`${file}.gz`)).toString(), '{"x":5}\n{"x":6}\n');
    assert.equal(readFileSync(join(dir, 'engine-2026-10-08.ndjson'), 'utf8'), '{"y":1}\n');
  });

  it('a write error (disk full) is retried every 30 s and lines are written again once the disk has room (review R3)', async () => {
    const dir = tempDir('full');
    const file = join(dir, 'engine-2026-10-07.ndjson');
    symlinkSync('/dev/full', file);                                    // every write fails with ENOSPC
    const { s, clock, errors } = sink(dir);
    assert.equal(s.write('{"a":1}', 'critical'), 'written');          // handed to the stream, then the write fails
    await waitFor(() => errors.length === 1);
    assert.deepEqual(errors, ['write']);
    assert.equal(s.write('{"a":2}', 'critical'), 'lost');
    clock.advance(REOPEN_MS);
    assert.equal(s.write('{"a":3}', 'warn'), 'written');              // reopened; the disk is still full
    await waitFor(() => errors.length === 2);
    assert.equal(s.write('{"a":4}', 'warn'), 'lost');
    unlinkSync(file);                                                  // room again
    clock.advance(REOPEN_MS);
    assert.equal(s.write('{"a":5}', 'warn'), 'written');
    await s.close();
    assert.deepEqual(errors, ['write', 'write']);
    assert.equal(readFileSync(file, 'utf8'), '{"a":5}\n');
    assert.equal(s.write('{"a":6}', 'critical'), 'lost');             // closed: never reopened
  });

  it('lines accepted before a write fails on a still-full disk are counted lost, each with its level (red team n4)', async () => {
    const dir = tempDir('fulllost');
    const file = join(dir, 'engine-2026-10-07.ndjson');
    symlinkSync('/dev/full', file);                                    // every write fails with ENOSPC
    const { s, clock, errors, lost } = sink(dir);
    assert.equal(s.write('{"a":1}', 'critical'), 'written');
    assert.equal(s.write('{"a":2}', 'warn'), 'written');              // queued behind the first, before its error is known
    assert.equal(s.write('{"a":3}', 'info'), 'written');
    await waitFor(() => errors.length === 1 && lost.length === 3);
    assert.deepEqual(lost, ['critical', 'warn', 'info']);
    assert.equal(s.write('{"a":4}', 'error'), 'lost');                // returned as lost (the logger counts it), not reported again
    clock.advance(REOPEN_MS);
    assert.equal(s.write('{"a":5}', 'warn'), 'written');              // reopened; the disk is still full
    await waitFor(() => errors.length === 2 && lost.length === 4);
    unlinkSync(file);                                                  // room again
    clock.advance(REOPEN_MS);
    assert.equal(s.write('{"a":6}', 'warn'), 'written');
    await s.close();
    assert.deepEqual(lost, ['critical', 'warn', 'info', 'warn']);    // the line that reached the file is not counted
    assert.equal(readFileSync(file, 'utf8'), '{"a":6}\n');
  });

  it('an error of the previous day\'s file leaves the new day\'s file working', async () => {
    const dir = tempDir('oldday');
    const file = join(dir, 'engine-2026-10-07.ndjson');
    symlinkSync('/dev/full', file);
    const { s, clock, errors, lost } = sink(dir);
    assert.equal(s.write('{"a":1}', 'warn'), 'written');
    clock.advance(DAY);
    assert.equal(s.write('{"b":1}', 'warn'), 'written');              // rotates; the old stream fails while it closes
    unlinkSync(file);                                                  // housekeeping must not read /dev/full
    await waitFor(() => errors.length === 1 && lost.length === 1);
    assert.deepEqual(lost, ['warn']);                                  // the old day's accepted line is counted lost
    assert.equal(s.write('{"b":2}', 'warn'), 'written');
    await s.close();
    assert.equal(readFileSync(join(dir, 'engine-2026-10-08.ndjson'), 'utf8'), '{"b":1}\n{"b":2}\n');
  });

  it('keeps the day\'s data and reports when compression fails; the next housekeeping retries it', async () => {
    const dir = tempDir('gzfail');
    mkdirSync(join(dir, 'engine-2026-10-06.ndjson'));                // yesterday's "file" cannot be read
    const { s, errors } = sink(dir);
    await s.close();
    assert.deepEqual(errors, ['compress']);
    assert.ok(existsSync(join(dir, 'engine-2026-10-06.ndjson.compressing')));   // renamed aside, not deleted
    assert.ok(!existsSync(join(dir, 'engine-2026-10-06.ndjson.gz')));
  });

  it('reports a directory that cannot be read during housekeeping', async () => {
    const dir = tempDir('gone');
    const { s, clock, errors } = sink(join(dir, 'logs'));
    // Replace the log directory by a file: the next day's open and sweep both fail.
    rmSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'logs'), 'not a directory');
    clock.advance(DAY);
    s.write('{"z":1}', 'info');
    await s.close();
    assert.ok(errors.includes('prune'));
    assert.ok(errors.includes('open'));
  });

  it('refuses a retention below one day', () => {
    assert.throws(() => sink(tempDir('bad'), { retentionDays: 0 }), RangeError);
  });
});
