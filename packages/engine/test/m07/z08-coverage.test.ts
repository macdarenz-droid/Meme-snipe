// A-M07-03 (card Z08): coverage reports, disk management, receipts and md-pull. Acceptance bullets of SPEC-A A-M07-03,
// the Z04 recorder integration rulings (1, 14, 38-40) and the Zeroed bugs of MIGRATION's A-M07-03 row (B1: gap length
// through SLOT_MS; the budget pass deleting files that were never uploaded) each have a named case. Fail-before runs
// against the old Zeroed code are recorded in the Z08 PR.
import { strict as assert } from 'node:assert';
import { createHash, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { computeCoverage, dayStartOf, type CoverageInput, type PollCountRecord, type WatchInterval } from '../../src/m07/coverage.ts';
import { dailyCoverage, dayManifests, runDailyCoverage } from '../../src/m07/daily.ts';
import { checkPolicy, DEFAULT_DISK_POLICY, DiskManager, GIB, type DiskDeps } from '../../src/m07/disk.ts';
import { parseArgs, runPull, sftpBatch, sftpTransport, type PullTransport } from '../../src/m07/md-pull.ts';
import { ed25519Key, receiptText, signReceipt, verifyReceipt } from '../../src/m07/receipt-sig.ts';
import { receiptFileName } from '../../src/m07/receipts.ts';
import { SegmentWriter } from '../../src/m07/segments.ts';
import { POLL_INTERVAL_MS, WatchLog } from '../../src/m07/watch-log.ts';
import { RecorderQueue } from '../../src/recorder/queue.ts';
import { tempDir } from '../helpers.ts';

const DAY = '2026-10-15';
const D0 = dayStartOf(DAY);
const MIN = 60_000;
const ms = (n: number): UnixMs => n as UnixMs;
const research = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

const watch = (poolId: string, fromMin: number, toMin: number, priorityClass: WatchInterval['priorityClass'] = 'candidate'): WatchInterval =>
  ({ poolId, priorityClass, fromMs: ms(D0 + fromMin * MIN), toMs: ms(D0 + toMin * MIN), pollIntervalMs: POLL_INTERVAL_MS[priorityClass] });
/** poll_counts for every minute of [fromMin, toMin) with 60 successful polls. */
const polls = (poolId: string, fromMin: number, toMin: number, priorityClass = 'candidate'): PollCountRecord[] =>
  Array.from({ length: toMin - fromMin }, (_, i) => ({ poolId, minuteStartMs: ms(D0 + (fromMin + i) * MIN), successfulPolls: 60, priorityClass }));
const input = (over: Partial<CoverageInput>): CoverageInput =>
  ({ dayUtc: DAY, watched: [], pollCounts: [], gaps: [], records: {}, universeManifestSha256: 'a'.repeat(64), ...over });

describe('A-M07-03 coverage arithmetic (coverage.ts)', () => {
  it('acceptance: a 2 h polling outage in a day → lowCoverage (2 h > 5% of 24 h)', () => {
    const c = computeCoverage(input({ watched: [watch('A', 0, 1_440)], pollCounts: [...polls('A', 0, 600), ...polls('A', 720, 1_440)] }));
    assert.equal(c.report.lowCoverage, true);
    assert.equal(c.detail.missingMs, 120 * MIN);
    assert.equal(c.detail.missingBps, 833);
    const full = computeCoverage(input({ watched: [watch('A', 0, 1_440)], pollCounts: polls('A', 0, 1_440) }));
    assert.deepEqual([full.report.lowCoverage, full.detail.missingMs], [false, 0]);
    const snap = full.report.streams.find((s) => s.stream === 'pool_snapshot');
    assert.deepEqual([snap?.expected, snap?.recorded], [86_400, 86_400]);
  });

  it('just under and just over 5%: 72 of 1,440 minutes missing is not low; 73 is', () => {
    const at = (missing: number) => computeCoverage(input({ watched: [watch('A', 0, 1_440)], pollCounts: polls('A', missing, 1_440) })).report.lowCoverage;
    assert.equal(at(72), false);
    assert.equal(at(73), true);
  });

  it('ruling 14: the denominator is the watch history, never poll_counts — a pool watched but never polled counts as missing', () => {
    // poll_counts alone would show one pool fully covered; the watchlist says two pools were watched all day.
    const c = computeCoverage(input({ watched: [watch('A', 0, 1_440), watch('B', 0, 1_440)], pollCounts: polls('A', 0, 1_440) }));
    assert.equal(c.detail.watchedMs, 2 * 86_400_000);
    assert.equal(c.detail.missingBps, 5_000);
    assert.equal(c.report.lowCoverage, true);
    // Polls of a pool not in the watch history add nothing to the denominator.
    const extra = computeCoverage(input({ watched: [watch('A', 0, 1_440)], pollCounts: [...polls('A', 0, 1_440), ...polls('Z', 0, 1_440)] }));
    assert.equal(extra.detail.watchedMs, 86_400_000);
  });

  it('ruling 38: a sparse pool whose only poll of a minute arrived late (credited back by lateFromMinuteStartMs) is observed', () => {
    const sparse: PollCountRecord[] = [];
    for (let m = 0; m < 1_440; m += 1) {
      // Each minute's single poll is recorded in the next minute's record as a late poll.
      sparse.push({ poolId: 'T', minuteStartMs: ms(D0 + (m + 1) * MIN), successfulPolls: 0, priorityClass: 'tail', latePolls: 1, lateFromMinuteStartMs: ms(D0 + m * MIN) });
    }
    const c = computeCoverage(input({ watched: [watch('T', 0, 1_440, 'tail')], pollCounts: sparse }));
    assert.deepEqual([c.detail.missingMs, c.report.lowCoverage], [0, false]);
    // Without the credit, every minute would be missing.
    const noCredit = computeCoverage(input({ watched: [watch('T', 0, 1_440, 'tail')], pollCounts: sparse.map(({ latePolls: _l, lateFromMinuteStartMs: _f, ...r }) => r) }));
    assert.equal(noCredit.detail.missingBps, 10_000);
  });

  it('a skippedMinutes record observes nothing minute by minute', () => {
    const c = computeCoverage(input({ watched: [watch('A', 0, 60)], pollCounts: [{ poolId: 'A', minuteStartMs: ms(D0), successfulPolls: 3_600, priorityClass: 'candidate', skippedMinutes: 60 }] }));
    assert.equal(c.detail.missingBps, 10_000);
  });

  it('ruling 40: a gap with poolId excludes only that pool\'s minutes; a gap with no pool excludes every watched pool for its time', () => {
    const all = [watch('A', 0, 1_440), watch('B', 0, 1_440)];
    const p = [...polls('A', 0, 1_440), ...polls('B', 0, 1_440)];
    const pooled = computeCoverage(input({ watched: all, pollCounts: p, gaps: [{ stream: 'poll_counts', gap: { fromMs: ms(D0 + 10 * MIN), toMs: ms(D0 + 100 * MIN), reason: 'clock_step', poolId: 'A' } }] }));
    assert.equal(pooled.detail.missingMs, 90 * MIN);                       // only A's 90 minutes
    const moved = computeCoverage(input({ watched: all, pollCounts: p, gaps: [{ stream: 'poll_counts', gap: { fromMs: ms(D0 + 10 * MIN + 1), toMs: ms(D0 + 10 * MIN + 2), reason: 'moved', poolId: 'B' } }] }));
    assert.equal(moved.detail.missingMs, MIN);                             // a minute touched by B's gap counts whole
    const wide = computeCoverage(input({ watched: all, pollCounts: p, gaps: [{ stream: 'pool_snapshot', gap: { fromMs: ms(D0 + 30 * MIN + 30_000), toMs: ms(D0 + 40 * MIN), reason: 'backpressure' } }] }));
    assert.equal(wide.detail.missingMs, 2 * (9.5 * MIN));                  // both pools, to the millisecond
    const other = computeCoverage(input({ watched: all, pollCounts: p, gaps: [{ stream: 'decision', gap: { fromMs: ms(D0), toMs: ms(D0 + 1_000 * MIN), reason: 'backpressure' } }] }));
    assert.equal(other.detail.missingMs, 0);                               // a gap on another stream is not pool time
    assert.deepEqual(other.report.streams.find((s) => s.stream === 'decision')?.gaps, [{ fromMs: D0, toMs: D0 + 1_000 * MIN, reason: 'backpressure' }]);
  });

  it('Zeroed B1: gap length is wall time, never slots × 400 ms (a 1 h crash gap is 1 h whatever the slot time)', () => {
    const c = computeCoverage(input({ watched: [watch('A', 0, 1_440)], pollCounts: polls('A', 0, 1_440),
      gaps: [{ stream: 'poll_counts', gap: { fromMs: ms(D0 + 600 * MIN), toMs: ms(D0 + 660 * MIN), reason: 'crash' } }] }));
    assert.equal(c.detail.missingMs, 3_600_000);
    assert.equal(c.report.lowCoverage, false);                             // 1 h < 5% of 24 h (72 min)
  });

  it('edge case 3: a day with no watched pools has expected 0 and lowCoverage true', () => {
    const c = computeCoverage(input({ records: { decision: 5 } }));
    assert.equal(c.report.lowCoverage, true);
    assert.equal(c.detail.missingBps, 10_000);
    assert.deepEqual(c.report.streams, [{ stream: 'decision', expected: 5, recorded: 5, gaps: [] }]);
  });

  it('intervals are clipped to the day, overlapping ones count once, position and tail map to their streams', () => {
    const c = computeCoverage(input({
      watched: [watch('A', -100, 30, 'position'), watch('A', 20, 60, 'position'), { ...watch('B', 1_430, 1_500, 'tail') }],
      pollCounts: [...polls('A', 0, 60, 'position'), ...polls('B', 1_430, 1_440, 'tail'), ...polls('C', -5, 0)],
      records: { pool_snapshot_position: 4 },
    }));
    assert.equal(c.detail.watchedMs, 70 * MIN);
    assert.equal(c.detail.missingMs, 0);
    const pos = c.report.streams.find((s) => s.stream === 'pool_snapshot_position');
    assert.deepEqual([pos?.expected, pos?.recorded], [30 * 120 + 40 * 120, 60 * 60]);
    assert.equal(c.report.streams.find((s) => s.stream === 'pool_snapshot_tail')?.expected, 60);
    // Two short intervals in one minute, one inside another, and minutes between two intervals (not watched).
    const split = computeCoverage(input({
      watched: [
        { ...watch('S', 0, 1), toMs: ms(D0 + 10_000) }, { ...watch('S', 0, 1), fromMs: ms(D0 + 30_000) }, { ...watch('S', 0, 1), fromMs: ms(D0 + 40_000), toMs: ms(D0 + 50_000) }, { ...watch('S', 0, 1), fromMs: ms(D0 + 5_000), toMs: ms(D0 + 20_000) },
        watch('S', 10, 12),
      ],
      pollCounts: [...polls('S', 0, 1), ...polls('S', 10, 12), { poolId: 'S', minuteStartMs: ms(D0), successfulPolls: 1, priorityClass: 'other' }],
    }));
    assert.deepEqual([split.detail.watchedMs, split.detail.missingMs], [50_000 + 2 * MIN, 0]);
    assert.throws(() => dayStartOf('2026-02-30'), RangeError);
    assert.throws(() => dayStartOf('15-10-2026'), RangeError);
  });
});

describe('A-M07-03 watch log', () => {
  it('writes watch, unwatch and day carries; reads intervals back (an unclosed watch runs to the end of the day)', () => {
    const dir = tempDir('z08-watch');
    const errors: unknown[] = [];
    const w = new WatchLog(dir, (e) => errors.push(e));
    w.watch('A', 'candidate', ms(D0 + 10 * MIN));
    w.watch('A', 'candidate', ms(D0 + 11 * MIN));                         // no change: nothing written
    w.watch('B', 'tail', ms(D0 + 20 * MIN));
    w.unwatch('A', ms(D0 + 30 * MIN));
    w.unwatch('A', ms(D0 + 31 * MIN));                                    // not watched: nothing
    w.watch('B', 'position', ms(D0 + 40 * MIN));                          // class change
    const day = WatchLog.readDay(dir, DAY);
    assert.deepEqual(day.map((i) => [i.poolId, i.priorityClass, (i.fromMs - D0) / MIN, (i.toMs - D0) / MIN]), [
      ['A', 'candidate', 10, 30], ['B', 'tail', 20, 40], ['B', 'position', 40, 1_440],
    ]);
    // The next day: a quiet tick carries B over, so the day file stands alone.
    w.tick(ms(D0 + 86_400_000 + 5));
    fs.appendFileSync(join(dir, 'watch', '2026-10-16.ndjson'), '{"torn');
    assert.deepEqual(WatchLog.readDay(dir, '2026-10-16').map((i) => [i.poolId, i.priorityClass, i.fromMs - D0 - 86_400_000]), [['B', 'position', 0]]);
    assert.deepEqual(WatchLog.readDay(dir, '2026-10-17'), []);
    assert.equal(errors.length, 0);
    const failing = new WatchLog(dir, (e) => errors.push(e), { ...fs, appendFileSync: () => { throw new Error('EIO'); } });
    failing.watch('C', 'candidate', ms(D0));
    failing.tick(ms(D0));
    assert.equal(errors.length, 1);
  });
});

describe('A-M07-03 receipts (receipt-sig.ts)', () => {
  const pem = (k: { export(o: object): string | Buffer }, type: 'spki' | 'pkcs8'): string => k.export({ type, format: 'pem' }) as string;
  const pub = ed25519Key(pem(research.publicKey, 'spki'), 'public');
  const priv = ed25519Key(pem(research.privateKey, 'pkcs8'), 'private');
  const r = signReceipt({ path: `${DAY}/10/pool_snapshot.ndjson.gz`, sha256: 'b'.repeat(64), verifiedAtMs: ms(D0), verifier: 'ops-mac' }, priv);

  it('a receipt signed by the research key verifies; any change or another key fails', () => {
    assert.deepEqual(verifyReceipt(Buffer.from(receiptText(r)), pub), r);
    const otherPub = ed25519Key(pem(other.publicKey, 'spki'), 'public');
    assert.equal(verifyReceipt(Buffer.from(receiptText(r)), otherPub), null);
    for (const bad of [
      { ...r, sha256: 'c'.repeat(64) }, { ...r, sha256: 'XYZ' }, { ...r, path: '../etc/passwd' }, { ...r, verifier: 'a b' }, { ...r, verifiedAtMs: 1.5 },
      { ...r, signatureB64: 'x' }, { ...r, extra: 1 }, { path: r.path },
    ]) assert.equal(verifyReceipt(Buffer.from(JSON.stringify(bad)), pub), null, JSON.stringify(bad).slice(0, 60));
    for (const raw of ['not json', '[]', 'null', '\xff']) assert.equal(verifyReceipt(Buffer.from(raw, 'latin1'), pub), null);
    assert.throws(() => signReceipt({ ...r, path: 'x' }, priv), TypeError);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1_024 });
    assert.throws(() => ed25519Key(pem(rsa.publicKey, 'spki'), 'public'), /Ed25519/);
  });
});

