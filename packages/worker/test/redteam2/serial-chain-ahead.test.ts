// RED TEAM 2 / H14 serial-deployer: a create already released to the engine is not counted when its chain block time
// is ahead of the local receipt clock.
//
// Scenario. DeployerIndex.factFor (core/src/gates/deployer-index.ts:211) filters the creator's mints by chain time
// (`createdAtMs <= now.receivedAt`) instead of by when the index learned them. `observe` (live path) keeps the block
// time unclamped (only `seed`/`fill` clamp to the as-of, deployer-index.ts:145), so a create whose block time is a
// second or two ahead of the worker's clock (block time is a stake-weighted validator estimate in whole seconds; the
// code itself allows CHAIN_SKEW_MS = 60 s of skew) is in the index, released before `now`, yet invisible to H14's
// 24 h count (hard.ts:518) until the local clock passes it. A serial deployer with 2 prior mints in the last seconds
// plus the candidate (3 > serialMaxMints24h = 2) then passes the serial half.
// Realism: LOW. The excluded window is only the skew (seconds) before the decision, and candidates are judged at
// migration, usually minutes after creates; it also differs from the backtest, whose receipt times come from block
// times. Expected (correct, fail-closed): a create released at or before `now` counts.
import { describe, expect, it } from 'vitest';
import { OFF_CHAIN, type MarketEvent, type Moment } from '../../../core/src/engine/index.ts';
import { DeployerIndex } from '../../../core/src/gates/index.ts';

const T = 1_791_039_600_000;
const SLOT = 452_957_000n;
const at = (receivedAt: number, slot: bigint): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt });
const market = (key: string, value: unknown, moment: Moment): MarketEvent => ({ kind: 'market', id: key, moment, key, value });
const create = (mint: string, creator: string, ms: number) => ({
  event: { name: 'CreateEvent', program: 'pump', data: { mint, creator, timestamp: BigInt(ms / 1_000), name: 'x', symbol: 'x', uri: '' } },
  signature: `sig-${mint}`, txSlot: SLOT, truncated: false, via: 'logs:creates', source: 'helius', backfilled: false, seq: 1,
});

describe('RT2-H14b: serial count and chain-time skew', () => {
  it('a create released before now counts even when its block time is 2 s ahead of the local clock', () => {
    const idx = new DeployerIndex();
    idx.observe(market('coverage:creates:start', { value: { fromSlot: SLOT - 7_000_000n, via: 'logs:creates' } }, at(T - 30 * 86_400_000, SLOT - 7_000_000n)));
    // Released at T - 1 s and T - 0.5 s by the local clock; block times T + 1 s and T + 2 s.
    idx.observe(market('logs:pump:CreateEvent:A', create('A', 'Dev', T + 1_000), at(T - 1_000, SLOT - 3n)));
    idx.observe(market('logs:pump:CreateEvent:B', create('B', 'Dev', T + 2_000), at(T - 500, SLOT - 2n)));
    const fact = idx.factFor('Dev', at(T, SLOT), 0);
    // Fails on 959d801: [] (both released creates are dropped by their chain time).
    expect(fact.mints.map((m) => m.mint)).toEqual(['A', 'B']);
  });
});
