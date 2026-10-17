// Card SWITCH-FIX (the three red teams on bac1f88a): the composition-root fixes, on the rig (virtual clock, fake chain).
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import type { Pubkey, UnixMs } from '@bot/types';
import { dayManifests } from '../../src/m07/daily.ts';
import { SegmentWriter } from '../../src/m07/segments.ts';
import { readPhase0Dataset } from '../../src/m13/phase0-input.ts';
import { venueRecordedPricing } from '../../src/m13/venue-pricing.ts';
import { heightReader, NEXT_SEQ_KEY } from '../../src/recorder-main/compose.ts';
import { FATAL_EXIT, fatalHandler, heartbeatSlot, startHealthServers } from '../../src/recorder-main/health.ts';
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

describe('SW-6: the facts map is bounded', () => {
  it('facts of a pool with no live candidate and no tracking are dropped; a live candidate\'s stay (fails before: kept forever)', async () => {
    const r = await startRig(tempDir('sw6'));
    try {
      await r.run(5_000);
      const fact = { venue: 'pumpswap' as const, quoteMint: 'q' as Pubkey, feeTotalBps: 30, effectiveQuoteLamports: 1n, observedAtMs: r.time.nowMs() };
      r.rec.parts.facts.set('ghost' as Pubkey, fact);
      const live = r.rec.parts.universe.candidates().find((c) => !c.reasons.some((x) => x.startsWith('retired=')));
      if (live !== undefined) r.rec.parts.facts.set(live.poolId, fact);
      await r.run(11_000);
      assert.equal(r.rec.parts.facts.has('ghost' as Pubkey), false);
      if (live !== undefined) assert.equal(r.rec.parts.facts.has(live.poolId), true);
    } finally {
      await r.rec.stop();
    }
  });
});

describe('SW-8: no slot in the heartbeat while nothing is watched', () => {
  it('heartbeatSlot is null at 0 watched pools, the newest stored slot otherwise (fails before: the stale slot was sent)', () => {
    assert.equal(heartbeatSlot({ watched: 0, newestStoredSlot: '400000000' }), null);
    assert.equal(heartbeatSlot({ watched: 3, newestStoredSlot: null }), null);
    assert.equal(heartbeatSlot(null), null);
    assert.equal(heartbeatSlot({ watched: 3, newestStoredSlot: '18446744073709551615' }), 18_446_744_073_709_551_615n);
  });
});

describe('SW-3: nothing the loop or the process does can throw past a handler', () => {
  it('fatalHandler: one line, a stop, then exit 70, once; the grace timer exits even if the stop hangs', async () => {
    const seen: string[] = [];
    let timer: (() => void) | null = null;
    const h = fatalHandler({
      log: (w, c) => seen.push(`log ${w} ${c}`), stop: () => new Promise<void>(() => undefined), exit: (c) => seen.push(`exit ${c}`), say: () => undefined,
      setTimer: (fn) => { timer = fn; },
    });
    h('unhandled_rejection', Object.assign(new Error('x'), { code: 'E_BAD/../x' }));
    h('uncaught_exception', new Error('again'));                          // a second one while stopping: ignored
    assert.deepEqual(seen, ['log unhandled_rejection E_BAD____x']);
    (timer as unknown as () => void)();
    assert.deepEqual(seen, ['log unhandled_rejection E_BAD____x', `exit ${FATAL_EXIT}`]);
    const done: string[] = [];
    fatalHandler({ log: () => undefined, stop: async () => { done.push('stopped'); }, exit: (c) => done.push(`exit ${c}`), say: () => undefined, setTimer: () => undefined })('uncaught_exception', 'not an error');
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(done, ['stopped', 'exit 70']);
  });

  it('a status that throws answers /health with 500 and the server keeps running (fails before: an uncaught exception)', async () => {
    let bad = true;
    const [s] = await startHealthServers([{ host: '127.0.0.1', port: 0 }], () => { if (bad) throw new Error('status'); return { mode: 'paper', git_sha: 'x', signing_key: false }; });
    try {
      const port = (s!.address() as { port: number }).port;
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 500);
      bad = false;
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    } finally {
      s!.close();
    }
  });

  it('a throw in M14\'s tick or the metrics tick is one internal_error line, and the loop goes on (fails before: the tick rejected)', async () => {
    const r = await startRig(tempDir('sw3'));
    try {
      await r.run(2_000);
      const rp = r.rec.parts.read as { tick: () => void };
      const m = r.rec.parts.metrics as unknown as { tick: () => void };
      const [t0, t1] = [rp.tick, m.tick];
      rp.tick = () => { throw Object.assign(new Error('x'), { code: 'E_TICK' }); };
      m.tick = () => { throw Object.assign(new Error('y'), { code: 'E_METRICS' }); };
      const before = r.rec.status().lastTickMs;
      await r.run(3_000);
      rp.tick = t0; m.tick = t1;
      const where = r.lines.map((l) => JSON.parse(l) as { code: string; where?: string }).filter((l) => l.code === 'recorder.internal_error').map((l) => l.where);
      assert.ok(where.includes('rpc_tick') && where.includes('metrics_tick'), where.join(','));
      assert.ok((r.rec.status().lastTickMs ?? 0) > (before ?? 0), 'the loop kept ticking');
    } finally {
      await r.rec.stop();
    }
  });
});

describe('SW-2: a provider stop survives a restart, and only the operator\'s resume ends it', () => {
  it('stop kept across a restart; provider-resume-<label> clears it, is deleted, and the clear survives the next restart (fails before: no way to resume)', async () => {
    const dir = tempDir('sw2');
    const time = new VirtualTime(WALL_START);
    const chain = new FakeChain(time, { seed: 3 });
    const a = await startRig(dir, { time, chain });
    const label = a.rec.status().providers[1] as string;
    await a.run(2_000);
    // Three 429s in the window (the owner's rule) is what stops a provider; the stop is what M14 saves.
    const store = a.rec.parts.db;
    const t = time.nowMs();
    store.withTx((tx) => { tx.run('INSERT OR REPLACE INTO "kv_state" ("key", "value_json", "created_at", "updated_at") VALUES (?, ?, ?, ?)', 'm14.stop_state', JSON.stringify({ stopped: [{ label, stoppedAtMs: t, reason: 'rate_limited' }], recent: [] }), t, t); });
    await a.rec.stop();
    const b = await startRig(dir, { time, chain });
    try {
      assert.ok(b.rec.parts.read.gateway.status().find((x) => x.label === label)?.stopped, 'the stop survived the restart');
      writeFileSync(join(b.paths.controlDir as string, `provider-resume-${label}`), '');
      writeFileSync(join(b.paths.controlDir as string, 'provider-resume-nosuch'), '');
      await b.run(6_000);
      assert.equal(b.rec.parts.read.gateway.status().find((x) => x.label === label)?.stopped, false);
      assert.deepEqual(readdirSync(b.paths.controlDir as string), []);
      const res = b.lines.map((l) => JSON.parse(l) as { code: string; provider?: string; result?: string }).filter((l) => l.code === 'recorder.provider_resume').map((l) => `${l.provider}:${l.result}`).sort();
      assert.deepEqual(res, [`${label}:resumed`, 'unknown:unknown'].sort());
    } finally {
      await b.rec.stop();
    }
    const c = await startRig(dir, { time, chain });
    try {
      assert.equal(c.rec.parts.read.gateway.status().find((x) => x.label === label)?.stopped, false, 'the resume was saved');
    } finally {
      await c.rec.stop();
    }
  }, 60_000);
});
