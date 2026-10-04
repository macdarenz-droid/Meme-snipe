// WORKER-1c: /health lists every open position, oldest first, not only the first one.
import { describe, expect, it } from 'vitest';
import type { PositionState } from '../../core/src/lifecycle/index.ts';
import { entryPrice, openPositionsHealth } from '../src/run/open-positions.ts';

const pos = (id: string, status: PositionState['status'], cost = 1_000_000n, quantity = 1_000n): PositionState =>
  ({ id, mint: `mint-${id}`, venue: 'pumpswap', entryIntentId: `e-${id}`, status, quantity, cost, bought: quantity, sold: 0n, exitOwner: null, exitSeq: 0, blockedReason: null }) as unknown as PositionState;

describe('openPositionsHealth', () => {
  const opened: Record<string, number> = { a: 300, b: 100, c: 200, d: 50 };
  const sources = {
    openedAt: (id: string) => opened[id] ?? null,
    plan: (id: string) => (id === 'c' ? null : { stopPrice: 7n }),
    universe: (id: string) => (id === 'c' ? 'none on record' : 'U2'),
    mark: (id: string) => (id === 'a' ? { price: 9n, atMs: 1_234, slot: 55n } : null),
  };

  it('lists every open position, oldest first; closed and opening positions are left out', () => {
    const list = openPositionsHealth([pos('a', 'open'), pos('b', 'exit_pending'), pos('x', 'closed'), pos('c', 'exit_blocked'), pos('d', 'opening'), pos('z', 'open')], sources);
    expect(list.map((p) => p.trade)).toEqual(['b', 'c', 'a', 'z']);
    expect(list[2]).toEqual({ trade: 'a', mint: 'mint-a', qty: '1000', entry: String(entryPrice(pos('a', 'open'))), stop: '7', mark: '9', mark_slot: 55, mark_ts: 1_234, universe: 'U2' });
    // No saved plan: stop unknown (the drill fails on it), the universe as its source says; no mark: the entry at time 0.
    expect(list[1]).toMatchObject({ trade: 'c', stop: 'unknown', universe: 'none on record', mark: list[1]!.entry, mark_slot: 0, mark_ts: 0 });
  });

  it('positions with the same open time are ordered by id; none open is an empty list', () => {
    const same = { ...sources, openedAt: () => 5 };
    expect(openPositionsHealth([pos('q', 'open'), pos('p', 'open')], same).map((p) => p.trade)).toEqual(['p', 'q']);
    expect(openPositionsHealth([pos('x', 'closed')], sources)).toEqual([]);
  });
});
