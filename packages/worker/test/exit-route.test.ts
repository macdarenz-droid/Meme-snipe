// EXIT-ROUTE: EXIT-1's sell route for a held position, from what the quote path proves on the held pool: route
// present, lost, or unknown (never read as present). Unit cases on the seam, then producer to exit on a real swap stream.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { poolSell } from '../../core/src/amm/index.ts';
import { FEE_CONTEXT } from '../../core/test/gates/world.ts';
import { sellRouteOf, type Market as PoolMarket } from '../src/engine/strategy.ts';
import { MINT, Market, makeWorker, passingMarket } from './worker-harness.ts';

const POOL = { baseReserve: 800_000_000_000_000n, quoteVault: 85_000_000_000n, virtualQuoteReserves: 0n };
const at = (atMs: number, pool = POOL, ctx = FEE_CONTEXT): PoolMarket => ({ pool, ctx, atMs, address: 'Pool' });
const NOW = 1_791_039_600_000;
const AGE = 2_000;

describe('sellRouteOf', () => {
  it('a fresh market that quotes the full position is a route', () => {
    expect(sellRouteOf(at(NOW - 100), 1_000_000_000n, NOW, AGE)).toEqual({ atMs: NOW - 100, value: 'ok' });
  });

  it('a fresh market that refuses the full sale for a market reason is a lost route', () => {
    // Drained to a few lamports: the fees take all the proceeds.
    expect(sellRouteOf(at(NOW, { ...POOL, quoteVault: 3n }), 1_000_000_000n, NOW, AGE)).toEqual({ atMs: NOW, value: 'missing' });
    // No usable reserves.
    expect(sellRouteOf(at(NOW, { ...POOL, quoteVault: 0n }), 1_000_000_000n, NOW, AGE)).toEqual({ atMs: NOW, value: 'missing' });
    // A coin the venue math does not price.
    expect(sellRouteOf(at(NOW, POOL, { ...FEE_CONTEXT, coin: { ...FEE_CONTEXT.coin, transferHook: true } }), 1_000_000_000n, NOW, AGE)).toEqual({ atMs: NOW, value: 'missing' });
  });

  it('a holding whose sale needs more than the real quote vault (virtual reserves set the price) is a lost route', () => {
    // The price comes from the vault plus the virtual reserves; the sale pays out of the real vault only.
    const effective = 170_000_000_000n;
    const full = poolSell({ ...POOL, quoteVault: effective, virtualQuoteReserves: 0n }, 1_000_000_000n, FEE_CONTEXT);
    if (!full.ok) throw new Error(full.reason);
    const need = full.trade.quote - full.trade.lpFee;
    const vault = (v: bigint) => ({ ...POOL, quoteVault: v, virtualQuoteReserves: effective - v });
    // One lamport short of what the sale takes from the vault: exceeds-reserves, so the route is lost.
    const short = poolSell(vault(need - 1n), 1_000_000_000n, FEE_CONTEXT);
    expect(short.ok ? null : short.reason).toBe('exceeds-reserves');
    expect(sellRouteOf(at(NOW, vault(need - 1n)), 1_000_000_000n, NOW, AGE)).toEqual({ atMs: NOW, value: 'missing' });
    // Exactly enough: a route.
    expect(sellRouteOf(at(NOW, vault(need)), 1_000_000_000n, NOW, AGE)).toEqual({ atMs: NOW, value: 'ok' });
  });

  it('unknown is never a route: no market, a stale one, one from the future, or nothing held', () => {
    expect(sellRouteOf('pool state unknown', 1_000_000_000n, NOW, AGE)).toBeNull();
    expect(sellRouteOf('pool state flagged gap', 1_000_000_000n, NOW, AGE)).toBeNull();
    expect(sellRouteOf(at(NOW - AGE - 1), 1_000_000_000n, NOW, AGE)).toBeNull();
    expect(sellRouteOf(at(NOW - AGE - 1, { ...POOL, quoteVault: 0n }), 1_000_000_000n, NOW, AGE)).toBeNull();
    expect(sellRouteOf(at(NOW + 1), 1_000_000_000n, NOW, AGE)).toBeNull();
    expect(sellRouteOf(at(NOW), 0n, NOW, AGE)).toBeNull();
  });
});

describe('the route, producer to exit', () => {
  type H = ReturnType<typeof makeWorker>;
  const lines = (h: H) => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const exitReasons = (h: H) => lines(h).filter((l) => l['kind'] === 'decision' && (l['reasons'] as string[])[0] === 'exit').flatMap((l) => l['reasons'] as string[]);
  const position = (h: H) => Object.values(h.worker.book.positions).find((p) => String(p.mint) === MINT);
  const run = async (m: Market, ms: number, each: () => void) => m.run(ms, 400, () => {
    m.slot();
    each();
  });
  /** The passing market, the pool's trade stream from before the entry and one account read; then the entry. */
  const entered = async (): Promise<{ h: H; m: Market }> => {
    const h = makeWorker({ config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18990', ZEROED_API_ADDR: '127.0.0.1:18991' } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h);
    const readSlot = h.worker.feed.releasedThrough;
    m.tradesStart(readSlot - 100n);
    m.accountsRead(readSlot);
    for (let k = 0; k < 100 && position(h)?.status !== 'open'; k++) await run(m, 400, () => m.pool());
    expect(position(h)?.status).toBe('open');
    return { h, m };
  };

  it('the pool drained by a seller on the swap stream: the full sale no longer quotes, and no_route fires', async () => {
    const { h, m } = await entered();
    // Someone sells the largest amount the pool can still pay out: its real quote vault is left nearly empty.
    let lo = 1n;
    let hi = m.chainState.baseReserve * 1_000_000n;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (poolSell(m.chainState, mid, FEE_CONTEXT).ok) lo = mid;
      else hi = mid;
    }
    m.chainSwap('sell', lo, h.worker.feed.openSlot);
    const held = position(h)!.quantity;
    expect(poolSell(m.chainState, held, FEE_CONTEXT).ok).toBe(false);
    // Judged while the drained state is fresh (the next slots, within the quote age).
    await run(m, 2_000, () => undefined);
    expect(exitReasons(h).some((r) => r.startsWith('no_route'))).toBe(true);
    await h.worker.stop();
  });

  it('#117\'s flow, producer to exit: real swap logs on the held pool, net selling for 5 whole minutes, fire negative_flow', async () => {
    const { h, m } = await entered();
    const b = m.chainState.baseReserve / 1_000_000n;
    // Each slot a sale and a slightly smaller buy: the price barely moves, the pool's net SOL flow is negative.
    await run(m, 6 * 60_000 + 2_000, () => {
      m.chainSwap('sell', b, h.worker.feed.openSlot);
      m.chainSwap('buy', (b * 9n) / 10n, h.worker.feed.openSlot);
    });
    const reasons = exitReasons(h);
    expect(reasons.some((r) => r.startsWith('negative_flow'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('price_stop') || r.startsWith('no_route'))).toBe(false);
    await h.worker.stop();
  });

  it('a quiet pool (stale market) never fires no_route: unknown is not lost, and not a route either', async () => {
    const { h, m } = await entered();
    await run(m, 6_000, () => undefined);
    expect(exitReasons(h).some((r) => r.startsWith('no_route'))).toBe(false);
    expect(position(h)?.status).toBe('open');
    await h.worker.stop();
  });
});
