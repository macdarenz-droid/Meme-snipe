// Live freshness against the observed tip (012efQ's #41 B1): the live strategy passes its observed tip (the clock's
// slot) to the gates, so a chain fact more than maxStateSlotLag slots behind it is stale and the candidate abstains;
// a tip of 0 would call every fact fresh.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { holdersKey } from '../../core/src/gates/index.ts';
import { passingFacts } from '../../core/test/gates/world.ts';
import { makeWorker, MINT, passingMarket } from './worker-harness.ts';

const lines = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const decisions = (dir: string) => lines(dir).filter((l) => l['kind'] === 'decision');
/** The passing world's holder fact, observed at `slot`. */
const holdersAt = (slot: bigint, receivedAt: number): unknown => {
  const v = passingFacts().get(holdersKey(MINT))!.value as { obs: object };
  return { ...v, obs: { ...v.obs, slot, receivedAt } };
};

describe('observed tip in live: a chain fact behind the tip is stale', () => {
  it('a holder read more than maxStateSlotLag slots behind the clock\'s slot is stale: the candidate abstains, never enters', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { omit: [holdersKey(MINT)] });
    const tick = () => {
      m.slot();
      m.pool();
    };
    await m.run(2_000, 400, tick);
    // The holder read lands now, but it was observed well behind the tip (the only fact that is).
    const lag = BigInt(TRIAL_POLICY.gates.maxStateSlotLag);
    const behind = h.worker.feed.openSlot - 1n - lag - 5n;
    m.omit = new Set();
    m.fact(holdersKey(MINT), holdersAt(behind, m.now - 50));
    m.omit = new Set([holdersKey(MINT)]);
    const from = m.now;
    await m.run(6_000, 400, tick);
    await h.worker.stop();
    const after = decisions(h.stateDir).filter((l) => Date.parse(String(l['ts'])) >= from);
    expect(after.filter((l) => l['action'] === 'enter')).toEqual([]);
    const rejects = after.filter((l) => l['action'] === 'reject').map((l) => (l['reasons'] as string[]).join(' '));
    expect(rejects.length).toBeGreaterThan(0);
    expect(rejects.some((r) => /H16 stale/.test(r) && /holders/.test(r))).toBe(true);
    expect(Object.values(h.worker.book.positions)).toEqual([]);
  }, 60_000);
});
