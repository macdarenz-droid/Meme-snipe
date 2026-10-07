// BEHIND: past the shed cap the feed sheds candidate pools' trade streams, each with the coverage gap a lossy catch-up
// reports (so the candidate's candles are not covered there and H11 refuses it, as s0-zero's lossy catch-up shows), and
// never a held position's stream.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHED_HELD_FRAMES } from '../src/run/behind.ts';
import { blockNetwork } from './helpers.ts';
import { POOL_ADDRESS, makeWorker, passingMarket, until, type Harness } from './worker-harness.ts';

blockNetwork();

const HELD = { heldPoolFacts: true } as const;
const lines = (h: Harness) => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const shedGaps = (h: Harness) => lines(h).filter((l) => l['kind'] === 'coverage_gap' && l['reason'] === 'shed');
/** More sightings on `pool`'s stream than the cap, in the next slot (held, not yet released). */
const flood = (h: Harness, pool: string, n = SHED_HELD_FRAMES + 1) => {
  const slot = (h.worker.feed.tip ?? 0n) + 1n;
  const name = (k: number) => [...String(k)].map((d) => 'abcdefghij'[Number(d)]).join('');
  for (let k = 0; k < n; k++) h.worker.feed.ingest('helius', { type: 'seen', signature: `Flood${name(k)}`.padEnd(88, '1'), slot, err: null, via: `logs:${pool}`, detail: null }, { receivedAt: h.timers.now() });
};

describe('BEHIND: the shed cap', () => {
  it('sheds a candidate pool\'s stream past the cap, with the coverage gap a lossy catch-up reports over it, logged', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    await passingMarket(h, HELD);
    expect(Object.values(h.worker.book.positions)).toEqual([]);
    flood(h, POOL_ADDRESS);
    const floodSlot = h.worker.feed.tip!;
    expect(h.worker.feed.heldFrames).toBeGreaterThan(SHED_HELD_FRAMES);
    // The gap goes on the feed first in the range's first slot (facts review B1): released before any event of it.
    const ingest = h.worker.feed.ingest.bind(h.worker.feed);
    const gaps: unknown[] = [];
    h.worker.feed.ingest = (src, body, o) => {
      if (body.type === 'offchain' && body.key === `coverage:trades:${POOL_ADDRESS}:gap`) gaps.push(o.firstIn);
      return ingest(src, body, o);
    };
    h.worker.step();
    expect(gaps).toEqual([floodSlot]);
    expect(h.worker.feed.heldFrames).toBeLessThan(SHED_HELD_FRAMES);
    expect(h.logs.some((l) => l.startsWith(`Behind: the feed held over ${SHED_HELD_FRAMES} frames; shed 1 candidate pools`))).toBe(true);
    // The coverage journal books it as the stream's own gap: the trades stream of that pool, from its logs watch.
    expect(shedGaps(h)).toHaveLength(1);
    expect(shedGaps(h)[0]).toMatchObject({ stream: 'trades', coverage: `trades:${POOL_ADDRESS}`, via: `logs:${POOL_ADDRESS}` });
    await h.worker.stop();
  });

  it('never sheds a pool whose entry is in flight, its position still opening (no exit plan yet): facts review', async () => {
    let h: Harness | null = null;
    // The paper world never reports the entry's landing: its attempt stays in flight, no position is booked.
    h = makeWorker({ worldFault: (e) => (e.type === 'intent' && e.event.type === 'status' && h!.worker.book.intents[e.intentId]?.intent.purpose === 'entry' ? null : e) });
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    const inFlight = () => Object.values(h!.worker.book.intents).some((i) => i.intent.purpose === 'entry' && i.attempts.length > 0);
    expect(await until(m, 30_000, inFlight, () => { m.slot(); m.pool(); })).toBe(true);
    // Its position is still opening: the pool is not held (no exit plan yet), yet money is in flight on it.
    expect(Object.values(h.worker.book.positions).map((p) => p.status)).toEqual(['opening']);
    expect(h.worker.strategy.watchedPools().get(POOL_ADDRESS)?.held).toBe(false);
    flood(h, POOL_ADDRESS);
    h.worker.step();
    expect(h.logs.some((l) => l.includes('candidate pools\' trade streams'))).toBe(false);
    expect(shedGaps(h)).toEqual([]);
    await h.worker.stop();
  });

  it('never sheds a held position\'s stream, however many frames are held', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    expect(await until(m, 30_000, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), () => { m.slot(); m.pool(); })).toBe(true);
    flood(h, POOL_ADDRESS);
    const held = h.worker.feed.heldFrames;
    expect(held).toBeGreaterThan(SHED_HELD_FRAMES);
    // The step sheds nothing (it may still release what the tip allows, never by shedding).
    h.worker.step();
    expect(h.logs.some((l) => l.includes('candidate pools\' trade streams'))).toBe(false);
    expect(shedGaps(h)).toEqual([]);
    await h.worker.stop();
  });
});