/** A recorder folder with closed segments for `hours` (one stream each), and a receipts folder. */
function mdDir(hours: string[]): { dir: string; receipts: string; paths: string[] } {
  const dir = tempDir('z08-md');
  const receipts = join(dir, 'receipts');
  fs.mkdirSync(receipts);
  const paths: string[] = [];
  for (const h of hours) {
    const now = { t: Date.parse(`${h}:00:00Z`) + 1_000 };
    const rec = SegmentWriter.recover({ dataDir: dir, nowMs: ms(now.t), log: () => undefined });
    const q = new RecorderQueue({ firstSeq: rec.nextSeq });
    const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', queue: q, nowMs: () => ms(now.t), log: () => undefined }, { ...rec, lastRecordMs: null });
    q.append({ stream: 'decision', recvMs: ms(now.t), slot: null, commitment: null, source: 't', payload: { pad: 'x'.repeat(1_000) } });
    w.pump();
    const [m] = w.rotate();
    paths.push((m as { path: string }).path);
  }
  return { dir, receipts, paths };
}
const pubKey = ed25519Key(research.publicKey.export({ type: 'spki', format: 'pem' }) as string, 'public');
const privKey = ed25519Key(research.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'private');
const fileSha = (dir: string, p: string): string => createHash('sha256').update(fs.readFileSync(join(dir, p))).digest('hex');
function receiptFor(receipts: string, dir: string, p: string, key = privKey, sha?: string): void {
  const r = signReceipt({ path: p, sha256: sha ?? fileSha(dir, p), verifiedAtMs: ms(D0), verifier: 'ops' }, key);
  fs.writeFileSync(join(receipts, receiptFileName(p)), receiptText(r));
}
function manager(dir: string, receipts: string, usedPct: number, over: Partial<DiskDeps> = {}) {
  const logs: Array<{ level: string; code: string; fields: Record<string, string | number> }> = [];
  let halted = false;
  const writer = { halts: 0, resumes: 0, halt() { halted = true; this.halts += 1; }, resume() { halted = false; this.resumes += 1; }, isHalted: () => halted };
  const total = 55e9;
  const usage = { free: total * (1 - usedPct / 100) };
  const m = new DiskManager({
    dataDir: dir, receiptsDir: receipts, publicKey: pubKey, policy: DEFAULT_DISK_POLICY, usage: () => ({ totalBytes: total, freeBytes: usage.free }),
    writer, nowMs: () => ms(Date.parse('2026-10-15T12:00:00Z')), log: (level, code, fields) => logs.push({ level, code, fields }), ...over,
  });
  return { m, logs, writer, usage };
}

