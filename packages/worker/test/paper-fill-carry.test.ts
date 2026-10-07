// BT-parity F2 (EXIT-FILL-FIXES): a paper entry lands on a carry-dated read. N1 fails a landing whose pool read is
// older than gates.maxQuoteAgeMs; a quiet pool (no swap in the ~2.4 s from send to landing) would then fail every entry
// the backtest fills. A carry proves the reserves unchanged through its slot, so the landing accepts it: the entry fills.
// With no carry (no covered trade stream), or a carry whose reserves differ from the pool fact, the read stays stale.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTyped } from '../src/run/json.ts';
import type { PaperAttempt } from '../src/run/paper-world.ts';
import { poolKey } from '../../core/src/gates/index.ts';
import { LANDS, MINT, type Market, makeWorker, passingMarket } from './worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const entries = (h: H): PaperAttempt[] => {
  const p = join(h.stateDir, 'paper.json');
  if (!existsSync(p)) return [];
  return Object.values((parseTyped(readFileSync(p, 'utf8')) as { attempts: Record<string, PaperAttempt> }).attempts).filter((a) => a.purpose === 'entry');
};

/** Slot by slot (400 ms) until `done` or `maxMs`. */
const until = async (m: Market, done: () => boolean, maxMs: number, each?: () => void): Promise<boolean> => {
  const end = m.now + maxMs;
  while (!done() && m.now < end) await m.run(400, 400, () => { m.slot(); each?.(); });
  return done();
};

/**
 * The passing market with fresh pool facts until the entry is sent, then a quiet pool: no swap and no pool fact, only
 * slots (and the SOL price) until the attempt settles. `covered` starts the pool's trade stream (so carries are made);
 * `moved` publishes one pool fact with other reserves than the chain right after the send.
 */
const quietLanding = async (o: { readonly covered: boolean; readonly moved?: boolean }): Promise<PaperAttempt> => {
  // No second-path reads: WATCH-1's snapshots would date the pool on their own; only the feed's facts and carries here.
  // Landing 12 slots after the send: the landing slot's notice comes about 4 s after it (the paper height trails the
  // feed head by its release horizon), past the 2 s quote age, so the last pool fact is stale unless a carry dates it.
  const h = makeWorker({ watchRead: () => new Promise(() => undefined), scenario: { ...LANDS, landingSlots: [12] } });
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h);
  const readSlot = h.worker.feed.releasedThrough;
  if (o.covered) m.tradesStart(readSlot - 100n);
  m.accountsRead(readSlot);
  expect(await until(m, () => entries(h).length > 0, 40_000, () => m.pool())).toBe(true);
  if (o.moved === true) {
    // A pool fact with other reserves than the producer's chain: the chain's carry no longer matches it, so cannot date it.
    const v = h.worker.poolFact(MINT) as { obs: Record<string, unknown>; quoteVault: bigint };
    m.fact(poolKey(MINT), { ...v, quoteVault: (v.quoteVault * 11n) / 10n, obs: { ...v.obs, slot: h.worker.feed.openSlot - 1n, receivedAt: m.now - 50 } });
  }
  const settled = () => entries(h).every((a) => a.outcome !== 'in_flight');
  expect(await until(m, settled, 20_000, () => m.solPrice())).toBe(true);
  const [a] = entries(h);
  await h.worker.stop();
  return a!;
};

describe('F2 a paper entry lands on a carry-dated read', () => {
  it('a quiet pool whose covered stream carries it: the entry fills', async () => {
    expect(await quietLanding({ covered: true })).toMatchObject({ outcome: 'filled' });
  });

  it('no carry (no covered trade stream): the read is stale at landing and the entry fails, never fills at the old price', async () => {
    const a = await quietLanding({ covered: false });
    expect(a.outcome).toBe('failed');
    expect(a.reason).toMatch(/^pool state stale/);
  });

  it('a carry whose reserves differ from the pool fact does not date it: stale, failed', async () => {
    const a = await quietLanding({ covered: true, moved: true });
    expect(a.outcome).toBe('failed');
    expect(a.reason).toMatch(/^pool state stale/);
  });
});
