// OOM-MINT (supervisor ruling): a create whose coin has not migrated within CREATE_KEEP_MS is let go; its coin, if it
// migrates later, is refused `create-expired` before anything is judged, counted in the summary's refused_by_reason.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOG_CREATE_PREFIX } from '../../core/src/gates/index.ts';
import { CREATE_KEEP_MS } from '../src/engine/strategy.ts';
import { blockNetwork } from './helpers.ts';
import { DEV, MINT, T, makeWorker, passingMarket } from './worker-harness.ts';

blockNetwork();

type Line = { kind: string; ts: string; action?: string; reasons?: string[]; gate_reasons?: { gate: string; code: string }[] };

/** The passing market, with the coin's create released `ageMs` before its migration fact (at T − 20 min). */
const run = async (ageMs: number) => {
  const h = makeWorker({});
  const got: string[] = [];
  const s = h.worker.strategy;
  const own = s.retired.bind(s);
  s.retired = () => {
    const r = own();
    got.push(...r);
    return r;
  };
  await h.worker.reconcile();
  const m = await passingMarket(h, {
    heldPoolFacts: true,
    before: { atMs: T - 20 * 60_000 - ageMs, run: () => h.worker.feed.ingest('helius', { type: 'fact', key: `${LOG_CREATE_PREFIX}${MINT}`, value: { event: { program: 'pump', name: 'CreateEvent', data: { mint: MINT, creator: DEV, timestamp: BigInt(Math.floor((T - 20 * 60_000 - ageMs) / 1000)) } }, signature: 'createsig' } }, { receivedAt: h.timers.now() }) },
  });
  await m.run(4_000, 100, () => m.pool());
  await m.run(10_000, 400, () => {
    m.slot();
    m.pool();
  });
  await h.worker.stop();
  const lines = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line).filter((l) => l.kind === 'decision');
  return { lines, got, expired: s.createExpired(MINT) };
};

describe('a create kept twelve hours (CREATE_KEEP_MS)', () => {
  it('is twelve hours', () => expect(CREATE_KEEP_MS).toBe(12 * 3_600_000));

  it('a migration 1 s inside twelve hours of the create is judged as before (it enters)', async () => {
    const r = await run(CREATE_KEEP_MS - 1_000);
    expect(r.expired).toBe(false);
    expect(r.got).not.toContain(MINT);
    expect(r.lines.filter((l) => l.action === 'enter')).toHaveLength(1);
    expect(r.lines.some((l) => (l.gate_reasons ?? []).some((g) => g.code === 'create-expired'))).toBe(false);
  });

  it('a migration 1 s past twelve hours is refused create-expired, never judged, and builds nothing', async () => {
    const r = await run(CREATE_KEEP_MS + 1_000);
    expect(r.expired).toBe(true);
    expect(r.got).toContain(MINT);
    expect(r.lines.filter((l) => l.action === 'enter')).toEqual([]);
    const rejects = r.lines.filter((l) => l.action === 'reject');
    expect(rejects.length).toBeGreaterThan(0);
    // Every judgement of the coin is the expiry, before the regime or any gate.
    for (const l of rejects) expect(l.gate_reasons).toEqual([{ gate: 'worker', code: 'create-expired', detail: expect.stringContaining('12 h') }]);
  });
});
