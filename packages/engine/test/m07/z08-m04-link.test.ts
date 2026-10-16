// Card Z08, recorder integration (Z04 review rulings 1 and 14): M04 unwatches the recorder for every pool it stops
// watching, and the coverage denominator is the watch history. A real M04 tracker on the fake model and reader, the
// real recorder queue and watch log.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { createPoolTracker } from '../../src/m04/tracker.ts';
import { M04_DEFAULTS } from '../../src/m04/settings.ts';
import { computeCoverage } from '../../src/m07/coverage.ts';
import { linkTrackerToRecorder } from '../../src/m07/m04-link.ts';
import { WatchLog } from '../../src/m07/watch-log.ts';
import { RecorderQueue } from '../../src/recorder/queue.ts';
import { FakeChain, fakeModel, Logs, Outputs, poolAccounts, ScriptedReader, type FakePool } from '../m04/fake.ts';
import { FakeTime } from '../m14/helpers.ts';
import { tempDir } from '../helpers.ts';

describe('card Z08 M04 → M07 link', () => {
  it('ruling 1: every pool M04 stops watching (unwatch, close) is unwatched in the recorder and closed in the watch log; a refused watch is recorded nowhere', async () => {
    const time = new FakeTime();
    const wall = (): UnixMs => (Date.UTC(2026, 9, 15) + time.now) as UnixMs;
    const reader = new ScriptedReader();
    const chain = new FakeChain();
    reader.slot = () => chain.highest;
    const queue = new RecorderQueue();
    const dir = tempDir('z08-link');
    const history = new WatchLog(dir, () => undefined);
    const link = linkTrackerToRecorder<FakePool>({ recorder: queue, history, model: fakeModel, nowMs: wall });
    const outputs = new Outputs();
    const merged = Object.assign(outputs, { snapshot: link.outputs.snapshot, unwatched: (p: string) => { outputs.unwatchedPools.push(p); link.outputs.unwatched(p); } });
    const tracker = createPoolTracker<FakePool>({
      model: fakeModel, reader, scheduler: time, chain, clock: time, outputs: merged, log: new Logs(), settings: { ...M04_DEFAULTS, maxPositions: 1 },
      providerOrder: () => ['primary'],
    });
    for (const id of ['A', 'B', 'C']) for (const [k, v] of poolAccounts(id, 1_000n, 2_000n)) reader.accounts.set(k, v);
    assert.ok(link.watch(tracker, 'A', 'candidate'));
    assert.ok(link.watch(tracker, 'B', 'position'));
    assert.equal(link.watch(tracker, 'C', 'position'), false);           // over M04's position cap: refused
    await tracker.settled();
    tracker.start();
    await time.advance(5_000);
    assert.ok(queue.stats().recordsTotal.pool_snapshot.written + queue.take(10_000, 's').length > 0);
    time.now += 60_000;
    tracker.unwatch('A');                                                // eviction
    reader.accounts.set('B', null);                                      // B closes on chain
    await time.advance(5_000);
    assert.deepEqual(outputs.unwatchedPools.sort(), ['A', 'B']);
    const day = WatchLog.readDay(dir, '2026-10-15');
    assert.deepEqual(day.map((i) => [i.poolId, i.priorityClass]).sort(), [['A', 'candidate'], ['B', 'position']]);
    assert.ok(day.every((i) => i.toMs < Date.UTC(2026, 9, 16)));          // both closed, not open to the end of the day
    assert.ok(!day.some((i) => i.poolId === 'C'));
    // The queue no longer counts polls for A or B: a tick emits no poll_counts for them past their unwatch.
    queue.tick((wall() + 120_000) as UnixMs);
    const late = queue.take(10_000, 't').filter((r) => r.stream === 'poll_counts').map((r) => JSON.parse(r.payloadJson) as { poolId: string; barStartMs: number });
    assert.ok(late.every((r) => r.barStartMs < wall()));
    tracker.stop();
  });

  it('ruling 14 end to end: a pool watched (in the history) but never polled lowers coverage; poll_counts alone would not', () => {
    const dir = tempDir('z08-link-cov');
    const h = new WatchLog(dir, () => undefined);
    const d0 = Date.UTC(2026, 9, 15) as UnixMs;
    h.watch('A', 'candidate', d0);
    h.watch('B', 'candidate', d0);
    // One poll_counts record per 15-second bar (ruling Z09-32).
    const polls = Array.from({ length: 1_440 * 4 }, (_, b) => ({ poolId: 'A', barStartMs: (d0 + b * 15_000) as UnixMs, successfulPolls: 15, priorityClass: 'candidate' }));
    const c = computeCoverage({ dayUtc: '2026-10-15', watched: WatchLog.readDay(dir, '2026-10-15'), pollCounts: polls, gaps: [], records: {}, universeManifestSha256: 'a'.repeat(64) });
    assert.equal(c.report.lowCoverage, true);
    assert.equal(c.detail.missingBps, 5_000);
  });
});
