// POS-1: a held position's pool state comes from the pool's confirmed swap stream, as live. After entry nothing
// re-reads the pool (the harness publishes no pool fact while a position is held): each swap's log line goes through
// FEED-1, DEC-1 and the fact producer, which release the pool right after it. Stops, trail and take-profit fire from
// that state; a gap in the stream makes it stale and no exit is priced from it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePool, poolKey } from '../../core/src/gates/index.ts';
import { TRIPPED_PREFIX } from '../src/engine/strategy.ts';
import { MINT, type Market, makeWorker, passingMarket } from './worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const lines = (h: H) => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const decisions = (h: H): string[][] => lines(h).filter((l) => l['kind'] === 'decision').map((l) => (l['reasons'] as string[]) ?? []);
const position = (h: H) => Object.values(h.worker.book.positions).find((p) => String(p.mint) === MINT);
const poolFact = (h: H) => {
  const v = h.worker.poolFact(MINT);
  return v === undefined ? null : { fact: parsePool(v)!, raw: v as Record<string, unknown> };
};

/** An active pool: a small buy every slot, so the state the exit is sent and filled on stays fresh. */
const ticks = (h: H, m: Market) => (): void => m.chainSwap('buy', m.chainState.baseReserve / 1_000_000n, h.worker.feed.openSlot);

/** Runs slot by slot (400 ms) until `done` or `maxMs` of virtual time; bounded, never a fixed window. */
const until = async (m: Market, done: () => boolean, maxMs: number, each?: () => void): Promise<boolean> => {
  const end = m.now + maxMs;
  while (!done() && m.now < end) {
    await m.run(400, 400, () => {
      m.slot();
      each?.();
    });
  }
  return done();
};

/** The passing market, the pool's trade stream and one account read, then the entry (pool facts only until it fills). */
const entered = async (o: { reads?: boolean } = {}): Promise<{ h: H; m: Market; readSlot: bigint }> => {
  const h = makeWorker();
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h);
  const readSlot = h.worker.feed.releasedThrough;
  m.tradesStart(readSlot - 100n);
  if (o.reads ?? true) m.accountsRead(readSlot);
  const ok = await until(m, () => position(h)?.status === 'open', 40_000, () => m.pool());
  if (!ok) console.log(JSON.stringify(decisions(h).slice(-15)));
  expect(ok).toBe(true);
  return { h, m, readSlot };
};

