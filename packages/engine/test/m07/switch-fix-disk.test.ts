// Card SWITCH-FIX SW-4 and SW-5 (red team 1 on bac1f88a): the disk check's cost does not grow with the segments on
// disk, and the recorder warns at 75% of its byte cap with the days left.
import { strict as assert } from 'node:assert';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { DEFAULT_DISK_POLICY, DiskManager, GIB, type DiskDeps } from '../../src/m07/disk.ts';
import { tempDir } from '../helpers.ts';

const pub = createPublicKey(generateKeyPairSync('ed25519').privateKey);
const writerStub: DiskDeps['writer'] = { halt() {}, resume() { return true; }, isHalted: () => false, haltReason: () => null, openPaths: () => [] };

/** `days` × 24 hours × `streams` segments, each with its manifest: 2 files a segment. */
function fill(dir: string, start: number, days: number, streams: number): number {
  let files = 0;
  for (let h = 0; h < days * 24; h++) {
    const t = new Date(start + h * 3_600_000).toISOString();
    const day = t.slice(0, 10), hour = t.slice(11, 13);
    const d = join(dir, day, hour);
    fs.mkdirSync(d, { recursive: true });
    for (let s = 0; s < streams; s++) {
      const st = `s_${String.fromCharCode(97 + Math.floor(s / 26))}${String.fromCharCode(97 + (s % 26))}`;
      const name = `${st}.ndjson.gz`;
      fs.writeFileSync(join(d, name), 'x'.repeat(100));
      fs.writeFileSync(join(d, `${st}.manifest.json`), JSON.stringify({
        path: `${day}/${hour}/${name}`, stream: st, firstSlot: null, lastSlot: null, records: 1, bytes: 100, sha256: 'a'.repeat(64), gaps: [], codec: 'gzip',
        firstSeq: null, lastSeq: null, hourUtc: `${day}T${hour}`, keyframes: 0, firstRecvMs: null, lastRecvMs: null,
      }));
      files += 2;
    }
  }
  return files;
}

function counting() {
  let calls = 0;
  const wrap = <F extends (...a: never[]) => unknown>(f: F): F => ((...a: Parameters<F>) => { calls++; return f(...a); }) as F;
  const cfs = { readdirSync: wrap(fs.readdirSync), readFileSync: wrap(fs.readFileSync), existsSync: wrap(fs.existsSync), statSync: wrap(fs.statSync), unlinkSync: wrap(fs.unlinkSync), rmdirSync: wrap(fs.rmdirSync) } as NonNullable<DiskDeps['fs']>;
  return { cfs, calls: () => calls, reset: () => { calls = 0; } };
}

describe('SW-5: the disk check reads only what changed', () => {
  it('19,200 files: the second check makes at most 2 calls per hour folder, not 3 per file (fails before: about 29,000)', () => {
    const dir = tempDir('sw5');
    const receipts = join(dir, 'receipts');
    fs.mkdirSync(receipts);
    const start = Date.UTC(2026, 9, 1);
    assert.equal(fill(dir, start, 20, 20), 19_200);
    const now = (start + 20 * 86_400_000 + 600_000) as UnixMs;
    const c = counting();
    const m = new DiskManager({ dataDir: dir, receiptsDir: receipts, publicKey: pub, policy: { ...DEFAULT_DISK_POLICY, maxBytes: 8 * GIB },
      usage: () => ({ totalBytes: 50e9, freeBytes: 40e9 }), writer: writerStub, nowMs: () => now, log: () => undefined, fs: c.cfs });
    const first = m.check();
    const firstCalls = c.calls();
    c.reset();
    const second = m.check();
    const hours = 20 * 24, days = 20;
    assert.deepEqual([second.recorderBytes, second.unreceipted], [first.recorderBytes, first.unreceipted]);
    assert.equal(second.unreceipted, 9_600);
    assert.ok(firstCalls > 19_200, `the first check reads every file (${firstCalls})`);
    assert.ok(c.calls() <= 2 * hours + 3 * days + 10, `second check: ${c.calls()} calls for ${hours} hour folders`);
  });

  it('a change in a closed hour (a new part, a delete) is seen at the next check', () => {
    const dir = tempDir('sw5-change');
    const receipts = join(dir, 'receipts');
    fs.mkdirSync(receipts);
    const start = Date.UTC(2026, 9, 1);
    fill(dir, start, 1, 2);
    const now = (start + 86_400_000 + 600_000) as UnixMs;
    const m = new DiskManager({ dataDir: dir, receiptsDir: receipts, publicKey: pub, policy: DEFAULT_DISK_POLICY,
      usage: () => ({ totalBytes: 50e9, freeBytes: 40e9 }), writer: writerStub, nowMs: () => now, log: () => undefined });
    assert.equal(m.check().unreceipted, 48);
    fs.rmSync(join(dir, '2026-10-01/05/s_aa.ndjson.gz'));
    fs.rmSync(join(dir, '2026-10-01/05/s_aa.manifest.json'));
    assert.equal(m.check().unreceipted, 47);
    fs.writeFileSync(join(dir, '2026-10-01/05/s_aa.p1.ndjson.gz'), 'x'.repeat(100));   // a late part, no manifest yet
    assert.equal(m.check().recorderBytes, 47 * 100 + 100);
  });
});

describe('SW-4: a warning at 75% of the byte cap, with the days left', () => {
  it('once a UTC day at or above 75% of max_bytes; days_to_cap from the last day\'s growth (fails before: nothing until the cap halts)', () => {
    const dir = tempDir('sw4');
    const receipts = join(dir, 'receipts');
    fs.mkdirSync(receipts);
    const start = Date.UTC(2026, 9, 1);
    let now = start;
    const logs: Array<{ code: string; fields: Record<string, string | number> }> = [];
    const watch = join(dir, 'watch');
    fs.mkdirSync(watch);
    // The watch log's bytes count against the cap (Z10-26): a stand-in for recorded bytes that grow 100 a hour.
    const grow = (bytes: number): void => { fs.writeFileSync(join(watch, '2026-10-01.ndjson'), 'x'.repeat(bytes)); };
    const m = new DiskManager({ dataDir: dir, receiptsDir: receipts, publicKey: pub, policy: { ...DEFAULT_DISK_POLICY, maxBytes: 10_000 },
      usage: () => ({ totalBytes: 50e9, freeBytes: 40e9 }), writer: writerStub, nowMs: () => now as UnixMs, log: (_l, code, fields) => logs.push({ code, fields }) });
    for (let h = 0; h <= 10; h++) { now = start + h * 3_600_000; grow(6_500 + 100 * h); m.check(); }
    const w = logs.filter((l) => l.code === 'M07.disk_budget_high');
    assert.equal(w.length, 1, 'once a day');
    assert.deepEqual([w[0]!.fields.recorder_bytes, w[0]!.fields.pct], [7_500, 75]);
    assert.equal(w[0]!.fields.days_to_cap, 1);                            // 2,500 left at 2,400 a day
    now = start + 86_400_000 + 1;
    m.check();
    assert.equal(logs.filter((l) => l.code === 'M07.disk_budget_high').length, 2, 'the next UTC day says it again');
  });
});
