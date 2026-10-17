// Card SWITCH-FIX (the three red teams on bac1f88a): the composition-root fixes, on the rig (virtual clock, fake chain).
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import type { Pubkey, UnixMs } from '@bot/types';
import { dayManifests } from '../../src/m07/daily.ts';
import { SegmentWriter } from '../../src/m07/segments.ts';
import { readPhase0Dataset } from '../../src/m13/phase0-input.ts';
import { venueRecordedPricing } from '../../src/m13/venue-pricing.ts';
import { heightReader, NEXT_SEQ_KEY } from '../../src/recorder-main/compose.ts';
import { tempDir } from '../helpers.ts';
import { FakeChain, VirtualTime } from './fake-chain.ts';
import { startRig, WALL_START, type Rig } from './rig.ts';

interface Line { stream: string; seq: string; recvMs: number; payload: Record<string, unknown> }
function files(dataDir: string, test: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else if (test(n)) out.push(p);
    }
  };
  if (existsSync(dataDir)) walk(dataDir);
  return out;
}
function records(dataDir: string, stream: string): Line[] {
  const re = new RegExp(`^${stream}(\\.p\\d+)?\\.ndjson\\.gz$`);
  return files(dataDir, (n) => re.test(n)).flatMap((p) => gunzipSync(readFileSync(p)).toString('utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Line))
    .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
}
const POOL = (r: Rig): Pubkey => r.chain.pools.find((p) => p.pool.startsWith('Dh39'))!.pool;

describe('SWITCH-FIX on the composition root', () => {
  it('SW-11: a stream whose segments were all deleted continues at a new seq after a restart (never reuses one)', async () => {
    const dir = tempDir('sw11');
    const time = new VirtualTime(WALL_START);
    const chain = new FakeChain(time, { seed: 5 });
    const a = await startRig(dir, { time, chain, release: 'a'.repeat(40) });
    await a.run(5_000);
    assert.ok(a.rec.parts.tracker.watch(POOL(a), 'candidate'));
    await a.run(31 * 60_000);                                             // past 18:00: one rotation
    await a.rec.stop();
    const last = records(a.paths.mdDir, 'poll_counts').at(-1);
    assert.ok(last !== undefined, 'poll counts were recorded');
    // What DiskManager does once every segment of the stream was received: the segments and manifests go.
    for (const p of files(a.paths.mdDir, (n) => /^poll_counts(\.p\d+)?\.(ndjson\.gz|manifest\.json)$/.test(n))) rmSync(p);
    await time.advance(30_000);
    const b = await startRig(dir, { time, chain, release: 'b'.repeat(40) });
    try {
      assert.ok(b.rec.parts.queue.peekNextSeq('poll_counts') > BigInt(last.seq), 'poll_counts continues past every seq it used');
      const saved = b.rec.parts.db.reader().get('SELECT "value_json" FROM "kv_state" WHERE "key" = ?', NEXT_SEQ_KEY);
      assert.ok(saved !== undefined);
    } finally {
      await b.rec.stop();
    }
  }, 120_000);
});

describe('SW-9: the recorder\'s real layout read by Phase 0, across a day boundary', () => {
  it('rig → readPhase0Dataset: day D\'s manifest (in D+1/00) and coverage report (in D+1/01) are found (fails before: manifest null)', async () => {
    const time = new VirtualTime(Date.UTC(2026, 9, 6, 23, 40, 0));
    const chain = new FakeChain(time, { seed: 9 });
    const r = await startRig(tempDir('sw9'), { time, chain });
    let report: { sha256: string; low: boolean };
    try {
      await r.run(5_000);
      assert.ok(r.rec.parts.tracker.watch(chain.pools[0]!.pool, 'candidate'));
      await r.run(85 * 60_000);
      const rd = r.rec.parts.db.reader();
      const m = rd.get('SELECT "sha256" FROM "universe_manifest" WHERE "day_utc" = ?', '2026-10-06') as { sha256: string } | undefined;
      const c = rd.get('SELECT "low_coverage" FROM "coverage_report" WHERE "day_utc" = ?', '2026-10-06') as { low_coverage: unknown } | undefined;
      assert.ok(m !== undefined && c !== undefined, 'the recorder wrote both');
      report = { sha256: m.sha256, low: Number(c.low_coverage) === 1 };
    } finally {
      await r.rec.stop();
    }
    // The next start seals the open hour (what md-pull then receives).
    SegmentWriter.recover({ dataDir: r.paths.mdDir, nowMs: time.nowMs(), log: () => undefined });
    const i = readPhase0Dataset({ dataDir: r.paths.mdDir, days: ['2026-10-06'], pricing: venueRecordedPricing() });
    const d = i.days.find((x) => x.dayUtc === '2026-10-06');
    assert.equal(d?.manifest?.sha256, report.sha256);
    assert.equal(d?.lowCoverage, report.low);                           // the fixture test (z09) proves a false one is read too
    // Each record sits where the writer put it: the manifest in D+1/00, the report in D+1/01.
    assert.ok(dayManifests(r.paths.mdDir, '2026-10-07').some((x) => x.stream === 'universe_manifest' && x.hourUtc === '2026-10-07T00'));
    assert.ok(dayManifests(r.paths.mdDir, '2026-10-07').some((x) => x.stream === 'coverage' && x.hourUtc === '2026-10-07T01'));
  }, 180_000);
});

describe('SW-14 and SW-16', () => {
  it('SW-14: a failed eviction write is logged as recorder.internal_error (fails before: silent)', async () => {
    const r = await startRig(tempDir('sw14'));
    try {
      await r.run(2_000);
      const db = r.rec.parts.db as { withTx: unknown };
      const orig = db.withTx;
      db.withTx = () => { throw Object.assign(new Error('busy'), { code: 'E_BUSY' }); };
      try {
        r.rec.parts.evictions.append({ poolId: 'p' as Pubkey, atMs: r.time.nowMs(), reason: 'cap', tailUntilMs: null });
      } finally {
        db.withTx = orig;
      }
      const line = r.lines.map((l) => JSON.parse(l) as { code: string; where?: string; error_code?: string }).find((l) => l.code === 'recorder.internal_error' && l.where === 'eviction_log');
      assert.equal(line?.error_code, 'E_BUSY');
    } finally {
      await r.rec.stop();
    }
  });

  it('SW-16: the anchor reading is timed at the send, not the answer (fails before: atMs = answer time, expected slot low by the latency)', async () => {
    let now = 1_000_000;
    const gateway = {
      call: async () => { now += 400; return { ok: true, value: { providerLabel: 'shyft', value: { absoluteSlot: 500, blockHeight: 1, epoch: 1, slotIndex: 1, slotsInEpoch: 432_000 }, contextSlot: null, latencyMs: 400 } }; },
    };
    const read = heightReader(gateway as never, () => now as UnixMs, 1_000);
    const got = await read('shyft');
    assert.deepEqual(got, { slot: 500n, atMs: 1_000_000 });
    assert.equal(await read('chainstack'), null);                          // an answer from another provider is not this one's
  });
});
