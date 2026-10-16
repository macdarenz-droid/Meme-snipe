// Card Z10: the Z09 obligations on the composition root (DECISIONS Z09-32, Z09-34/39/44, Z09-40, Z09-47, Z09-49).
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import type { Pubkey } from '@bot/types';
import { tempDir } from '../helpers.ts';
import { FakeChain, VirtualTime } from './fake-chain.ts';
import { startRig, WALL_START, type Rig } from './rig.ts';

interface Line { stream: string; seq: string; recvMs: number; payload: Record<string, unknown> }

/** Every record of `stream` on disk, sealed or open (gzip members are concatenated frames). */
function records(dataDir: string, stream: string): Line[] {
  const out: Line[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === `${stream}.ndjson.gz` || new RegExp(`^${stream}\\.p\\d+\\.ndjson\\.gz$`).test(n)) {
        const text = gunzipSync(readFileSync(p)).toString('utf8');
        for (const l of text.split('\n')) if (l !== '') out.push(JSON.parse(l) as Line);
      }
    }
  };
  if (existsSync(dataDir)) walk(dataDir);
  return out.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
}

const MARKED = ['poll_counts', 'pool_snapshot', 'pool_snapshot_position', 'pool_snapshot_tail'] as const;
const POOL = (r: Rig): Pubkey => r.chain.pools.find((p) => p.pool.startsWith('Dh39'))!.pool;

describe('Z10 obligations (Z09)', () => {
  it('Z09-47/49: firstSeq of all four marked streams comes from recover().nextSeq across a restart; the marker is written before any poll', async () => {
    const dir = tempDir('z10-seq');
    const time = new VirtualTime(WALL_START);
    const chain = new FakeChain(time, { seed: 5 });
    const a = await startRig(dir, { time, chain, release: 'a'.repeat(40) });
    await a.run(5_000);
    assert.ok(a.rec.parts.tracker.watch(POOL(a), 'candidate'));
    await a.run(90_000);
    assert.equal(a.rec.parts.queue.stats().rejectedTotal.E_NOT_STARTED ?? 0, 0, 'nothing was appended before markProcessStart');
    await a.rec.stop();
    const before = Object.fromEntries(MARKED.map((s) => [s, records(a.paths.mdDir, s).at(-1)?.seq ?? null]));
    assert.ok(before.poll_counts !== null && before.pool_snapshot !== null, 'the first run recorded counts and snapshots');
    // A restart in the same folders: recovery seals the open segments and every stream's seq continues.
    await time.advance(30_000);
    const b = await startRig(dir, { time, chain, release: 'b'.repeat(40) });
    try {
      await b.run(5_000);
      const markers = records(b.paths.mdDir, 'process_start');
      assert.equal(markers.length, 2);
      const second = markers[1]!.payload as { releaseId: string; firstSeq: Record<string, string> };
      assert.equal(second.releaseId, 'b'.repeat(40));
      for (const s of MARKED) {
        const want = before[s] === null ? '0' : (BigInt(before[s] as string) + 1n).toString();
        assert.equal(second.firstSeq[s], want, `${s} continues from the recovered tail`);
      }
    } finally {
      await b.rec.stop();
    }
  }, 120_000);

  it('Z09-32: each second M07 tick(now), the writer hands the written poll_counts to M08, then M08 closeDue(now): no count is late or early, and closed 60 s bars are stored', async () => {
    const r = await startRig(tempDir('z10-bars'));
    try {
      await r.run(5_000);
      assert.ok(r.rec.parts.tracker.watch(POOL(r), 'candidate'));
      await r.run(5 * 60_000);
      const st = r.rec.parts.bars.stats();
      assert.equal(st.lateCounts, 0);
      assert.equal(st.earlyCounts, 0);
      await r.run(70_000);                                        // the bar store flushes once a minute
      const rows = Number(r.rec.parts.db.reader().get('SELECT count(*) AS n FROM bar_1m')?.n ?? 0);
      assert.ok(rows >= 3, `bar_1m rows ${rows}`);
    } finally {
      await r.rec.stop();
    }
  }, 120_000);

  it('Z09-34/39/44: requestFacts reads slotless pools at P4 through M14, at most two calls a flush, and pauses (nothing asked) while the primary is down', async () => {
    const r = await startRig(tempDir('z10-facts'));
    const calls: Array<{ method: string; priority: number; provider: string | undefined }> = [];
    const gw = r.rec.parts.read.gateway;
    const call = gw.call.bind(gw);
    gw.call = ((method: string, params: unknown[], o: { priority: number; provider?: string }) => { calls.push({ method, priority: o.priority, provider: o.provider }); return call(method, params, o as never); }) as typeof gw.call;
    try {
      r.chain.migrationsVisible = 3;
      await r.run(30 * 60_000);
      // The retry at migration + 20 min asked for fresh facts: P4 getMultipleAccounts, and the pool was then watched.
      const p4 = calls.filter((c) => c.method === 'getMultipleAccounts' && c.priority === 4);
      assert.ok(p4.length >= 2, `P4 reads ${p4.length}`);
      assert.ok(r.rec.status().watched >= 1);
      // Shyft down: degraded mode; M05's fresh reads pause and nothing goes to the metered backup at P2+.
      r.chain.provider('shyft').down = true;
      const n0 = calls.length;
      await r.run(3 * 60_000);
      assert.equal(r.rec.parts.read.monitor.mode(), 'degraded_reads');
      const chainstackP2plus = (r.chain.byMethod.get('chainstack getMultipleAccounts') ?? 0);
      const later = calls.slice(n0).filter((c) => c.method === 'getMultipleAccounts' && c.priority === 4);
      assert.equal(later.length, 0, 'no fresh-facts read while the primary is down');
      assert.equal(chainstackP2plus, 0, 'no P2+ read reached the metered backup');
    } finally {
      await r.rec.stop();
    }
  }, 120_000);

  it('a failed poll batch is counted as failed polls for each watched pool (A-M07-01 failedPolls)', async () => {
    const r = await startRig(tempDir('z10-failed'));
    try {
      await r.run(5_000);
      assert.ok(r.rec.parts.tracker.watch(POOL(r), 'candidate'));
      await r.run(30_000);
      r.chain.provider('shyft').down = true;
      await r.run(30_000);
      await r.rec.stop();
      const counts = records(r.paths.mdDir, 'poll_counts').map((l) => l.payload as { failedPolls: number; successfulPolls: number });
      assert.ok(counts.some((c) => c.failedPolls > 0), 'failed polls recorded');
      assert.ok(counts.some((c) => c.successfulPolls > 0));
    } finally {
      await r.rec.stop();
    }
  }, 120_000);
});