describe('a held position priced from its pool\'s swap stream (POS-1)', () => {
  it('with no swap, the pool state goes stale after entry and no price exit can fire; one swap down 30% fires the stop', async () => {
    const { h, m } = await entered();
    const pid = position(h)!.id;
    // Quiet pool: the last pool fact ages past maxQuoteAgeMs, and the m.pool() calls publish none while held.
    await until(m, () => false, 6_000, () => m.pool());
    expect(position(h)!.status).toBe('open');
    const before = poolFact(h)!;
    expect(m.now - before.fact.obs.receivedAt).toBeGreaterThan(h.session.policy.gates.maxQuoteAgeMs);
    // A seller takes the price down about 30%: the stop fires from the swap-derived state, no account read after entry.
    const sell = (m.chainState.baseReserve * 20n) / 100n;
    m.chainSwap('sell', sell, h.worker.feed.openSlot);
    expect(await until(m, () => h.worker.book.positions[pid]!.status === 'closed', 20_000, ticks(h, m))).toBe(true);
    const f = poolFact(h)!.fact;
    expect(f.obs.provider).toBe('helius');
    // Swap-derived (the read was before entry): the 20% sell is in it, less the small buys since.
    expect(f.obs.quality).toEqual([]);
    expect(f.baseVault - before.fact.baseVault > (sell * 99n) / 100n).toBe(true);
    expect(decisions(h).some((r) => r[0] === 'exit' && r.some((x) => x.startsWith('price_stop: ')))).toBe(true);
    await h.worker.stop();
  });

  it('an exit decided about 2 s after entry is priced and filled, never booked blocked', async () => {
    const { h, m } = await entered();
    const pid = position(h)!.id;
    await until(m, () => false, 2_000, ticks(h, m));
    m.chainSwap('sell', (m.chainState.baseReserve * 20n) / 100n, h.worker.feed.openSlot);
    expect(await until(m, () => h.worker.book.positions[pid]!.status === 'closed', 20_000, ticks(h, m))).toBe(true);
    expect(decisions(h).some((r) => r[0] === 'exit blocked')).toBe(false);
    await h.worker.stop();
  });

  it('risk judges the exit with the position marked from the swap-derived market (RISK-MARK): no unknown or stale mark', async () => {
    const { h, m } = await entered();
    const pid = position(h)!.id;
    // The account snapshot that risk reads holds the open position once the fill's snapshot is released.
    await until(m, () => false, 2_000, ticks(h, m));
    m.chainSwap('sell', (m.chainState.baseReserve * 20n) / 100n, h.worker.feed.openSlot);
    expect(await until(m, () => h.worker.book.positions[pid]!.status === 'closed', 20_000, ticks(h, m))).toBe(true);
    const exit = decisions(h).find((r) => r[0] === 'exit')!;
    const tripped = exit.find((x) => x.startsWith(TRIPPED_PREFIX))?.slice(TRIPPED_PREFIX.length).split(',') ?? [];
    // The position itself still counts against maxOpen; its value is known and fresh.
    expect(tripped).toContain('max_open_positions');
    expect(tripped).not.toContain('mark_unknown');
    expect(tripped).not.toContain('mark_stale');
    await h.worker.stop();
  });

  it('take-profit then the trail fire from swaps alone', async () => {
    const { h, m } = await entered();
    const pid = position(h)!.id;
    // A buyer lifts the price about 15%: past 1.5R, so the first partial sells half and the runner's trail starts.
    m.chainSwap('buy', (m.chainState.baseReserve * 675n) / 10_000n, h.worker.feed.openSlot);
    expect(await until(m, () => (h.worker.strategy.saved()[pid]?.tracker.partials ?? 0) >= 1 && h.worker.book.positions[pid]!.sold > 0n && h.worker.book.positions[pid]!.status === 'open', 20_000, ticks(h, m))).toBe(true);
    expect(decisions(h).some((r) => r[0] === 'partial exit' && r.some((x) => x.startsWith('take_profit: ')))).toBe(true);
    const trail = h.worker.strategy.saved()[pid]!.tracker.trail;
    expect(trail).not.toBeNull();
    // A seller takes it back down under the trail: the runner closes on the trailing stop.
    m.chainSwap('sell', (m.chainState.baseReserve * 12n) / 100n, h.worker.feed.openSlot);
    expect(await until(m, () => h.worker.book.positions[pid]!.status === 'closed', 20_000, ticks(h, m))).toBe(true);
    expect(decisions(h).some((r) => r[0] === 'exit' && r.some((x) => x.startsWith('trailing_stop: ') || x.startsWith('break_even: ')))).toBe(true);
    await h.worker.stop();
  });

  it('a gap in the swap stream makes the state stale: a later swap down 30% inside the gap prices nothing', async () => {
    const { h, m } = await entered();
    const pid = position(h)!.id;
    const gapFrom = h.worker.feed.openSlot;
    m.tradesGap(gapFrom, null);
    await until(m, () => false, 1_200);
    const stale = poolFact(h)!;
    expect(stale.fact.obs.quality).toContain('partial');
    expect(stale.raw['stale']).toBe('swap stream gap');
    m.chainSwap('sell', (m.chainState.baseReserve * 20n) / 100n, h.worker.feed.openSlot);
    await until(m, () => false, 4_000, () => m.pool());
    expect(h.worker.book.positions[pid]!.status).toBe('open');
    expect(decisions(h).some((r) => r.some((x) => x.startsWith('price_stop: ')))).toBe(false);
    expect(poolFact(h)!.fact.obs.quality).toContain('partial');
    await h.worker.stop();
  });

  it('a flagged pool fact is never priced from, however fresh: no stop, and no paper market', async () => {
    const { h, m } = await entered({ reads: false });
    const pid = position(h)!.id;
    const v = h.worker.poolFact(MINT) as { obs: Record<string, unknown>; quoteVault: bigint };
    // 30% down and fresh every slot, but flagged: the strategy must not read it.
    await until(m, () => false, 4_000, () => m.fact(poolKey(MINT), { ...v, quoteVault: (v.quoteVault * 7n) / 10n, obs: { ...v.obs, slot: h.worker.feed.openSlot - 1n, receivedAt: m.now - 50, quality: ['partial'] }, stale: 'swap stream gap' }));
    expect(h.worker.book.positions[pid]!.status).toBe('open');
    expect(decisions(h).some((r) => r.some((x) => x.startsWith('price_stop: ')))).toBe(false);
    expect(h.worker.poolOf(MINT)).toBeNull();
    await h.worker.stop();
  });

  it('without the switch the harness publishes no pool fact while held; with it, it does (other tests use it)', async () => {
    const { h, m } = await entered({ reads: false });
    await until(m, () => false, 800);
    const last = poolFact(h)!.fact.obs.receivedAt;
    m.pool();
    await until(m, () => false, 800);
    expect(poolFact(h)!.fact.obs.receivedAt).toBe(last);
    m.heldPoolFacts = true;
    m.pool();
    await until(m, () => false, 800);
    expect(poolFact(h)!.fact.obs.receivedAt).toBeGreaterThan(last);
    await h.worker.stop();
  });
});
