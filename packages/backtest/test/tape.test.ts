// Audit B4 (#115 definitions.nonCreatorUserFlow): U2's flow is net SOL from swaps whose user is not the creator's exact
// address. It is not "independent" buying: a wallet the creator funded still counts (funding links are not in the data).
import { describe, expect, it } from 'vitest';
import type { PoolView } from '../src/sim/market.ts';
import { u2Setup } from '../src/strategy/study.ts';
import { PoolTape } from '../src/strategy/tape.ts';

const view = (user: string, side: 'buy' | 'sell', userQuote: bigint): PoolView => ({
  pool: 'P', mint: 'M', quoteMint: 'Q', baseReserve: 1_000_000n, quoteVault: 1_000_000n, virtualQuoteReserves: 0n, fees: {} as PoolView['fees'], baseSupply: 1_000_000n,
  side, userQuote, baseAmount: 10n, user, blockHeight: 1n, observed: { slot: 1n, at: 0 },
});

describe('non-creator-user flow (audit B4)', () => {
  it('nets every user\'s SOL but the creator\'s exact address; a wallet the creator funded still counts', () => {
    const t = new PoolTape(0, 10, 10);
    t.add(view('creator', 'buy', 500n), 1_000, 'creator');
    t.add(view('funded-by-creator', 'buy', 300n), 2_000, 'creator');
    t.add(view('other', 'sell', 100n), 3_000, 'creator');
    expect(t.tail[0]!.netNonCreatorUser).toBe(200n);
  });

  it('names the condition as non-creator-user flow, never as independent buying', () => {
    const t = new PoolTape(0, 10, 10);
    for (let k = 0; k < 20; k++) t.add(view('other', 'sell', 100n), k * 60_000, 'creator');
    const r = u2Setup({ kind: 'U2', recentMs: 120_000, flushBps: 0, higherLowBps: -10_000, stopBelowLowBps: 100 } as never, t, 10n ** 30n, 19 * 60_000, { quote: 1n, base: 1n });
    expect(JSON.stringify(r)).toMatch(/flow/);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/independent/i);
  });
});