describe('A-M07-03 disk management (disk.ts; ruling Z08-3)', () => {
  it('acceptance: disk at 81% with two old segments, one with a valid receipt: only that one is deleted', () => {
    const { dir, receipts, paths } = mdDir([`${DAY}T01`, `${DAY}T02`]);
    receiptFor(receipts, dir, paths[0] as string);
    const { m } = manager(dir, receipts, 81);
    const r = m.check();
    assert.deepEqual(r.deleted, [paths[0]]);
    assert.equal(fs.existsSync(join(dir, paths[0] as string)), false);
    assert.equal(fs.existsSync(join(dir, paths[1] as string)), true);
    assert.equal(fs.existsSync(join(receipts, receiptFileName(paths[0] as string))), false);
  });

  it('acceptance: a receipt signed with a different key never deletes a segment (and is swept with a security warning)', () => {
    const { dir, receipts, paths } = mdDir([`${DAY}T01`]);
    const foreign = ed25519Key(other.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'private');
    receiptFor(receipts, dir, paths[0] as string, foreign);
    const { m, logs } = manager(dir, receipts, 81);
    assert.deepEqual(m.check().deleted, []);
    assert.equal(fs.existsSync(join(dir, paths[0] as string)), true);
    assert.ok(logs.some((l) => l.code === 'M07.receipts_swept' && l.fields.category === 'security'));
  });

  it('a valid receipt whose sha256 differs from the manifest does not delete (the file changed after the pull)', () => {
    const { dir, receipts, paths } = mdDir([`${DAY}T01`]);
    receiptFor(receipts, dir, paths[0] as string, privKey, 'f'.repeat(64));
    assert.deepEqual(manager(dir, receipts, 81).m.check().deleted, []);
  });

  it('MIGRATION ruling (Zeroed recorder-budget.ts deleted unuploaded files): no receipts and the disk at its stop level → recording halts with a critical alert and nothing is deleted', () => {
    const { dir, receipts, paths } = mdDir([`${DAY}T01`, `${DAY}T02`]);
    const { m, logs, writer, usage } = manager(dir, receipts, 96);
    const r = m.check();
    assert.deepEqual([r.deleted, r.halted, r.reasons], [[], true, ['disk_stop_pct', 'min_free_bytes']]);   // 96% of 55 GB leaves 2.2 GB
    for (const p of paths) assert.equal(fs.existsSync(join(dir, p)), true);
    assert.ok(logs.some((l) => l.level === 'critical' && l.code === 'M07.disk_full'));
    m.check();
    assert.equal(writer.halts, 1);                                        // halted once, alerted each check
    usage.free = 55e9 * 0.5;
    assert.equal(m.check().halted, false);
    assert.equal(writer.resumes, 1);
  });

  it('the byte cap and the free floor (DISKBUDGET ruling 2) apply too, and the stricter wins; a halt the manager did not make is left alone', () => {
    const { dir, receipts } = mdDir([`${DAY}T01`]);
    const capped = manager(dir, receipts, 10, { policy: { ...DEFAULT_DISK_POLICY, maxBytes: 100 } });
    assert.deepEqual(capped.m.check().reasons, ['max_bytes']);
    const floor = manager(dir, receipts, 10, { usage: () => ({ totalBytes: 30 * GIB, freeBytes: 2 * GIB }) });   // 93% used, 2 GiB free
    assert.deepEqual(floor.m.check().reasons, ['min_free_bytes']);
    const other = manager(dir, receipts, 10);
    other.writer.halt();
    other.m.check();
    assert.equal(other.writer.resumes, 0);
  });

  it('retention: a receipted segment older than 7 days goes without pressure; an unreceipted one stays with one alert a day', () => {
    const { dir, receipts, paths } = mdDir(['2026-10-01T01', '2026-10-01T02', `${DAY}T01`]);
    receiptFor(receipts, dir, paths[0] as string);
    receiptFor(receipts, dir, paths[2] as string);
    const { m, logs } = manager(dir, receipts, 10);
    assert.deepEqual(m.check().deleted, [paths[0]]);                       // the recent receipted one stays
    m.check();
    assert.equal(logs.filter((l) => l.code === 'M07.unpulled_segments').length, 1);
    assert.equal(fs.existsSync(join(dir, paths[1] as string)), true);
  });

  it('the open hour (no manifest), unreadable manifests and stray files are never touched; policy limits are checked', () => {
    const { dir, receipts } = mdDir([`${DAY}T01`]);
    fs.writeFileSync(join(dir, `${DAY}/01/fill.ndjson.gz`), 'open');
    fs.mkdirSync(join(dir, `${DAY}/02`));
    fs.writeFileSync(join(dir, `${DAY}/02/coverage.ndjson.gz`), 'x');
    fs.writeFileSync(join(dir, `${DAY}/02/coverage.manifest.json`), '{bad');
    fs.writeFileSync(join(dir, `${DAY}/02/note.txt`), 'x');
    const { m } = manager(dir, receipts, 99);
    assert.deepEqual(m.check().deleted, []);
    assert.equal(m.segments().closed.length, 1);
    assert.deepEqual(new DiskManager({ ...({} as DiskDeps), dataDir: join(dir, 'none'), receiptsDir: receipts, publicKey: pubKey, policy: DEFAULT_DISK_POLICY,
      usage: () => ({ totalBytes: 1, freeBytes: 1 }), writer: { halt() {}, resume() {}, isHalted: () => false }, nowMs: () => ms(0), log: () => undefined }).segments(), { closed: [], totalBytes: 0 });
    for (const bad of [{ warnPct: 96 }, { stopPct: 100 }, { maxBytes: 0 }, { minFreeBytes: -1 }, { retentionDays: 6 }, { retentionDays: 366 }]) {
      assert.notEqual(checkPolicy({ ...DEFAULT_DISK_POLICY, ...bad }), null, JSON.stringify(bad));
      assert.throws(() => manager(dir, receipts, 10, { policy: { ...DEFAULT_DISK_POLICY, ...bad } }), RangeError);
    }
  });

  it('a delete that fails is logged and the segment counted as kept', () => {
    const { dir, receipts, paths } = mdDir([`${DAY}T01`]);
    receiptFor(receipts, dir, paths[0] as string);
    const { m, logs } = manager(dir, receipts, 81, { fs: { ...fs, unlinkSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } } });
    assert.deepEqual(m.check().deleted, []);
    assert.ok(logs.some((l) => l.code === 'M07.segment_delete_failed' && l.fields.code === 'EPERM'));
  });
});

describe('A-M07-03 md-pull and the daily coverage job', () => {
  it('md-pull downloads, verifies by SHA-256, signs receipts, uploads them, and the host then accepts them; a corrupted copy gets none', () => {
    const host = mdDir([`${DAY}T01`, `${DAY}T02`]);
    const local = tempDir('z08-local');
    const uploaded: string[] = [];
    let corrupt = true;
    const transport: PullTransport = {
      listDays: () => [DAY, '2026-10-01', 'receipts'],
      fetchDay(day, root) {
        fs.cpSync(join(host.dir, day), join(root, day), { recursive: true });
        if (corrupt) { fs.appendFileSync(join(root, host.paths[1] as string), 'x'); corrupt = false; }
      },
      putReceipts(files) { for (const f of files) { fs.copyFileSync(f.local, join(host.receipts, f.name)); uploaded.push(f.name); } },
    };
    fs.writeFileSync(join(host.dir, `${DAY}/02/fill.ndjson.gz`), 'open hour');   // no manifest yet
    const logs: string[] = [];
    const r = runPull({ transport, localRoot: local, since: '2026-10-10', privateKey: privKey, verifier: 'ops-mac', nowMs: () => ms(D0), log: (l) => logs.push(l) });
    assert.deepEqual(r.days, [DAY]);
    assert.deepEqual(r.verified.map((x) => x.path), [host.paths[0]]);
    assert.deepEqual(r.mismatched, [host.paths[1]]);
    assert.deepEqual(r.unmanifested, [`${DAY}/02/fill.ndjson.gz`]);
    assert.deepEqual(uploaded, [receiptFileName(host.paths[0] as string)]);
    const { m } = manager(host.dir, host.receipts, 81);
    assert.deepEqual(m.check().deleted, [host.paths[0]]);                   // the host trusts only the signed match
    assert.ok(logs.some((l) => l.startsWith('MISMATCH')));
    assert.throws(() => runPull({ transport, localRoot: local, since: 'x', privateKey: privKey, verifier: 'v', nowMs: () => ms(0), log: () => undefined }), RangeError);
  });

  it('the sftp transport sends safe batch lines only; arguments are parsed', () => {
    const seen: Array<{ args: string[]; batch: string }> = [];
    const t = sftpTransport('zeroed-host', (args, batch) => { seen.push({ args, batch }); return { status: 0, stdout: 'md/2026-10-15\nmd/receipts\n' }; });
    assert.deepEqual(t.listDays(), ['2026-10-15']);
    t.fetchDay('2026-10-15', '/tmp/x');
    t.putReceipts([{ local: '/tmp/x/receipts/a.receipt.json', name: 'a.receipt.json' }]);
    assert.deepEqual(seen.map((s) => s.batch), ['ls -1 md\n', 'lcd /tmp/x\nget -r md/2026-10-15\n', 'put /tmp/x/receipts/a.receipt.json md/receipts/a.receipt.json\n']);
    assert.deepEqual(seen[0]?.args, ['-b', '-', '-o', 'BatchMode=yes', 'zeroed-pull@zeroed-host']);
    assert.throws(() => sftpBatch([['get', 'a b']]), /unsafe/);
    assert.throws(() => sftpTransport('evil host'), RangeError);
    const failing = sftpTransport('h', () => ({ status: 255, stdout: '' }));
    assert.throws(() => failing.listDays(), /sftp exited 255/);
    assert.deepEqual(parseArgs(['--host', 'h', '--since', DAY, '--out', '/o', '--key', '/k', '--verifier', 'v']), { host: 'h', since: DAY, out: '/o', key: '/k', verifier: 'v' });
    assert.equal(parseArgs(['--host', 'h']), 'missing --since');
    assert.equal(parseArgs(['host', 'h']), 'bad argument host');
  });

  it('the daily job reads the day from disk: manifests, poll_counts segments (and the next day\'s first minute), the watch log; appends and saves the report', () => {
    const dir = tempDir('z08-daily');
    const now = { t: D0 + 1_000 };
    const wl = new WatchLog(dir, () => undefined);
    wl.watch('A', 'candidate', ms(D0));
    const rec = SegmentWriter.recover({ dataDir: dir, nowMs: ms(now.t), log: () => undefined });
    const q = new RecorderQueue({ firstSeq: rec.nextSeq });
    const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', queue: q, nowMs: () => ms(now.t), log: () => undefined }, rec);
    const pc = (p: PollCountRecord, at: number): void => {
      q.append({ stream: 'poll_counts', recvMs: ms(at), slot: null, commitment: null, source: 'm07', payload: p });
    };
    for (let m = 0; m < 1_440; m += 1) {
      now.t = D0 + (m + 1) * MIN;
      if (m === 1_439) {
        w.pump();                                                         // close 23:00 first; 23:59's poll arrives late, after midnight
        pc({ poolId: 'A', minuteStartMs: ms(D0 + 1_440 * MIN), successfulPolls: 0, priorityClass: 'candidate', latePolls: 1, lateFromMinuteStartMs: ms(D0 + 1_439 * MIN) }, now.t);
      } else {
        pc({ poolId: 'A', minuteStartMs: ms(D0 + m * MIN), successfulPolls: 60, priorityClass: 'candidate' }, now.t);
      }
      w.pump();
    }
    w.rotate();
    assert.equal(dayManifests(dir, DAY).length, 24);
    const appended: unknown[] = [];
    const saved: unknown[] = [];
    const c = runDailyCoverage({ dataDir: dir, nowMs: ms(D0 + 86_400_000 + 5), universeManifestSha256: null, append: (r) => appended.push(r), save: (r) => saved.push(r) });
    assert.equal(c.detail.missingMs, 0);
    assert.equal(c.report.lowCoverage, false);
    assert.equal(c.report.universeManifestSha256, createHash('sha256').update(fs.readFileSync(join(dir, 'watch', `${DAY}.ndjson`))).digest('hex'));
    assert.deepEqual([appended, saved], [[c.report], [c.report]]);
    assert.equal(dailyCoverage({ dataDir: dir, dayUtc: '2026-10-01', universeManifestSha256: 'e'.repeat(64) }).report.lowCoverage, true);
  });
});
